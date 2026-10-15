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
// One start fence, bound to the job lease, decides who starts or refuses an
// order: a racing executor, a stale lease or a buyer's pending cancellation
// never starts or fails an order another decision owns.
vi.setConfig({ testTimeout: 30_000 });
const h = vi.hoisted(() => ({
  pool: null as pg.Pool | null,
  executions: 0,
  result: { status: "completed", artifacts: [{ name: "note", data: { note: "done" } }] } as AdapterResult,
  preExecute: null as null | (() => Promise<unknown>),
  executeGate: null as Promise<void> | null,
  invariants: [] as string[],
  module: null as unknown,
}));
vi.mock("../src/core/db/pool.js", () => ({
  pool: {
    query: (...args: unknown[]) => (h.pool!.query as (...a: unknown[]) => unknown)(...args),
    connect: () => h.pool!.connect(),
  },
}));
vi.mock("../src/core/serviceRegistry/registry.js", () => ({
  getAdapter: () => ({
    execute: async () => { h.executions += 1; await h.executeGate; return h.result; },
    handleInput: vi.fn(),
    cancel: vi.fn(),
    quote: async () => ({ ok: true, amount: 250_000n, currency: "USDC" }),
  }),
  getService: () => h.module,
  getAllServices: () => [],
}));
vi.mock("../src/core/engine/preExecuteRunner.js", () => ({
  consultPreExecuteAgent: async () => (h.preExecute ? h.preExecute() : { action: "proceed" }),
}));

const { StandardQuoteService } = await import("../src/core/standardRail/quote.js");
const { ProviderEvidenceVerifier } = await import("../src/core/standardRail/evidence.js");
const { enqueueUnqueuedAdmissions, resumeAdmittedOrder, runPaidFulfillmentCycle } =
  await import("../src/core/standardRail/paidFulfillmentWorker.js");
const { claimDurableJob, enqueueDurableJob, requeueDeadLetter } = await import("../src/core/db/queries/durableJobs.js");
const { isInfrastructureFailure } = await import("../src/core/standardRail/faultClassification.js");
const { SupplierClientError } = await import("../src/core/suppliers/errorClassifier.js");
const { createPreExecuteEscalation } = await import("../src/core/engine/escalationResolutionStore.js");
const { computeRequestHash } = await import("../src/core/auth/requestHash.js");
const { getServiceById } = await import("../src/core/db/queries/services.js");
const { getSkillByServiceAndSkillId } = await import("../src/core/db/queries/skills.js");
const { getTransactionById } = await import("../src/core/db/queries/transactions.js");

const config = fixtureConfig([fixedOutcome]);
const request = { item: "widget" };
const { paidOrder } = paidOrderHarness({ config, request, quoteService: () => new StandardQuoteService(config, CHAIN_ID) });
const lostConnection = () => Object.assign(new Error("Connection terminated unexpectedly"), { code: "08006" });
let database: DisposableDatabase;
let rail: Awaited<ReturnType<typeof startRailServer>>;
let serviceId: string;

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

/** The order's fulfillment-job lease, as a worker takes it. */
async function claimFulfillment() {
  const job = await claimDurableJob({ queue: "standard-paid-fulfillment", workerId: "test-worker", leaseSeconds: 300 });
  expect(job).not.toBeNull();
  return { id: job!.id, leaseToken: job!.lease_token };
}

/** A pre-execute review that waits for the test's verdict on its first call and proceeds on later ones. */
function heldReview() {
  let entered!: () => void;
  let decide!: (decision: unknown) => void;
  const reviewing = new Promise<void>((resolve) => { entered = resolve; });
  const verdict = new Promise<unknown>((resolve) => { decide = resolve; });
  let calls = 0;
  h.preExecute = async () => {
    calls += 1;
    if (calls > 1) return { action: "proceed" };
    entered();
    return verdict;
  };
  return { reviewing, decide };
}

/** Hold the service call open until the returned release is called. */
function heldExecution(): () => void {
  let release!: () => void;
  h.executeGate = new Promise<void>((resolve) => { release = resolve; });
  return release;
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
  serviceId = await seedFixtureService(database.pool, { skillIds: [fixedOutcome.skillId] });
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
  h.executeGate = null;
  h.invariants = [];
  h.module = null;
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

  it("keeps an order resumable when a pre-start query times out in the database client", async () => {
    const order = await paidOrder();
    // node-postgres's own query timeout carries no SQLSTATE and fires before the server's.
    h.preExecute = async () => { throw new Error("Query read timeout"); };
    const answer = await postJson(`${rail.base}/dispatch`, order);
    h.preExecute = null;
    expect([answer.status, await answer.text()]).toEqual([503, ""]);
    expect(await task(order)).toMatchObject({ status: "submitted", job_status: "retry" });
    await database.pool.query("UPDATE durable_jobs SET available_at=now() WHERE queue='standard-paid-fulfillment'");
    await runPaidFulfillmentCycle(config, false);
    expect(h.executions).toBe(1);
    expect(await task(order)).toMatchObject({ status: "completed", job_status: "completed" });
    for (const error of [
      Object.assign(new Error("could not obtain lock on row"), { code: "55P03" }),
      Object.assign(new Error("getaddrinfo EAI_AGAIN database"), { code: "EAI_AGAIN" }),
      new Error("Client was closed and is not queryable"),
    ]) expect(isInfrastructureFailure(error), error.message).toBe(true);
    expect(isInfrastructureFailure(new Error("Standard managed asset was not found"))).toBe(false);
    expect(isInfrastructureFailure(Object.assign(new Error("invalid argument"), { code: "ERR_INVALID_ARG_TYPE" })))
      .toBe(false);
  });

  it("keeps an order resumable when the pre-start consult or a service hook meets a transient fault", async () => {
    const orders: DispatchArgs[] = [];
    for (const fault of [
      new SupplierClientError("supplier temporarily unavailable", { supplier: "synthetic", status: 503 }),
      Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }),
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    ]) {
      const order = await paidOrder();
      h.preExecute = async () => { throw fault; };
      const answer = await postJson(`${rail.base}/dispatch`, order);
      h.preExecute = null;
      // Nothing was started and nothing was decided: no signed failure.
      expect([answer.status, await answer.text()], fault.message).toEqual([503, ""]);
      expect(await task(order), fault.message).toMatchObject({ status: "submitted", job_status: "retry" });
      orders.push(order);
    }
    await database.pool.query("UPDATE durable_jobs SET available_at=now() WHERE queue='standard-paid-fulfillment'");
    await runPaidFulfillmentCycle(config, false);
    for (const order of orders) expect(await task(order)).toMatchObject({ status: "completed", job_status: "completed" });
  });

  describe("an order waiting on a fault that decides nothing", () => {
    const jobOf = async (order: DispatchArgs) => (await database.pool.query(
      "SELECT status,attempts FROM durable_jobs WHERE queue='standard-paid-fulfillment' AND idempotency_key=$1",
      [(await task(order)).id],
    )).rows[0];
    /** More worker cycles than the job's attempt budget, each with the job due. */
    async function outlastAttemptBudget(): Promise<void> {
      for (let cycle = 0; cycle < 14; cycle += 1) {
        await database.pool.query("UPDATE durable_jobs SET available_at=now() WHERE queue='standard-paid-fulfillment'");
        await runPaidFulfillmentCycle(config, false);
      }
    }
    const unavailable = () => new SupplierClientError("supplier temporarily unavailable", { supplier: "synthetic", status: 503 });

    it("spends none of its job's attempts, and starts once the fault clears", async () => {
      const order = await admittedButNotStarted();
      h.preExecute = async () => { throw unavailable(); };
      await outlastAttemptBudget();
      expect(await jobOf(order)).toMatchObject({ status: "retry", attempts: 1 });
      expect(await task(order)).toMatchObject({ status: "submitted" });
      h.preExecute = null;
      await database.pool.query("UPDATE durable_jobs SET available_at=now() WHERE queue='standard-paid-fulfillment'");
      await runPaidFulfillmentCycle(config, false);
      expect(h.executions).toBe(1);
      expect(await task(order)).toMatchObject({ status: "completed", job_status: "completed" });
    });

    it("fails as never started once its admitted fulfillment deadline passed", async () => {
      const order = await admittedButNotStarted();
      h.preExecute = async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); };
      await runPaidFulfillmentCycle(config, false);
      expect(await task(order)).toMatchObject({ status: "submitted", job_status: "retry" });
      await database.pool.query(
        `UPDATE standard_dispatch_claims SET claimed_at=now() - (admitted_fulfillment_seconds + 10) * interval '1 second'
          WHERE order_id=$1`, [order.dispatch.payload.orderId],
      );
      await database.pool.query("UPDATE durable_jobs SET available_at=now() WHERE queue='standard-paid-fulfillment'");
      await runPaidFulfillmentCycle(config, false);
      expect(h.executions).toBe(0);
      expect(await task(order)).toMatchObject({ status: "failed", claim_state: "failed", job_status: "completed" });
      expect((await status(order)).body.state).toBe("failed");
    });

    it("keeps the attempt budget when it was admitted with no known deadline, so it reaches an operator", async () => {
      const order = await admittedButNotStarted();
      // As an earlier release may have left it: no deadline would ever end it.
      await database.pool.query("ALTER TABLE standard_dispatch_claims DISABLE TRIGGER standard_dispatch_claims_admitted_clocks");
      try {
        await database.pool.query(
          "UPDATE standard_dispatch_claims SET admitted_fulfillment_seconds=NULL WHERE order_id=$1",
          [order.dispatch.payload.orderId],
        );
      } finally {
        await database.pool.query("ALTER TABLE standard_dispatch_claims ENABLE TRIGGER standard_dispatch_claims_admitted_clocks");
      }
      h.preExecute = async () => { throw unavailable(); };
      await outlastAttemptBudget();
      expect(await jobOf(order)).toMatchObject({ status: "dead_letter" });
      expect(await task(order)).toMatchObject({ status: "submitted" });
      // The operator's retry, once the fault cleared, starts it.
      h.preExecute = null;
      await expect(requeueDeadLetter("standard-paid-fulfillment", (await task(order)).id)).resolves.toBe(true);
      await runPaidFulfillmentCycle(config, false);
      expect(await task(order)).toMatchObject({ status: "completed", job_status: "completed" });
    });
  });

  it("admits and answers a funded order while this process takes no new sales (C05)", async () => {
    const stopped = await startRailServer(config, {
      salesAdmission: async () => ({ status: "stopped" as const }), contractIntegrity: async () => undefined,
    });
    try {
      const order = await paidOrder();
      const admitted = await postJson(`${stopped.base}/dispatch`, order);
      expect(admitted.status).toBe(200);
      expect(await task(order)).toMatchObject({ status: "completed" });
      const read = await postJson(`${stopped.base}/dispatch/status`, { query: await statusQuery(order) });
      expect(read.status).toBe(200);
    } finally {
      await stopped.close();
    }
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
    const lease = await claimFulfillment();
    await Promise.all([resumeAdmittedOrder(config, taskId, lease), resumeAdmittedOrder(config, taskId, lease)]);
    expect(h.executions).toBe(1);
    expect(await task(order)).toMatchObject({ status: "completed" });
  });

  it("never lets a later pre-start rejection end an order another executor started", async () => {
    const order = await admittedButNotStarted();
    const taskId = (await task(order)).id as string;
    const lease = await claimFulfillment();
    const { reviewing, decide } = heldReview();
    const release = heldExecution();
    const slow = resumeAdmittedOrder(config, taskId, lease);
    await reviewing;
    const fast = resumeAdmittedOrder(config, taskId, lease);
    await vi.waitFor(() => expect(h.executions).toBe(1));
    decide({ action: "reject" });
    await expect(slow).resolves.toBe("done");
    expect(await task(order)).toMatchObject({ status: "working", claim_state: "dispatching" });
    release();
    await expect(fast).resolves.toBe("done");
    expect(await task(order)).toMatchObject({ status: "completed", claim_state: "completed" });
  });

  it("never lets a late definite pre-start failure end an order another executor started", async () => {
    const order = await admittedButNotStarted();
    const taskId = (await task(order)).id as string;
    const lease = await claimFulfillment();
    let entered!: () => void;
    let fail!: () => void;
    const reviewing = new Promise<void>((resolve) => { entered = resolve; });
    const failure = new Promise<never>((_, reject) => {
      fail = () => reject(new Error("The review refused the request"));
    });
    failure.catch(() => undefined);
    let calls = 0;
    h.preExecute = async () => {
      calls += 1;
      if (calls > 1) return { action: "proceed" };
      entered();
      return failure;
    };
    const release = heldExecution();
    const slow = resumeAdmittedOrder(config, taskId, lease);
    await reviewing;
    const fast = resumeAdmittedOrder(config, taskId, lease);
    await vi.waitFor(() => expect(h.executions).toBe(1));
    fail();
    await expect(slow).resolves.toBe("done");
    expect(await task(order)).toMatchObject({ status: "working" });
    release();
    await expect(fast).resolves.toBe("done");
    expect(await task(order)).toMatchObject({ status: "completed", claim_state: "completed" });
  });

  it("lets only the live lease holder start the order", async () => {
    const order = await admittedButNotStarted();
    const taskId = (await task(order)).id as string;
    const stale = await claimFulfillment();
    await database.pool.query(
      "UPDATE durable_jobs SET lease_expires_at=now() - interval '1 second' WHERE id=$1", [stale.id],
    );
    await expect(resumeAdmittedOrder(config, taskId, stale)).resolves.toBe("done");
    expect(h.executions).toBe(0);
    expect(await task(order)).toMatchObject({ status: "submitted" });
    await runPaidFulfillmentCycle(config, false);
    expect(h.executions).toBe(1);
    expect(await task(order)).toMatchObject({ status: "completed", job_status: "completed" });
  });

  it("never starts an order a buyer's cancellation holds, and starts it once the service refused that cancellation", async () => {
    const order = await admittedButNotStarted();
    const taskId = (await task(order)).id as string;
    await database.pool.query(
      `INSERT INTO standard_lifecycle_actions (transaction_id,action,identity_hash,request_hash,state,lease_expires_at)
       VALUES ($1,'cancel',$2,$3,'claimed',now() + interval '60 seconds')`,
      [taskId, randomBytes(32), randomBytes(32)],
    );
    await runPaidFulfillmentCycle(config, false);
    expect(h.executions).toBe(0);
    expect(await task(order)).toMatchObject({ status: "submitted", job_status: "retry" });
    // The service refused the cancellation, which frees the order.
    await database.pool.query("DELETE FROM standard_lifecycle_actions WHERE transaction_id=$1", [taskId]);
    await database.pool.query("UPDATE durable_jobs SET available_at=now() WHERE queue='standard-paid-fulfillment'");
    await runPaidFulfillmentCycle(config, false);
    expect(h.executions).toBe(1);
    expect(await task(order)).toMatchObject({ status: "completed", job_status: "completed" });
  });

  it("waits out a declared service outage instead of failing the order", async () => {
    const order = await admittedButNotStarted();
    h.module = { operations: { readiness: { checkInvariants: async () => h.invariants } } };
    h.invariants = ["supplier outage"];
    await runPaidFulfillmentCycle(config, false);
    expect(h.executions).toBe(0);
    expect(await task(order)).toMatchObject({ status: "submitted", job_status: "retry" });
    h.invariants = [];
    await database.pool.query("UPDATE durable_jobs SET available_at=now() WHERE queue='standard-paid-fulfillment'");
    await runPaidFulfillmentCycle(config, false);
    expect(await task(order)).toMatchObject({ status: "completed", job_status: "completed" });
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

// A pre-execute review opens against PostgreSQL itself, bound to the
// request the order was admitted with (its dispatch claim's provider
// request hash, never the gateway's canonical request hash), and only by
// the executor that wins the order's start fence.
describe("pre-execute review of admitted work", () => {
  const escalations = async (taskId: string) => (await database.pool.query(
    `SELECT id::text,status,source,target_id,request_hash FROM escalations WHERE transaction_id=$1`, [taskId],
  )).rows;

  it("opens a review for a funded order and leaves it started for the reviewer, never failed", async () => {
    const order = await paidOrder();
    h.preExecute = async () => ({ action: "escalate", reviewQuestion: "A human must look first." });
    const answer = await postJson(`${rail.base}/dispatch`, order);
    h.preExecute = null;
    expect(answer.status).toBe(200);
    const row = await task(order);
    expect(row).toMatchObject({ status: "working", claim_state: "working", job_status: "completed" });
    expect(row.metadata.supplier_mutation_started).toBeUndefined();
    expect(h.executions).toBe(0);
    const [review] = await escalations(row.id as string);
    expect(review).toMatchObject({ status: "pending", source: "pre_execute", request_hash: computeRequestHash(request) });
    // The review's target is its own id, as text beside the uuid column.
    expect(review.target_id).toBe(review.id);
    expect((await status(order)).body.state).toBe("working");
  });

  it("never opens a review for an order another executor already started", async () => {
    const order = await admittedButNotStarted();
    const taskId = (await task(order)).id as string;
    const lease = await claimFulfillment();
    const { reviewing, decide } = heldReview();
    const release = heldExecution();
    const slow = resumeAdmittedOrder(config, taskId, lease);
    await reviewing;
    const fast = resumeAdmittedOrder(config, taskId, lease);
    await vi.waitFor(() => expect(h.executions).toBe(1));
    decide({ action: "escalate", reviewQuestion: "Too late to ask." });
    await expect(slow).resolves.toBe("done");
    expect(await escalations(taskId)).toEqual([]);
    release();
    await expect(fast).resolves.toBe("done");
    expect(await task(order)).toMatchObject({ status: "completed", claim_state: "completed" });
  });

  it("opens a review for a free task under its materialized request hash and refuses any other request", async () => {
    const free = { item: "free-widget" };
    const taskId = `task-free-${randomBytes(6).toString("hex")}`;
    await database.pool.query(
      `INSERT INTO transactions (id,service_id,skill_id,status,canonical_request_hash)
       VALUES ($1,$2,$3,'submitted',$4)`,
      [taskId, serviceId, fixedOutcome.skillId, Buffer.from(computeRequestHash(free).slice(2), "hex")],
    );
    const [service, skill, transaction] = await Promise.all([
      getServiceById(serviceId), getSkillByServiceAndSkillId(serviceId, fixedOutcome.skillId), getTransactionById(taskId),
    ]);
    const escalate = (requestData: Record<string, unknown>) => createPreExecuteEscalation({
      transaction: transaction!, service: service!, skill: skill!, asset: null, requestData, question: "Review it.",
    });
    await expect(escalate({ item: "another-widget" })).rejects.toThrow(/canonical request changed/);
    expect(await escalations(taskId)).toEqual([]);
    const opened = await escalate(free);
    expect(opened).toMatchObject({ status: "pending", target_id: opened.id });
    expect((await getTransactionById(taskId))?.status).toBe("working");
  });
});
