import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import { acceptDispatchResponse, classifyDispatchAnswer, classifyStatusAnswer } from "./gatewayConsumer.js";
import { readBoundedAnswer } from "./gatewayLifecycleConsumer.js";
import { appliesToFull, context, fixture, type WireAnswer } from "./providerWireFixture.js";

// The ported gateway dispatch consumer, which the wire harness's gateway view
// folds dispatch and status answers with, reproduces the gateway's verdict on
// every vendored dispatch and dispatch-status vector that applies to full.
const dispatch = fixture("dispatch.json");
const status = fixture("dispatch-status.json");

type Vector = {
  id: string; request: string; appliesTo: string[];
  response: { status: number; headers: Record<string, string>; body?: unknown; bodyText?: string };
  gateway: Record<string, any>;
};

const answerOf = (entry: Vector): WireAnswer => ({
  status: entry.response.status,
  contentType: entry.response.headers["content-type"] ?? null,
  contentEncoding: entry.response.headers["content-encoding"] ?? null,
  text: entry.response.bodyText ?? (entry.response.body === undefined ? "" : JSON.stringify(entry.response.body)),
});
const responseOf = (answer: WireAnswer): Response => new Response(answer.text === "" ? null : answer.text, {
  status: answer.status,
  headers: Object.fromEntries([["content-type", answer.contentType], ["content-encoding", answer.contentEncoding]]
    .filter((entry): entry is [string, string] => entry[1] !== null)),
});

async function snapshot(answer: WireAnswer, dispatchHash: Hex, now: number): Promise<boolean> {
  try {
    await acceptDispatchResponse(readBoundedAnswer(answer, context.provider.controlProfile.maxResponseBytes), {
      dispatchHash, now,
      providerAuthorityKey: context.provider.authorityKey,
      terminalAttestationKey: context.provider.terminalAttestationKey,
    });
    return true;
  } catch {
    return false;
  }
}

describe("ported gateway dispatch consumer", () => {
  const dispatchVectors: Vector[] = dispatch.responses.filter(appliesToFull);
  const statusVectors: Vector[] = status.responses.filter(appliesToFull);

  it("covers every dispatch and dispatch-status vector that applies to full", () => {
    expect([dispatchVectors.length, statusVectors.length]).toEqual([34, 11]);
  });

  it.each(dispatchVectors.map((entry) => [entry.id, entry] as const))("dispatch %s", async (_id, entry) => {
    const answer = answerOf(entry);
    const ok = answer.status >= 200 && answer.status <= 299;
    const dispatchHash = canonicalHash(dispatch.requests[entry.request].http.body.dispatch);
    const verdict = ok
      ? (await snapshot(answer, dispatchHash, entry.gateway.receivedAt) ? "accepted" : "ambiguous")
      : await classifyDispatchAnswer(responseOf(answer));
    expect(verdict).toBe(entry.gateway.verdict);
    if (verdict === "refused") {
      expect({ status: answer.status, error: (JSON.parse(answer.text) as { error: unknown }).error })
        .toEqual({ status: entry.gateway.refusal.status, error: entry.gateway.refusal.reason });
    }
  });

  it.each(statusVectors.map((entry) => [entry.id, entry] as const))("status %s", async (_id, entry) => {
    const answer = answerOf(entry);
    const dispatchHash = status.requests[entry.request].http.body.query.payload.dispatchHash as Hex;
    const classified = await classifyStatusAnswer(responseOf(answer));
    const verdict = classified === "snapshot"
      ? (await snapshot(answer, dispatchHash, entry.gateway.receivedAt) ? "accepted" : "unknown")
      : classified === "no_claim" ? "noClaim" : "unknown";
    expect(verdict).toBe(entry.gateway.verdict);
  });
});
