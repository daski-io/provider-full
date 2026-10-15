import { ConditionTracker } from "./conditionTracker.js";

/*
 * A polling worker reports its own failure when it starts failing, or fails
 * differently, and its recovery once: never on every unchanged poll. Its
 * readiness heartbeat (health.ts) still reflects every cycle; only the log
 * lines are transitions.
 */
const workers = new ConditionTracker();
const HEALTHY = "healthy";

/** Record a failed cycle; true when this failure is a change worth logging. */
export function workerCycleFailed(worker: string, error: unknown): boolean {
  const errorClass = error instanceof Error ? error.name : "UnknownError";
  return workers.changed(worker, `failing:${errorClass}`);
}

/** Record a healthy cycle; true when it ends a failure, so the recovery is logged once. */
export function workerCycleSucceeded(worker: string): boolean {
  const previous = workers.get(worker);
  workers.changed(worker, HEALTHY);
  return previous !== undefined && previous !== HEALTHY;
}
