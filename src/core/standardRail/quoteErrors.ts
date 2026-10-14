import type { QuoteFieldError } from "../serviceRegistry/types.js";
import { fitFieldErrors } from "./quoteFieldErrors.js";
import { GatewayEnvelopeError } from "./gatewayEnvelope.js";

/**
 * Reviewed quote/intake refusal vocabulary. A 4xx means the gateway declines
 * the request (PROVIDER_QUOTE_REJECTED, with fieldErrors when present); a
 * 503 means the provider cannot quote right now (PROVIDER_QUOTE_UNAVAILABLE).
 */
export type QuoteRefusalReason =
  | "envelope"
  | "envelope_lifetime"
  | "signature"
  | "outcome_policy"
  | "request_invalid"
  | "price"
  | "capacity"
  | "service_unavailable"
  | "readiness_unavailable"
  | "unavailable";

export class QuoteRefusedError extends Error {
  readonly fieldErrors: QuoteFieldError[];

  constructor(
    readonly status: 400 | 401 | 409 | 422 | 503,
    readonly reason: QuoteRefusalReason,
    fieldErrors: QuoteFieldError[] = [],
  ) {
    super(`Provider quote refused: ${reason}`);
    this.name = "QuoteRefusedError";
    this.fieldErrors = fieldErrors;
  }

  body(): Record<string, unknown> {
    const base = { error: this.status === 503 ? "quote_unavailable" : "quote_rejected", reason: this.reason };
    if (this.fieldErrors.length === 0) return base;
    return { ...base, fieldErrors: fitFieldErrors(base, this.fieldErrors) };
  }
}

export function requestInvalid(fieldErrors: QuoteFieldError[]): QuoteRefusedError {
  return new QuoteRefusedError(422, "request_invalid", fieldErrors);
}

export function quoteEnvelopeRefusal(error: unknown): QuoteRefusedError {
  if (!(error instanceof GatewayEnvelopeError)) return new QuoteRefusedError(400, "envelope");
  if (error.failure === "signature") return new QuoteRefusedError(401, "signature");
  if (error.failure === "lifetime") return new QuoteRefusedError(400, "envelope_lifetime");
  return new QuoteRefusedError(400, "envelope");
}
