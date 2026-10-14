import { randomBytes } from "node:crypto";
import type pg from "pg";
import type { Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FulfillmentAdapter, TaskContext } from "../src/core/serviceRegistry/types.js";
import { paidOrderHarness } from "./paidOrderHarness.js";
import { createMigratedDatabase, type DisposableDatabase } from "./postgresHarness.js";
import {
  CHAIN_ID, dynamicOutcome, fixedOutcome, fixtureConfig, seedFixtureService,
} from "./standardRailFixture.js";

// F-T01: a synthetic service with external spend. Core binds the quoted
// ceiling at admission; the service compares each planned supplier operation
// against it before spend, so an over-ceiling purchase never reaches the
// supplier mutation.
const h = vi.hoisted(() => ({
  pool: null as pg.Pool | null,
  adapter: null as unknown as FulfillmentAdapter,
  plannedAmount: "4.25",
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
const { runSupplierOperation } = await import("../src/core/suppliers/operationJournal.js");
const { mergeTransactionMetadata } = await import("../src/core/db/queries/transactions.js");
const { admittedSupplierCostCeiling } = await import("../src/core/serviceRegistry/supplierCostCeiling.js");

const config = fixtureConfig();
const request = { item: "widget" };
const ceiling = {
  kind: "supplier-cost-ceiling-v1" as const, supplier: "synthetic-supplier", currency: "USD", maximumAmount: "4.25",
};
let database: DisposableDatabase;
const { paidOrder } = paidOrderHarness({
  config, request, quoteService: () => new StandardQuoteService(config, CHAIN_ID),
});

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
      ? { ok: true as const, amount: 1_234_567n, currency: "USDC" as const, supplierCostCeiling: ceiling }
      : { ok: true as const, amount: 250_000n, currency: "USDC" as const }),
  };
}

beforeAll(async () => {
  database = await createMigratedDatabase("supplier_ceiling");
  h.pool = database.pool;
  await seedFixtureService(database.pool, { skillIds: [fixedOutcome.skillId, dynamicOutcome.skillId] });
});

afterAll(async () => {
  await database.drop();
});

beforeEach(() => {
  h.adapter = spendingAdapter();
  h.plannedAmount = "4.25";
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

describe("admitted supplier-cost ceiling (F-T01)", () => {
  it("spends once when the planned supplier operation stays within the ceiling", async () => {
    const response = await accept(await paidOrder({ outcome: dynamicOutcome }));
    expect(response.state).toBe("completed");
    expect(h.supplierMutation).toHaveBeenCalledOnce();
    expect(await journal(response.taskId)).toEqual([{ state: "confirmed", error_code: null }]);
  });

  it("stops an over-ceiling purchase before the supplier mutation", async () => {
    h.plannedAmount = "4.26";
    const response = await accept(await paidOrder({ outcome: dynamicOutcome }));
    expect(response.state).toBe("failed");
    expect(h.supplierMutation).not.toHaveBeenCalled();
    expect(await journal(response.taskId)).toEqual([{ state: "intent", error_code: null }]);
  });

  it("refuses spend for an order whose quote admitted no ceiling", async () => {
    const response = await accept(await paidOrder({ outcome: fixedOutcome }));
    expect(response.state).toBe("failed");
    expect(h.supplierMutation).not.toHaveBeenCalled();
  });

  it("keeps the admitted ceiling immutable for every later attempt", async () => {
    h.plannedAmount = "4.26";
    const response = await accept(await paidOrder({ outcome: dynamicOutcome }));
    const changed = { ...ceiling, maximumAmount: "100.00" };
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
    expect(() => admittedSupplierCostCeiling({ supplier_cost_ceiling: { ...ceiling, maximumAmount: "-1" } }))
      .toThrow("Supplier cost ceiling is invalid");
  });
});
