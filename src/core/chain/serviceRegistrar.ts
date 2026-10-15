import { encodeAbiParameters, keccak256, parseAbiParameters, type Hex } from "viem";
import { CHAIN_MODE_MOCK } from "./client.js";
import { config } from "../config.js";
import {
  listActiveServices,
  setServiceOnChainId,
  type ServiceRow,
} from "../db/queries/services.js";
import { emitEvent } from "../events/emitter.js";
import { redactSensitiveText } from "../security/redaction.js";
import { logWarn } from "../logger.js";
import { observeRegistration } from "./registrationObservability.js";
import { RegistrationCycleBudget } from "./registrationCycleBudget.js";
import { detachedCycle, type ReconcileCycle } from "./reconcileCycle.js";
import { expectedServiceWallet, serviceUriFor } from "./registeredService.js";
import { registerOne } from "./serviceRegistration.js";

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
//   4. Audit a changed link (chain.service_registered), then write the
//      resulting bytes32 back to services.on_chain_id.
//   5. Record the verdict; a change of verdict, not every cycle, is logged.
//
// Re-registration on `version` bump is handled by inserting a new
// services row with the new version (the registry seeder respects the
// (slug, version) UNIQUE constraint); the next bootstrap picks it up.

interface BootstrapResult {
  registered: number;
  already_on_chain: number;
  skipped_missing_data: number;
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
let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let reconciliationInFlight: Promise<BootstrapResult> | null = null;
/** Errors a service's own verdict already recorded, so the cycle does not record them twice. */
const serviceObservedErrors = new WeakSet<object>();

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
    if (isCurrent()) {
      registrationHealth = { ok: true, checkedAt: new Date(), error: null };
      observeRegistration("cycle", null);
    }
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
      observeRegistration(service.id, safeRegistrationError(error), service);
      if (error && typeof error === "object") serviceObservedErrors.add(error);
      throw error;
    }
    if (!before || !before.equals(hexToBuffer(onChainId))) {
      // A changed link is audited before it is written, so a failed
      // mandatory insert is retried by the next cycle; an unchanged
      // verification is no audit event.
      await emitEvent({
        serviceId: service.id,
        source: "chain",
        type: "chain.service_registered",
        message: `Linked ${service.slug} v${service.version} to ServiceRegistry`,
        payload: {
          slug: service.slug,
          version: service.version,
          onChainId,
          serviceURI: serviceUriFor(service),
        },
      });
      if (!isCurrent()) return result;
      await setServiceOnChainId(service.id, hexToBuffer(onChainId));
      result.registered++;
    } else {
      result.already_on_chain++;
    }
    if (!isCurrent()) return result;
    observeRegistration(service.id, null, service);
  }

  if (isCurrent()) {
    registrationHealth = { ok: true, checkedAt: new Date(), error: null };
    observeRegistration("cycle", null);
  }
  return result;
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

// Budget for one reconcile cycle's chain reads, signer lease, and local
// writes. Kept under the reconciler's three-minute interval so a hung cycle frees the
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
        // Logged on a change of verdict only; a service's own failure was
        // recorded with that service.
        if (!(error && typeof error === "object" && serviceObservedErrors.has(error))) {
          observeRegistration("cycle", safeRegistrationError(error));
        }
      }
      throw error;
    })
    .finally(() => {
      if (attempt === reconcileAttempt) reconciliationInFlight = null;
    });
  return reconciliationInFlight;
}

/**
 * Re-verify every service's registration every three minutes, within the
 * five-minute verification freshness limit; a failed cycle revokes it at
 * once and writes still recheck under the signer lease.
 */
export function startServiceRegistrationReconciler(
  intervalMs = Math.max(10_000, Math.min(180_000, Math.floor(SERVICE_VERIFICATION_MAX_AGE_MS * 0.6))),
): void {
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
