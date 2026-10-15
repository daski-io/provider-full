import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validatePublicUrl: vi.fn(),
  pinnedHttpRequest: vi.fn(),
}));

vi.mock("../src/core/config.js", () => ({
  config: {
    OUTBOUND_MAX_CONCURRENCY_PER_ORIGIN: 4,
    OUTBOUND_TOTAL_TIMEOUT_MS: 1_000,
    OUTBOUND_MAX_RESPONSE_BYTES: 1_024,
    OUTBOUND_CIRCUIT_FAILURE_THRESHOLD: 3,
    OUTBOUND_CIRCUIT_OPEN_MS: 1_000,
  },
}));
vi.mock("../src/core/security/ssrf.js", () => ({
  validatePublicUrl: mocks.validatePublicUrl,
}));
vi.mock("../src/core/security/pinnedHttp.js", () => ({
  pinnedHttpRequest: mocks.pinnedHttpRequest,
}));

import { boundedFetch } from "../src/core/security/outboundHttp.js";
import { isUndecidedPreStartFault } from "../src/core/standardRail/faultClassification.js";

async function rejection(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the request to be refused");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn());
});

describe("boundedFetch public-target policy", () => {
  it("rejects private targets before opening a request", async () => {
    mocks.validatePublicUrl.mockResolvedValue({
      ok: false,
      reason: "private address",
    });

    await expect(
      boundedFetch("https://gateway.example/profile", {}, {
        publicTarget: { allowHttp: false },
      }),
    ).rejects.toThrow("outbound target rejected");

    expect(mocks.validatePublicUrl).toHaveBeenCalledWith(
      "https://gateway.example/profile",
      { allowHttp: false, allowQueryOrFragment: undefined },
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps a resolver fault as the cause, so a lookup outage is told apart from a refused target", async () => {
    const resolverFault = Object.assign(new Error("getaddrinfo EAI_AGAIN gateway.example"), { code: "EAI_AGAIN" });
    mocks.validatePublicUrl.mockResolvedValueOnce({
      ok: false,
      reason: "dns lookup failed for gateway.example: getaddrinfo EAI_AGAIN gateway.example",
      cause: resolverFault,
    });
    const outage = await rejection(boundedFetch("https://gateway.example/profile", {}, { publicTarget: {} }));
    expect(outage.message).toMatch(/^outbound target rejected: dns lookup failed/);
    expect(outage.cause).toBe(resolverFault);
    expect(isUndecidedPreStartFault(outage)).toBe(true);

    mocks.validatePublicUrl.mockResolvedValueOnce({ ok: false, reason: "host gateway.example resolves to private/reserved address 10.0.0.1" });
    const refused = await rejection(boundedFetch("https://gateway.example/profile", {}, { publicTarget: {} }));
    expect(refused.cause).toBeUndefined();
    expect(isUndecidedPreStartFault(refused)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("dials the address returned by the SSRF validator without re-resolving", async () => {
    mocks.validatePublicUrl.mockResolvedValue({
      ok: true,
      url: new URL("https://gateway.example/profile"),
      addresses: ["8.8.8.8"],
    });
    mocks.pinnedHttpRequest.mockResolvedValue({
      status: 200,
      statusText: "OK",
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      body: Buffer.from("{}"),
    });

    const response = await boundedFetch("https://gateway.example/profile", {}, {
      publicTarget: { allowHttp: false, allowQueryOrFragment: false },
      allowedContentTypes: ["application/json"],
    });

    expect(response.ok).toBe(true);
    expect(mocks.pinnedHttpRequest).toHaveBeenCalledWith(expect.objectContaining({
      pinnedIp: "8.8.8.8",
      url: new URL("https://gateway.example/profile"),
    }));
    expect(fetch).not.toHaveBeenCalled();
  });
});
