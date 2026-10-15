import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// C05: every failed outbound call is reported redacted (class, operation,
// short remote code and timing only), throttled to one report a minute per
// identical failure, including JSON-RPC error answers and RPC block tags.

const h = vi.hoisted(() => ({
  logWarn: vi.fn(),
  emitEvent: vi.fn(),
  validatePublicUrl: vi.fn(),
  pinnedHttpRequest: vi.fn(),
}));

vi.mock("../src/core/config.js", () => ({
  config: {
    OUTBOUND_MAX_CONCURRENCY_PER_ORIGIN: 4,
    OUTBOUND_TOTAL_TIMEOUT_MS: 1_000,
    OUTBOUND_MAX_RESPONSE_BYTES: 4_096,
    OUTBOUND_CIRCUIT_FAILURE_THRESHOLD: 2,
    OUTBOUND_CIRCUIT_OPEN_MS: 60_000,
  },
}));
vi.mock("../src/core/logger.js", () => ({
  logWarn: h.logWarn,
  logError: vi.fn(),
  logInfo: vi.fn(),
}));
vi.mock("../src/core/events/emitter.js", () => ({ emitEvent: h.emitEvent }));
vi.mock("../src/core/security/ssrf.js", () => ({ validatePublicUrl: h.validatePublicUrl }));
vi.mock("../src/core/security/pinnedHttp.js", () => ({ pinnedHttpRequest: h.pinnedHttpRequest }));

import {
  describeOutboundFailure,
  observeOutbound,
  onOutboundFailure,
  outboundErrorCode,
  outboundFailureFromError,
  outboundOperation,
  reportOutboundFailure,
  resetOutboundFailureThrottle,
  type OutboundFailureReport,
} from "../src/core/observability/outboundFailures.js";
import {
  installOutboundFailureLog,
  outboundFailureEvent,
} from "../src/core/observability/outboundFailureLog.js";
import { boundedFetch, OutboundAbortedError } from "../src/core/security/outboundHttp.js";
import { withRpcFailover } from "../src/core/chain/rpcFailover.js";

const reports: OutboundFailureReport[] = [];
let unsubscribe: (() => void) | null = null;

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  for (const mock of Object.values(h)) mock.mockReset();
  h.emitEvent.mockResolvedValue(undefined);
  resetOutboundFailureThrottle();
  reports.length = 0;
  unsubscribe = onOutboundFailure((report) => {
    reports.push(report);
  });
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  vi.unstubAllGlobals();
});

describe("outbound failure classification", () => {
  it("templates identifiers out of the operation and drops the query", () => {
    expect(outboundOperation("get", new URL("https://api.example/orders/8b8ca6bb-859a-48c4-9e28-196a83441f59/items")))
      .toBe("GET /orders/:id/items");
    expect(outboundOperation("GET", new URL("https://api.example/catalog/schemas?account_id=c&plan_id=m")))
      .toBe("GET /catalog/schemas");
    expect(outboundOperation("DELETE", new URL("https://api.example/documents/1234567")))
      .toBe("DELETE /documents/:id");
    expect(outboundOperation(undefined, new URL("https://api.example/"))).toBe("GET /");
  });

  it("keeps only plain words and versions of a path, so no domain, e-mail or account id is logged", () => {
    expect(outboundOperation("POST", new URL("https://api.example/v1/domains/acme-secret.com/renew")))
      .toBe("POST /v1/domains/:id/renew");
    expect(outboundOperation("GET", new URL("https://api.example/customers/jane%40example.com"))).toBe("GET /customers/:id");
    expect(outboundOperation("GET", new URL("https://api.example/customers/jane@example.com/orders")))
      .toBe("GET /customers/:id/orders");
    expect(outboundOperation("DELETE", new URL("https://api.example/v2/customers/synth_Rk7QmXp2LvT9")))
      .toBe("DELETE /v2/customers/:id");
    expect(outboundOperation("GET", new URL("https://api.example/accounts/ACME/plans/Gold")))
      .toBe("GET /accounts/:id/plans/:id");
    expect(outboundOperation("GET", new URL("https://api.example/report_jobs/batch-status/")))
      .toBe("GET /report_jobs/batch-status/");
    expect(outboundOperation("POST", new URL("https://api.example/v1/chat/completions"))).toBe("POST /v1/chat/completions");
    expect(outboundOperation("GET", new URL(`https://api.example/${"a".repeat(33)}`))).toBe("GET /:id");
  });

  it("keeps only the remote's short error code, never its text", () => {
    expect(outboundErrorCode("application/json", JSON.stringify({ ErrorCode: 300, Message: "Invalid recipient address" }))).toBe(300);
    expect(outboundErrorCode("application/json; charset=utf-8", JSON.stringify({ error: "DEFAULT", message: "Default error" }))).toBe("DEFAULT");
    expect(outboundErrorCode("application/json", JSON.stringify({ error: { code: "LISTING_MISMATCH", message: "x" } }))).toBe("LISTING_MISMATCH");
    expect(outboundErrorCode("application/json", JSON.stringify({ success: false, result: "the plan id is not offered" }))).toBeNull();
    expect(outboundErrorCode("text/html", "<html>bad gateway</html>")).toBeNull();
    expect(outboundErrorCode("application/json", "{not json")).toBeNull();
    expect(outboundErrorCode("application/json", JSON.stringify({ error: "a sentence with spaces is not a code" }))).toBeNull();
  });

  it("classifies thrown transport and guard errors without keeping their messages", () => {
    expect(outboundFailureFromError(new Error("outbound circuit open for https://x"))).toMatchObject({ reason: "circuit_open" });
    expect(outboundFailureFromError(new Error("outbound concurrency budget exhausted for https://x"))).toMatchObject({ reason: "concurrency" });
    expect(outboundFailureFromError(new Error("outbound response exceeds 10 bytes"))).toMatchObject({ reason: "response_too_large" });
    expect(outboundFailureFromError(new Error("outbound response content type 'text/html' is not allowed"))).toMatchObject({ reason: "content_type" });
    expect(outboundFailureFromError(new Error("outbound target rejected: private address"))).toMatchObject({ reason: "target_rejected" });
    expect(outboundFailureFromError(new Error("outbound request timed out after 1000ms"))).toMatchObject({ reason: "timeout" });
    // A DOMException's numeric code is its legacy type number, not a remote's code.
    expect(outboundFailureFromError(new DOMException("The operation was aborted due to timeout", "TimeoutError")))
      .toMatchObject({ reason: "timeout", code: null });
    const fetchFailure = new TypeError("fetch failed");
    (fetchFailure as { cause?: unknown }).cause = { code: "ENOTFOUND" };
    expect(outboundFailureFromError(fetchFailure)).toMatchObject({ reason: "network", networkCode: "ENOTFOUND" });
    expect(outboundFailureFromError({ name: "HttpRequestError", status: 503, message: "Service unavailable" }))
      .toMatchObject({ reason: "http_error", status: 503 });
    expect(outboundFailureFromError({ name: "RateLimitError", status: 429, code: "rate_limit_exceeded", message: "slow down" }))
      .toMatchObject({ reason: "http_error", status: 429, code: "rate_limit_exceeded" });
  });

  // A node can answer eth_getTransactionCount with a JSON-RPC -32603 body
  // on HTTP 200; that is an RPC error answer, not a network failure.
  it("classifies a JSON-RPC error answer as rpc_error, keeping its code", () => {
    const internal = { name: "RpcRequestError", code: -32603, message: "RPC Request failed. Details: Internal error" };
    expect(outboundFailureFromError(internal)).toEqual({ reason: "rpc_error", status: null, code: -32603, networkCode: null });
    expect(outboundFailureFromError({ name: "RpcRequestError", code: 3, message: "execution reverted" }))
      .toMatchObject({ reason: "rpc_error", code: 3 });
    expect(describeOutboundFailure({ ...outboundFailureFromError(internal), target: "rpc", operation: "eth_call" }))
      .toBe("JSON-RPC error -32603");
    expect(describeOutboundFailure({ target: "rpc", operation: "eth_call", reason: "rpc_error", status: null, code: null, networkCode: null }))
      .toBe("JSON-RPC error");
    // A string code is still a transport failure, never a JSON-RPC answer.
    expect(outboundFailureFromError({ name: "Error", code: "ECONNRESET", message: "socket hang up" }))
      .toMatchObject({ reason: "network", networkCode: "ECONNRESET" });
  });
});

describe("outbound failure reporting", () => {
  const failure = {
    target: "api.example",
    operation: "GET /thing",
    reason: "http_error" as const,
    status: 503,
    code: null,
    networkCode: null,
  };

  it("logs and fans out the first report, then throttles identical failures for a minute", async () => {
    reportOutboundFailure(failure, 1_000);
    reportOutboundFailure(failure, 2_000);
    reportOutboundFailure(failure, 3_000);
    await settle();

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ ...failure, suppressed: 0 });
    expect(h.logWarn).toHaveBeenCalledTimes(1);
    expect(h.logWarn).toHaveBeenCalledWith("outbound request failed", expect.objectContaining({ target: "api.example", status: 503 }));

    reportOutboundFailure(failure, 62_000);
    await settle();
    expect(reports).toHaveLength(2);
    expect(reports[1]!.suppressed).toBe(2);

    reportOutboundFailure({ ...failure, status: 502 }, 62_500);
    await settle();
    expect(reports).toHaveLength(3);
  });

  it("survives a listener that throws", async () => {
    const remove = onOutboundFailure(() => {
      throw new Error("listener failure");
    });
    reportOutboundFailure(failure, 5_000);
    await settle();
    remove();

    expect(reports).toHaveLength(1);
  });

  it("observeOutbound reports and rethrows", async () => {
    await expect(observeOutbound("api.openai.com", "chat.completions", async () => {
      throw Object.assign(new Error("boom"), { status: 429, code: "rate_limit_exceeded" });
    })).rejects.toThrow("boom");
    await settle();

    expect(reports[0]).toMatchObject({
      target: "api.openai.com",
      operation: "chat.completions",
      reason: "http_error",
      status: 429,
      code: "rate_limit_exceeded",
    });
  });

  // viem probes eth_fillTransaction once per client before estimating gas
  // itself; many nodes answer -32601. That answer is the expected outcome,
  // not an outbound failure.
  it("does not report the optional eth_fillTransaction probe a node lacks", async () => {
    const notFound = Object.assign(
      new Error('The method "eth_fillTransaction" does not exist / is not available.'),
      { name: "MethodNotFoundRpcError", code: -32601 },
    );
    await expect(observeOutbound("rpc.node.example", "eth_fillTransaction", async () => {
      throw notFound;
    })).rejects.toBe(notFound);
    // Any other method missing, or any other failure of the probe, still reports.
    await expect(observeOutbound("rpc.node.example", "eth_estimateGas", async () => {
      throw notFound;
    })).rejects.toBe(notFound);
    await expect(observeOutbound("rpc.node.example", "eth_fillTransaction", async () => {
      throw Object.assign(new Error("rate limited"), { name: "HttpRequestError", status: 429 });
    })).rejects.toThrow("rate limited");
    await expect(withRpcFailover(
      [{ host: "rpc.primary", client: null }],
      async () => { throw notFound; },
      { attempts: 1, baseDelayMs: 0, operation: "eth_fillTransaction" },
    )).rejects.toThrow("RPC observation failed");
    await settle();

    expect(reports.map((report) => [report.operation, report.code, report.status])).toEqual([
      ["eth_estimateGas", -32601, null],
      ["eth_fillTransaction", null, 429],
    ]);
  });

  it("reports every endpoint attempt that fails inside the RPC failover", async () => {
    await expect(withRpcFailover(
      [{ host: "rpc.primary", client: null }, { host: "rpc.fallback", client: null }],
      async () => {
        throw Object.assign(new Error("unavailable"), { name: "HttpRequestError", status: 503 });
      },
      { attempts: 1, baseDelayMs: 0, operation: "eth_blockNumber" },
    )).rejects.toThrow("RPC observation failed");
    await settle();

    expect(reports.map((report) => [report.target, report.operation, report.reason, report.status])).toEqual([
      ["rpc.primary", "eth_blockNumber", "http_error", 503],
      ["rpc.fallback", "eth_blockNumber", "http_error", 503],
    ]);
  });
});

describe("boundedFetch failure reporting", () => {
  it("reports a non-2xx reply with the remote's code and still returns it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "DEFAULT", message: "Default error" }),
      { status: 502, headers: { "content-type": "application/json" } },
    )));

    const response = await boundedFetch("https://api.supplier.example/catalog?account_id=abc", { method: "GET" });
    await settle();

    expect(response.status).toBe(502);
    expect(reports).toEqual([expect.objectContaining({
      target: "api.supplier.example",
      operation: "GET /catalog",
      reason: "http_error",
      status: 502,
      code: "DEFAULT",
      suppressed: 0,
    })]);
  });

  it("reports a transport timeout and then the circuit opening", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("timed out", "TimeoutError")));

    await expect(boundedFetch("https://timeouts.example/a", { method: "POST" })).rejects.toThrow();
    await expect(boundedFetch("https://timeouts.example/a", { method: "POST" })).rejects.toThrow();
    await expect(boundedFetch("https://timeouts.example/a", { method: "POST" })).rejects.toThrow("outbound circuit open");
    await settle();

    expect(reports.map((report) => report.reason)).toEqual(["timeout", "circuit_open"]);
    expect(reports[0]).toMatchObject({ target: "timeouts.example", operation: "POST /a" });
  });

  it("counts a caller's own deadline the origin missed, but never the caller's other aborts", async () => {
    // The origin never answers: fetch rejects with whatever aborted its signal.
    vi.stubGlobal("fetch", vi.fn((_url: URL, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    })));
    const cancelled = () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("caller gave up")), 5);
      return controller.signal;
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(boundedFetch("https://cancelled.example/a", { signal: cancelled() }))
        .rejects.toBeInstanceOf(OutboundAbortedError);
    }
    await settle();
    expect(reports).toEqual([]);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(boundedFetch("https://slow.example/a", { signal: AbortSignal.timeout(5) }))
        .rejects.toBeInstanceOf(OutboundAbortedError);
    }
    await expect(boundedFetch("https://slow.example/a", { signal: AbortSignal.timeout(5) }))
      .rejects.toThrow("outbound circuit open");
    await settle();
    expect(reports.map((report) => [report.target, report.reason])).toEqual([
      ["slow.example", "timeout"], ["slow.example", "circuit_open"],
    ]);
  });

  it("reports a rejected target before any request is made", async () => {
    h.validatePublicUrl.mockResolvedValue({ ok: false, reason: "private address" });
    vi.stubGlobal("fetch", vi.fn());

    await expect(boundedFetch("https://gateway.example/profile", {}, { publicTarget: {} }))
      .rejects.toThrow("outbound target rejected");
    await settle();

    expect(reports).toEqual([expect.objectContaining({ target: "gateway.example", reason: "target_rejected" })]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("platform log listener", () => {
  it("writes warnings for client rejections and errors for outages", () => {
    expect(outboundFailureEvent({
      target: "mail.supplier.example", operation: "POST /email", reason: "http_error",
      status: 422, code: 300, networkCode: null, suppressed: 3,
    })).toMatchObject({
      source: "system",
      severity: "warn",
      type: "outbound.request_failed",
      message: "Outbound POST /email to mail.supplier.example failed: HTTP 422 (code 300). 3 identical failure(s) since the previous report.",
      payload: { target: "mail.supplier.example", status: 422, code: 300, suppressed: 3 },
    });
    expect(outboundFailureEvent({
      target: "rpc.example", operation: "eth_call", reason: "timeout",
      status: null, code: null, networkCode: null, suppressed: 0,
    })).toMatchObject({ severity: "error", message: "Outbound eth_call to rpc.example failed: timeout." });
    expect(outboundFailureEvent({
      target: "api.example", operation: "GET /x", reason: "network",
      status: null, code: null, networkCode: "ENOTFOUND", suppressed: 0,
    })).toMatchObject({ severity: "error", message: "Outbound GET /x to api.example failed: network (ENOTFOUND)." });
  });

  it("emits a platform-log event for every report once installed", async () => {
    const uninstall = installOutboundFailureLog();
    reportOutboundFailure({
      target: "api.example", operation: "GET /x", reason: "http_error",
      status: 500, code: null, networkCode: null,
    }, 10_000);
    await settle();
    uninstall();

    expect(h.emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "outbound.request_failed",
      severity: "error",
      message: "Outbound GET /x to api.example failed: HTTP 500.",
    }));
  });
});
