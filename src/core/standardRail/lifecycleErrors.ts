import { PayerSignatureError } from "./payerSignature.js";
import { TerminalIdentityUnavailableError } from "./terminalResult.js";

/**
 * The lifecycle refusals the gateway names to the buyer (gateway G02), plus
 * the authentication refusal it never names. Each named body carries exactly
 * one key, `error`:
 *
 *   - `artifact_unavailable` (409): an artifact read before completed
 *     fulfilment or without retained deliverable bytes;
 *   - `unsupported_action` (409): the action is not available for this order
 *     in its current state; nothing was changed;
 *   - `action_conflict` (409): the action's durable identity is already bound
 *     to different content;
 *   - `lifecycle_unavailable` (503): the provider cannot serve the action
 *     right now; it asserts nothing about an earlier attempt's effect;
 *   - `lifecycle_rejected` (401): authentication or binding failure, without
 *     detail.
 */
export type LifecycleRefusalKind =
  | "rejected"
  | "artifact_unavailable"
  | "unsupported_action"
  | "action_conflict"
  | "lifecycle_unavailable";

export class LifecycleRefusal extends Error {
  constructor(readonly kind: LifecycleRefusalKind, message: string = kind) {
    super(message);
    this.name = "LifecycleRefusal";
  }

  get status(): 401 | 409 | 503 {
    if (this.kind === "rejected") return 401;
    return this.kind === "lifecycle_unavailable" ? 503 : 409;
  }

  body(): { error: string } {
    return { error: this.kind === "rejected" ? "lifecycle_rejected" : this.kind };
  }
}

export const lifecycleRejected = (message: string) => new LifecycleRefusal("rejected", message);
export const unsupportedAction = (message: string) => new LifecycleRefusal("unsupported_action", message);
export const actionConflict = (message: string) => new LifecycleRefusal("action_conflict", message);
export const artifactUnavailable = (message: string) => new LifecycleRefusal("artifact_unavailable", message);
export const lifecycleUnavailable = (message: string) => new LifecycleRefusal("lifecycle_unavailable", message);

/**
 * Every failure is a refusal. Authentication marks its own rejections; a
 * retryable payer-signature outage, an unanswerable terminal identity, a
 * database fault or anything unforeseen is temporarily unavailable, which
 * claims nothing about whether an earlier attempt took effect.
 */
export function lifecycleRefusalOf(error: unknown): LifecycleRefusal {
  if (error instanceof LifecycleRefusal) return error;
  if (error instanceof PayerSignatureError) {
    return error.retryable ? lifecycleUnavailable(error.message) : lifecycleRejected(error.message);
  }
  if (error instanceof TerminalIdentityUnavailableError) return lifecycleUnavailable(error.message);
  return lifecycleUnavailable(error instanceof Error ? error.name : "UnknownError");
}
