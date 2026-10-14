import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import { judgeLifecycleAnswer, type GatewayObservation } from "./gatewayLifecycleConsumer.js";
import { createGatewayView, ProviderWireDefect } from "./gatewayView.js";
import { appliesToFull, context, fixture, type WireAnswer } from "./providerWireFixture.js";

// The ported gateway lifecycle consumer reproduces the gateway's own verdict
// on every vendored lifecycle and terminal-evidence vector a full provider is
// judged by, so the lifecycle tests can judge full's live answers with it.
const lifecycle = fixture("lifecycle.json");
const terminal = fixture("terminal-evidence.json");

type Vector = {
  id: string; request: string; appliesTo: string[];
  response: { status: number; headers: Record<string, string>; body?: unknown; bodyText?: string };
  gateway: Record<string, any>;
};

function stored(gateway: Record<string, any>): GatewayObservation | null {
  const operations = gateway.storedOperations;
  if (!operations) return null;
  const { observedAt, ...semantic } = operations;
  return {
    revision: operations.revision, observedAt, projectionHash: canonicalHash(semantic),
    originalTerminal: gateway.storedTerminal ?? null,
  };
}

const answerOf = (entry: Vector): WireAnswer => ({
  status: entry.response.status,
  contentType: entry.response.headers["content-type"] ?? null,
  contentEncoding: entry.response.headers["content-encoding"] ?? null,
  text: entry.response.bodyText ?? JSON.stringify(entry.response.body),
});

async function verdictOf(entry: Vector) {
  const request = lifecycle.requests[entry.request];
  return judgeLifecycleAnswer(answerOf(entry), {
    action: request.action,
    request: request.http.body.request,
    readCapability: request.access === "readCapability",
    orderId: context.order.orderId,
    providerTaskId: context.order.providerTaskId,
    providerAuthorityKey: context.provider.authorityKey,
    terminalAttestationKey: context.provider.terminalAttestationKey,
    maxResponseBytes: context.provider.controlProfile.maxResponseBytes,
    receivedAt: entry.gateway.receivedAt ?? request.gateway.now,
    stored: stored(entry.gateway),
  });
}

const vectors: Vector[] = [...lifecycle.responses, ...lifecycle.refusals, ...terminal.responses].filter(appliesToFull);

describe("ported gateway lifecycle consumer", () => {
  it("covers every lifecycle and terminal-evidence vector that applies to full", () => {
    expect(vectors.length).toBe(33);
  });

  it.each(vectors.map((entry) => [entry.id, entry] as const))("%s", async (_id, entry) => {
    const verdict = await verdictOf(entry);
    const expected = entry.gateway;
    expect(verdict.verdict).toBe(expected.verdict);
    if (verdict.verdict === "refused") {
      expect({ code: verdict.code, status: verdict.status, requiresNewSignature: verdict.requiresNewSignature })
        .toEqual({ code: expected.code, status: expected.status, requiresNewSignature: expected.requiresNewSignature });
    }
    if (verdict.verdict === "rejected") {
      // The strict JSON scanner words its duplicate-key error differently.
      if (entry.id === "status.duplicate-key.rejected") expect(verdict.message).toMatch(/duplicate key/);
      else expect(verdict.message).toBe(expected.message);
    }
    if (verdict.verdict === "accepted" && entry.gateway.storedTerminal) {
      expect(verdict.stored.originalTerminal).toEqual(entry.gateway.storedTerminal);
    }
  });
});

describe("the gateway view every wire-harness lifecycle answer passes", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const byId = (id: string): Vector => vectors.find((entry) => entry.id === id)!;
  const observe = (view: ReturnType<typeof createGatewayView>, entry: Vector, answer = answerOf(entry)) => {
    const http = lifecycle.requests[entry.request].http;
    return view.observe(http.url, http.body, answer);
  };

  it("keeps the first accepted terminal identity and fails a later answer that changes it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(context.times.lifecycleCompleted * 1_000);
    const view = createGatewayView();
    await observe(view, byId("status.completed-task.accepted"));
    const changed = byId("task-projection.revealed-hash.rejected");
    await expect(observe(view, changed)).rejects.toThrow(/provider_original_terminal_changed/);
    view.reset();
    await expect(observe(view, changed)).resolves.toBeUndefined();
  });

  it("fails a 2xx answer the gateway rejects and a 409 or 503 it would not name", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(context.times.midway * 1_000);
    const view = createGatewayView();
    await expect(observe(view, byId("status.extra-key.rejected"))).rejects.toThrow(ProviderWireDefect);
    await expect(observe(view, byId("empty-503.internal"))).rejects.toThrow(ProviderWireDefect);
    await expect(observe(view, byId("unsupported.extra-key.internal"))).rejects.toThrow(ProviderWireDefect);
    await expect(observe(view, byId("status.unavailable.read-capability"))).resolves.toBeUndefined();
    // An authentication failure stays an unnamed refusal.
    await expect(observe(view, byId("status.unavailable.read-capability"), {
      status: 401, contentType: "application/json", contentEncoding: null, text: JSON.stringify({ error: "lifecycle_rejected" }),
    })).resolves.toBeUndefined();
  });
});
