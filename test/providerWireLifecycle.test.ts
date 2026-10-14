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
const { encryptString } = await import("../src/core/chain/encryption.js");
const { canonicalJson } = await import("../src/core/standardRail/canonical.js");
const { WIRE_AUTHORIZATION_KEY, plantFrozenResult, startWireHarness, wire } = await import("./providerWireHarness.js");
const { context, expectWireAnswer, fixture, order, vector } = await import("./providerWireFixture.js");

/**
 * Drives full's lifecycle handler through every vendored lifecycle and
 * terminal-evidence vector a full provider answers: grant-attested read
 * capabilities and payer-signed authorizations, the frozen terminal identity
 * in every attestation, the protected-reveal artifact, input, cancellation
 * and the named refusals.
 */
const quote = fixture("quote.json");
const dispatch = fixture("dispatch.json");
const lifecycle = fixture("lifecycle.json");
const terminal = fixture("terminal-evidence.json");

let harness: Awaited<ReturnType<typeof startWireHarness>>;
let executeResult: AdapterResult = { status: "working" };
let inputResult: AdapterResult = { status: "working" };
let cancel: () => Promise<void> = async () => undefined;
const adapterCalls: string[] = [];

wire.adapter = {
  execute: async () => executeResult,
  handleInput: async () => { adapterCalls.push("handleInput"); return inputResult; },
  cancel: async () => { adapterCalls.push("cancel"); await cancel(); },
  quote: async () => ({ ok: true, amount: 250_000n, currency: "USDC" }),
} satisfies FulfillmentAdapter;

/** The context order, admitted through the real quote and dispatch handlers. */
async function admittedOrder(result: AdapterResult = { status: "working" }): Promise<void> {
  await harness.at(context.times.quote);
  expect((await harness.send(quote.requests["fixed-payer-lowercase"].http)).status).toBe(200);
  executeResult = result;
  await harness.at(context.times.dispatchAnswered);
  expect((await harness.send(dispatch.requests.initial.http)).status).toBe(200);
}

async function send(requestId: string) {
  const request = lifecycle.requests[requestId];
  await harness.at(request.gateway.now);
  return harness.send(request.http);
}

beforeAll(async () => {
  vi.spyOn(ProviderEvidenceVerifier.prototype, "verify").mockResolvedValue({ authorizationKey: WIRE_AUTHORIZATION_KEY });
  vi.spyOn(ProviderEvidenceVerifier.prototype, "assertNotSanctioned").mockResolvedValue();
  harness = await startWireHarness("provider_wire_lifecycle");
});

afterAll(async () => {
  vi.restoreAllMocks();
  await harness?.close();
});

beforeEach(async () => {
  await harness.reset();
  inputResult = { status: "working" };
  cancel = async () => undefined;
  adapterCalls.length = 0;
});

describe("provider-wire lifecycle reads", () => {
  it("answers a read-capability status of a working order with a fresh signed observation", async () => {
    await admittedOrder();
    expectWireAnswer(await send("status.read-capability.working"), vector(lifecycle, "status.working.accepted"));
  });

  it("attests the frozen unrevealed projection on a payer-signed status of a completed order", async () => {
    await admittedOrder();
    const expected = vector(lifecycle, "status.completed-task.accepted");
    await plantFrozenResult(harness.database, expected.provider);
    const answer = await send("status.payer-signed.completed");
    expectWireAnswer(answer, expected);
    // The rebuilt or revealed hashes the gateway would reject are never signed.
    for (const id of ["task-projection.revealed-hash.rejected", "task-projection.reconstructed.rejected"]) {
      expect(canonicalJson(JSON.parse(answer.text))).not.toBe(canonicalJson(vector(terminal, id).response.body));
    }
  });

  it("reveals the frozen protected reference only for the payer's own signature", async () => {
    await admittedOrder();
    const expected = vector(lifecycle, "artifact.protected-reveal.accepted");
    const artifact = "note_created";
    await plantFrozenResult(harness.database, expected.provider, [{ artifactName: artifact, fieldPath: "accessCode" }]);
    await harness.database.pool.query(
      `INSERT INTO artifact_secrets (transaction_id,artifact_name,field_path,secret,expires_at)
       VALUES ($1,$2,'accessCode',$3,now() + interval '3650 days')`,
      [order.providerTaskId, artifact, encryptString("synthetic-access-code-0001", {
        purpose: "customer-artifact", table: "artifact_secrets",
        recordId: `${order.providerTaskId}:${artifact}:accessCode`, field: "secret",
      })],
    );
    expectWireAnswer(await send("artifact.payer-signed.completed"), expected);
    // A read capability is not the payer's fresh signature: it reads the
    // unrevealed frozen projection, whose hash is the attested resultHash.
    const capability = JSON.parse((await send("artifact.read-capability.completed")).text) as {
      result: unknown; terminalAttestation: { payload: unknown };
    };
    expect(capability.result).toEqual(expected.provider.frozenResult);
    expect(capability.terminalAttestation.payload).toEqual(expected.response.body.terminalAttestation.payload);
  });

  it("refuses an unfinished artifact and an unavailable read with the named refusals", async () => {
    await admittedOrder();
    expectWireAnswer(await send("artifact.read-capability.working"), vector(lifecycle, "artifact.unavailable"));
    wire.faults.push("AND standard_payer IS NOT NULL");
    expectWireAnswer(await send("status.read-capability.working"), vector(lifecycle, "status.unavailable.read-capability"));
  });
});

describe("provider-wire lifecycle mutations", () => {
  it("hands buyer input to the service and answers the order working again", async () => {
    await admittedOrder({ status: "input-required", message: "Confirm the title." });
    expectWireAnswer(await send("input.payer-signed"), vector(lifecycle, "input.working.accepted"));
    expect(adapterCalls).toEqual(["handleInput"]);
  });

  it("cancels, freezes the canceled projection and attests it", async () => {
    await admittedOrder();
    expectWireAnswer(await send("cancel.payer-signed"), vector(lifecycle, "cancel.canceled.accepted"));
    expect(adapterCalls).toEqual(["cancel"]);
  });

  it("answers an uncertain cancellation with the retryable named refusal", async () => {
    await admittedOrder();
    cancel = async () => { throw new Error("supplier timeout"); };
    expectWireAnswer(await send("cancel.payer-signed"), vector(lifecycle, "cancel.unavailable.payer-signed"));
  });
});
