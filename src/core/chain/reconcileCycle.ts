import type { Hex } from "viem";
import { finalityWaitBudgetMs, waitForCanonicalFinalReceipt } from "./finality.js";

// How the ServiceRegistry bootstrap's steps observe the reconcile cycle that
// runs them, and the signal a preflight raises when another registrar's
// journaled write or registration makes this one's write unnecessary.

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

export function awaitFinalReceipt(cycle: ReconcileCycle, hash: Hex) {
  return cycle.awaitBroadcast(() =>
    waitForCanonicalFinalReceipt(hash, { timeoutMs: finalityWaitBudgetMs() }));
}

/** Checked under the signer lease, before any signing work starts. */
export function assertCycleCurrent(cycle: ReconcileCycle): void {
  if (!cycle.isCurrent()) {
    throw new Error("service registration reconcile cycle was abandoned before broadcast");
  }
}

/**
 * Raised by a preflight, under the signer lease, when the registry already
 * holds the state the write was for or another registrar journaled the same
 * write: the caller adopts or resumes it instead of signing.
 */
export class JournaledWriteObserved extends Error {
  constructor() {
    super("Another registrar already registered or journaled this ServiceRegistry write");
    this.name = "JournaledWriteObserved";
  }
}
