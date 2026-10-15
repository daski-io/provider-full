import { logWarn } from "../logger.js";

// Every outbound API call that fails is reported here: supplier and email
// HTTP through boundedFetch, the gateway registration fetch, chain RPC
// through the failover wrapper and the wallet transport, and the LLM SDK.
// The reporter classifies the failure, keeps only the remote's short error
// code (never response text, which can echo protected data), throttles
// repeats, writes the structured log line, and fans out to listeners. The
// platform-log listener lives in outboundFailureLog.ts so this module stays
// free of database imports and every transport can depend on it.

export type OutboundFailureReason =
  | "http_error"
  /** The endpoint answered with a JSON-RPC error object, e.g. -32603. */
  | "rpc_error"
  | "timeout"
  | "network"
  | "circuit_open"
  | "concurrency"
  | "response_too_large"
  | "content_type"
  | "target_rejected"
  | "redirect";

export interface OutboundFailure {
  /** Remote host, e.g. api.supplier.example. */
  target: string;
  /** Method plus templated path, an RPC method, or an SDK operation. */
  operation: string;
  reason: OutboundFailureReason;
  status: number | null;
  /** The remote's short error code when it sent one; never free text. */
  code: string | number | null;
  /** Node/undici network code such as ENOTFOUND, when known. */
  networkCode: string | null;
}

export interface OutboundFailureReport extends OutboundFailure {
  /** Identical failures swallowed by the throttle since the last report. */
  suppressed: number;
}

type Listener = (report: OutboundFailureReport) => void | Promise<void>;

const listeners = new Set<Listener>();
const THROTTLE_MS = 60_000;
const MAX_TRACKED_KEYS = 1_000;
const OPERATION_MAX_CHARS = 120;
const CODE_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
/**
 * A path segment kept as written: lowercase words joined by `-` or `_`, or
 * a version such as `v2`. Anything else (digits, capitals, dots, `@` or
 * percent-encoding) may name a customer, account, domain or document.
 */
const PATH_WORD = /^(?:[a-z]+(?:[-_][a-z]+)*|v\d{1,3})$/;
const PATH_WORD_MAX_CHARS = 32;
const recent = new Map<string, { emittedAt: number; suppressed: number }>();

export function onOutboundFailure(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetOutboundFailureThrottle(): void {
  recent.clear();
}

export function reportOutboundFailure(failure: OutboundFailure, now = Date.now()): void {
  const key = [
    failure.target,
    failure.operation,
    failure.reason,
    failure.status ?? "",
    failure.code ?? "",
    failure.networkCode ?? "",
  ].join("|");
  const entry = recent.get(key);
  if (entry && now - entry.emittedAt < THROTTLE_MS) {
    entry.suppressed++;
    return;
  }
  if (recent.size >= MAX_TRACKED_KEYS) recent.clear();
  const report: OutboundFailureReport = { ...failure, suppressed: entry?.suppressed ?? 0 };
  recent.set(key, { emittedAt: now, suppressed: 0 });
  logWarn("outbound request failed", { ...report });
  for (const listener of listeners) {
    Promise.resolve()
      .then(() => listener(report))
      .catch(() => undefined);
  }
}

export function describeOutboundFailure(failure: OutboundFailure): string {
  if (failure.reason === "http_error" && failure.status !== null) {
    return `HTTP ${failure.status}${failure.code === null ? "" : ` (code ${failure.code})`}`;
  }
  if (failure.reason === "rpc_error") {
    return `JSON-RPC error${failure.code === null ? "" : ` ${failure.code}`}`;
  }
  return failure.reason
    + (failure.networkCode ? ` (${failure.networkCode})` : "")
    + (failure.status === null ? "" : ` HTTP ${failure.status}`);
}

/// `POST /orders/:id` — every segment that is not a plain lowercase word or
/// a version becomes `:id` and the query is dropped, so the label never
/// carries an order, account, domain, e-mail or document id.
export function outboundOperation(method: string | undefined, url: URL): string {
  const path = url.pathname
    .split("/")
    .map((segment) => (
      !segment || (segment.length <= PATH_WORD_MAX_CHARS && PATH_WORD.test(segment)) ? segment : ":id"
    ))
    .join("/");
  return `${(method ?? "GET").toUpperCase()} ${path || "/"}`.slice(0, OPERATION_MAX_CHARS);
}

function codeToken(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && CODE_TOKEN.test(value)) return value;
  return null;
}

/// The remote's error code from a JSON error body: an `ErrorCode`, a short
/// `error` token, the Daski gateway's `error.code`, or a plain `code`. Text
/// fields are never read.
export function outboundErrorCode(contentType: string | null, body: Buffer | string): string | number | null {
  if (!contentType || !contentType.toLowerCase().includes("json")) return null;
  if (body.length > 65_536) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof body === "string" ? body : body.toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const nested = record.error && typeof record.error === "object" && !Array.isArray(record.error)
    ? (record.error as Record<string, unknown>).code
    : null;
  return codeToken(record.ErrorCode)
    ?? codeToken(record.error)
    ?? codeToken(nested)
    ?? codeToken(record.code);
}

/// Classify a thrown error from any transport without keeping its message:
/// boundedFetch's own guard errors, fetch/undici failures, SDK errors that
/// carry `status`, and viem RPC errors.
export function outboundFailureFromError(
  error: unknown,
): Pick<OutboundFailure, "reason" | "status" | "code" | "networkCode"> {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const name = typeof record.name === "string" ? record.name : "";
  const message = typeof record.message === "string" ? record.message : "";
  const cause = record.cause && typeof record.cause === "object"
    ? record.cause as Record<string, unknown>
    : null;
  const status = typeof record.status === "number" && Number.isInteger(record.status)
    ? record.status
    : null;
  // A DOMException's numeric `code` is its legacy type number, not the remote's.
  const ownCode = error instanceof DOMException ? null : codeToken(record.code);
  const code = ownCode ?? codeToken(record.type) ?? codeToken(cause?.code);
  const networkCode = typeof cause?.code === "string" && CODE_TOKEN.test(cause.code)
    ? cause.code
    : typeof record.code === "string" && /^E[A-Z0-9_]+$/.test(record.code)
      ? record.code
      : null;

  if (message.startsWith("outbound target rejected") || message.startsWith("outbound target resolved")) {
    return { reason: "target_rejected", status, code, networkCode };
  }
  if (message.startsWith("outbound circuit open")) return { reason: "circuit_open", status, code, networkCode };
  if (message.startsWith("outbound concurrency")) return { reason: "concurrency", status, code, networkCode };
  if (message.startsWith("outbound response exceeds")) {
    return { reason: "response_too_large", status, code, networkCode };
  }
  if (message.startsWith("outbound response content type")) {
    return { reason: "content_type", status, code, networkCode };
  }
  if (message.startsWith("outbound redirects")) return { reason: "redirect", status, code, networkCode };
  if (/timeout|timed out/i.test(name) || /timed out|timeout/i.test(message) || name === "AbortError") {
    return { reason: "timeout", status, code, networkCode };
  }
  if (status !== null) return { reason: "http_error", status, code, networkCode };
  // A numeric JSON-RPC code without an HTTP status: the request reached the
  // node, which answered with an error object (viem's RpcRequestError).
  if (typeof ownCode === "number") return { reason: "rpc_error", status, code, networkCode };
  return { reason: "network", status, code, networkCode };
}

/// JSON-RPC methods viem probes for and falls back from when the node lacks
/// them: prepareTransactionRequest tries eth_fillTransaction once per client
/// before estimating gas and fees itself. A "method not found" answer
/// (-32601) is the expected outcome on most public Base nodes, not an
/// outage, so it is not reported.
const OPTIONAL_RPC_METHODS: ReadonlySet<string> = new Set(["eth_fillTransaction"]);
const RPC_METHOD_NOT_FOUND = -32601;

export function isExpectedOutboundFailure(
  operation: string,
  failure: Pick<OutboundFailure, "code">,
): boolean {
  return OPTIONAL_RPC_METHODS.has(operation) && failure.code === RPC_METHOD_NOT_FOUND;
}

/// Run one outbound call, reporting a failure before rethrowing it.
export async function observeOutbound<T>(
  target: string,
  operation: string,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const failure = outboundFailureFromError(error);
    if (!isExpectedOutboundFailure(operation, failure)) {
      reportOutboundFailure({ target, operation, ...failure });
    }
    throw error;
  }
}
