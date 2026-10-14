import { failWorker, heartbeatWorker, setWorkerStatus } from "../health.js";
import { errorExtra, logError, logInfo, logWarn } from "../logger.js";
import { withCycleLease } from "../db/cycleLease.js";
import { CHAIN_MODE_MOCK } from "./client.js";
import { reconcileProviderNonceGap } from "./providerWriteCoordinator.js";

const WORKER = "provider-write-reconciler";
const INTERVAL_MS = 30_000;
// Replicas that started an exact multiple of the interval apart tick in
// lockstep, and the one that started last loses the cycle lease every time.
// Random jitter on every tick breaks the phase lock.
export const RECONCILE_JITTER_MS = 5_000;
// A cycle holds the lease for its signer-lease wait and a few chain reads,
// well under a minute. A lease another session has held on every tick for
// this long is no longer a live peer reconciling: its cycle is stuck, so
// this replica stops vouching for it and reports the worker not ready.
export const PEER_LEASE_TRUST_MS = 5 * 60_000;
let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<void> | null = null;
let leaseBusySince: number | null = null;
let stalePeerReported = false;

export async function runProviderWriteReconciliation(): Promise<void> {
  const result = await withCycleLease("daski:provider-write-reconcile:v1", async () =>
    reconcileProviderNonceGap());
  if (result === null) {
    // Another replica holds the lease and is doing this cycle's work. The
    // lease is a session advisory lock, released when its holder's session
    // ends, so a busy lease is a live peer reconciling: this replica is
    // healthy, for as long as the peer keeps completing cycles.
    const now = Date.now();
    leaseBusySince ??= now;
    if (now - leaseBusySince <= PEER_LEASE_TRUST_MS) {
      heartbeatWorker(WORKER);
      return;
    }
    failWorker(WORKER);
    if (!stalePeerReported) {
      stalePeerReported = true;
      logWarn("Provider write reconciliation lease has been held by another session for too long", {
        busyForMs: now - leaseBusySince,
      });
    }
    return;
  }
  leaseBusySince = null;
  stalePeerReported = false;
  if (result === "clear") {
    heartbeatWorker(WORKER);
    return;
  }
  failWorker(WORKER);
  logWarn("Provider wallet nonce gap recovery is active", { result });
}

export function startProviderWriteReconciler(): void {
  if (timer) return;
  if (CHAIN_MODE_MOCK) {
    // There is no wallet nonce to reconcile in mock mode, and the mock
    // transport deliberately points at a blackhole, so every cycle would
    // throw. requiredWorkerNames() drops this worker in mock mode to match.
    logInfo("Provider write reconciler skipped (CHAIN_MODE=mock)");
    return;
  }
  setWorkerStatus(WORKER, false);
  const run = () => {
    if (inFlight) return;
    inFlight = runProviderWriteReconciliation();
    void inFlight.catch((error) => {
      failWorker(WORKER);
      logError("Provider wallet write reconciliation failed", errorExtra(error));
    }).finally(() => {
      inFlight = null;
    });
  };
  const schedule = () => {
    timer = setTimeout(() => {
      run();
      schedule();
    }, INTERVAL_MS + Math.floor(Math.random() * RECONCILE_JITTER_MS));
    timer.unref();
  };
  run();
  schedule();
}

export async function stopProviderWriteReconciler(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  if (inFlight) await inFlight.catch(() => undefined);
  leaseBusySince = null;
  stalePeerReported = false;
}
