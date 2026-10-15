import { randomBytes } from "node:crypto";
import type pg from "pg";
import { getAddress, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import type { FulfillmentAdapter, TaskContext } from "../src/core/serviceRegistry/types.js";
import { gatewayDispatch, gatewayQuoteV1 } from "./dispatchWire.js";
import { paidOrderHarness } from "./paidOrderHarness.js";
import { createMigratedDatabase, DATABASE_HOOK_TIMEOUT_MS, type DisposableDatabase } from "./postgresHarness.js";
import {
  CHAIN_ID, dynamicOutcome, fixedOutcome, fixtureConfig, hash, payerA, payerB, seedFixtureService,
} from "./standardRailFixture.js";

// Database-backed protocol tests: allow for a loaded shared host.
vi.setConfig({ testTimeout: 30_000 });
const h = vi.hoisted(() => ({
  pool: null as pg.Pool | null,
  adapter: null as unknown as FulfillmentAdapter,
  depositTimestamp: null as number | null,
}));
vi.mock("../src/core/db/pool.js", () => ({
  pool: {
    query: (...args: unknown[]) => (h.pool!.query as (...a: unknown[]) => unknown)(...args),
    connect: () => h.pool!.connect(),
  },
}));
vi.mock("../src/core/serviceRegistry/registry.js", () => ({
  getAdapter: () => h.adapter,
  getService: () => null,
  getAllServices: () => [],
}));
vi.mock("../src/core/engine/preExecuteRunner.js", () => ({
  consultPreExecuteAgent: async () => ({ action: "proceed" }),
}));

const { StandardDispatchService } = await import("../src/core/standardRail/dispatch.js");
const { StandardQuoteService } = await import("../src/core/standardRail/quote.js");
const { ProviderEvidenceVerifier } = await import("../src/core/standardRail/evidence.js");
const { assertDepositWithinQuoteWindow } = await import("../src/core/standardRail/paymentBinding.js");

const config = fixtureConfig();
let database: DisposableDatabase;
const request = { item: "widget" };
const supplierCost = { supplier: "synthetic-supplier", currency: "USD", amount: "4.25" };
const ceiling = {
  kind: "supplier-cost-ceiling-v2" as const, supplier: "synthetic-supplier", currency: "USD",
  quotedAmount: "4.25", tolerancePercent: "10",
};

function adapter(): FulfillmentAdapter {
  return {
    execute: vi.fn(async () => ({ status: "completed" as const, artifacts: [{ name: "receipt", data: { ok: true } }] })),
    handleInput: vi.fn(),
    cancel: vi.fn(),
    quote: vi.fn(async (skillId: string) => ({
      ok: true as const,
      amount: skillId === fixedOutcome.skillId ? 250_000n : 1_234_567n,
      currency: "USDC" as const,
      ...(skillId === dynamicOutcome.skillId ? { supplierCost } : {}),
    })),
  };
}

beforeAll(async () => {
  database = await createMigratedDatabase("dispatch_binding");
  h.pool = database.pool;
  await seedFixtureService(database.pool, { skillIds: [fixedOutcome.skillId, dynamicOutcome.skillId] });
}, DATABASE_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await database?.drop();
}, DATABASE_HOOK_TIMEOUT_MS);

beforeEach(() => {
  h.adapter = adapter();
  h.depositTimestamp = null;
  vi.spyOn(ProviderEvidenceVerifier.prototype, "verify").mockImplementation(async ({ quote }) => {
    // The production verifier proves settlement time from the authenticated
    // deposit block; the synthetic chain supplies only that timestamp.
    assertDepositWithinQuoteWindow(h.depositTimestamp ?? quote.issuedAt + 5, quote);
    return { authorizationKey: `0x${randomBytes(32).toString("hex")}` as Hex };
  });
  vi.spyOn(ProviderEvidenceVerifier.prototype, "assertNotSanctioned").mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const { paidOrder } = paidOrderHarness({
  config, request, quoteService: () => new StandardQuoteService(config, CHAIN_ID),
});

const service = () => new StandardDispatchService(config, baseSepolia, CHAIN_ID);

async function claimRow(orderId: string) {
  return (await database.pool.query(
    `SELECT encode(provider_quote_hash,'hex') AS provider_quote_hash,t.metadata
       FROM standard_dispatch_claims c JOIN transactions t ON t.id=c.transaction_id
      WHERE c.order_id=$1`, [orderId],
  )).rows[0] as { provider_quote_hash: string; metadata: Record<string, unknown> } | undefined;
}

describe("dispatch verifies the persisted provider quote for both pricing modes (F-T01)", () => {
  it("admits a fixed-price order bound to its nonzero provider quote hash", async () => {
    const args = await paidOrder();
    const response = await service().accept(args);
    expect(response.state).toBe("completed");
    expect((await claimRow(args.dispatch.payload.orderId))?.provider_quote_hash)
      .toBe(args.quote.payload.providerQuoteHash.slice(2));
  });

  it("admits a dynamic order and carries its admitted supplier-cost ceiling into fulfillment", async () => {
    const args = await paidOrder({ outcome: dynamicOutcome });
    await service().accept(args);
    const task = vi.mocked(h.adapter.execute).mock.calls[0]?.[1] as TaskContext;
    expect(task.supplierCostCeiling).toEqual(ceiling);
    expect((await claimRow(args.dispatch.payload.orderId))?.metadata.supplier_cost_ceiling).toEqual(ceiling);
  });

  it("compares the lowercase quote payer with the checksummed dispatch payer as addresses", async () => {
    const args = await paidOrder({ dispatchPayer: getAddress(payerA) });
    await expect(service().accept(args)).resolves.toMatchObject({ state: "completed" });
  });

  it("refuses a dispatch for a different payer than the bound quote", async () => {
    const args = await paidOrder({ dispatchPayer: payerB });
    await expect(service().accept(args)).rejects.toMatchObject({ reason: "price" });
    expect(h.adapter.execute).not.toHaveBeenCalled();
  });

  it("admits any payer for a payer-unbound readiness quote", async () => {
    const args = await paidOrder({ quotePayer: null, dispatchPayer: payerB });
    await expect(service().accept(args)).resolves.toMatchObject({ state: "completed" });
  });

  it("refuses the retired zero provider quote hash and an unknown quote", async () => {
    for (const [providerQuoteHash, reason] of [[hash("0"), "price"], [hash("1"), "quote_window"]] as const) {
      const quote = await gatewayQuoteV1({
        outcome: fixedOutcome, request,
        providerQuote: {
          providerQuoteHash, grossAmount: fixedOutcome.fixedGrossAmount,
          issuedAt: Math.floor(Date.now() / 1_000), validBefore: Math.floor(Date.now() / 1_000) + 100,
        },
      });
      const args = await gatewayDispatch({
        outcome: fixedOutcome, quote, request, payer: payerA,
        reputationContract: config.reputationContract, outcomeSchemaUid: config.reputationOutcomeSchemaUid,
      });
      await expect(service().accept(args)).rejects.toMatchObject({ reason });
    }
    expect(h.adapter.execute).not.toHaveBeenCalled();
  });

  it("refuses a gateway quote window the provider quote does not cover", async () => {
    const args = await paidOrder({ gatewayValidBefore: (validBefore) => validBefore + 1 });
    await expect(service().accept(args)).rejects.toMatchObject({ reason: "quote_window" });
  });

  it("refuses a request that differs from the quoted one", async () => {
    const args = await paidOrder();
    const changed = await gatewayDispatch({
      outcome: fixedOutcome, quote: args.quote, request: { item: "other" }, payer: payerA,
      reputationContract: config.reputationContract, outcomeSchemaUid: config.reputationOutcomeSchemaUid,
    });
    await expect(service().accept(changed)).rejects.toMatchObject({ reason: "price" });
  });

  it("refuses a persisted quote row that no longer reproduces its signed hash", async () => {
    const args = await paidOrder({ quotePayer: null });
    await database.pool.query(
      "UPDATE standard_provider_quotes SET payer=$2 WHERE quote_hash=$1",
      [Buffer.from(args.quote.payload.providerQuoteHash.slice(2), "hex"), payerB.toLowerCase()],
    );
    await expect(service().accept(args)).rejects.toMatchObject({ reason: "price" });
  });

  it("still admits a dynamic quote persisted by an earlier release without a payer field", async () => {
    const issuedAt = Math.floor(Date.now() / 1_000);
    const legacy = {
      outcomeId: dynamicOutcome.outcomeId, listingManifestHash: dynamicOutcome.listingManifestHash,
      requestHash: canonicalHash(request), grossAmount: "1234567", issuedAt, validBefore: issuedAt + 180,
    };
    const legacyHash = canonicalHash(legacy);
    await database.pool.query(
      `INSERT INTO standard_provider_quotes (quote_hash,outcome_id,listing_manifest_hash,request_hash,
         gross_amount,issued_at,valid_before,pricing_mode)
       VALUES ($1,$2,$3,$4,$5,to_timestamp($6),to_timestamp($7),'dynamic')`,
      [Buffer.from(legacyHash.slice(2), "hex"), legacy.outcomeId,
        Buffer.from(legacy.listingManifestHash.slice(2), "hex"), Buffer.from(legacy.requestHash.slice(2), "hex"),
        legacy.grossAmount, issuedAt, issuedAt + 180],
    );
    const quote = await gatewayQuoteV1({
      outcome: dynamicOutcome, request,
      providerQuote: { providerQuoteHash: legacyHash, grossAmount: "1234567", issuedAt, validBefore: issuedAt + 120 },
    });
    const args = await gatewayDispatch({
      outcome: dynamicOutcome, quote, request, payer: payerB,
      reputationContract: config.reputationContract, outcomeSchemaUid: config.reputationOutcomeSchemaUid,
    });
    await expect(service().accept(args)).resolves.toMatchObject({ state: "completed" });
  });
});

describe("settlement time, not dispatch time, bounds a timely payment (C-T04)", () => {
  it.each([25 * 3_600, 29 * 86_400])("admits a fresh dispatch %i s after the quote for an on-time payment",
    async (age) => {
      const quotedAt = Math.floor(Date.now() / 1_000) - age;
      const args = await paidOrder({ quotedAt });
      h.depositTimestamp = args.quote.issuedAt + 60;
      await expect(service().accept(args)).resolves.toMatchObject({ state: "completed" });
    });

  it("refuses a payment settled after the gateway quote window closed", async () => {
    const args = await paidOrder({ quotedAt: Math.floor(Date.now() / 1_000) - 3_600 });
    h.depositTimestamp = args.quote.validBefore + 1;
    await expect(service().accept(args)).rejects.toMatchObject({ reason: "evidence" });
    await expect(vi.mocked(ProviderEvidenceVerifier.prototype.verify).mock.results[0]!.value)
      .rejects.toThrow("outside the quote payment window");
    expect(h.adapter.execute).not.toHaveBeenCalled();
  });
});

// The gateway's dispatch carries the control profile its checkout snapshot
// committed, never re-derived from the current one: an order sold before the
// provider rotated its profile, and first dispatched after, carries the
// earlier hash. A deployment serves it only while it retains that profile,
// and each readiness quote records the profile it was issued under.
describe("dispatches under an earlier provider control profile (C04)", () => {
  const earlier = hash("9");
  afterEach(() => { config.retainedControlProfileHashes = undefined; });

  async function soldUnderEarlierProfile() {
    const args = await paidOrder();
    const dispatch = await gatewayDispatch({
      outcome: { ...fixedOutcome, providerControlProfileHash: earlier },
      quote: args.quote, request, payer: payerA,
      reputationContract: config.reputationContract, outcomeSchemaUid: config.reputationOutcomeSchemaUid,
    });
    return { ...args, dispatch: dispatch.dispatch };
  }

  it("refuses a profile the deployment does not retain, before admission", async () => {
    const args = await soldUnderEarlierProfile();
    await expect(service().accept(args)).rejects.toMatchObject({ reason: "outcome_policy" });
    expect(h.adapter.execute).not.toHaveBeenCalled();
    expect(await claimRow(args.dispatch.payload.orderId)).toBeUndefined();
  });

  it("admits a first dispatch under a retained earlier profile", async () => {
    config.retainedControlProfileHashes = [earlier];
    const args = await soldUnderEarlierProfile();
    await expect(service().accept(args)).resolves.toMatchObject({ state: "completed" });
  });

  it("records the control profile each readiness quote was issued under", async () => {
    const args = await paidOrder();
    const recorded = (await database.pool.query(
      "SELECT encode(provider_control_profile_hash,'hex') AS profile FROM standard_provider_quotes WHERE quote_hash=$1",
      [Buffer.from(args.quote.payload.providerQuoteHash.slice(2), "hex")],
    )).rows[0];
    expect(recorded).toEqual({ profile: fixedOutcome.providerControlProfileHash.slice(2) });
  });
});
