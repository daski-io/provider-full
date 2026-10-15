import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// C05: an empty or non-JSON error reply keeps its HTTP status, the circuit
// reports its real reopening time, and the response-size guards still hold.

const mocks = vi.hoisted(() => ({ pinnedHttpRequest: vi.fn(), reportOutboundFailure: vi.fn() }));
vi.mock("../src/core/config.js", () => ({
  config: {
    OUTBOUND_MAX_CONCURRENCY_PER_ORIGIN: 4,
    OUTBOUND_TOTAL_TIMEOUT_MS: 1_000,
    OUTBOUND_MAX_RESPONSE_BYTES: 4_096,
    OUTBOUND_CIRCUIT_FAILURE_THRESHOLD: 2,
    OUTBOUND_CIRCUIT_OPEN_MS: 30_000,
  },
}));
vi.mock("../src/core/security/ssrf.js", () => ({
  validatePublicUrl: vi.fn(async () => ({ ok: true, addresses: ["8.8.8.8"] })),
}));
vi.mock("../src/core/security/pinnedHttp.js", () => ({ pinnedHttpRequest: mocks.pinnedHttpRequest }));
vi.mock("../src/core/observability/outboundFailures.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/observability/outboundFailures.js")>()),
  reportOutboundFailure: mocks.reportOutboundFailure,
}));

import { boundedFetch, OutboundCircuitOpenError } from "../src/core/security/outboundHttp.js";

let caseId = 0;
let url: string;
const policy = { allowedContentTypes: ["application/json"], publicTarget: {} };

function response(status: number, text: string, contentType?: string) {
  return {
    status, statusText: "controlled", ok: status >= 200 && status < 300,
    headers: new Headers(contentType ? { "content-type": contentType } : {}),
    body: Buffer.from(text),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  url = `https://case-${++caseId}.example/catalog/schemas?account_id=private-id`;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("outbound HTTP error preservation", () => {
  it.each([
    [500, "", undefined],
    [502, "<html>private supplier error</html>", "text/html"],
    [429, "private supplier error", "text/plain"],
  ] as const)("reports HTTP %s without requiring a success content type", async (status, text, contentType) => {
    mocks.pinnedHttpRequest.mockResolvedValue(response(status, text, contentType));

    const result = await boundedFetch(url, {}, policy);

    expect(result).toMatchObject({ status, ok: false });
    expect(mocks.reportOutboundFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      operation: "GET /catalog/schemas", reason: "http_error", status, code: null,
    }));
    const reports = JSON.stringify(mocks.reportOutboundFailure.mock.calls);
    expect(reports).not.toContain("private-id");
    expect(reports).not.toContain("private supplier error");
  });

  it.each([undefined, "text/html"])("still rejects HTTP 200 with content type %s", async (contentType) => {
    mocks.pinnedHttpRequest.mockResolvedValue(response(200, "{}", contentType));

    await expect(boundedFetch(url, {}, policy)).rejects.toThrow("content type");

    expect(mocks.reportOutboundFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      reason: "content_type",
    }));
  });

  it("keeps the declared response-size guard for HTTP errors", async () => {
    const result = response(500, "");
    result.headers.set("content-length", "8192");
    mocks.pinnedHttpRequest.mockResolvedValue(result);

    await expect(boundedFetch(url, {}, policy)).rejects.toThrow("exceeds 4096 bytes");
  });

  it("keeps the streamed response-size guard for HTTP errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("x".repeat(65), { status: 500 })));

    await expect(boundedFetch(url, {}, { maxResponseBytes: 32, allowedContentTypes: ["application/json"] }))
      .rejects.toThrow("exceeds 32 bytes");
  });

  it("exposes the real circuit reopening time without extending it on local refusals", async () => {
    vi.useFakeTimers();
    mocks.pinnedHttpRequest.mockResolvedValue(response(500, ""));
    await boundedFetch(url, {}, policy);
    await boundedFetch(url, {}, policy);
    const retryAt = Date.now() + 30_000;

    await expect(boundedFetch(url, {}, policy)).rejects.toBeInstanceOf(OutboundCircuitOpenError);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(boundedFetch(url, {}, policy)).rejects.toMatchObject({ retryAt });
    expect(mocks.pinnedHttpRequest).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(29_000);
    mocks.pinnedHttpRequest.mockResolvedValue(response(200, "{}", "application/json"));
    await expect(boundedFetch(url, {}, policy)).resolves.toMatchObject({ ok: true });
    expect(mocks.pinnedHttpRequest).toHaveBeenCalledTimes(3);
  });
});
