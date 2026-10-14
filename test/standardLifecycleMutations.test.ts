import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterResult, FulfillmentAdapter, TaskContext } from "../src/core/serviceRegistry/types.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });
vi.mock("../src/core/db/pool.js", async () => (await import("./providerWireHarness.js")).poolModule());
vi.mock("../src/core/serviceRegistry/registry.js", async () => (await import("./providerWireHarness.js")).registryModule());
vi.mock("../src/core/standardRail/identifiers.js", async () => (await import("./providerWireHarness.js")).identifiersModule());
vi.mock("../src/core/engine/preExecuteRunner.js", () => ({
  consultPreExecuteAgent: async () => ({ action: "proceed" }),
}));

const { ProviderEvidenceVerifier } = await import("../src/core/standardRail/evidence.js");
const { CancellationRefusedError } = await import("../src/core/serviceRegistry/types.js");
const { canonicalHash } = await import("../src/core/standardRail/canonical.js");
const { processAdapterResult } = await import("../src/core/engine/taskFinalization.js");
const { WIRE_AUTHORIZATION_KEY, startWireHarness, wire } = await import("./providerWireHarness.js");
const { context, fixture, keys, order } = await import("./providerWireFixture.js");
const { LIFECYCLE_HTTP, lifecycleBody } = await import("./lifecycleWire.js");
const { acceptDispatchResponse, signGatewayEnvelope } = await import("./gatewayConsumer.js");

// Lifecycle mutations claim the task with a status/version fence before any
// supplier-facing adapter call, act on the claimed row, and persist behind
// the same fence, so a racing worker's terminal state is never overwritten.
const quote = fixture("quote.json");
const dispatch = fixture("dispatch.json");
const T = context.times.midway;
let harness: Awaited<ReturnType<typeof startWireHarness>>;
let executeResult: AdapterResult = { status: "working" };
let onCancel: (task: TaskContext) => Promise<void> = async () => undefined;
let onInput: (task: TaskContext) => Promise<AdapterResult> = async () => ({ status: "working" });
const seen: TaskContext[] = [];

wire.adapter = {
  execute: async () => executeResult,
  handleInput: async (task) => { seen.push(task); return onInput(task); },
  cancel: async (task) => { seen.push(task); await onCancel(task); },
  quote: async () => ({ ok: true, amount: 250_000n, currency: "USDC" }),
} satisfies FulfillmentAdapter;

async function admittedOrder(result: AdapterResult): Promise<void> {
  await harness.at(context.times.quote);
  expect((await harness.send(quote.requests["fixed-payer-lowercase"].http)).status).toBe(200);
  executeResult = result;
  await harness.at(context.times.dispatchAnswered);
  expect((await harness.send(dispatch.requests.initial.http)).status).toBe(200);
}

async function call(action: string, request: Record<string, unknown> = {}) {
  await harness.at(T);
  const answer = await harness.send({
    url: LIFECYCLE_HTTP.url, headers: LIFECYCLE_HTTP.headers,
    body: await lifecycleBody({ action, request, form: "payer-signed", now: T }),
  });
  return { status: answer.status, body: JSON.parse(answer.text) as Record<string, unknown> };
}

const task = async () => (await harness.database.pool.query(
  "SELECT status,version FROM transactions WHERE id=$1", [order.providerTaskId])).rows[0] as { status: string; version: string };

async function dispatchStatusIdentity() {
  const query = await signGatewayEnvelope({
    artifactType: "DispatchStatusQueryV1", environment: context.environment, chainId: context.chainId,
    audience: context.provider.audience, signerKeyId: "gateway-dispatch", privateKey: keys.gatewayDispatch!.privateKey,
    issuedAt: T, validBefore: T + 60,
    payload: { orderId: order.orderId, dispatchHash: dispatch.requests.initial.dispatchHash, issuedAt: T, validBefore: T + 60 },
  });
  const answer = await harness.send({ url: context.provider.controlProfile.dispatchStatusUrl,
    headers: { "content-type": "application/json" }, body: { query } });
  const accepted = await acceptDispatchResponse(JSON.parse(answer.text), {
    dispatchHash: dispatch.requests.initial.dispatchHash, providerAuthorityKey: keys.providerAuthority!.address,
    terminalAttestationKey: keys.providerTerminalAttestation!.address, now: T,
  });
  const { dispatchHash: _hash, ...identity } = accepted.evidence!.payload;
  return identity;
}

beforeAll(async () => {
  vi.spyOn(ProviderEvidenceVerifier.prototype, "verify").mockResolvedValue({ authorizationKey: WIRE_AUTHORIZATION_KEY });
  vi.spyOn(ProviderEvidenceVerifier.prototype, "assertNotSanctioned").mockResolvedValue();
  harness = await startWireHarness("lifecycle_mutations");
});

afterAll(async () => {
  vi.restoreAllMocks();
  await harness?.close();
});

beforeEach(async () => {
  await harness.reset();
  seen.length = 0;
  onCancel = async () => undefined;
  onInput = async () => ({ status: "working" });
});

describe("lifecycle cancellation fencing", () => {
  it("claims before adapter.cancel, cancels the claimed row and attests the frozen identity both ways", async () => {
    await admittedOrder({ status: "working" });
    const loaded = await task();
    const canceled = await call("cancel");
    expect(canceled.status).toBe(200);
    expect(canceled.body.state).toBe("canceled");
    expect(seen[0]).toMatchObject({ id: order.providerTaskId, version: String(Number(loaded.version) + 1), supplierMutationStarted: true });
    const lifecycleIdentity = (canceled.body.terminalAttestation as { payload: Record<string, unknown> }).payload;
    const { orderId: _orderId, ...identity } = lifecycleIdentity;
    expect(await dispatchStatusIdentity()).toEqual(identity);
  });

  it("never calls the service when the claim is lost to a concurrent writer", async () => {
    await admittedOrder({ status: "working" });
    wire.beforeQuery = async (text) => {
      if (!text.includes("SET version=version+1,updated_at=now()")) return;
      wire.beforeQuery = null;
      await harness.database.pool.query("UPDATE transactions SET version=version+1 WHERE id=$1", [order.providerTaskId]);
    };
    const refused = await call("cancel");
    expect([refused.status, refused.body]).toEqual([503, { error: "lifecycle_unavailable" }]);
    expect(seen).toEqual([]);
  });

  it("never overwrites a terminal state a worker committed during the supplier call", async () => {
    await admittedOrder({ status: "working" });
    onCancel = async (claimed) => {
      await processAdapterResult(claimed.id, { status: "completed", message: "Done first." }, claimed.service_id);
    };
    const refused = await call("cancel");
    expect([refused.status, refused.body]).toEqual([503, { error: "lifecycle_unavailable" }]);
    expect((await task()).status).toBe("completed");
    const frozen = await harness.database.pool.query("SELECT state FROM standard_terminal_results WHERE transaction_id=$1",
      [order.providerTaskId]);
    expect(frozen.rows[0]?.state).toBe("completed");
  });

  it("refuses a terminal order and a service refusal as unsupported, without changing state", async () => {
    await admittedOrder({ status: "working" });
    onCancel = async () => { throw new CancellationRefusedError("already provisioned"); };
    const refusedByService = await call("cancel");
    expect([refusedByService.status, refusedByService.body]).toEqual([409, { error: "unsupported_action" }]);
    expect((await task()).status).toBe("working");

    await harness.reset();
    seen.length = 0;
    await admittedOrder({ status: "completed", message: "Done." });
    const before = await task();
    const terminal = await call("cancel");
    expect([terminal.status, terminal.body]).toEqual([409, { error: "unsupported_action" }]);
    expect(seen).toEqual([]);
    expect(await task()).toEqual(before);
  });
});

describe("lifecycle input fencing", () => {
  it("claims before adapter.handleInput and answers a completion with the frozen projection inline", async () => {
    await admittedOrder({ status: "input-required", message: "Confirm the title." });
    const loaded = await task();
    onInput = async () => ({
      status: "completed", message: "Note created.",
      artifacts: [{ name: "note_created", data: { note: "note-0001", title: "Synthetic fixture note", characters: 48 } }],
    });
    const answer = await call("input", { inputText: "Keep it.", data: { title: "Synthetic fixture note" } });
    expect(answer.status).toBe(200);
    expect(seen[0]).toMatchObject({ version: String(Number(loaded.version) + 1) });
    expect(answer.body.state).toBe("completed");
    const attestation = answer.body.terminalAttestation as { payload: { resultHash: string } };
    expect(attestation.payload.resultHash).toBe(canonicalHash(answer.body.result));
  });

  it("refuses input that changes the payer-committed request without calling the service", async () => {
    await admittedOrder({ status: "input-required", message: "Confirm the title." });
    const refused = await call("input", { inputText: "Change it.", data: { title: "Another title" } });
    expect([refused.status, refused.body]).toEqual([409, { error: "unsupported_action" }]);
    expect(seen).toEqual([]);
    expect((await task()).status).toBe("input-required");
  });
});
