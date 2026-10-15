import { config } from "../config.js";
import {
  outboundErrorCode,
  outboundFailureFromError,
  outboundOperation,
  reportOutboundFailure,
} from "../observability/outboundFailures.js";
import { validatePublicUrl } from "./ssrf.js";
import { pinnedHttpRequest } from "./pinnedHttp.js";

export interface OutboundPolicy {
  timeoutMs?: number;
  maxResponseBytes?: number;
  allowedContentTypes?: string[];
  publicTarget?: {
    allowHttp?: boolean;
    allowQueryOrFragment?: boolean;
  };
}

export interface BoundedResponse {
  status: number;
  statusText: string;
  ok: boolean;
  headers: Headers;
  body: Buffer;
  text(): string;
  json<T = unknown>(): T;
}

/** The origin's circuit is open until `retryAt` (epoch milliseconds); nothing was sent. */
export class OutboundCircuitOpenError extends Error {
  constructor(origin: string, readonly retryAt: number) {
    super(`outbound circuit open for ${origin}`);
    this.name = "OutboundCircuitOpenError";
  }
}

/** The caller's signal aborted the request; the origin did not fail. */
export class OutboundAbortedError extends Error {
  constructor(cause: unknown) {
    super("outbound request was aborted by its caller", { cause });
    this.name = "OutboundAbortedError";
  }
}

interface OriginState {
  active: number;
  failures: number;
  openUntil: number;
}

const origins = new Map<string, OriginState>();

/**
 * Bounded outbound HTTP. The caller's `init.signal` and the helper's own
 * timeout both bound the whole exchange, response body included, on the
 * fetch and the pinned paths alike. An abort only stops this process from
 * waiting: it never proves the remote action did not happen, so a mutating
 * caller must reconcile, not retry blindly. A caller abort is not counted
 * against the origin's circuit, unless it was the caller's own deadline
 * (`AbortSignal.timeout`), which the origin missed. An error reply keeps
 * its HTTP status even when its body is empty or not the expected media
 * type; content-type admission applies to successful bodies only. Every
 * failure (a guard refusal, a transport error, a missed deadline or a
 * non-2xx reply) is reported to the outbound-failure log, redacted, before
 * it is thrown or returned.
 */
export async function boundedFetch(
  input: string | URL,
  init: RequestInit = {},
  policy: OutboundPolicy = {},
): Promise<BoundedResponse> {
  const url = new URL(input);
  const target = url.hostname;
  const operation = outboundOperation(init.method, url);
  const failed = (error: Error): Error => {
    reportOutboundFailure({ target, operation, ...outboundFailureFromError(error) });
    return error;
  };
  let pinnedIp: string | null = null;
  if (policy.publicTarget) {
    const resolved = await validatePublicUrl(url.toString(), {
      allowHttp: policy.publicTarget.allowHttp,
      allowQueryOrFragment: policy.publicTarget.allowQueryOrFragment,
    });
    if (!resolved.ok) {
      // The resolver's own error stays the cause, so a transient lookup
      // fault (EAI_AGAIN) is told apart from a refused target.
      throw failed(new Error(
        `outbound target rejected: ${resolved.reason}`,
        resolved.cause === undefined ? undefined : { cause: resolved.cause },
      ));
    }
    pinnedIp = resolved.addresses[0] ?? null;
    if (!pinnedIp) throw failed(new Error("outbound target resolved without a usable address"));
  }
  const caller = init.signal ?? undefined;
  if (caller?.aborted) throw new OutboundAbortedError(caller.reason);
  const state = origins.get(url.origin) ?? { active: 0, failures: 0, openUntil: 0 };
  origins.set(url.origin, state);
  if (state.openUntil > Date.now()) {
    throw failed(new OutboundCircuitOpenError(url.origin, state.openUntil));
  }
  if (state.active >= config.OUTBOUND_MAX_CONCURRENCY_PER_ORIGIN) {
    throw failed(new Error(`outbound concurrency budget exhausted for ${url.origin}`));
  }
  state.active++;
  try {
    const timeoutMs = policy.timeoutMs ?? config.OUTBOUND_TOTAL_TIMEOUT_MS;
    const maxBytes = policy.maxResponseBytes ?? config.OUTBOUND_MAX_RESPONSE_BYTES;
    const response = pinnedIp
      ? await pinnedHttpRequest({
          url,
          pinnedIp,
          method: init.method,
          headers: init.headers,
          body: init.body,
          timeoutMs,
          maxResponseBytes: maxBytes,
          signal: caller,
        })
      : await fetchResponse(url, init, timeoutMs, maxBytes);
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`outbound response exceeds ${maxBytes} bytes`);
    }
    const contentType = (response.headers.get("content-type") ?? "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    const expectsBody = String(init.method ?? "GET").toUpperCase() !== "HEAD"
      && response.status !== 204;
    if (response.ok && policy.allowedContentTypes?.length && expectsBody
      && (!contentType || !policy.allowedContentTypes.includes(contentType))) {
      throw new Error(`outbound response content type '${contentType || "missing"}' is not allowed`);
    }
    const body = response.body;
    if (response.status >= 500) recordFailure(state);
    else state.failures = 0;
    if (!response.ok) {
      reportOutboundFailure({
        target,
        operation,
        reason: "http_error",
        status: response.status,
        code: outboundErrorCode(contentType, body),
        networkCode: null,
      });
    }
    return {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      headers: response.headers,
      body,
      text: () => body.toString("utf8"),
      json: <T>() => JSON.parse(body.toString("utf8")) as T,
    };
  } catch (error) {
    if (caller?.aborted) {
      // The caller's own deadline (AbortSignal.timeout) expiring means the
      // origin did not answer in time: that counts and is reported. Any
      // other caller abort is the caller's decision, not the origin's fault.
      if (isDeadline(caller.reason)) {
        recordFailure(state);
        reportOutboundFailure({ target, operation, ...outboundFailureFromError(caller.reason) });
      }
      throw new OutboundAbortedError(caller.reason);
    }
    recordFailure(state);
    throw failed(error instanceof Error ? error : new Error(String(error)));
  } finally {
    state.active--;
  }
}

async function fetchResponse(
  url: URL,
  init: RequestInit,
  timeoutMs: number,
  maxBytes: number,
): Promise<{ status: number; statusText: string; ok: boolean; headers: Headers; body: Buffer }> {
  // One signal for the request and the whole body read: the caller's
  // cancellation, composed with the helper's own deadline.
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const response = await fetch(url, { ...init, redirect: "error", signal });
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    const cancel = () => void reader.cancel(signal.reason).catch(() => undefined);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (signal.aborted) throw signal.reason ?? new Error("outbound request was aborted");
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new Error(`outbound response exceeds ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
  return {
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    headers: response.headers,
    body: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size),
  };
}

const isDeadline = (reason: unknown): boolean =>
  typeof reason === "object" && reason !== null && (reason as { name?: unknown }).name === "TimeoutError";

function recordFailure(state: OriginState): void {
  state.failures++;
  if (state.failures >= config.OUTBOUND_CIRCUIT_FAILURE_THRESHOLD) {
    state.openUntil = Date.now() + config.OUTBOUND_CIRCUIT_OPEN_MS;
    state.failures = 0;
  }
}
