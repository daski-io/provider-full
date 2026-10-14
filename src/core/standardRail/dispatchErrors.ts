/**
 * Reviewed reason codes for a definite dispatch refusal. They are public
 * diagnostics, so they never carry input, signed envelopes or dependency
 * errors. A refusal is only ever returned before any admission.
 */
export const DISPATCH_REJECTION_REASONS = [
  "quote_window", "envelope_lifetime", "signature", "outcome_policy",
  "self_purchase", "price", "validator", "evidence",
] as const;

export type DispatchRejectionReason = typeof DISPATCH_REJECTION_REASONS[number];

export class DispatchRejectedError extends Error {
  constructor(readonly reason: DispatchRejectionReason, message: string = reason) {
    super(message);
    this.name = "DispatchRejectedError";
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
