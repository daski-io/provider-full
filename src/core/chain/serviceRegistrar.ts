import { encodeAbiParameters, keccak256, parseAbiParameters, type Hex } from "viem";
import {
  publicClient,
  CHAIN_MODE_MOCK,
} from "./client.js";
import { serviceRegistryAbi } from "./abis.js";
import { config } from "../config.js";
import {
  listActiveServices,
  setServiceOnChainId,
  type ServiceRow,
} from "../db/queries/services.js";
import { emitEvent } from "../events/emitter.js";
import {
  confirmProviderWrite,
  prepareAndBroadcastProviderWrite,
  revertProviderWrite,
} from "./providerWriteCoordinator.js";
import {
  finalityWaitBudgetMs,
  finalizedReadBlockNumber,
  waitForCanonicalFinalReceipt,
} from "./finality.js";
import { redactSensitiveText } from "../security/redaction.js";
import { logWarn } from "../logger.js";
import { RegistrationCycleBudget } from "./registrationCycleBudget.js";
import { isServiceAlreadyRegisteredRevert } from "./registrationReverts.js";

function safeRegistrationError(error: unknown): string {
  return redactSensitiveText((error as Error).message)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 512) || "service registration verification failed";
}

// ServiceRegistry bootstrap. Every service has an on-chain catalog identity
// independent of the standard payment rail.
//
// This module runs once at app boot, after the service registry has
// seeded `services` from each ServiceModule's manifest. For each active
// service row without an on_chain_id we:
//   1. Derive the expected serviceId (pure helper on the contract).
//   2. Check whether it already exists on-chain (idempotent reboot).
//   3. If not, submit registerService(...) from the provider wallet.
//   4. Write the resulting bytes32 back to services.on_chain_id.
//   5. Emit a chain.service_registered event for the platform log.
//
// Re-registration on `version` bump is handled by inserting a new
// services row with the new version (the registry seeder respects the
// (slug, version) UNIQUE constraint); the next bootstrap picks it up.

interface BootstrapResult {
  registered: number;
  already_on_chain: number;
  skipped_missing_data: number;
}

/** How one reconcile cycle observes the bootstrap it runs. */
interface ReconcileCycle {
  /** False once the cycle was superseded or abandoned; work then stops early. */
  isCurrent(): boolean;
  /**
   * Await a transaction this cycle broadcast. The cycle's deadline pauses
   * for the duration so a pending receipt is never abandoned; the wait
   * itself is bounded by finalityWaitBudgetMs.
   */
  awaitBroadcast<T>(wait: () => Promise<T>): Promise<T>;
}

const detachedCycle: ReconcileCycle = {
  isCurrent: () => true,
  awaitBroadcast: (wait) => wait(),
};

function awaitFinalReceipt(cycle: ReconcileCycle, hash: Hex) {
  return cycle.awaitBroadcast(() =>
    waitForCanonicalFinalReceipt(hash, { timeoutMs: finalityWaitBudgetMs() }));
}

/** Checked under the signer lease: an abandoned cycle never broadcasts. */
function assertCycleCurrent(cycle: ReconcileCycle): void {
  if (!cycle.isCurrent()) {
    throw new Error("service registration reconcile cycle was abandoned before broadcast");
  }
}

export interface ServiceRegistrationHealth {
  ok: boolean;
  checkedAt: Date | null;
  error: string | null;
}

let registrationHealth: ServiceRegistrationHealth = {
  ok: false,
  checkedAt: null,
  error: "service registration has not been reconciled",
};
const SERVICE_VERIFICATION_MAX_AGE_MS =
  config.REGISTRATION_RECONCILE_MAX_AGE_SECONDS * 1_000;
const verifiedServices = new Map<string, {
  onChainId: string;
  serviceWallet: string;
  checkedAt: Date;
  ok: boolean;
  error: string | null;
}>();
const INHERITED_SERVICE_WALLET = "0x0000000000000000000000000000000000000000";

function expectedServiceWallet(service: ServiceRow): string {
  return (service.service_wallet ?? INHERITED_SERVICE_WALLET).toLowerCase();
}
let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let reconciliationInFlight: Promise<BootstrapResult> | null = null;

export function getServiceRegistrationHealth(): ServiceRegistrationHealth {
  return { ...registrationHealth };
}

export function getServiceRegistrationAuthorization(service: ServiceRow): {
  ok: boolean;
  reason: string | null;
} {
  if (!service.on_chain_id) return { ok: false, reason: "service has no on-chain registration" };
  const verification = verifiedServices.get(service.id);
  if (!verification?.ok) {
    return { ok: false, reason: verification?.error ?? "service registration is not verified" };
  }
  if (Date.now() - verification.checkedAt.getTime() > SERVICE_VERIFICATION_MAX_AGE_MS) {
    return { ok: false, reason: "service registration verification is stale" };
  }
  const localId = `0x${service.on_chain_id.toString("hex")}`.toLowerCase();
  if (verification.onChainId !== localId) {
    return { ok: false, reason: "service registration changed after verification" };
  }
  if (verification.serviceWallet !== expectedServiceWallet(service)) {
    return { ok: false, reason: "service payout destination changed after verification" };
  }
  return { ok: true, reason: null };
}

/**
 * Register or verify every active service on the ServiceRegistry. A
 * reconcile cycle passes its observer: once the cycle was abandoned by its
 * budget or superseded, the detached work stops at the next step and can no
 * longer overwrite a newer cycle's verdict, so a late success never turns a
 * newer failure into a ready state.
 */
export async function bootstrapServiceRegistry(
  cycleOverrides: Partial<ReconcileCycle> = {},
): Promise<BootstrapResult> {
  const cycle: ReconcileCycle = { ...detachedCycle, ...cycleOverrides };
  const { isCurrent } = cycle;
  const services = await listActiveServices();
  const result: BootstrapResult = {
    registered: 0,
    already_on_chain: 0,
    skipped_missing_data: 0,
  };

  if (!isCurrent()) return result;
  if (CHAIN_MODE_MOCK) {
    for (const service of services) {
      if (!isCurrent()) return result;
      const mockId = mockServiceId(service);
      if (!service.on_chain_id || !service.on_chain_id.equals(hexToBuffer(mockId))) {
        await setServiceOnChainId(service.id, hexToBuffer(mockId));
      }
      if (!isCurrent()) return result;
      verifiedServices.set(service.id, {
        onChainId: mockId.toLowerCase(),
        serviceWallet: expectedServiceWallet(service),
        checkedAt: new Date(), ok: true, error: null,
      });
      result.already_on_chain++;
    }
    if (isCurrent()) registrationHealth = { ok: true, checkedAt: new Date(), error: null };
    return result;
  }

  for (const service of services) {
    if (!isCurrent()) return result;
    const before = service.on_chain_id;
    let onChainId: Hex;
    try {
      onChainId = await registerOne(service, cycle);
      if (!isCurrent()) return result;
      verifiedServices.set(service.id, {
        onChainId: onChainId.toLowerCase(),
        serviceWallet: expectedServiceWallet(service),
        checkedAt: new Date(), ok: true, error: null,
      });
    } catch (error) {
      if (!isCurrent()) throw error;
      verifiedServices.set(service.id, {
        onChainId: before ? `0x${before.toString("hex")}`.toLowerCase() : "",
        serviceWallet: expectedServiceWallet(service),
        checkedAt: new Date(), ok: false, error: safeRegistrationError(error),
      });
      throw error;
    }
    if (!before || !before.equals(hexToBuffer(onChainId))) {
      await setServiceOnChainId(service.id, hexToBuffer(onChainId));
      result.registered++;
    } else {
      result.already_on_chain++;
    }
    if (!isCurrent()) return result;
    await emitEvent({
      serviceId: service.id,
      source: "chain",
      type: "chain.service_registration_verified",
      message: `Verified ${service.slug} v${service.version} on ServiceRegistry`,
      payload: {
        slug: service.slug,
        version: service.version,
        onChainId,
        serviceURI: serviceUriFor(service),
      },
    });
  }

  if (isCurrent()) registrationHealth = { ok: true, checkedAt: new Date(), error: null };
  return result;
}

function serviceUriFor(service: ServiceRow): string {
  return new URL(`/agent-cards/${service.slug}.json`, config.BASE_URL).toString();
}

function mockServiceId(service: ServiceRow): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("uint256, string, string"), [
      config.PROVIDER_AGENT_ID,
      service.slug,
      service.version,
    ]),
  );
}

async function registerOne(service: ServiceRow, cycle: ReconcileCycle): Promise<Hex> {
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
  const exists = (await publicClient.readContract({
    address: config.SERVICE_REGISTRY_ADDRESS as Hex,
    abi: serviceRegistryAbi,
    functionName: "exists",
    args: [expected],
    blockNumber: finalizedBlock,
  })) as boolean;

  if (exists) {
    await reconcileRegisteredService(service, expected, finalizedBlock, cycle);
    return expected;
  }

  // 3. Submit a registration tx. serviceWallet=0x0 inherits the provider
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
        const nowExists = await publicClient.readContract({
          address: config.SERVICE_REGISTRY_ADDRESS as Hex,
          abi: serviceRegistryAbi,
          functionName: "exists",
          args: [expected],
          blockNumber,
        }) as boolean;
        if (nowExists) {
          peerRegistrationBlock = blockNumber;
          throw new PeerRegistrationObserved();
        }
      },
      persist: async () => true,
    });
  } catch (error) {
    if (error instanceof PeerRegistrationObserved && peerRegistrationBlock !== null) {
      await reconcileRegisteredService(service, expected, peerRegistrationBlock, cycle);
      return expected;
    }
    // The registry already holds the id although the finalized-depth reads
    // above could not see it: it was mined fewer than
    // CHAIN_WRITE_FINALITY_CONFIRMATIONS blocks ago, typically by the detached
    // continuation of a cycle a previous boot abandoned. Adopt what the chain
    // has at the latest block; only a registration that is not there either
    // makes the revert an error.
    if (isServiceAlreadyRegisteredRevert(error)) {
      const latestBlock = await publicClient.getBlockNumber() as bigint;
      const visible = await publicClient.readContract({
        address: config.SERVICE_REGISTRY_ADDRESS as Hex,
        abi: serviceRegistryAbi,
        functionName: "exists",
        args: [expected],
        blockNumber: latestBlock,
      }) as boolean;
      if (visible) {
        await reconcileRegisteredService(service, expected, latestBlock, cycle);
        return expected;
      }
    }
    throw error;
  }
  const receipt = await awaitFinalReceipt(cycle, write.hash);
  if (receipt.status !== "success") {
    await revertProviderWrite(write.id, "canonical_receipt_reverted");
    throw new Error(`registerService tx reverted: ${write.hash}`);
  }
  await confirmProviderWrite(write.id);
  const postRegistrationBlock = await finalizedReadBlockNumber();
  await assertRegisteredService(service, expected, postRegistrationBlock);
  return expected;
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
      persist: async () => true,
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

// Budget for one reconcile cycle's chain reads, signer lease, and local
// writes. Kept under the reconciler's 60s interval so a hung cycle frees the
// in-flight slot before the next tick fires; one hung cycle would otherwise
// freeze reconciliationInFlight forever — readiness (and, via verification
// staleness, every paid purchase) then fails closed with no recovery path
// until a restart. Receipt waits for transactions the cycle broadcast do not
// count against it: the budget pauses while one is pending (see
// RegistrationCycleBudget) and each wait is bounded by finalityWaitBudgetMs,
// so a first boot fits however many services it must register, and a
// failure still surfaces as an explicit unhealthy verdict.
const RECONCILE_DEADLINE_MS = 45_000;
let reconcileAttempt = 0;

export function reconcileServiceRegistrations(): Promise<BootstrapResult> {
  if (reconciliationInFlight) return reconciliationInFlight;
  const attempt = ++reconcileAttempt;
  let timedOut = false;
  const budget = new RegistrationCycleBudget(RECONCILE_DEADLINE_MS, () => {
    timedOut = true;
  });
  const work = bootstrapServiceRegistry({
    isCurrent: () => attempt === reconcileAttempt && !timedOut,
    awaitBroadcast: (wait) => budget.awaitBroadcast(wait),
  });
  // A timed-out cycle keeps running detached. Absorb its eventual outcome so
  // it can neither become an unhandled rejection nor go unnoticed.
  void work.then(
    () => {
      budget.cancel();
      if (timedOut) {
        logWarn("Timed-out service registration reconcile eventually completed", {});
      }
    },
    (error) => {
      budget.cancel();
      if (timedOut) {
        logWarn("Timed-out service registration reconcile eventually failed", {
          error: safeRegistrationError(error),
        });
      }
    },
  );
  reconciliationInFlight = Promise.race([work, budget.expired])
    .catch((error) => {
      // The attempt guard keeps a superseded cycle from overwriting a newer
      // cycle's verdict or clearing a newer cycle's in-flight slot.
      if (attempt === reconcileAttempt) {
        registrationHealth = {
          ok: false,
          checkedAt: new Date(),
          error: safeRegistrationError(error),
        };
      }
      logWarn("Service registration reconcile failed", {
        error: safeRegistrationError(error),
      });
      throw error;
    })
    .finally(() => {
      if (attempt === reconcileAttempt) reconciliationInFlight = null;
    });
  return reconciliationInFlight;
}

export function startServiceRegistrationReconciler(intervalMs = 60_000): void {
  if (reconcileTimer) return;
  reconcileTimer = setInterval(() => {
    void reconcileServiceRegistrations().catch(() => {
      // Already logged and recorded in registrationHealth by the reconcile
      // itself; swallowed here only so the fire-and-forget tick cannot raise
      // an unhandled rejection.
    });
  }, intervalMs);
}

export function stopServiceRegistrationReconciler(): void {
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = null;
}

function hexToBuffer(hex: Hex): Buffer {
  return Buffer.from(hex.slice(2), "hex");
}
