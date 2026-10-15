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
 * fails it as never started. After the start, a call that stopped waiting
 * for its answer may still have acted, so it is ambiguous, never a failure.
 */

/** SQLSTATEs of a database that could not answer: connection, rollback, resources, lock, operator, system. */
const INFRASTRUCTURE_CODES = /^(?:08|25P03|40|53|55P03|57|58)/;
/** System error codes (ECONNRESET, EAI_AGAIN, ...). */
const SYSTEM_ERROR_CODE = /^E(?:AI_)?[A-Z]+$/;
/** The fetch client's own connection failures, which fetch reports as its error's cause. */
const FETCH_TRANSPORT_CODE = /^UND_ERR_(?:SOCKET|CLOSED|DESTROYED|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT)$/;
/** node-postgres's own errors, which carry no code: its query timeout fires before the server's. */
const INFRASTRUCTURE_MESSAGES = new RegExp([
  "connection terminated", "connection error", "timeout exceeded when trying to connect", "query read timeout",
  "not queryable", "cannot use a pool after calling end", "ECONN", "ETIMEDOUT", "EPIPE",
].join("|"), "i");
/** Transport failures and the outbound boundary's refusals, by the names their libraries give them. */
const TRANSIENT_NAMES = new Set([
  "AbortError", "TimeoutError", "OutboundAbortedError", "OutboundCircuitOpenError", "HttpRequestError",
  "APIConnectionError", "APIConnectionTimeoutError", "InternalServerError", "RateLimitError",
]);
/** The same failures by message, for errors that carry no distinguishing name. */
const TRANSIENT_MESSAGES = new RegExp([
  "^fetch failed$", "^outbound circuit open", "^outbound concurrency budget exhausted",
  "RPC observation failed", "timed out", "\\btimeout\\b",
].join("|"), "i");
/** A certificate or TLS handshake the remote or this host's trust store could not complete: provider-side. */
const TLS_ERROR_CODE =
  /^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_(?:GET|VERIFY|DECRYPT)_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|HOSTNAME_MISMATCH$)/;
/** A call that stopped waiting for its answer (a timeout or an abort), by name. */
const UNANSWERED_NAMES = new Set(["AbortError", "TimeoutError", "OutboundAbortedError"]);
/** The same by message, for timeouts that carry no distinguishing name. */
const UNANSWERED_MESSAGES = /timed out|\btimeout\b/i;
/** How deep a cause chain is followed. */
const MAX_CAUSE_DEPTH = 4;

interface ErrorRecord {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  status?: unknown;
  cause?: unknown;
  errors?: unknown;
}

/**
 * A database, connection or handler-resolution failure says nothing about
 * the service's answer. Before the service was called the order stays
 * resumable; after, it is ambiguous.
 */
export function isInfrastructureFailure(error: unknown): boolean {
  if (error instanceof RetainedHandlerUnavailableError) return true;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && (
    INFRASTRUCTURE_CODES.test(code) || SYSTEM_ERROR_CODE.test(code) || FETCH_TRANSPORT_CODE.test(code)
  )) return true;
  return error instanceof Error && INFRASTRUCTURE_MESSAGES.test(error.message);
}

/** Whether `test` holds for the error, one of its aggregated errors, or its bounded cause chain. */
function somewhereIn(error: unknown, test: (record: ErrorRecord) => boolean | null, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > MAX_CAUSE_DEPTH) return false;
  const record = error as ErrorRecord;
  const verdict = test(record);
  if (verdict !== null) return verdict;
  if (Array.isArray(record.errors) && record.errors.some((inner) => somewhereIn(inner, test, depth + 1))) return true;
  return somewhereIn(record.cause, test, depth + 1);
}

function undecidedBeforeStart(record: ErrorRecord): boolean | null {
  if (isInfrastructureFailure(record)) return true;
  // A supplier's explicit rejection is definite; its temporary, ambiguous
  // or provider-side (credential) condition is not the order's to bear.
  const kind = classifySupplierError(record)?.kind;
  if (kind) return kind !== "supplier_rejected";
  if (typeof record.name === "string" && TRANSIENT_NAMES.has(record.name)) return true;
  if (typeof record.code === "string" && TLS_ERROR_CODE.test(record.code)) return true;
  if (typeof record.status === "number" && (record.status === 408 || record.status === 429 || record.status >= 500)) {
    return true;
  }
  if (typeof record.message === "string" && TRANSIENT_MESSAGES.test(record.message)) return true;
  return null;
}

/**
 * A fault before the order started that decides nothing about it:
 * infrastructure, a transient, ambiguous or provider-side supplier
 * condition, a timeout, a certificate or TLS failure, or an
 * outbound-boundary refusal, raised directly or as a cause. Anything else,
 * a stale owner or a supplier's explicit rejection among them, is a
 * definite refusal.
 */
export function isUndecidedPreStartFault(error: unknown): boolean {
  return somewhereIn(error, undecidedBeforeStart);
}

function ambiguousAfterStart(record: ErrorRecord): boolean | null {
  if (isInfrastructureFailure(record)) return true;
  // Otherwise a supplier client's own classification of its error decides it.
  const kind = classifySupplierError(record)?.kind;
  if (kind) return kind === "ambiguous";
  if (typeof record.name === "string" && UNANSWERED_NAMES.has(record.name)) return true;
  if (typeof record.message === "string" && UNANSWERED_MESSAGES.test(record.message)) return true;
  return null;
}

/**
 * A failure of a started order whose outcome is unknown: a supplier's
 * ambiguous outcome, an infrastructure failure, or a call that stopped
 * waiting for its answer (a timeout or an abort) after it may have reached
 * the supplier, raised directly or as a cause. Such an order is parked for
 * reconciliation; only any other failure is signed as definite.
 */
export function isAmbiguousAfterStart(error: unknown): boolean {
  return somewhereIn(error, ambiguousAfterStart);
}
