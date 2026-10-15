import { randomBytes } from "node:crypto";
import type pg from "pg";
import type { Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import type { FulfillmentAdapter, SupplierCost, TaskContext } from "../src/core/serviceRegistry/types.js";
import { gatewayDispatch, gatewayQuoteV1 } from "./dispatchWire.js";
import { paidOrderHarness } from "./paidOrderHarness.js";
import { createMigratedDatabase, DATABASE_HOOK_TIMEOUT_MS, type DisposableDatabase } from "./postgresHarness.js";
import {
  CHAIN_ID, dynamicOutcome, fixedOutcome, fixtureConfig, payerA, seedFixtureService,
} from "./standardRailFixture.js";

// F-T01: a synthetic service with external spend. Its quote reports the
// supplier's current price; core records it with the configured price
// tolerance as the order's ceiling and binds that ceiling at admission; the
// service compares each planned supplier operation against it before spend,
// so a purchase above the quoted price plus the tolerance never reaches the
// supplier mutation.
// Database-backed protocol tests: allow for a loaded shared host.
vi.setConfig({ testTimeout: 30_000 });
const h = vi.hoisted(() => ({
  pool: null as pg.Pool | null,
  adapter: null as unknown as FulfillmentAdapter,
  plannedAmount: "4.25",
  fixedCost: undefined as SupplierCost | undefined,
  supplierMutation: null as unknown as () => Promise<Record<string, unknown>>,
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
const { persistProviderQuote, providerQuoteHash } = await import("../src/core/standardRail/quoteStore.js");
const { runSupplierOperation } = await import("../src/core/suppliers/operationJournal.js");
const { mergeTransactionMetadata } = await import("../src/core/db/queries/transactions.js");
const { admittedSupplierCostCeiling } = await import("../src/core/serviceRegistry/supplierCostCeiling.js");

const config = fixtureConfig();
const supplierCost = { supplier: "synthetic-supplier", currency: "USD", amount: "4.25" };
const ceiling = {
  kind: "supplier-cost-ceiling-v2" as const, supplier: "synthetic-supplier", currency: "USD",
  quotedAmount: "4.25", tolerancePercent: "10",
};
let database: DisposableDatabase;
// One request per scenario: quotes for one request, payer and second share
// a hash, and must then carry the same ceiling.
const orders = (item: string, tolerancePercent?: string) => paidOrderHarness({
  config, request: { item }, quoteService: () => new StandardQuoteService(config, CHAIN_ID, {}, tolerancePercent),
}).paidOrder;
const paidOrder = orders("widget");

/** The synthetic service: one external purchase journaled with its planned spend. */
function spendingAdapter(): FulfillmentAdapter {
  return {
    async execute(_skillId: string, task: TaskContext) {
      const result = await runSupplierOperation({
        serviceId: task.service_id,
        transactionId: task.id,
        opKey: `purchase:${task.id}`,
        kind: "synthetic-supplier.purchase",
        request: { taskId: task.id, amount: h.plannedAmount },
        spend: {
          ceiling: task.supplierCostCeiling,
          planned: { supplier: "synthetic-supplier", currency: "USD", amount: h.plannedAmount },
        },
        execute: () => h.supplierMutation(),
        reconcile: async () => null,
      });
      return { status: "completed", artifacts: [{ name: "purchase", data: result }] };
    },
    handleInput: vi.fn(),
    cancel: vi.fn(),
    quote: vi.fn(async (skillId: string) => skillId === dynamicOutcome.skillId
      ? { ok: true as const, amount: 1_234_567n, currency: "USDC" as const, supplierCost }
      : { ok: true as const, amount: 250_000n, currency: "USDC" as const,
          ...(h.fixedCost ? { supplierCost: h.fixedCost } : {}) }),
  };
}

beforeAll(async () => {
  database = await createMigratedDatabase("supplier_ceiling");
  h.pool = database.pool;
  await seedFixtureService(database.pool, { skillIds: [fixedOutcome.skillId, dynamicOutcome.skillId] });
}, DATABASE_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await database?.drop();
}, DATABASE_HOOK_TIMEOUT_MS);

beforeEach(() => {
  h.adapter = spendingAdapter();
  h.plannedAmount = "4.25";
  h.fixedCost = undefined;
  h.supplierMutation = vi.fn(async () => ({ supplierOrder: "synthetic-1" }));
  vi.spyOn(ProviderEvidenceVerifier.prototype, "verify")
    .mockImplementation(async () => ({ authorizationKey: `0x${randomBytes(32).toString("hex")}` as Hex }));
  vi.spyOn(ProviderEvidenceVerifier.prototype, "assertNotSanctioned").mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const accept = (order: Awaited<ReturnType<typeof paidOrder>>) =>
  new StandardDispatchService(config, baseSepolia, CHAIN_ID).accept(order);

async function journal(taskId: string) {
  return (await database.pool.query(
    "SELECT state,error_code FROM supplier_operations WHERE transaction_id=$1", [taskId],
  )).rows;
}

async function boundCeiling(taskId: string) {
  return (await database.pool.query("SELECT metadata FROM transactions WHERE id=$1", [taskId]))
    .rows[0]?.metadata.supplier_cost_ceiling;
}

describe("admitted supplier-cost ceiling (F-T01)", () => {
  it("spends once when the planned supplier operation stays at the quoted price", async () => {
    const response = await accept(await paidOrder({ outcome: dynamicOutcome }));
    expect(response.state).toBe("completed");
    expect(h.supplierMutation).toHaveBeenCalledOnce();
    expect(await journal(response.taskId)).toEqual([{ state: "confirmed", error_code: null }]);
    expect(await boundCeiling(response.taskId)).toEqual(ceiling);
  });

  it("absorbs a supplier price increase up to the configured tolerance", async () => {
    for (const amount of ["4.26", "4.675"]) {
      h.plannedAmount = amount;
      h.supplierMutation = vi.fn(async () => ({ supplierOrder: `synthetic-${amount}` }));
      const response = await accept(await paidOrder({ outcome: dynamicOutcome }));
      expect(response.state).toBe("completed");
      expect(h.supplierMutation).toHaveBeenCalledOnce();
    }
  });

  it("stops a purchase above the quoted price plus tolerance before the supplier mutation", async () => {
    h.plannedAmount = "4.676";
    const response = await accept(await paidOrder({ outcome: dynamicOutcome }));
    expect(response.state).toBe("failed");
    expect(h.supplierMutation).not.toHaveBeenCalled();
    expect(await journal(response.taskId)).toEqual([{ state: "failed", error_code: "execute.not_applied" }]);
  });

  it("records and enforces the ceiling of a fixed listing whose quote reports a supplier cost", async () => {
    h.fixedCost = { supplier: "synthetic-supplier", currency: "USD", amount: "2" };
    const costed = orders("costed-widget");
    h.plannedAmount = "2.2";
    const within = await accept(await costed({ outcome: fixedOutcome }));
    expect(within.state).toBe("completed");
    expect(await boundCeiling(within.taskId)).toEqual({ ...ceiling, quotedAmount: "2" });
    h.plannedAmount = "2.21";
    const above = await accept(await costed({ outcome: fixedOutcome }));
    expect(above.state).toBe("failed");
    expect(h.supplierMutation).toHaveBeenCalledOnce();
  });

  it("binds the tolerance in force when the order was quoted, whatever is configured later", async () => {
    h.plannedAmount = "4.26";
    const response = await accept(await orders("strict-widget", "0")({ outcome: dynamicOutcome }));
    expect(response.state).toBe("failed");
    expect(h.supplierMutation).not.toHaveBeenCalled();
    expect(await boundCeiling(response.taskId)).toEqual({ ...ceiling, tolerancePercent: "0" });
  });

  it("refuses spend for an order whose quote reported no supplier cost", async () => {
    const response = await accept(await paidOrder({ outcome: fixedOutcome }));
    expect(response.state).toBe("failed");
    expect(h.supplierMutation).not.toHaveBeenCalled();
    expect(await boundCeiling(response.taskId)).toBeUndefined();
  });

  it("keeps a v1 ceiling an earlier release recorded at its exact maximum", async () => {
    const legacy = {
      kind: "supplier-cost-ceiling-v1" as const, supplier: "synthetic-supplier", currency: "USD", maximumAmount: "4.25",
    };
    const legacyOrder = async (item: string) => {
      const request = { item };
      const issuedAt = Math.floor(Date.now() / 1_000);
      const payload = {
        outcomeId: fixedOutcome.outcomeId, listingManifestHash: fixedOutcome.listingManifestHash,
        requestHash: canonicalHash(request), grossAmount: fixedOutcome.fixedGrossAmount,
        payer: payerA.toLowerCase() as Hex, issuedAt, validBefore: issuedAt + 120,
      };
      await persistProviderQuote(payload, { pricingMode: "fixed", supplierCostCeiling: legacy });
      const quote = await gatewayQuoteV1({
        outcome: fixedOutcome, request, validBefore: payload.validBefore - 20,
        providerQuote: { providerQuoteHash: providerQuoteHash(payload), ...payload },
      });
      return gatewayDispatch({
        outcome: fixedOutcome, quote, request, payer: payerA,
        reputationContract: config.reputationContract, outcomeSchemaUid: config.reputationOutcomeSchemaUid,
      });
    };
    const atMaximum = await accept(await legacyOrder("legacy-at-maximum"));
    expect(atMaximum.state).toBe("completed");
    expect(await boundCeiling(atMaximum.taskId)).toEqual(legacy);
    h.plannedAmount = "4.26";
    const above = await accept(await legacyOrder("legacy-above"));
    expect(above.state).toBe("failed");
    expect(h.supplierMutation).toHaveBeenCalledOnce();
  });

  it("keeps the admitted ceiling immutable for every later attempt", async () => {
    h.plannedAmount = "4.676";
    const response = await accept(await paidOrder({ outcome: dynamicOutcome }));
    const changed = { ...ceiling, tolerancePercent: "100" };
    await expect(database.pool.query(
      `UPDATE transactions SET metadata=metadata || jsonb_build_object('supplier_cost_ceiling',$2::jsonb)
        WHERE id=$1`, [response.taskId, JSON.stringify(changed)],
    )).rejects.toMatchObject({ code: "23000" });
    await expect(database.pool.query(
      "UPDATE transactions SET metadata=metadata - 'supplier_cost_ceiling' WHERE id=$1", [response.taskId],
    )).rejects.toMatchObject({ code: "23000" });
    await expect(mergeTransactionMetadata(response.taskId, { supplier_cost_ceiling: changed }))
      .rejects.toMatchObject({ code: "23000" });
    const merged = await mergeTransactionMetadata(response.taskId, { operator_note_seen: true });
    expect(admittedSupplierCostCeiling(merged!.metadata)).toEqual(ceiling);
  });

  it("fails closed on a malformed durable ceiling binding", () => {
    expect(admittedSupplierCostCeiling({})).toBeUndefined();
    for (const malformed of [
      { ...ceiling, quotedAmount: "-1" },
      { ...ceiling, tolerancePercent: "100.5" },
      { kind: "supplier-cost-ceiling-v1", supplier: "synthetic-supplier", currency: "USD", maximumAmount: "-1" },
    ]) {
      expect(() => admittedSupplierCostCeiling({ supplier_cost_ceiling: malformed }))
        .toThrow("Supplier cost ceiling is invalid");
    }
  });
});
