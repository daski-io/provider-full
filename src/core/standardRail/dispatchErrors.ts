import { GatewayEnvelopeError } from "./gatewayEnvelope.js";

/**
 * Reviewed reason codes for a definite dispatch refusal. They are public
 * diagnostics, so they never carry input, signed envelopes or dependency
 * errors. A refusal is only ever returned before any admission.
 */
export const DISPATCH_REJECTION_REASONS = [
  "quote_window", "envelope_lifetime", "signature", "outcome_policy",
  "self_purchase", "price", "validator", "evidence", "service_unavailable",
] as const;

export type DispatchRejectionReason = typeof DISPATCH_REJECTION_REASONS[number];

/**
 * A definite refusal: no claim exists for the order and none was committed.
 * The gateway records it and later sends a new envelope for the paid order.
 */
export class DispatchRejectedError extends Error {
  constructor(readonly reason: DispatchRejectionReason, message: string = reason) {
    super(message);
    this.name = "DispatchRejectedError";
  }
}

/**
 * Admission exists, its commit outcome is unknown, or admitted work cannot be
 * rendered right now. The answer must be deliberately ambiguous (an empty
 * 503) so the gateway reconciles through status with the original hash.
 */
export class DispatchAmbiguousError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DispatchAmbiguousError";
  }
}

/**
 * The admission COMMIT failed without a definite answer. Only the claim's
 * task id can prove whether this request's own transaction committed.
 */
export class DispatchCommitUncertainError extends DispatchAmbiguousError {
  constructor(
    readonly taskId: string,
    cause: unknown,
    /** The fulfillment job the uncertain transaction would have created. */
    readonly job: { id: string; leaseToken: string } | null = null,
  ) {
    super("Dispatch admission commit outcome is unknown", { cause });
    this.name = "DispatchCommitUncertainError";
  }
}

/** Convert any failure inside `work` into one reviewed refusal reason. */
export async function withDispatchRejection<T>(
  reason: DispatchRejectionReason,
  work: () => T | Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof DispatchRejectedError) throw error;
    throw new DispatchRejectedError(reason);
  }
}

export function dispatchEnvelopeRejection(error: unknown): DispatchRejectedError {
  if (!(error instanceof GatewayEnvelopeError)) return new DispatchRejectedError("validator");
  if (error.failure === "signature") return new DispatchRejectedError("signature");
  if (error.failure === "shape") return new DispatchRejectedError("validator");
  return new DispatchRejectedError("envelope_lifetime");
}

type StatusFailure =
  | { status: 400 | 401; error: "dispatch_status_rejected"; reason: "validator" | "envelope_lifetime" | "signature" }
  | { status: 404; error: "dispatch_status_unavailable"; reason: "outcome_policy" }
  | { status: 409; error: "dispatch_status_unavailable"; reason: "dispatch_conflict" }
  | { status: 503; error: "dispatch_status_unavailable"; reason: "unavailable" | "admission_in_progress" };

/**
 * Status-query failures. Only `noClaim()` uses `reason: "outcome_policy"`,
 * the gateway's sole signal that the provider proved it holds no claim for
 * the order; every other failure leaves the dispatch unknown.
 */
export class DispatchStatusError extends Error {
  private constructor(private readonly failure: StatusFailure) {
    super(`Dispatch status ${failure.reason}`);
    this.name = "DispatchStatusError";
  }

  get status(): StatusFailure["status"] {
    return this.failure.status;
  }

  get reason(): StatusFailure["reason"] {
    return this.failure.reason;
  }

  body(): { error: string; reason: string } {
    return { error: this.failure.error, reason: this.failure.reason };
  }

  static rejected(error: unknown): DispatchStatusError {
    const failure = error instanceof GatewayEnvelopeError ? error.failure : "shape";
    if (failure === "signature") {
      return new DispatchStatusError({ status: 401, error: "dispatch_status_rejected", reason: "signature" });
    }
    return new DispatchStatusError({
      status: 400, error: "dispatch_status_rejected",
      reason: failure === "shape" ? "validator" : "envelope_lifetime",
    });
  }

  static unavailable(reason: "unavailable" | "admission_in_progress" = "unavailable"): DispatchStatusError {
    return new DispatchStatusError({ status: 503, error: "dispatch_status_unavailable", reason });
  }

  static conflict(): DispatchStatusError {
    return new DispatchStatusError({ status: 409, error: "dispatch_status_unavailable", reason: "dispatch_conflict" });
  }

  /** Only after a verified, fresh query found no claim and no admission in flight. */
  static noClaim(): DispatchStatusError {
    return new DispatchStatusError({ status: 404, error: "dispatch_status_unavailable", reason: "outcome_policy" });
  }
}
