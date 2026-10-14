import { randomBytes } from "node:crypto";
import type pg from "pg";
import type { Hex } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import type { AdapterResult } from "../src/core/serviceRegistry/types.js";
import { postJson, startRailServer } from "./dispatchHttpHarness.js";
import type { DispatchArgs } from "./dispatchWire.js";
import { acceptDispatchResponse, readGatewayJson } from "./gatewayConsumer.js";
import { paidOrderHarness } from "./paidOrderHarness.js";
import { createMigratedDatabase, DATABASE_HOOK_TIMEOUT_MS, type DisposableDatabase } from "./postgresHarness.js";
import { CHAIN_ID, fixedOutcome, fixtureConfig, provider, seedFixtureService } from "./standardRailFixture.js";

// C-T05: every timely-paid order becomes exactly one durable obligation. A
// funded dispatch is never refused for local capacity, paused sales or an
// expired envelope on an exact replay, and no copy starts a second task.
// Database-backed protocol tests: allow for a loaded shared host.
vi.setConfig({ testTimeout: 30_000 });
const h = vi.hoisted(() => ({
  pool: null as pg.Pool | null,
  result: { status: "working" } as AdapterResult,
  executions: 0,
  gate: null as Promise<void> | null,
}));
vi.mock("../src/core/db/pool.js", () => ({
  pool: {
    query: (...args: unknown[]) => (h.pool!.query as (...a: unknown[]) => unknown)(...args),
    connect: () => h.pool!.connect(),
  },
}));
vi.mock("../src/core/serviceRegistry/registry.js", () => ({
  getAdapter: () => ({
    execute: async () => {
      h.executions += 1;
      await h.gate;
      return h.result;
    },
    handleInput: vi.fn(),
    cancel: vi.fn(),
    quote: async () => ({ ok: true, amount: 250_000n, currency: "USDC" }),
  }),
  getService: () => null,
  getAllServices: () => [],
}));
vi.mock("../src/core/engine/preExecuteRunner.js", () => ({
  consultPreExecuteAgent: async () => ({ action: "proceed" }),
}));

const { StandardQuoteService } = await import("../src/core/standardRail/quote.js");
const { ProviderEvidenceVerifier } = await import("../src/core/standardRail/evidence.js");

// One open order fills this listing version's admitted capacity.
const outcome = { ...fixedOutcome, maxOpenOrders: 1 };
const config = fixtureConfig([outcome]);
const request = { item: "widget" };
let database: DisposableDatabase;
let rail: Awaited<ReturnType<typeof startRailServer>>;
const { paidOrder } = paidOrderHarness({
  config, request, quoteService: () => new StandardQuoteService(config, CHAIN_ID),
});

beforeAll(async () => {
  database = await createMigratedDatabase("dispatch_obligations");
  h.pool = database.pool;
  await seedFixtureService(database.pool, { skillIds: [outcome.skillId] });
  rail = await startRailServer(config);
}, DATABASE_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await rail?.close();
  await database?.drop();
}, DATABASE_HOOK_TIMEOUT_MS);

beforeEach(async () => {
  h.result = { status: "working" };
  h.executions = 0;
  h.gate = null;
  await database.pool.query("UPDATE services SET is_active=true");
  await database.pool.query("UPDATE skills SET is_active=true");
  // Earlier orders finish so the next readiness quote is not capacity-bound.
  await database.pool.query(
    "UPDATE transactions SET status='completed',completed_at=COALESCE(completed_at,now()) WHERE status<>'completed'",
  );
  vi.spyOn(ProviderEvidenceVerifier.prototype, "verify")
    .mockImplementation(async () => ({ authorizationKey: `0x${randomBytes(32).toString("hex")}` as Hex }));
  vi.spyOn(ProviderEvidenceVerifier.prototype, "assertNotSanctioned").mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function admit(order: DispatchArgs) {
  const response = await postJson(`${rail.base}/dispatch`, order);
  expect(response.status).toBe(200);
  return acceptDispatchResponse(await readGatewayJson(response), {
    dispatchHash: canonicalHash(order.dispatch), providerAuthorityKey: provider.address,
    terminalAttestationKey: provider.address, now: Math.floor(Date.now() / 1_000),
  });
}

describe("funded orders are obligations (C-T05)", () => {
  it("admits funded orders beyond local capacity instead of refusing them after payment", async () => {
    const orders = [];
    // Readiness quotes stop once capacity is full, so the orders are quoted
    // first, as the gateway reserves capacity only from payment.
    for (let index = 0; index < 3; index += 1) orders.push(await paidOrder());
    for (const order of orders) await admit(order);
    expect(h.executions).toBe(3);
    const open = await database.pool.query(
      "SELECT count(*)::int AS n FROM transactions WHERE status='working' AND standard_listing_manifest_hash=$1",
      [Buffer.from(outcome.listingManifestHash.slice(2), "hex")],
    );
    expect(open.rows[0].n).toBeGreaterThanOrEqual(3);
  });

  it("admits a funded order while sales are paused", async () => {
    const order = await paidOrder();
    await database.pool.query("UPDATE services SET is_active=false");
    await database.pool.query("UPDATE skills SET is_active=false");
    const accepted = await admit(order);
    expect(accepted.body.state).toBe("working");
  });

  it("answers an exact replay after its envelope expired, without new work", async () => {
    const order = await paidOrder();
    const first = await admit(order);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((order.dispatch.validBefore + 3_600) * 1_000);
    const replay = await postJson(`${rail.base}/dispatch`, order);
    vi.useRealTimers();
    expect(replay.status).toBe(200);
    const body = await readGatewayJson(replay) as { taskId: string };
    expect(body.taskId).toBe(first.body.taskId);
    expect(h.executions).toBe(1);
  });

  it("keeps one task for concurrent copies of the same envelope", async () => {
    const order = await paidOrder();
    let open!: () => void;
    h.gate = new Promise<void>((resolve) => { open = resolve; });
    const copies = [postJson(`${rail.base}/dispatch`, order), postJson(`${rail.base}/dispatch`, order)];
    await new Promise((resolve) => setTimeout(resolve, 300));
    open();
    const answers = await Promise.all(copies);
    const bodies = await Promise.all(answers.map((answer) => answer.json() as Promise<{ taskId: string }>));
    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    expect(bodies[0]!.taskId).toBe(bodies[1]!.taskId);
    expect(h.executions).toBe(1);
    const tasks = await database.pool.query(
      "SELECT count(*)::int AS n FROM transactions WHERE standard_order_id=$1", [order.dispatch.payload.orderId],
    );
    expect(tasks.rows[0].n).toBe(1);
  });
});
