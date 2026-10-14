import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterResult, FulfillmentAdapter } from "../src/core/serviceRegistry/types.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });
vi.mock("../src/core/db/pool.js", async () => (await import("./providerWireHarness.js")).poolModule());
vi.mock("../src/core/serviceRegistry/registry.js", async () => (await import("./providerWireHarness.js")).registryModule());
vi.mock("../src/core/standardRail/identifiers.js", async () => (await import("./providerWireHarness.js")).identifiersModule());
vi.mock("../src/core/engine/preExecuteRunner.js", () => ({
  consultPreExecuteAgent: async () => ({ action: "proceed" }),
}));

const { ProviderEvidenceVerifier } = await import("../src/core/standardRail/evidence.js");
const { processAdapterResult } = await import("../src/core/engine/taskFinalization.js");
const { runRetention } = await import("../src/core/db/retention.js");
const { coreReviewActionTools } = await import("../src/core/admin/ui/coreReviewActions.js");
const { WIRE_AUTHORIZATION_KEY, startWireHarness, wire } = await import("./providerWireHarness.js");
const { context, fixture, order } = await import("./providerWireFixture.js");
const { LIFECYCLE_HTTP, lifecycleBody } = await import("./lifecycleWire.js");

// F-T09 / F-T13 support receipts: deduplicated by order, payer and requestId
// with their content, published in operations under a higher revision, never
// touching terminal evidence, and closed with their Review.
const quote = fixture("quote.json");
const dispatch = fixture("dispatch.json");
const T = context.times.support;
let harness: Awaited<ReturnType<typeof startWireHarness>>;
let executeResult: AdapterResult = { status: "working" };

wire.adapter = {
  execute: async () => executeResult,
  handleInput: async () => ({ status: "working" }),
  cancel: async () => undefined,
  quote: async () => ({ ok: true, amount: 250_000n, currency: "USDC" }),
} satisfies FulfillmentAdapter;

async function admittedOrder(result: AdapterResult): Promise<void> {
  await harness.at(context.times.quote);
  expect((await harness.send(quote.requests["fixed-payer-lowercase"].http)).status).toBe(200);
  executeResult = result;
  await harness.at(context.times.dispatchAnswered);
  expect((await harness.send(dispatch.requests.initial.http)).status).toBe(200);
}

type Answer = { status: number; body: Record<string, any> };

async function call(action: string, request: Record<string, unknown>, now = T, nonce?: `0x${string}`): Promise<Answer> {
  await harness.at(now);
  const body = await lifecycleBody({ action, request, form: "payer-signed", now, nonce });
  const answer = await harness.send({ url: LIFECYCLE_HTTP.url, headers: LIFECYCLE_HTTP.headers, body });
  return { status: answer.status, body: JSON.parse(answer.text) };
}

const support = (requestId: string, message: string, now = T, nonce?: `0x${string}`) =>
  call("support", { requestId, message }, now, nonce);
const count = async (sql: string) => (await harness.database.pool.query(sql)).rows[0].n as number;

beforeAll(async () => {
  vi.spyOn(ProviderEvidenceVerifier.prototype, "verify").mockResolvedValue({ authorizationKey: WIRE_AUTHORIZATION_KEY });
  vi.spyOn(ProviderEvidenceVerifier.prototype, "assertNotSanctioned").mockResolvedValue();
  harness = await startWireHarness("order_support");
});

afterAll(async () => {
  vi.restoreAllMocks();
  await harness?.close();
});

beforeEach(async () => {
  await harness.reset();
});

describe("support receipts (F-T09)", () => {
  it("returns the original receipt to a retry under a fresh authorization, and refuses changed content", async () => {
    await admittedOrder({ status: "working" });
    const first = await support("support-1", "Please confirm.");
    expect(first.status).toBe(200);
    const receipt = first.body.result.supportReceipt;
    expect(receipt).toEqual({
      requestId: "support-1", messageId: context.support.messageId, reviewId: context.support.reviewId,
      acceptedAt: new Date(T * 1_000).toISOString(),
    });
    expect(first.body.operations).toMatchObject({ revision: 1, support: { status: "open", reviewId: receipt.reviewId } });
    // Later and under a new nonce: the same receipt, nothing new recorded.
    wire.supportMessageIds.push("11111111-1111-4111-8111-111111111111");
    const retry = await support("support-1", "Please confirm.", T + 120);
    expect(retry.status).toBe(200);
    expect(retry.body.result.supportReceipt).toEqual(receipt);
    expect(retry.body.operations.revision).toBe(1);
    expect(await count("SELECT count(*)::int AS n FROM events WHERE type='transaction.message.user'")).toBe(1);
    const conflict = await support("support-1", "Something else.", T + 130);
    expect([conflict.status, conflict.body]).toEqual([409, { error: "action_conflict" }]);
    expect(await count("SELECT count(*)::int AS n FROM standard_support_receipts")).toBe(1);
  });

  it("refuses a replay of the same signed authorization", async () => {
    await admittedOrder({ status: "working" });
    const nonce = `0x${"77".repeat(32)}` as const;
    expect((await support("support-2", "Hello", T, nonce)).status).toBe(200);
    const replay = await support("support-2", "Hello", T, nonce);
    expect([replay.status, replay.body]).toEqual([401, { error: "lifecycle_rejected" }]);
  });

  it("joins the open Review, then closes it with its disposition under a higher revision", async () => {
    await admittedOrder({ status: "working" });
    const first = await support("support-a", "First question.");
    wire.supportMessageIds.push("22222222-2222-4222-8222-222222222222");
    wire.supportReviewIds.push("33333333-3333-4333-8333-333333333333");
    const second = await support("support-b", "Second question.", T + 10);
    expect(second.body.result.supportReceipt.reviewId).toBe(first.body.result.supportReceipt.reviewId);
    expect(second.body.operations).toMatchObject({
      revision: 2,
      support: { status: "open", lastAcceptedRequest: { requestId: "support-b", messageId: "22222222-2222-4222-8222-222222222222" } },
    });
    const tool = coreReviewActionTools().find((candidate) => candidate.name === "resolve_order_support")!;
    const context2 = { actor: "operator@example.com", mode: "human" as const, escalationId: first.body.result.supportReceipt.reviewId,
      directAdminApproval: true as const };
    await expect(tool.execute({ note: "Confirmed with the buyer." }, context2)).resolves.toBe(JSON.stringify({ ok: true }));
    const status = await call("status", {}, T + 20);
    expect(status.body.operations).toMatchObject({ revision: 3, support: { status: "closed" } });
    // A request after closure opens a new Review.
    wire.supportMessageIds.push("44444444-4444-4444-8444-444444444444");
    wire.supportReviewIds.push("55555555-5555-4555-8555-555555555555");
    const reopened = await support("support-c", "One more thing.", T + 30);
    expect(reopened.body.result.supportReceipt.reviewId).toBe("55555555-5555-4555-8555-555555555555");
    expect(reopened.body.operations).toMatchObject({ revision: 4, support: { status: "open" } });
  });
});

describe("support never changes terminal evidence (F-T13)", () => {
  it("keeps a support message out of a later completion's frozen projection", async () => {
    await admittedOrder({ status: "working" });
    expect((await support("support-w", "Where is it?")).status).toBe(200);
    await processAdapterResult(order.providerTaskId, { status: "completed", message: "Done." }, harness.serviceId);
    const status = await call("status", {}, T + 60);
    const artifact = await call("artifact", {}, T + 60);
    expect(artifact.body.result.status.message.parts).toEqual([{ kind: "text", text: "Done." }]);
    expect(status.body.terminalAttestation).toEqual(artifact.body.terminalAttestation);
    // A support request after completion and event retention change nothing.
    wire.supportMessageIds.push("66666666-6666-4666-8666-666666666666");
    expect((await support("support-x", "Thanks!", T + 70)).status).toBe(200);
    await harness.database.pool.query("UPDATE events SET created_at=now() - interval '4000 days'");
    await runRetention();
    const later = await call("status", {}, T + 80);
    expect(later.body.terminalAttestation).toEqual(status.body.terminalAttestation);
    const retried = await support("support-x", "Thanks!", T + 90);
    expect(retried.body.result.supportReceipt.messageId).toBe("66666666-6666-4666-8666-666666666666");
    await expect(harness.database.pool.query("DELETE FROM standard_support_receipts")).rejects.toThrow(/append-only/);
  });
});
