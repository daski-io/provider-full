import type { Hex } from "viem";
import { publicClient } from "./client.js";
import { serviceRegistryAbi } from "./abis.js";
import { config } from "../config.js";
import type { ServiceRow } from "../db/queries/services.js";
import type { ProviderChainWriteRow } from "../db/queries/providerChainWrites.js";
import { emitEvent } from "../events/emitter.js";
import {
  confirmProviderWrite,
  prepareAndBroadcastProviderWrite,
  rebroadcastProviderWrite,
  revertProviderWrite,
} from "./providerWriteCoordinator.js";
import {
  finalityWaitBudgetMs,
  finalizedReadBlockNumber,
  waitForCanonicalFinalReceipt,
} from "./finality.js";
import { isServiceAlreadyRegisteredRevert } from "./registrationReverts.js";
import {
  openRegistrationWrites,
  registryHolds,
  settleRegistrationWrites,
  waitForFinalizedRegistration,
} from "./registrationWrites.js";

// One service's ServiceRegistry registration: verify an existing entry and
// heal its discovery URI, resume a journaled registration write, adopt a
// peer's registration once final, or submit a new one. The reconcile cycle in
// serviceRegistrar.ts drives these steps and owns their verdict.

/** How one reconcile cycle observes the bootstrap it runs. */
export interface ReconcileCycle {
  /** False once the cycle was superseded or abandoned; work then stops early. */
  isCurrent(): boolean;
  /**
   * Await a transaction this cycle broadcast. The cycle's deadline pauses
   * for the duration so a pending receipt is never abandoned; the wait
   * itself is bounded by finalityWaitBudgetMs.
   */
  awaitBroadcast<T>(wait: () => Promise<T>): Promise<T>;
}

export const detachedCycle: ReconcileCycle = {
  isCurrent: () => true,
  awaitBroadcast: (wait) => wait(),
};

function awaitFinalReceipt(cycle: ReconcileCycle, hash: Hex) {
  return cycle.awaitBroadcast(() =>
    waitForCanonicalFinalReceipt(hash, { timeoutMs: finalityWaitBudgetMs() }));
}

/** Checked under the signer lease, before any signing work starts. */
function assertCycleCurrent(cycle: ReconcileCycle): void {
  if (!cycle.isCurrent()) {
    throw new Error("service registration reconcile cycle was abandoned before broadcast");
  }
}

export const INHERITED_SERVICE_WALLET = "0x0000000000000000000000000000000000000000";

export function expectedServiceWallet(service: ServiceRow): string {
  return (service.service_wallet ?? INHERITED_SERVICE_WALLET).toLowerCase();
}

export function serviceUriFor(service: ServiceRow): string {
  return new URL(`/agent-cards/${service.slug}.json`, config.BASE_URL).toString();
}

export async function registerOne(service: ServiceRow, cycle: ReconcileCycle): Promise<Hex> {
  // 1. Compute the expected serviceId without any state change.
  const expected = (await publicClient.readContract({
    address: config.SERVICE_REGISTRY_ADDRESS as Hex,
    abi: serviceRegistryAbi,
    functionName: "computeServiceId",
    args: [config.PROVIDER_AGENT_ID, service.slug, service.version],
  })) as Hex;

  // 2. Did someone else already register this id (e.g. a prior boot
  // that succeeded on-chain but failed before writing services.on_chain_id)?
  // The contract reverts on collision so we must check first.
  const finalizedBlock = await finalizedReadBlockNumber();
  if (await registryHolds(expected, finalizedBlock)) {
    await settleRegistrationWrites(service.id, finalizedBlock);
    await reconcileRegisteredService(service, expected, finalizedBlock, cycle);
    return expected;
  }

  // 3. A registration this provider already journaled, whose transaction may
  // still be pending, is resumed and never signed a second time.
  const [journaled] = await openRegistrationWrites(service.id);
  if (journaled) return resumeRegistrationWrite(service, expected, journaled, cycle);

  // 4. Submit a registration tx. serviceWallet=0x0 inherits the provider
  // wallet; a non-zero wallet records a service-specific operating account.
  const serviceWallet = (service.service_wallet ??
    INHERITED_SERVICE_WALLET) as Hex;

  let peerRegistrationBlock: bigint | null = null;
  let write;
  try {
    write = await prepareAndBroadcastProviderWrite({
      purpose: "service_registration",
      target: { type: "service", id: service.id },
      address: config.SERVICE_REGISTRY_ADDRESS as Hex,
      abi: serviceRegistryAbi,
      functionName: "registerService",
      callArgs: [
        config.PROVIDER_AGENT_ID,
        service.slug,
        service.version,
        serviceUriFor(service),
        serviceWallet,
      ],
      preflight: async () => {
        assertCycleCurrent(cycle);
        const blockNumber = await finalizedReadBlockNumber();
        if (await registryHolds(expected, blockNumber)) {
          peerRegistrationBlock = blockNumber;
          throw new PeerRegistrationObserved();
        }
      },
      // Checked again inside the journal transaction, after signing and just
      // before broadcast: a cycle its budget abandoned meanwhile persists and
      // sends nothing.
      persist: async () => cycle.isCurrent(),
    });
  } catch (error) {
    if (error instanceof PeerRegistrationObserved && peerRegistrationBlock !== null) {
      await reconcileRegisteredService(service, expected, peerRegistrationBlock, cycle);
      return expected;
    }
    // The registry already holds the id although the finalized-depth reads
    // above could not see it: it was mined fewer than
    // CHAIN_WRITE_FINALITY_CONFIRMATIONS blocks ago, typically by another
    // replica. Adopt it once it is final; only a registration that is not at
    // the latest block either makes the revert an error.
    if (isServiceAlreadyRegisteredRevert(error) &&
        await adoptVisibleRegistration(service, expected, cycle)) {
      return expected;
    }
    throw error;
  }
  const receipt = await awaitFinalReceipt(cycle, write.hash);
  return finishRegistrationWrite(service, expected, write, receipt.status, cycle);
}

/**
 * Verify a registration another replica's transaction made: visible at the
 * latest block, then waited for until it is final and checked at the
 * finalized depth like this provider's own registrations.
 */
async function adoptVisibleRegistration(
  service: ServiceRow,
  expected: Hex,
  cycle: ReconcileCycle,
): Promise<boolean> {
  const latestBlock = await publicClient.getBlockNumber() as bigint;
  if (!await registryHolds(expected, latestBlock)) return false;
  const finalizedBlock = await cycle.awaitBroadcast(() =>
    waitForFinalizedRegistration(expected));
  await reconcileRegisteredService(service, expected, finalizedBlock, cycle);
  return true;
}

async function finishRegistrationWrite(
  service: ServiceRow,
  expected: Hex,
  write: { id: string; hash: Hex },
  status: string,
  cycle: ReconcileCycle,
): Promise<Hex> {
  if (status !== "success") {
    await revertProviderWrite(write.id, "canonical_receipt_reverted");
    // A peer's registration mined first and this duplicate reverted.
    if (await adoptVisibleRegistration(service, expected, cycle)) return expected;
    throw new Error(`registerService tx reverted: ${write.hash}`);
  }
  await confirmProviderWrite(write.id);
  const postRegistrationBlock = await finalizedReadBlockNumber();
  await assertRegisteredService(service, expected, postRegistrationBlock);
  return expected;
}

async function resumeRegistrationWrite(
  service: ServiceRow,
  expected: Hex,
  write: ProviderChainWriteRow,
  cycle: ReconcileCycle,
): Promise<Hex> {
  if (write.status === "attention") {
    throw new Error(
      `registerService write ${write.id} for ${service.slug} awaits review of its blocked nonce`,
    );
  }
  if (write.status === "prepared") {
    // Persisted but never accepted by the network: resend the same signed
    // bytes. A node that already has them refuses the resend harmlessly.
    try {
      await rebroadcastProviderWrite(write.id);
    } catch {
      // The receipt wait below decides; a later cycle resends again.
    }
  }
  const receipt = await awaitFinalReceipt(cycle, write.transaction_hash);
  return finishRegistrationWrite(
    service,
    expected,
    { id: write.id, hash: write.transaction_hash },
    receipt.status,
    cycle,
  );
}

class PeerRegistrationObserved extends Error {
  constructor() {
    super("Service was registered by another provider replica");
    this.name = "PeerRegistrationObserved";
  }
}

interface RegisteredService {
  providerAgentId: bigint;
  serviceId: Hex;
  serviceSlug: string;
  version: string;
  serviceURI: string;
  serviceWallet: Hex;
  active: boolean;
}

async function readRegisteredService(
  expected: Hex,
  blockNumber: bigint,
): Promise<RegisteredService> {
  return (await publicClient.readContract({
    address: config.SERVICE_REGISTRY_ADDRESS as Hex,
    abi: serviceRegistryAbi,
    functionName: "getService",
    args: [expected],
    blockNumber,
  })) as RegisteredService;
}

/** Identity and payout fields — everything except the mutable discovery URI. */
function registeredIdentityMatches(
  service: ServiceRow,
  expected: Hex,
  registered: RegisteredService,
): boolean {
  return registered.providerAgentId === config.PROVIDER_AGENT_ID
    && registered.serviceId.toLowerCase() === expected.toLowerCase()
    && registered.serviceSlug === service.slug
    && registered.version === service.version
    && registered.serviceWallet.toLowerCase() === expectedServiceWallet(service)
    && registered.active;
}

// An existing on-chain entry must match the local identity exactly. One
// field is operator-mutable and self-heals here: serviceURI. The discovery
// pointer legitimately changes when the AgentCard layout evolves (it moved
// from per-domain /.well-known/agent-card.json to /agent-cards/<slug>.json
// in 2026-07), and the registry contract exposes updateServiceURI for
// exactly that. Identity and payout fields (agent id, slug, version,
// serviceWallet, active) never self-heal — drift there stays fail-closed
// because rewriting them from local state could launder a hijacked entry.
async function reconcileRegisteredService(
  service: ServiceRow,
  expected: Hex,
  blockNumber: bigint,
  cycle: ReconcileCycle,
): Promise<void> {
  const registered = await readRegisteredService(expected, blockNumber);
  const canonicalUri = serviceUriFor(service);
  if (
    registeredIdentityMatches(service, expected, registered)
    && registered.serviceURI !== canonicalUri
  ) {
    const write = await prepareAndBroadcastProviderWrite({
      purpose: "service_uri_update",
      target: { type: "service", id: service.id },
      address: config.SERVICE_REGISTRY_ADDRESS as Hex,
      abi: serviceRegistryAbi,
      functionName: "updateServiceURI",
      callArgs: [expected, canonicalUri],
      preflight: async () => assertCycleCurrent(cycle),
      persist: async () => cycle.isCurrent(),
    });
    const receipt = await awaitFinalReceipt(cycle, write.hash);
    if (receipt.status !== "success") {
      await revertProviderWrite(write.id, "canonical_receipt_reverted");
      throw new Error(`updateServiceURI tx reverted: ${write.hash}`);
    }
    await confirmProviderWrite(write.id);
    await emitEvent({
      serviceId: service.id,
      source: "chain",
      type: "chain.service_uri_updated",
      message: `Updated stale ServiceRegistry URI for ${service.slug} v${service.version}`,
      payload: {
        slug: service.slug,
        version: service.version,
        onChainId: expected,
        serviceURI: canonicalUri,
      },
    });
    const healedBlock = await finalizedReadBlockNumber();
    await assertRegisteredService(service, expected, healedBlock);
    return;
  }
  if (
    !registeredIdentityMatches(service, expected, registered)
    || registered.serviceURI !== canonicalUri
  ) {
    throw new Error(`ServiceRegistry entry for ${service.slug} does not match local identity`);
  }
}

async function assertRegisteredService(
  service: ServiceRow,
  expected: Hex,
  blockNumber: bigint,
): Promise<void> {
  const registered = await readRegisteredService(expected, blockNumber);
  if (
    !registeredIdentityMatches(service, expected, registered)
    || registered.serviceURI !== serviceUriFor(service)
  ) {
    throw new Error(`ServiceRegistry entry for ${service.slug} does not match local identity`);
  }
}
