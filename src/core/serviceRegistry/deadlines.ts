import type { SkillContractDefinition } from "./manifestTypes.js";

/** The gateway's sealed dispatch deadline, published when a skill declares none. */
export const DEFAULT_DISPATCH_SECONDS = 300;
/** The gateway's sealed fulfillment window, published when a skill declares none. */
export const DEFAULT_FULFILLMENT_SECONDS = 2_592_000;
/**
 * After a no-claim status answer the gateway replaces an unanswered dispatch
 * envelope only from its validBefore plus this grace.
 */
export const DISPATCH_EXPIRY_GRACE_SECONDS = 60;
/**
 * A replacement dispatch is fulfilled synchronously before it is answered;
 * the gateway waits at most its largest provider timeout (120 s) and then
 * reconciles by status.
 */
export const DISPATCH_ANSWER_BUDGET_SECONDS = 120;
/**
 * Reviewed slack on top of one recovered dispatch: one step of the gateway's
 * refusal backoff (at most 60 s), its ten-second status polling, transport
 * timeouts and the 30-second clock tolerance both sides allow.
 */
export const DISPATCH_RECOVERY_MARGIN_SECONDS = 120;

const MIN_DEADLINE_SECONDS = 30;
const MAX_DISPATCH_SECONDS = 86_400;
const MAX_FULFILLMENT_SECONDS = 31_536_000;

export interface SkillDeadlines {
  dispatchSeconds: number;
  fulfillmentSeconds: number;
}

/** The deadlines every published skill contract carries, defaults applied. */
export function skillDeadlines(skill: Pick<SkillContractDefinition, "deadlines">): SkillDeadlines {
  return {
    dispatchSeconds: skill.deadlines?.dispatchSeconds ?? DEFAULT_DISPATCH_SECONDS,
    fulfillmentSeconds: skill.deadlines?.fulfillmentSeconds ?? DEFAULT_FULFILLMENT_SECONDS,
  };
}

/**
 * The shortest fulfillment window that still lets the gateway recover a lost
 * initial dispatch. The gateway re-dispatches a paid order only until its
 * first release observation plus the snapshot fulfillment window, and may
 * replace an unanswered envelope only after that envelope's validBefore
 * (dispatchSeconds) plus 60 seconds; the replacement is then answered within
 * the 120-second synchronous budget.
 */
export function minimumFulfillmentSeconds(dispatchSeconds: number): number {
  return dispatchSeconds + DISPATCH_EXPIRY_GRACE_SECONDS + DISPATCH_ANSWER_BUDGET_SECONDS
    + DISPATCH_RECOVERY_MARGIN_SECONDS;
}

/** Refuse deadlines the gateway would reject or a lost dispatch could not survive. */
export function assertRecoverableDeadlines(label: string, deadlines: SkillDeadlines): void {
  const { dispatchSeconds, fulfillmentSeconds } = deadlines;
  if (
    !Number.isSafeInteger(dispatchSeconds) || dispatchSeconds < MIN_DEADLINE_SECONDS
    || dispatchSeconds > MAX_DISPATCH_SECONDS
  ) throw new Error(`${label} dispatchSeconds must be an integer from 30 to 86400`);
  if (
    !Number.isSafeInteger(fulfillmentSeconds) || fulfillmentSeconds < MIN_DEADLINE_SECONDS
    || fulfillmentSeconds > MAX_FULFILLMENT_SECONDS
  ) throw new Error(`${label} fulfillmentSeconds must be an integer from 30 to 31536000`);
  const minimum = minimumFulfillmentSeconds(dispatchSeconds);
  if (fulfillmentSeconds < minimum) {
    throw new Error(
      `${label} fulfillmentSeconds must be at least ${minimum} (dispatchSeconds + 60 + 120 + 120) `
      + "so the gateway can recover a lost initial dispatch",
    );
  }
}
