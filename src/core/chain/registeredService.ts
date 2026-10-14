import type { Hex } from "viem";
import { config } from "../config.js";
import type { ProviderChainWriteRow } from "../db/queries/providerChainWrites.js";
import type { ServiceRow } from "../db/queries/services.js";
import { emitEvent } from "../events/emitter.js";
import { serviceRegistryAbi } from "./abis.js";
import { publicClient } from "./client.js";
import { finalizedReadBlockNumber } from "./finality.js";
import {
  confirmProviderWrite,
  prepareAndBroadcastProviderWrite,
  revertProviderWrite,
} from "./providerWriteCoordinator.js";
import {
  JournaledWriteObserved,
  assertCycleCurrent,
  awaitFinalReceipt,
  type ReconcileCycle,
} from "./reconcileCycle.js";
import {
  openServiceWrites,
  resumeServiceWrite,
  settleServiceWrites,
} from "./registrationWrites.js";

// Verification of an existing ServiceRegistry entry against the local
// service, and the one field that self-heals: its discovery URI.

export const INHERITED_SERVICE_WALLET = "0x0000000000000000000000000000000000000000";

export function expectedServiceWallet(service: ServiceRow): string {
  return (service.service_wallet ?? INHERITED_SERVICE_WALLET).toLowerCase();
}

export function serviceUriFor(service: ServiceRow): string {
  return new URL(`/agent-cards/${service.slug}.json`, config.BASE_URL).toString();
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

// Rewrite a stale serviceURI. An update this provider already journaled, also
// one another registrar journaled while this one waited for the signer lease,
// is resumed and never signed a second time.
async function healServiceUri(
  service: ServiceRow,
  expected: Hex,
  canonicalUri: string,
  cycle: ReconcileCycle,
): Promise<void> {
  const journaled: { write: ProviderChainWriteRow | null } = {
    write: (await openServiceWrites(service.id, "service_uri_update"))[0] ?? null,
  };
  if (!journaled.write) {
    try {
      const write = await prepareAndBroadcastProviderWrite({
        purpose: "service_uri_update",
        target: { type: "service", id: service.id },
        address: config.SERVICE_REGISTRY_ADDRESS as Hex,
        abi: serviceRegistryAbi,
        functionName: "updateServiceURI",
        callArgs: [expected, canonicalUri],
        preflight: async () => {
          assertCycleCurrent(cycle);
          journaled.write = (await openServiceWrites(service.id, "service_uri_update"))[0] ?? null;
          if (journaled.write) throw new JournaledWriteObserved();
        },
        persist: async () => cycle.isCurrent(),
      });
      const receipt = await awaitFinalReceipt(cycle, write.hash);
      if (receipt.status !== "success") {
        await revertProviderWrite(write.id, "canonical_receipt_reverted");
        throw new Error(`updateServiceURI tx reverted: ${write.hash}`);
      }
      await confirmProviderWrite(write.id);
      return;
    } catch (error) {
      if (!(error instanceof JournaledWriteObserved) || !journaled.write) throw error;
    }
  }
  const update = journaled.write;
  const outcome = await resumeServiceWrite({
    write: update,
    label: `updateServiceURI for ${service.slug}`,
    cycle,
    reached: async (finalized) =>
      (await readRegisteredService(expected, finalized)).serviceURI === canonicalUri,
  });
  if ("reverted" in outcome) {
    await revertProviderWrite(update.id, "canonical_receipt_reverted");
    throw new Error(`updateServiceURI tx reverted: ${update.transaction_hash}`);
  }
  await settleServiceWrites(service.id, outcome.finalizedBlock);
}

// An existing on-chain entry must match the local identity exactly. One
// field is operator-mutable and self-heals here: serviceURI. The discovery
// pointer legitimately changes when the AgentCard layout evolves (it moved
// from per-domain /.well-known/agent-card.json to /agent-cards/<slug>.json
// in 2026-07), and the registry contract exposes updateServiceURI for
// exactly that. Identity and payout fields (agent id, slug, version,
// serviceWallet, active) never self-heal — drift there stays fail-closed
// because rewriting them from local state could launder a hijacked entry.
export async function reconcileRegisteredService(
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
    await healServiceUri(service, expected, canonicalUri, cycle);
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

export async function assertRegisteredService(
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
