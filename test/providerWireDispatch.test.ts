import type { Hex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterResult, FulfillmentAdapter, QuoteResult } from "../src/core/serviceRegistry/types.js";

// Database-backed protocol tests: allow for a loaded shared host.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });
const gate = vi.hoisted(() => ({ preExecute: null as Promise<void> | null }));
vi.mock("../src/core/db/pool.js", async () => (await import("./providerWireHarness.js")).poolModule());
vi.mock("../src/core/serviceRegistry/registry.js", async () => (await import("./providerWireHarness.js")).registryModule());
vi.mock("../src/core/standardRail/identifiers.js", async () => (await import("./providerWireHarness.js")).identifiersModule());
vi.mock("../src/core/engine/preExecuteRunner.js", () => ({
  consultPreExecuteAgent: async () => {
    if (gate.preExecute) await gate.preExecute;
    return { action: "proceed" };
  },
}));

const { ProviderEvidenceVerifier } = await import("../src/core/standardRail/evidence.js");
const { acceptDispatchResponse, acceptIntakeResponse, readGatewayJson } = await import("./gatewayConsumer.js");
const { WIRE_AUTHORIZATION_KEY, plantFrozenResult, startWireHarness, wire } = await import("./providerWireHarness.js");
const fx = await import("./providerWireFixture.js");
const { context, expectWireAnswer, fixture, keys, order, vector } = fx;

/**
 * Drives full's quote, intake, dispatch and dispatch-status handlers through
 * every vendored provider-wire vector a full provider answers (README
 * "Matching an answer exactly"). `rejected` and `ambiguous` vectors show
 * answers the gateway refuses; full produces one of them only where a vector
 * pins the provider's own skewed clock.
 */
const quote = fixture("quote.json");
const intake = fixture("intake.json");
const dispatch = fixture("dispatch.json");
const status = fixture("dispatch-status.json");

let harness: Awaited<ReturnType<typeof startWireHarness>>;
let executeResult: AdapterResult = { status: "working" };
let dynamicAmount = 400_000n;

const adapter: FulfillmentAdapter = {
  execute: async () => executeResult,
  handleInput: async () => ({ status: "working" }),
  cancel: async () => undefined,
  quote: async (skillId): Promise<QuoteResult> => ({
    ok: true, amount: skillId === "create-quoted-note" ? dynamicAmount : 250_000n, currency: "USDC",
  }),
  intake: async () => ({
    requiredFields: {}, selectorsRequired: [], normalizedSelectors: {}, fieldErrors: [], supported: true,
  }),
};

async function claims(): Promise<Array<{ transaction_id: string; dispatch_hash: Buffer }>> {
  return (await harness.database.pool.query("SELECT transaction_id,dispatch_hash FROM standard_dispatch_claims")).rows;
}

/** The provider quote the context order's QuoteV1 names, persisted by the real handler. */
async function persistOrderQuote(): Promise<void> {
  await harness.at(context.times.quote);
  expectWireAnswer(await harness.send(quote.requests["fixed-payer-lowercase"].http),
    vector(quote, "fixed.payer-lowercase.accepted"));
  const stored = await harness.database.pool.query("SELECT encode(quote_hash,'hex') AS hash FROM standard_provider_quotes");
  expect(stored.rows.map((row) => `0x${row.hash}`)).toContain(order.providerQuoteHash);
}

beforeAll(async () => {
  vi.spyOn(ProviderEvidenceVerifier.prototype, "verify").mockResolvedValue({ authorizationKey: WIRE_AUTHORIZATION_KEY });
  vi.spyOn(ProviderEvidenceVerifier.prototype, "assertNotSanctioned").mockResolvedValue();
  wire.adapter = adapter;
  harness = await startWireHarness("provider_wire_dispatch");
});

afterAll(async () => {
  vi.restoreAllMocks();
  await harness?.close();
});

beforeEach(async () => {
  await harness.reset();
  executeResult = { status: "working" };
  dynamicAmount = 400_000n;
  gate.preExecute = null;
});

describe("provider-wire quote and intake vectors", () => {
  it("answers fixed quotes byte for byte at every provider clock the fixtures name", async () => {
    // A 120-second quote with the literal payer echo; at 31 s of skew the
    // same rule yields exactly the answers the gateway refuses at receipt.
    for (const id of [
      "fixed.payer-lowercase.accepted", "fixed.payer-null.accepted",
      "fixed.issued-30s-before-receipt.accepted", "fixed.issued-30s-after-receipt.accepted",
      "fixed.issued-31s-before-receipt.rejected", "fixed.issued-31s-after-receipt.rejected",
    ]) {
      const expected = vector(quote, id);
      await harness.at(expected.provider.now);
      expectWireAnswer(await harness.send(quote.requests[expected.request].http), expected);
    }
  });

  it("answers dynamic quotes under the admitted policy and never signs below the releasable minimum", async () => {
    await harness.at(context.times.quote);
    expectWireAnswer(await harness.send(quote.requests["dynamic-payer-lowercase"].http), vector(quote, "dynamic.accepted"));
    // The admitted dynamic policy may be shorter than the catalog maximum.
    const { createProviderApp } = await import("../src/core/server.js");
    const shorter = createProviderApp(
      fx.wireConfig([fx.wireOutcome(fx.dynamicListing, { quoteMaximumLifetimeSeconds: 120 })]),
      undefined, { salesAdmission: async () => ({ status: "open" as const }) },
    );
    const server = shorter.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    try {
      const port = (server.address() as { port: number }).port;
      const send = async (amount: bigint) => {
        dynamicAmount = amount;
        const http = quote.requests["dynamic-payer-lowercase"].http;
        const response = await fetch(`http://127.0.0.1:${port}/standard-rail/quote`, {
          method: "POST", headers: http.headers, body: http.bodyText,
        });
        return { status: response.status, contentType: response.headers.get("content-type"),
          contentEncoding: response.headers.get("content-encoding"), text: await response.text() };
      };
      expectWireAnswer(await send(20n), vector(quote, "dynamic.minimum-releasable.accepted"));
      const below = await send(19n);
      expect(below.status).toBe(422);
      expect(JSON.parse(below.text)).toMatchObject({ error: "quote_rejected", reason: "price" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("answers intake on the quote URL without storing a quote", async () => {
    const expected = vector(intake, "accepted");
    await harness.at(expected.provider.now);
    const answer = await harness.send(intake.requests.intake.http);
    expectWireAnswer(answer, expected);
    await acceptIntakeResponse(JSON.parse(answer.text), {
      outcomeId: fx.fixedListing.outcomeId, listingManifestHash: fx.fixedListing.listingManifestHash,
      requestHash: expected.provider.requestHash, requestSchema: fx.fixedListing.requestSchema,
      providerAuthorityKey: keys.providerAuthority!.address, now: expected.gateway.receivedAt,
    });
    expect((await harness.database.pool.query("SELECT 1 FROM standard_provider_quotes")).rowCount).toBe(0);
  });
});

describe("provider-wire dispatch vectors", () => {
  it("admits the initial dispatch working or input-required with the vectors' signed bytes", async () => {
    for (const [id, result] of [
      ["working.accepted", { status: "working" }],
      ["input-required.accepted", { status: "input-required", message: "Which folder?" }],
    ] as const) {
      await harness.reset();
      await persistOrderQuote();
      executeResult = result as AdapterResult;
      const expected = vector(dispatch, id);
      await harness.at(expected.provider.now);
      expectWireAnswer(await harness.send(dispatch.requests.initial.http), expected);
      expect((await claims()).map((claim) => claim.transaction_id)).toEqual([order.providerTaskId]);
    }
  });

  it("answers an exact replay of an admitted, not yet started order as submitted", async () => {
    await persistOrderQuote();
    let release!: () => void;
    gate.preExecute = new Promise<void>((resolve) => { release = resolve; });
    const expected = vector(dispatch, "submitted.accepted");
    await harness.at(expected.provider.now);
    const first = harness.send(dispatch.requests.initial.http);
    await vi.waitFor(async () => expect(await claims()).toHaveLength(1), { timeout: 10_000 });
    expectWireAnswer(await harness.send(dispatch.requests.initial.http), expected);
    release();
    expect((await first).status).toBe(200);
  });

  it("stamps the database clock faithfully, inside and beyond the gateway's freshness window", async () => {
    for (const id of [
      "accepted.operations-300s-old", "accepted.operations-30s-ahead",
      "rejected.operations-301s-old", "rejected.operations-31s-ahead",
    ]) {
      await harness.reset();
      await persistOrderQuote();
      const expected = vector(dispatch, id);
      await harness.at(expected.provider.now, expected.provider.operations.observedAt);
      expectWireAnswer(await harness.send(dispatch.requests.initial.http), expected);
    }
  });

  it("refuses definitely before admission and answers uncertainty with the empty 503", async () => {
    // No persisted provider quote: the QuoteV1 binding cannot be proven.
    const quoteWindow = vector(dispatch, "refused.quote-window");
    await harness.at(quoteWindow.provider.now);
    expectWireAnswer(await harness.send(dispatch.requests.initial.http), quoteWindow);
    expect(await claims()).toHaveLength(0);

    await persistOrderQuote();
    wire.readinessFailures.push("synthetic product outage");
    const unavailable = vector(dispatch, "refused.service-unavailable");
    await harness.at(unavailable.provider.now);
    expectWireAnswer(await harness.send(dispatch.requests.initial.http), unavailable);
    expect(await claims()).toHaveLength(0);

    // The gateway's fresh envelope after the refusal is admitted.
    wire.readinessFailures.length = 0;
    const retry = dispatch.requests["retry-after-refusal"];
    await harness.at(retry.gateway.now);
    const admitted = await harness.send(retry.http);
    expect(admitted.status).toBe(200);
    await acceptDispatchResponse(JSON.parse(admitted.text), {
      dispatchHash: retry.dispatchHash, providerAuthorityKey: keys.providerAuthority!.address,
      terminalAttestationKey: keys.providerTerminalAttestation!.address, now: retry.gateway.now,
    });

    await harness.reset();
    await persistOrderQuote();
    wire.faults.push("FROM standard_dispatch_claims WHERE gateway_audience=$1 AND order_id=$2");
    const ambiguous = vector(dispatch, "ambiguous.empty-503");
    await harness.at(ambiguous.provider.now);
    expectWireAnswer(await harness.send(dispatch.requests.initial.http), ambiguous);
  });

  it("admits a timely-paid order dispatched for the first time 26 hours after its quote", async () => {
    await persistOrderQuote();
    const delayed = dispatch.requests["delayed-first-dispatch"];
    await harness.at(delayed.gateway.now);
    const answer = await harness.send(delayed.http);
    expect(answer.status).toBe(200);
    const accepted = await acceptDispatchResponse(JSON.parse(answer.text), {
      dispatchHash: delayed.dispatchHash, providerAuthorityKey: keys.providerAuthority!.address,
      terminalAttestationKey: keys.providerTerminalAttestation!.address, now: delayed.gateway.now,
    });
    expect(accepted.body).toMatchObject({ taskId: order.providerTaskId, state: "working" });
    expect(`0x${(await claims())[0]!.dispatch_hash.toString("hex")}`).toBe(delayed.dispatchHash);
  });
});

describe("provider-wire dispatch-status vectors", () => {
  it("answers a status poll for the original hash with a fresh signed snapshot", async () => {
    await persistOrderQuote();
    await harness.at(context.times.dispatchAnswered);
    expect((await harness.send(dispatch.requests.initial.http)).status).toBe(200);
    const expected = vector(status, "working.accepted");
    await harness.at(expected.provider.now);
    expectWireAnswer(await harness.send(status.requests.working.http), expected);
  });

  it("answers a completed full order with the frozen unrevealed projection's identity", async () => {
    await persistOrderQuote();
    await harness.at(context.times.dispatchAnswered);
    expect((await harness.send(dispatch.requests.initial.http)).status).toBe(200);
    const expected = vector(status, "completed-task.accepted");
    await plantFrozenResult(harness.database, expected.provider);
    await harness.at(expected.provider.now);
    expectWireAnswer(await harness.send(status.requests.completed.http), expected);
  });

  it("proves absence with the no-claim 404 only after an authoritative lookup", async () => {
    for (const id of ["no-claim.within-grace", "no-claim.after-grace"]) {
      const expected = vector(status, id);
      await harness.at(expected.provider.now);
      wire.statements.length = 0;
      expectWireAnswer(await harness.send(status.requests[expected.request].http), expected);
      expect(wire.statements.some((sql) => sql.includes("standard_dispatch_claims"))).toBe(true);
    }
  });

  it("keeps an unchanged pending order at revision 0 across six minutes and eight hours", async () => {
    const sequence = fixture("operations.json").sequences
      .find((entry: { id: string }) => entry.id === "all-null-constant-revision");
    await persistOrderQuote();
    await harness.at(context.times.dispatchAnswered);
    expect((await harness.send(dispatch.requests.initial.http)).status).toBe(200);
    const { signGatewayEnvelope } = await import("./gatewayConsumer.js");
    for (const step of sequence.steps as Array<{ now: number; operations: Record<string, unknown> }>) {
      await harness.at(step.now);
      const query = await signGatewayEnvelope({
        artifactType: "DispatchStatusQueryV1", environment: context.environment, chainId: context.chainId,
        audience: context.provider.audience, signerKeyId: "gateway-dispatch",
        privateKey: keys.gatewayDispatch!.privateKey as Hex, issuedAt: step.now, validBefore: step.now + 60,
        payload: {
          orderId: order.orderId, dispatchHash: dispatch.requests.initial.dispatchHash,
          issuedAt: step.now, validBefore: step.now + 60,
        },
      });
      const answer = await harness.send({
        url: context.provider.controlProfile.dispatchStatusUrl,
        headers: { "content-type": "application/json" }, body: { query },
      });
      const body = await readGatewayJson(new Response(answer.text, {
        status: answer.status, headers: { "content-type": answer.contentType ?? "" },
      })) as { operations: unknown };
      expect(body.operations).toEqual(step.operations);
    }
  });
});
