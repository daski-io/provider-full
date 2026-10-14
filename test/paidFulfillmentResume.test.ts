import { randomBytes } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import type { AdapterResult } from "../src/core/serviceRegistry/types.js";
import { postJson, startRailServer, statusQuery } from "./dispatchHttpHarness.js";
import type { DispatchArgs } from "./dispatchWire.js";
import { acceptDispatchResponse, readGatewayJson } from "./gatewayConsumer.js";
import { paidOrderHarness } from "./paidOrderHarness.js";
import { createMigratedDatabase, DATABASE_HOOK_TIMEOUT_MS, type DisposableDatabase } from "./postgresHarness.js";
import { CHAIN_ID, fixedOutcome, fixtureConfig, provider, seedFixtureService } from "./standardRailFixture.js";

// Admitted paid work survives its admitting request (F-T17, C-T07): the
// order's durable fulfillment job resumes a never-started order, a started
// call is never repeated, the dispatch deadline never fails admitted work,
// and only the admitted fulfillment deadline ends a never-started order.
vi.setConfig({ testTimeout: 30_000 });
const h = vi.hoisted(() => ({
  pool: null as pg.Pool | null,
  executions: 0,
  result: { status: "completed", artifacts: [{ name: "note", data: { note: "done" } }] } as AdapterResult,
  preExecute: null as null | (() => Promise<unknown>),
}));
vi.mock("../src/core/db/pool.js", () => ({
  pool: {
    query: (...args: unknown[]) => (h.pool!.query as (...a: unknown[]) => unknown)(...args),
    connect: () => h.pool!.connect(),
  },
}));
vi.mock("../src/core/serviceRegistry/registry.js", () => ({
  getAdapter: () => ({
    execute: async () => { h.executions += 1; return h.result; },
    handleInput: vi.fn(),
    cancel: vi.fn(),
    quote: async () => ({ ok: true, amount: 250_000n, currency: "USDC" }),
  }),
  getService: () => null,
  getAllServices: () => [],
}));
vi.mock("../src/core/engine/preExecuteRunner.js", () => ({
  consultPreExecuteAgent: async () => (h.preExecute ? h.preExecute() : { action: "proceed" }),
}));

const { StandardQuoteService } = await import("../src/core/standardRail/quote.js");
const { ProviderEvidenceVerifier } = await import("../src/core/standardRail/evidence.js");
const { enqueueUnqueuedAdmissions, resumeAdmittedOrder, runPaidFulfillmentCycle } =
  await import("../src/core/standardRail/paidFulfillmentWorker.js");
const { claimDurableJob, enqueueDurableJob } = await import("../src/core/db/queries/durableJobs.js");

const config = fixtureConfig([fixedOutcome]);
const request = { item: "widget" };
const { paidOrder } = paidOrderHarness({ config, request, quoteService: () => new StandardQuoteService(config, CHAIN_ID) });
const lostConnection = () => Object.assign(new Error("Connection terminated unexpectedly"), { code: "08006" });
let database: DisposableDatabase;
let rail: Awaited<ReturnType<typeof startRailServer>>;

async function task(order: DispatchArgs) {
  return (await database.pool.query(
    `SELECT t.id,t.status,t.metadata,c.state AS claim_state,c.admitted_dispatch_seconds,c.admitted_fulfillment_seconds,
            j.status AS job_status,j.required_capability
       FROM transactions t JOIN standard_dispatch_claims c ON c.transaction_id=t.id
       LEFT JOIN durable_jobs j ON j.queue='standard-paid-fulfillment' AND j.idempotency_key=t.id
      WHERE t.standard_order_id=$1`,
    [order.dispatch.payload.orderId],
  )).rows[0];
}

/** Admit an order whose inline attempt dies before the service is called. */
async function admittedButNotStarted(): Promise<DispatchArgs> {
  const order = await paidOrder();
  h.preExecute = async () => { throw lostConnection(); };
  const answer = await postJson(`${rail.base}/dispatch`, order);
  h.preExecute = null;
  expect([answer.status, await answer.text()]).toEqual([503, ""]);
  // The worker would pick the handed-back job up shortly; make it due now.
  await database.pool.query("UPDATE durable_jobs SET available_at=now() WHERE queue='standard-paid-fulfillment'");
  return order;
}

async function status(order: DispatchArgs) {
  const response = await postJson(`${rail.base}/dispatch/status`, { query: await statusQuery(order) });
  expect(response.status).toBe(200);
  return acceptDispatchResponse(await readGatewayJson(response), {
    dispatchHash: canonicalHash(order.dispatch), providerAuthorityKey: provider.address,
    terminalAttestationKey: provider.address, now: Math.floor(Date.now() / 1_000),
  });
}

beforeAll(async () => {
  vi.spyOn(ProviderEvidenceVerifier.prototype, "verify").mockImplementation(async () => ({
    authorizationKey: `0x${randomBytes(32).toString("hex")}`,
  }));
  vi.spyOn(ProviderEvidenceVerifier.prototype, "assertNotSanctioned").mockResolvedValue();
  database = await createMigratedDatabase("paid_fulfillment_resume");
  h.pool = database.pool;
  await seedFixtureService(database.pool, { skillIds: [fixedOutcome.skillId] });
  rail = await startRailServer(config);
}, DATABASE_HOOK_TIMEOUT_MS);

afterAll(async () => {
  vi.restoreAllMocks();
  await rail?.close();
  await database?.drop();
}, DATABASE_HOOK_TIMEOUT_MS);

beforeEach(() => {
  h.executions = 0;
  h.preExecute = null;
  h.result = { status: "completed", artifacts: [{ name: "note", data: { note: "done" } }] };
});

describe("admitted paid work", () => {
  it("records the admitted deadlines and completes the order's job with its inline attempt", async () => {
    const order = await paidOrder();
    expect((await postJson(`${rail.base}/dispatch`, order)).status).toBe(200);
    expect(await task(order)).toMatchObject({
      status: "completed", admitted_dispatch_seconds: 300, admitted_fulfillment_seconds: 2_592_000,
      job_status: "completed", required_capability: null,
    });
    await expect(database.pool.query(
      `UPDATE standard_dispatch_claims SET admitted_fulfillment_seconds=60
        WHERE order_id=$1`, [order.dispatch.payload.orderId],
    )).rejects.toThrow(/immutable/);
  });

  it("resumes an order whose admitting request died, long after its dispatch deadline", async () => {
    const order = await admittedButNotStarted();
    expect(await task(order)).toMatchObject({ status: "submitted", job_status: "retry" });
    // Ten minutes after acceptance: the 300 s dispatch deadline has long
    // passed, which bounds only new claims and never fails admitted work.
    await database.pool.query(
      "UPDATE standard_dispatch_claims SET claimed_at=now() - interval '600 seconds' WHERE order_id=$1",
      [order.dispatch.payload.orderId],
    );
    await runPaidFulfillmentCycle(config, false);
    expect(h.executions).toBe(1);
    expect(await task(order)).toMatchObject({ status: "completed", job_status: "completed" });
    expect((await status(order)).body.state).toBe("completed");
  });

  it("never repeats a started call whose answer was lost: it parks the order for reconciliation", async () => {
    const order = await admittedButNotStarted();
    // As if the process died inside the service call.
    await database.pool.query(
      `UPDATE transactions SET status='working',metadata=metadata || '{"supplier_mutation_started":true}'::jsonb
        WHERE standard_order_id=$1`, [order.dispatch.payload.orderId],
    );
    await runPaidFulfillmentCycle(config, false);
    expect(h.executions).toBe(0);
    const parked = await task(order);
    expect(parked).toMatchObject({ status: "working", claim_state: "working", job_status: "completed" });
    expect(parked.metadata.standard_reconciliation_required).toBe(true);
    expect((await database.pool.query(
      "SELECT count(*)::int AS n FROM standard_security_incidents WHERE incident_kind='ambiguous_supplier_outcome' AND order_id=$1",
      [order.dispatch.payload.orderId],
    )).rows[0].n).toBe(1);
  });

  it("fails a never-started order only once its admitted fulfillment deadline passed, and keeps started work open", async () => {
    const unstarted = await admittedButNotStarted();
    await database.pool.query(
      `UPDATE standard_dispatch_claims SET claimed_at=now() - (admitted_fulfillment_seconds + 10) * interval '1 second'
        WHERE order_id=$1`, [unstarted.dispatch.payload.orderId],
    );
    await runPaidFulfillmentCycle(config, false);
    expect(h.executions).toBe(0);
    expect(await task(unstarted)).toMatchObject({ status: "failed", claim_state: "failed" });
    const failed = await status(unstarted);
    expect(failed.body.state).toBe("failed");
    expect(failed.evidence).not.toBeNull();

    const started = await admittedButNotStarted();
    await database.pool.query(
      `UPDATE transactions SET status='working',metadata=metadata || '{"supplier_mutation_started":true}'::jsonb
        WHERE standard_order_id=$1`, [started.dispatch.payload.orderId],
    );
    await database.pool.query(
      `UPDATE standard_dispatch_claims SET claimed_at=now() - (admitted_fulfillment_seconds + 10) * interval '1 second'
        WHERE order_id=$1`, [started.dispatch.payload.orderId],
    );
    await runPaidFulfillmentCycle(config, false);
    expect(await task(started)).toMatchObject({ status: "working" });
  });

  it("starts an order once when two executors race for it", async () => {
    const order = await admittedButNotStarted();
    const taskId = (await task(order)).id as string;
    await Promise.all([resumeAdmittedOrder(config, taskId), resumeAdmittedOrder(config, taskId)]);
    expect(h.executions).toBe(1);
    expect(await task(order)).toMatchObject({ status: "completed" });
  });

  it("queues admitted orders that have no job, as earlier releases left them", async () => {
    const order = await admittedButNotStarted();
    await database.pool.query("DELETE FROM durable_jobs WHERE queue='standard-paid-fulfillment'");
    await expect(enqueueUnqueuedAdmissions(config)).resolves.toBe(1);
    await expect(enqueueUnqueuedAdmissions(config)).resolves.toBe(0);
    await runPaidFulfillmentCycle(config, false);
    expect(await task(order)).toMatchObject({ status: "completed", job_status: "completed" });
  });

  it("leaves a job that requires another contract for a worker whose build can run it", async () => {
    const capability = `0x${"ab".repeat(32)}`;
    await enqueueDurableJob({ queue: "capability-probe", idempotencyKey: "one", payload: {}, requiredCapability: capability });
    await expect(claimDurableJob({ queue: "capability-probe", workerId: "w", leaseSeconds: 30, capabilities: [`0x${"cd".repeat(32)}`] }))
      .resolves.toBeNull();
    await expect(claimDurableJob({ queue: "capability-probe", workerId: "w", leaseSeconds: 30, capabilities: [capability] }))
      .resolves.toMatchObject({ idempotency_key: "one" });
  });
});
