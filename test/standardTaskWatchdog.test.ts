import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMigratedDatabase, DATABASE_HOOK_TIMEOUT_MS, type DisposableDatabase } from "./postgresHarness.js";
import { payerA, seedFixtureService } from "./standardRailFixture.js";

// F-T06, F-T17: the watchdog watches worker progress and the admitted
// fulfillment clock from persisted per-order state, never the dispatch
// deadline or the boot catalog. A wait is supervised only while a healthy
// service poller durably owns it; a resolved stall closes its incident and a
// new stall reopens it; overdue work is marked once and stays open.
vi.setConfig({ testTimeout: 30_000 });
const h = vi.hoisted(() => ({ pool: null as pg.Pool | null, owned: new Set<string>(), hookCalls: 0 }));
vi.mock("../src/core/db/pool.js", () => ({
  pool: {
    query: (...args: unknown[]) => (h.pool!.query as (...a: unknown[]) => unknown)(...args),
    connect: () => h.pool!.connect(),
  },
  checkDatabase: async () => true,
}));
vi.mock("../src/core/serviceRegistry/registry.js", () => ({
  getService: (slug: string) => slug === "fixture" ? {
    manifest: { slug },
    operations: {
      readiness: { requiredWorkers: ["fixture-poller"] },
      waitSupervision: {
        worker: "fixture-poller",
        supervisedTasks: async ({ taskIds }: { taskIds: readonly string[] }) => {
          h.hookCalls += 1;
          return new Set(taskIds.filter((id) => h.owned.has(id)));
        },
      },
    },
  } : null,
  getAllServices: () => [],
  getAdapter: () => { throw new Error("no adapter in watchdog tests"); },
}));

const { reconcileStuckStandardTasks, STUCK_TASK, OVERDUE_TASK } = await import("../src/core/standardRail/taskWatchdog.js");
const { heartbeatWorker, failWorker } = await import("../src/core/health.js");

let database: DisposableDatabase;
let serviceId: string;

/** An admitted order of any listing version, current or superseded. */
async function admitted(status: string, quietSeconds: number, acceptedSecondsAgo = 60, fulfillmentSeconds = 43_200) {
  const id = `task-${randomUUID()}`;
  const orderId = `ord_${randomUUID()}`;
  const customer = (await database.pool.query<{ id: string }>(
    `INSERT INTO customers(wallet_address) VALUES ($1)
     ON CONFLICT (wallet_address) DO UPDATE SET last_seen_at=now() RETURNING id`, [payerA.toLowerCase()],
  )).rows[0]!.id;
  await database.pool.query(
    `INSERT INTO transactions (id,customer_id,service_id,skill_id,status,standard_order_id,standard_payer,
       standard_listing_manifest_hash,standard_order_key,standard_token,standard_gross_amount,
       standard_provider_net_amount,standard_daski_commission_amount,updated_at)
     VALUES ($1,$2,$3,'fixed-skill',$4,$5,$6,$7,$8,'0x6666666666666666666666666666666666666666',250000,237500,12500,
             now() - $9 * interval '1 second')`,
    [id, customer, serviceId, status, orderId, payerA, Buffer.alloc(32, 0x5a), Buffer.from(randomUUID().replaceAll("-", "").repeat(2), "hex"), quietSeconds],
  );
  await database.pool.query(
    `INSERT INTO standard_dispatch_claims (gateway_audience,order_id,dispatch_nonce,dispatch_hash,request_hash,payer,
       state,transaction_id,admitted_dispatch_seconds,admitted_fulfillment_seconds,claimed_at)
     VALUES ('https://gateway.example',$1,$2,$3,$4,$5,$6,$7,300,$8,now() - $9 * interval '1 second')`,
    [orderId, randomUUID().replaceAll("-", "").repeat(2), randomUUID().replaceAll("-", "").repeat(2),
      Buffer.alloc(32, 1), payerA, status, id, fulfillmentSeconds, acceptedSecondsAgo]
      .map((value, index) => index === 1 || index === 2 ? Buffer.from(value as string, "hex") : value),
  );
  return { id, orderId };
}

async function incident(kind: string, taskId: string) {
  return (await database.pool.query<{ resolved: boolean }>(
    "SELECT resolved_at IS NOT NULL AS resolved FROM standard_security_incidents WHERE incident_kind=$1 AND details->>'taskId'=$2",
    [kind, taskId],
  )).rows[0] ?? null;
}

beforeAll(async () => {
  database = await createMigratedDatabase("task_watchdog");
  h.pool = database.pool;
  serviceId = await seedFixtureService(database.pool, { skillIds: ["fixed-skill"] });
}, DATABASE_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await database?.drop();
}, DATABASE_HOOK_TIMEOUT_MS);

beforeEach(async () => {
  h.owned.clear();
  h.hookCalls = 0;
  heartbeatWorker("fixture-poller");
  // A disposable reset: claims are otherwise undeletable.
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of ["standard_security_incidents", "standard_dispatch_claims", "transactions"]) {
      await client.query(`DELETE FROM ${table}`);
    }
    await client.query("COMMIT");
  } finally {
    client.release();
  }
});

describe("standard task watchdog (F-T06, F-T17)", () => {
  it("flags a truly stalled task, clears its incident and stall flag on progress, and reopens it on a new stall", async () => {
    const task = await admitted("working", 1_000);
    await database.pool.query(
      `UPDATE transactions SET metadata=metadata || '{"standard_reconciliation_required":true}'::jsonb WHERE id=$1`,
      [task.id],
    );
    await expect(reconcileStuckStandardTasks()).resolves.toMatchObject({ stalled: 1 });
    expect(await incident(STUCK_TASK, task.id)).toEqual({ resolved: false });

    await database.pool.query("UPDATE transactions SET updated_at=now() WHERE id=$1", [task.id]);
    await reconcileStuckStandardTasks();
    expect(await incident(STUCK_TASK, task.id)).toEqual({ resolved: true });
    const flag = (await database.pool.query("SELECT metadata FROM transactions WHERE id=$1", [task.id])).rows[0];
    expect(flag.metadata.standard_reconciliation_required).toBeUndefined();

    await database.pool.query("UPDATE transactions SET updated_at=now() - interval '1000 seconds' WHERE id=$1", [task.id]);
    await reconcileStuckStandardTasks();
    expect(await incident(STUCK_TASK, task.id)).toEqual({ resolved: false });
  });

  it("keeps the flag an ambiguous supplier outcome raised when the stall clears", async () => {
    const task = await admitted("working", 1_000);
    await database.pool.query(
      `UPDATE transactions SET metadata=metadata || '{"standard_reconciliation_required":true}'::jsonb WHERE id=$1`,
      [task.id],
    );
    await database.pool.query(
      `INSERT INTO standard_security_incidents(incident_id,incident_kind,order_id,fingerprint,details)
       VALUES ($1,'ambiguous_supplier_outcome',$2,$3,$4)`,
      [randomUUID(), task.orderId, Buffer.alloc(32, 7), { taskId: task.id }],
    );
    await reconcileStuckStandardTasks();
    await database.pool.query("UPDATE transactions SET updated_at=now() WHERE id=$1", [task.id]);
    await reconcileStuckStandardTasks();
    const row = (await database.pool.query("SELECT metadata FROM transactions WHERE id=$1", [task.id])).rows[0];
    expect(row.metadata.standard_reconciliation_required).toBe(true);
  });

  it("leaves a wait to a healthy poller that owns it, and flags it once that poller is unhealthy", async () => {
    const task = await admitted("working", 3 * 86_400);
    h.owned.add(task.id);
    await expect(reconcileStuckStandardTasks()).resolves.toMatchObject({ stalled: 0 });
    expect(h.hookCalls).toBe(1);
    expect(await incident(STUCK_TASK, task.id)).toBeNull();

    // Another replica may hold the poller's lease: what counts is that this
    // replica's poller worker reports healthy. A dead poller supervises nothing.
    failWorker("fixture-poller");
    await reconcileStuckStandardTasks();
    expect(await incident(STUCK_TASK, task.id)).toEqual({ resolved: false });

    heartbeatWorker("fixture-poller");
    await reconcileStuckStandardTasks();
    expect(await incident(STUCK_TASK, task.id)).toEqual({ resolved: true });
  });

  it("never trusts a service merely for declaring supervision: unowned waits are flagged", async () => {
    const task = await admitted("working", 3 * 86_400);
    await reconcileStuckStandardTasks();
    expect(h.hookCalls).toBe(1);
    expect(await incident(STUCK_TASK, task.id)).toEqual({ resolved: false });
  });

  it("flags an admitted order nobody started, but not one still within its job lease", async () => {
    const fresh = await admitted("submitted", 120);
    const abandoned = await admitted("submitted", 700);
    await reconcileStuckStandardTasks();
    expect(await incident(STUCK_TASK, fresh.id)).toBeNull();
    expect(await incident(STUCK_TASK, abandoned.id)).toEqual({ resolved: false });
  });

  it("marks overdue work once and never fails it, then resolves the incident on late completion", async () => {
    // Accepted 13 hours ago under a 12-hour admitted duration, still running.
    const task = await admitted("working", 30, 13 * 3_600, 12 * 3_600);
    await expect(reconcileStuckStandardTasks()).resolves.toMatchObject({ overdue: 1 });
    const claim = async () => (await database.pool.query(
      `SELECT c.fulfillment_overdue_at,t.status FROM standard_dispatch_claims c JOIN transactions t ON t.id=c.transaction_id
        WHERE c.transaction_id=$1`, [task.id],
    )).rows[0];
    const first = await claim();
    expect(first.fulfillment_overdue_at).not.toBeNull();
    expect(first.status).toBe("working");
    expect(await incident(OVERDUE_TASK, task.id)).toEqual({ resolved: false });
    await expect(reconcileStuckStandardTasks()).resolves.toMatchObject({ overdue: 0 });
    expect((await claim()).fulfillment_overdue_at).toEqual(first.fulfillment_overdue_at);

    await database.pool.query("UPDATE transactions SET status='completed',completed_at=now() WHERE id=$1", [task.id]);
    await reconcileStuckStandardTasks();
    expect(await incident(OVERDUE_TASK, task.id)).toEqual({ resolved: true });
  });

  it("does not stall-flag an order awaiting buyer input, yet still watches its fulfillment clock", async () => {
    const task = await admitted("input-required", 5 * 86_400, 31 * 86_400, 30 * 86_400);
    await expect(reconcileStuckStandardTasks()).resolves.toEqual({ stalled: 0, overdue: 1 });
    expect(await incident(STUCK_TASK, task.id)).toBeNull();
  });
});
