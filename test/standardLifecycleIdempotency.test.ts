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
const { CancellationRefusedError } = await import("../src/core/serviceRegistry/types.js");
const { processAdapterResult } = await import("../src/core/engine/taskFinalization.js");
const { WIRE_AUTHORIZATION_KEY, startWireHarness, wire } = await import("./providerWireHarness.js");
const { context, fixture, order } = await import("./providerWireFixture.js");
const { LIFECYCLE_HTTP, lifecycleBody } = await import("./lifecycleWire.js");

// F-T09: input and cancellation have durable business-action identities. A
// fresh gateway grant or payer nonce never repeats a committed mutation, a
// definite pre-effect failure frees the identity, and an uncertain outcome
// keeps it bound until a later attempt reconciles it.
const quote = fixture("quote.json");
const dispatch = fixture("dispatch.json");
const T = context.times.midway;
const INPUT = { inputText: "Keep the title as written.", data: { title: "Synthetic fixture note" } };
let harness: Awaited<ReturnType<typeof startWireHarness>>;
let executeResult: AdapterResult = { status: "working" };
let onCancel: () => Promise<void> = async () => undefined;
let onInput: () => Promise<AdapterResult> = async () => ({ status: "working" });
const calls = { cancel: 0, input: 0 };
/** The action context every service call received, in order. */
const contexts: unknown[] = [];

wire.adapter = {
  execute: async () => executeResult,
  handleInput: async (task) => { calls.input += 1; contexts.push(task.lifecycleAction); return onInput(); },
  cancel: async (task) => { calls.cancel += 1; contexts.push(task.lifecycleAction); await onCancel(); },
  quote: async () => ({ ok: true, amount: 250_000n, currency: "USDC" }),
} satisfies FulfillmentAdapter;

async function admittedOrder(result: AdapterResult): Promise<void> {
  await harness.at(context.times.quote);
  expect((await harness.send(quote.requests["fixed-payer-lowercase"].http)).status).toBe(200);
  executeResult = result;
  await harness.at(context.times.dispatchAnswered);
  expect((await harness.send(dispatch.requests.initial.http)).status).toBe(200);
}

/** Every call is a fresh gateway grant and a fresh payer authorization. */
async function call(action: "cancel" | "input", request: Record<string, unknown>, now = T) {
  await harness.at(now);
  const answer = await harness.send({
    url: LIFECYCLE_HTTP.url, headers: LIFECYCLE_HTTP.headers,
    body: await lifecycleBody({ action, request, form: "payer-signed", now }),
  });
  return { status: answer.status, body: JSON.parse(answer.text) as Record<string, any> };
}

const actions = async () => (await harness.database.pool.query(
  "SELECT action,state,attempts,outcome_state FROM standard_lifecycle_actions ORDER BY claimed_at")).rows;

beforeAll(async () => {
  vi.spyOn(ProviderEvidenceVerifier.prototype, "verify").mockResolvedValue({ authorizationKey: WIRE_AUTHORIZATION_KEY });
  vi.spyOn(ProviderEvidenceVerifier.prototype, "assertNotSanctioned").mockResolvedValue();
  harness = await startWireHarness("lifecycle_idempotency");
});

afterAll(async () => {
  vi.restoreAllMocks();
  await harness?.close();
});

beforeEach(async () => {
  await harness.reset();
  calls.cancel = 0;
  calls.input = 0;
  contexts.length = 0;
  onCancel = async () => undefined;
  onInput = async () => ({ status: "working" });
});

describe("cancellation idempotency (F-T09)", () => {
  it("answers a retried committed cancellation without repeating it, and refuses a different reason", async () => {
    await admittedOrder({ status: "working" });
    const first = await call("cancel", {});
    expect([first.status, first.body.state]).toEqual([200, "canceled"]);
    const retry = await call("cancel", {}, T + 30);
    expect(retry.status).toBe(200);
    expect(retry.body.terminalAttestation).toEqual(first.body.terminalAttestation);
    expect(calls.cancel).toBe(1);
    const changed = await call("cancel", { reason: "changed my mind" }, T + 40);
    expect([changed.status, changed.body]).toEqual([409, { error: "action_conflict" }]);
    expect(await actions()).toEqual([{ action: "cancel", state: "committed", attempts: 1, outcome_state: "canceled" }]);
  });

  it("keeps an uncertain cancellation bound, refuses a concurrent attempt, and reconciles on retry", async () => {
    await admittedOrder({ status: "working" });
    onCancel = async () => { throw new Error("supplier timeout"); };
    const uncertain = await call("cancel", {});
    expect([uncertain.status, uncertain.body]).toEqual([503, { error: "lifecycle_unavailable" }]);
    expect(await actions()).toMatchObject([{ action: "cancel", state: "claimed" }]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    onCancel = async () => { await gate; };
    const resumed = call("cancel", {}, T + 10);
    await vi.waitFor(() => expect(calls.cancel).toBe(2));
    const concurrent = await call("cancel", {}, T + 11);
    expect([concurrent.status, concurrent.body]).toEqual([503, { error: "lifecycle_unavailable" }]);
    release();
    expect((await resumed).body.state).toBe("canceled");
    expect(calls.cancel).toBe(2);
    expect(await actions()).toEqual([{ action: "cancel", state: "committed", attempts: 2, outcome_state: "canceled" }]);
  });

  it("records the terminal state an uncertain cancellation met as its outcome, never as unsupported", async () => {
    await admittedOrder({ status: "working" });
    // The service cancels, but a worker completes the order first, so the
    // cancellation's own write loses its fence: its effect is unknown.
    onCancel = async () => {
      await processAdapterResult(order.providerTaskId, { status: "completed", message: "Done." }, harness.serviceId);
    };
    const uncertain = await call("cancel", {});
    expect([uncertain.status, uncertain.body]).toEqual([503, { error: "lifecycle_unavailable" }]);
    const retry = await call("cancel", {}, T + 10);
    expect([retry.status, retry.body.state, retry.body.terminalAttestation.payload.state])
      .toEqual([200, "completed", "completed"]);
    expect(calls.cancel).toBe(1);
    expect(await actions()).toEqual([{ action: "cancel", state: "committed", attempts: 2, outcome_state: "completed" }]);
  });

  it("never lets an attempt that outlived its lease disturb the attempt that took over", async () => {
    await admittedOrder({ status: "working" });
    const gates: Array<{ open: () => void; wait: Promise<void> }> = [0, 1].map(() => {
      let open!: () => void;
      const wait = new Promise<void>((resolve) => { open = resolve; });
      return { open, wait };
    });
    const pending = [...gates];
    onCancel = async () => { await pending.shift()?.wait; };
    const first = call("cancel", {});
    await vi.waitFor(() => expect(calls.cancel).toBe(1));
    // The first supplier call outlives the 300-second lease: a retry takes over.
    const second = call("cancel", {}, T + 400);
    await vi.waitFor(() => expect(calls.cancel).toBe(2));
    gates[0]!.open();
    expect(await first).toEqual({ status: 503, body: { error: "lifecycle_unavailable" } });
    // The stale attempt's failure left the new owner's lease alone.
    const third = await call("cancel", {}, T + 401);
    expect([third.status, third.body]).toEqual([503, { error: "lifecycle_unavailable" }]);
    gates[1]!.open();
    expect((await second).body.state).toBe("canceled");
    expect(calls.cancel).toBe(2);
    expect(await actions()).toEqual([{ action: "cancel", state: "committed", attempts: 2, outcome_state: "canceled" }]);
  });

  it("frees the identity after a definite refusal, so a later cancellation may run", async () => {
    await admittedOrder({ status: "working" });
    onCancel = async () => { throw new CancellationRefusedError("not yet cancelable"); };
    const refused = await call("cancel", {});
    expect([refused.status, refused.body]).toEqual([409, { error: "unsupported_action" }]);
    expect(await actions()).toEqual([]);
    onCancel = async () => undefined;
    expect((await call("cancel", {}, T + 20)).body.state).toBe("canceled");
    expect(calls.cancel).toBe(2);
  });
});

describe("input idempotency (F-T09)", () => {
  it("answers a retried committed input without handing it to the service again", async () => {
    await admittedOrder({ status: "input-required", message: "Confirm the title." });
    const first = await call("input", INPUT);
    expect([first.status, first.body.state]).toEqual([200, "working"]);
    const retry = await call("input", INPUT, T + 30);
    expect([retry.status, retry.body.state]).toEqual([200, "working"]);
    expect(calls.input).toBe(1);
  });

  it("refuses a different input while one is unresolved, and still lets the buyer cancel", async () => {
    await admittedOrder({ status: "input-required", message: "Confirm the title." });
    onInput = async () => { throw new Error("supplier timeout"); };
    const uncertain = await call("input", INPUT);
    expect([uncertain.status, uncertain.body]).toEqual([503, { error: "lifecycle_unavailable" }]);
    const other = await call("input", { inputText: "Something else.", data: { title: "Synthetic fixture note" } }, T + 5);
    expect([other.status, other.body]).toEqual([409, { error: "action_conflict" }]);
    const cancel = await call("cancel", {}, T + 6);
    expect(cancel.status).toBe(200);
    expect(cancel.body.state).toBe("canceled");
    expect(calls.input).toBe(1);
  });

  it("calls the service again only as a resumed attempt under the same action key", async () => {
    await admittedOrder({ status: "input-required", message: "Confirm the title." });
    onInput = async () => { throw new Error("supplier timeout"); };
    expect((await call("input", INPUT)).status).toBe(503);
    onInput = async () => ({ status: "working" });
    expect((await call("input", INPUT, T + 5)).body.state).toBe("working");
    const [first, resumed] = contexts as Array<{ idempotencyKey: string; resumed: boolean }>;
    expect(first).toEqual({
      idempotencyKey: expect.stringMatching(new RegExp(`^standard-lifecycle:${order.providerTaskId}:input:0x[0-9a-f]{64}$`)),
      resumed: false,
    });
    expect(resumed).toEqual({ idempotencyKey: first!.idempotencyKey, resumed: true });
  });

  it("keeps an unresolved input bound when a resumed attempt fails before calling the service", async () => {
    await admittedOrder({ status: "input-required", message: "Confirm the title." });
    onInput = async () => { throw new Error("supplier timeout"); };
    expect((await call("input", INPUT)).status).toBe(503);
    // The resumed attempt's first read fails like a lost connection.
    wire.faults.push("c.operations_revision::text AS operations_revision");
    const failed = await call("input", INPUT, T + 5);
    expect([failed.status, failed.body]).toEqual([503, { error: "lifecycle_unavailable" }]);
    expect(await actions()).toEqual([{ action: "input", state: "claimed", attempts: 2, outcome_state: null }]);
    const other = await call("input", { inputText: "Something else.", data: { title: "Synthetic fixture note" } }, T + 6);
    expect([other.status, other.body]).toEqual([409, { error: "action_conflict" }]);
    expect(calls.input).toBe(1);
  });

  it("records an input whose effect committed before its answer was lost, without repeating it", async () => {
    await admittedOrder({ status: "input-required", message: "Confirm the title." });
    // The service's answer is persisted, then the lifecycle bookkeeping fails.
    wire.faults.push("SET status=$2,updated_at=now(),version=version+1");
    const lost = await call("input", INPUT);
    expect([lost.status, lost.body]).toEqual([503, { error: "lifecycle_unavailable" }]);
    expect((await harness.database.pool.query("SELECT status FROM transactions WHERE id=$1", [order.providerTaskId]))
      .rows[0].status).toBe("working");
    const retry = await call("input", INPUT, T + 30);
    expect([retry.status, retry.body.state]).toEqual([200, "working"]);
    expect(calls.input).toBe(1);
    expect(await actions()).toEqual([{ action: "input", state: "committed", attempts: 2, outcome_state: "working" }]);
  });
});
