import { RetainedHandlerUnavailableError } from "../serviceRegistry/retainedHandlers.js";
import { classifySupplierError } from "../suppliers/errorClassifier.js";

/*
 * How a failure of admitted paid work is read. An infrastructure failure
 * says nothing about the service's answer at any point. Before the order
 * started, a transient fault says nothing about the order either (a
 * dependency that could not answer, a timeout, the outbound boundary's own
 * refusal, a supplier's temporary, ambiguous or provider-side condition),
 * so it never becomes a signed failure of a funded order: the order stays
 * unstarted for its fulfillment job to resume, and only a definite refusal
 * fails it as never started.
 */

/** SQLSTATEs of a database that could not answer: connection, rollback, resources, lock, operator, system. */
const INFRASTRUCTURE_CODES = /^(?:08|25P03|40|53|55P03|57|58)/;
/** System error codes (ECONNRESET, EAI_AGAIN, ...). */
const SYSTEM_ERROR_CODE = /^E(?:AI_)?[A-Z]+$/;
/** node-postgres's own errors, which carry no code: its query timeout fires before the server's. */
const INFRASTRUCTURE_MESSAGES = new RegExp([
  "connection terminated", "connection error", "timeout exceeded when trying to connect", "query read timeout",
  "not queryable", "cannot use a pool after calling end", "ECONN", "ETIMEDOUT", "EPIPE",
].join("|"), "i");
/** Transport failures and the outbound boundary's refusals, by the names their libraries give them. */
const TRANSIENT_NAMES = new Set([
  "AbortError", "TimeoutError", "OutboundCircuitOpenError", "HttpRequestError",
  "APIConnectionError", "APIConnectionTimeoutError", "InternalServerError", "RateLimitError",
]);
/** The same failures by message, for errors that carry no distinguishing name. */
const TRANSIENT_MESSAGES = new RegExp([
  "^fetch failed$", "^outbound circuit open", "^outbound concurrency budget exhausted",
  "RPC observation failed", "timed out", "\\btimeout\\b",
].join("|"), "i");
/** How deep a cause chain is followed. */
const MAX_CAUSE_DEPTH = 4;

/**
 * A database, connection or handler-resolution failure says nothing about
 * the service's answer. Before the service was called the order stays
 * resumable; after, it is ambiguous.
 */
export function isInfrastructureFailure(error: unknown): boolean {
  if (error instanceof RetainedHandlerUnavailableError) return true;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && (INFRASTRUCTURE_CODES.test(code) || SYSTEM_ERROR_CODE.test(code))) return true;
  return error instanceof Error && INFRASTRUCTURE_MESSAGES.test(error.message);
}

function undecidedAt(error: unknown, depth: number): boolean {
  if (!error || typeof error !== "object" || depth > MAX_CAUSE_DEPTH) return false;
  if (isInfrastructureFailure(error)) return true;
  // A supplier's explicit rejection is definite; its temporary, ambiguous
  // or provider-side (credential) condition is not the order's to bear.
  const kind = classifySupplierError(error)?.kind;
  if (kind) return kind !== "supplier_rejected";
  const record = error as { name?: unknown; message?: unknown; status?: unknown; cause?: unknown; errors?: unknown };
  if (typeof record.name === "string" && TRANSIENT_NAMES.has(record.name)) return true;
  if (typeof record.status === "number" && (record.status === 408 || record.status === 429 || record.status >= 500)) {
    return true;
  }
  if (typeof record.message === "string" && TRANSIENT_MESSAGES.test(record.message)) return true;
  if (Array.isArray(record.errors) && record.errors.some((inner) => undecidedAt(inner, depth + 1))) return true;
  return undecidedAt(record.cause, depth + 1);
}

/**
 * A fault before the order started that decides nothing about it:
 * infrastructure, a transient, ambiguous or provider-side supplier
 * condition, a timeout or an outbound-boundary refusal, raised directly or
 * as a cause. Anything else, a stale owner or a supplier's explicit
 * rejection among them, is a definite refusal.
 */
export function isUndecidedPreStartFault(error: unknown): boolean {
  return undecidedAt(error, 0);
}
