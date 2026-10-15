import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../src/core/config.js";
import { boundedFetch, OutboundAbortedError } from "../src/core/security/outboundHttp.js";
import { pinnedHttpRequest } from "../src/core/security/pinnedHttp.js";

/** A server that sends headers and a first chunk, then stalls the body. */
async function stallingServer() {
  const state = { requests: 0, sockets: new Set<Socket>(), closed: 0 };
  const server = http.createServer((_request, response) => {
    state.requests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.write("{\"partial\":");
  });
  server.on("connection", (socket) => {
    state.sockets.add(socket);
    socket.on("close", () => { state.closed += 1; });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    state,
    url: `http://127.0.0.1:${port}/stall`,
    port,
    close: () => new Promise<void>((resolve) => {
      for (const socket of state.sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

const abortAfter = (milliseconds: number) => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("caller gave up")), milliseconds).unref();
  return controller.signal;
};

// C05 / L-T15: the caller's cancellation and the helper's own timeout bound
// the whole exchange, response body included, on both outbound paths.
describe("outbound cancellation", () => {
  it("aborts a stalled response body on the fetch path when the caller cancels", async () => {
    const stall = await stallingServer();
    close = stall.close;
    const started = Date.now();
    await expect(boundedFetch(stall.url, { signal: abortAfter(150) }, { timeoutMs: 10_000 }))
      .rejects.toBeInstanceOf(OutboundAbortedError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("still applies the helper's own timeout through the body read", async () => {
    const stall = await stallingServer();
    close = stall.close;
    const started = Date.now();
    await expect(boundedFetch(stall.url, { signal: new AbortController().signal }, { timeoutMs: 200 }))
      .rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("does not dial at all for an already cancelled caller", async () => {
    const stall = await stallingServer();
    close = stall.close;
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(boundedFetch(stall.url, { signal: cancelled.signal })).rejects.toBeInstanceOf(OutboundAbortedError);
    await expect(pinnedHttpRequest({
      url: new URL(stall.url), pinnedIp: "127.0.0.1", timeoutMs: 1_000, maxResponseBytes: 1_024,
      signal: cancelled.signal,
    })).rejects.toThrow(/aborted before it started/);
    expect(stall.state.requests).toBe(0);
  });

  it("aborts a stalled response body on the pinned path and closes the connection", async () => {
    const stall = await stallingServer();
    close = stall.close;
    const started = Date.now();
    await expect(pinnedHttpRequest({
      url: new URL(`http://unresolvable.invalid:${stall.port}/stall`),
      pinnedIp: "127.0.0.1",
      timeoutMs: 10_000,
      maxResponseBytes: 1_024,
      signal: abortAfter(150),
    })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stall.state.closed).toBe(1);
  });

  it("does not open the origin's circuit for caller cancellations", async () => {
    const stall = await stallingServer();
    close = stall.close;
    for (let attempt = 0; attempt <= config.OUTBOUND_CIRCUIT_FAILURE_THRESHOLD; attempt += 1) {
      await expect(boundedFetch(stall.url, { signal: abortAfter(20) }, { timeoutMs: 10_000 }))
        .rejects.toBeInstanceOf(OutboundAbortedError);
    }
    // The next call reaches the origin instead of failing fast on an open circuit.
    const before = stall.state.requests;
    await expect(boundedFetch(stall.url, { signal: abortAfter(50) }, { timeoutMs: 10_000 }))
      .rejects.toBeInstanceOf(OutboundAbortedError);
    expect(stall.state.requests).toBe(before + 1);
  });
});
