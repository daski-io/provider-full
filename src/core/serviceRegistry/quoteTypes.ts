import type { Hex } from "viem";

/**
 * Public, schema- or service-authored detail for a declined quote, in the
 * gateway's field-error format. It names fields and rules; it never echoes
 * submitted values.
 */
export interface QuoteFieldError {
  path: string;
  rule: string;
  message: string;
  allowedValues?: string[];
}

export interface RequestReadinessContext {
  /** Lowercase payer the gateway bound the quote to, or null when unbound. */
  payer: Hex | null;
  /** Aborted when core's readiness time budget elapses. */
  signal: AbortSignal;
}

/**
 * Read-only verdict on mutable product prerequisites for one request. It can
 * refuse with reviewed field errors but never changes the quoted amount. A
 * service that needs an identified payer refuses an unbound (null) payer.
 */
export type RequestReadiness =
  | { ready: true }
  | { ready: false; fieldErrors: QuoteFieldError[] };

/** Context-specific intake requirements; never quotes or starts work. */
export interface IntakeDetail {
  requiredFields: Record<string, unknown>;
  selectorsRequired: string[];
  fieldErrors: QuoteFieldError[];
  supported: boolean | null;
  normalizedSelectors: Record<string, unknown>;
}
