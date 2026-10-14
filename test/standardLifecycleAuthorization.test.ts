import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Hex } from "viem";
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
const { ERC1271_MAGIC_RETURN, resetPayerSignatureDefaults } = await import("../src/core/standardRail/payerSignature.js");
const { config: coreConfig } = await import("../src/core/config.js");
const { WIRE_AUTHORIZATION_KEY, startWireHarness, wire } = await import("./providerWireHarness.js");
const { context, fixture, keys, order } = await import("./providerWireFixture.js");
const { LIFECYCLE_HTTP, lifecycleBody } = await import("./lifecycleWire.js");

// C-T03, F-T07 and F-T10 through the real HTTP stack: both authorization
// forms read, forged and cross-order calls and read-capability mutations
// fail before anything is read or changed, contract-account payers verify
// through the bounded verifier after the grant, and every refusal is named.
const quote = fixture("quote.json");
const dispatch = fixture("dispatch.json");
const T = context.times.lifecycleCompleted;
let harness: Awaited<ReturnType<typeof startWireHarness>>;
let executeResult: AdapterResult = { status: "working" };
const adapterCalls: string[] = [];
const completed: AdapterResult = {
  status: "completed", message: "Note created.",
  artifacts: [{ name: "note_created", data: { note: "note-0001", title: "Synthetic fixture note", characters: 48 } }],
};

wire.adapter = {
  execute: async () => executeResult,
  handleInput: async () => { adapterCalls.push("handleInput"); return { status: "working" }; },
  cancel: async () => { adapterCalls.push("cancel"); },
  quote: async () => ({ ok: true, amount: 250_000n, currency: "USDC" }),
} satisfies FulfillmentAdapter;

async function admittedOrder(result: AdapterResult): Promise<void> {
  await harness.at(context.times.quote);
  expect((await harness.send(quote.requests["fixed-payer-lowercase"].http)).status).toBe(200);
  executeResult = result;
  await harness.at(context.times.dispatchAnswered);
  expect((await harness.send(dispatch.requests.initial.http)).status).toBe(200);
}

async function call(options: Parameters<typeof lifecycleBody>[0], headers: Record<string, string> = LIFECYCLE_HTTP.headers) {
  await harness.at(options.now);
  const answer = await harness.send({ url: LIFECYCLE_HTTP.url, headers, body: await lifecycleBody(options) });
  return { ...answer, body: answer.text ? JSON.parse(answer.text) as Record<string, unknown> : null };
}

const taskVersion = async () => (await harness.database.pool.query(
  "SELECT status,version FROM transactions WHERE id=$1", [order.providerTaskId])).rows[0];

beforeAll(async () => {
  vi.spyOn(ProviderEvidenceVerifier.prototype, "verify").mockResolvedValue({ authorizationKey: WIRE_AUTHORIZATION_KEY });
  vi.spyOn(ProviderEvidenceVerifier.prototype, "assertNotSanctioned").mockResolvedValue();
  // Purchase and per-client budgets are tiny and not bypassed, so any
  // servicing call that spent them would be refused.
  harness = await startWireHarness("lifecycle_authorization", {
    RATE_LIMIT_BYPASS_IPS: "", RATE_LIMIT_GLOBAL_CAPACITY: 4, RATE_LIMIT_GLOBAL_PER_MIN: 1,
    RATE_LIMIT_A2A_CAPACITY: 3, RATE_LIMIT_A2A_PER_MIN: 1,
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await harness?.close();
});

beforeEach(async () => {
  await harness.reset();
  adapterCalls.length = 0;
});

describe("lifecycle authorization (C-T03)", () => {
  it("serves status and artifact reads under a read capability and under the payer's signature", async () => {
    await admittedOrder(completed);
    for (const form of ["read-capability", "payer-signed"] as const) {
      const status = await call({ action: "status", form, now: T });
      expect(status.status).toBe(200);
      expect(Object.keys(status.body!).sort()).toEqual(["operations", "orderId", "signature", "state", "taskId", "terminalAttestation"]);
      const artifact = await call({ action: "artifact", form, now: T });
      expect(artifact.status).toBe(200);
      expect(artifact.body!.result).toMatchObject({ id: order.providerTaskId, status: { state: "TASK_STATE_COMPLETED" } });
      expect(artifact.body!.terminalAttestation).toEqual(status.body!.terminalAttestation);
    }
  });

  it("refuses forged grants, cross-order calls and another signer before reading any state", async () => {
    await admittedOrder(completed);
    const otherOrder = "ord_00000000-0000-4000-8000-0000000000ff";
    for (const options of [
      { action: "status", now: T, grantKey: keys.unrecognized!.privateKey },
      { action: "status", now: T, grantKey: keys.gatewayDispatch!.privateKey },
      { action: "status", form: "payer-signed" as const, now: T, payerKey: keys.unrecognized!.privateKey },
      { action: "status", now: T, orderId: otherOrder, taskId: order.providerTaskId },
    ]) {
      wire.statements.length = 0;
      const refused = await call(options);
      expect(refused.status).toBe(401);
      expect(refused.body).toEqual({ error: "lifecycle_rejected" });
      if (!options.orderId) expect(wire.statements.filter((sql) => /transactions|standard_/.test(sql))).toEqual([]);
    }
  });

  it("never lets a read capability mutate the order (F-T07)", async () => {
    await admittedOrder({ status: "input-required", message: "Confirm the title." });
    const before = await taskVersion();
    for (const [action, request] of [
      ["cancel", {}],
      ["input", { inputText: "yes", data: { title: "Synthetic fixture note" } }],
      ["support", { requestId: "support-1", message: "Hello" }],
    ] as const) {
      const refused = await call({ action, request, now: T });
      expect(refused.status).toBe(401);
      expect(refused.body).toEqual({ error: "lifecycle_rejected" });
    }
    expect(adapterCalls).toEqual([]);
    expect(await taskVersion()).toEqual(before);
  });
});

describe("contract-account payers through the bounded verifier (F-T07)", () => {
  let rpc: Server;
  let calls = 0;
  let answer: "magic" | "revert" | "down" = "magic";
  const contractSignature = `0x${"ab".repeat(130)}` as Hex;

  beforeAll(async () => {
    rpc = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        calls += 1;
        const { method } = JSON.parse(raw) as { method: string };
        if (answer === "down") { res.writeHead(503); res.end(); return; }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(method === "eth_getCode"
          ? { jsonrpc: "2.0", id: 1, result: "0x6080" }
          : answer === "magic"
            ? { jsonrpc: "2.0", id: 1, result: ERC1271_MAGIC_RETURN }
            : { jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted" } }));
      });
    }).listen(0, "127.0.0.1");
    await once(rpc, "listening");
    Object.assign(coreConfig, {
      PAYER_ACCOUNT_TYPES: "eoa,contract", PAYER_SIGNATURE_VERIFY_TIMEOUT_MS: 2_000,
      BASE_RPC_URL: `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`, BASE_RPC_FALLBACK_URLS: "",
    });
    resetPayerSignatureDefaults();
  });

  afterAll(async () => {
    Object.assign(coreConfig, { PAYER_ACCOUNT_TYPES: "eoa", BASE_RPC_URL: "https://sepolia.base.org" });
    resetPayerSignatureDefaults();
    await new Promise<void>((resolve) => rpc.close(() => resolve()));
  });

  beforeEach(() => {
    calls = 0;
    answer = "magic";
  });

  it("accepts the exact magic value, refuses a revert, and keeps an outage retryable without spending the nonce", async () => {
    await admittedOrder(completed);
    const nonce = `0x${"5a".repeat(32)}` as Hex;
    answer = "down";
    const unavailable = await call({ action: "status", form: "payer-signed", now: T, signature: contractSignature, nonce });
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toEqual({ error: "lifecycle_unavailable" });
    expect((await harness.database.pool.query("SELECT count(*)::int AS n FROM standard_action_nonces")).rows[0].n).toBe(0);
    answer = "magic";
    expect((await call({ action: "status", form: "payer-signed", now: T, signature: contractSignature, nonce })).status).toBe(200);
    answer = "revert";
    const invalid = await call({ action: "status", form: "payer-signed", now: T, signature: contractSignature });
    expect(invalid.status).toBe(401);
  });

  it("verifies the gateway grant before any chain call", async () => {
    await admittedOrder(completed);
    const forged = await call({
      action: "status", form: "payer-signed", now: T, signature: contractSignature, grantKey: keys.unrecognized!.privateKey,
    });
    expect(forged.status).toBe(401);
    expect(calls).toBe(0);
  });
});

describe("named refusals and negotiated views (F-T10)", () => {
  it("adds no optional view, negotiated or not, and refuses unfinished or untraceable artifacts", async () => {
    await admittedOrder({ status: "working" });
    for (const headers of [LIFECYCLE_HTTP.headers, { "content-type": "application/json" }]) {
      const status = await call({ action: "status", now: T }, headers);
      expect(status.status).toBe(200);
      expect(Object.keys(status.body!).sort()).toEqual(["operations", "orderId", "signature", "state", "taskId"]);
    }
    const unfinished = await call({ action: "artifact", now: T });
    expect([unfinished.status, unfinished.body]).toEqual([409, { error: "artifact_unavailable" }]);
    const unknown = await call({ action: "confirmation", form: "payer-signed", now: T });
    expect([unknown.status, unknown.body]).toEqual([409, { error: "unsupported_action" }]);
  });

  it("answers a terminal order without a frozen identity as unavailable, never with a guess", async () => {
    await admittedOrder({ status: "working" });
    await harness.database.pool.query("UPDATE transactions SET status='completed',completed_at=now() WHERE id=$1",
      [order.providerTaskId]);
    for (const action of ["status", "artifact"]) {
      const refused = await call({ action, now: T });
      expect([refused.status, refused.body]).toEqual([503, { error: "lifecycle_unavailable" }]);
    }
  });

  it("serves repeated reads while sales and the product are paused, without spending purchase limits", async () => {
    await admittedOrder({ status: "working" });
    wire.readinessFailures.push("synthetic product outage");
    await harness.database.pool.query("UPDATE services SET is_active=false");
    const buckets = async () => (await harness.database.pool.query(
      "SELECT bucket_key,tokens FROM rate_limit_buckets ORDER BY bucket_key")).rows;
    const before = await buckets();
    // The quote and dispatch above did spend the per-client budgets.
    expect(before.length).toBeGreaterThan(0);
    for (let read = 0; read < 25; read += 1) {
      expect((await call({ action: "status", now: T })).status).toBe(200);
    }
    expect(await buckets()).toEqual(before);
    await harness.database.pool.query("UPDATE services SET is_active=true");
  });
});

// Keep this suite last: it exhausts the authentication-failure budget for its
// one-minute window.
describe("the lifecycle authentication-failure budget", () => {
  it("is spent only by calls no verified gateway grant binds, never by one buyer's refused authorizations", async () => {
    await admittedOrder({ status: "working" });
    const at = T + 3_600;
    const nonce = `0x${"42".repeat(32)}` as Hex;
    expect((await call({ action: "status", form: "payer-signed", now: at, nonce })).status).toBe(200);
    // Replays of one payer authorization through the gateway's shared address.
    for (let replay = 0; replay < 35; replay += 1) {
      expect((await call({ action: "status", form: "payer-signed", now: at, nonce })).status).toBe(401);
    }
    expect((await call({ action: "status", now: at })).status).toBe(200);
    for (let forged = 0; forged < 30; forged += 1) {
      expect((await call({ action: "status", now: at, grantKey: keys.unrecognized!.privateKey })).status).toBe(401);
    }
    const exhausted = await call({ action: "status", now: at });
    expect([exhausted.status, exhausted.body]).toEqual([429, { error: "rate_limit_exceeded" }]);
  });
});
