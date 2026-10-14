import { pool } from "../db/pool.js";
import { failWorker, heartbeatWorker, setWorkerStatus } from "../health.js";
import { recordStandardSecurityIncident, resolveTaskIncidents } from "./incidents.js";
import { supervisedWaitingTasks } from "./waitSupervision.js";

/*
 * The standard task watchdog watches two clocks, never the dispatch deadline:
 *
 * - Worker progress. A never-started order should be resumed within its
 *   fulfillment job's lease; a working task should show progress unless a
 *   healthy service poller durably supervises its wait. A stalled task gets
 *   a `stuck_standard_task` incident, resolved when it progresses, finishes
 *   or is supervised again, and reopened if it stalls again.
 * - Fulfillment. Each claim records the duration its order was sold with,
 *   from durable acceptance. An open order past it is marked overdue once
 *   (`overdue_standard_task`); being overdue never makes it terminal.
 *
 * Both read only persisted per-order state, so they hold for orders of any
 * listing version, current or superseded.
 */

const WORKER = "standard-task-watchdog";
export const STUCK_TASK = "stuck_standard_task";
export const OVERDUE_TASK = "overdue_standard_task";
/** A never-started order is resumed within its 300 s job lease plus worker polls. */
export const START_STALL_SECONDS = 600;
/** An unsupervised working task reports progress at least this often. */
export const PROGRESS_STALL_SECONDS = 900;

interface OpenTask {
  id: string;
  standard_order_id: string;
  status: string;
  updated_at: Date;
  service_slug: string;
  overdue: boolean;
  marked_overdue: boolean;
}

export interface WatchdogPass {
  stalled: number;
  overdue: number;
}

async function markOverdue(task: OpenTask): Promise<boolean> {
  const marked = await pool.query(
    `UPDATE standard_dispatch_claims SET fulfillment_overdue_at=now()
      WHERE transaction_id=$1 AND order_id=$2 AND fulfillment_overdue_at IS NULL`,
    [task.id, task.standard_order_id],
  );
  await recordStandardSecurityIncident({
    kind: OVERDUE_TASK,
    orderId: task.standard_order_id,
    identity: { taskId: task.id, orderId: task.standard_order_id },
    details: { taskId: task.id, state: task.status },
  });
  return marked.rowCount === 1;
}

/** Drop the reconciliation flag a stall raised, unless an ambiguous supplier outcome raised it too. */
async function clearStallFlags(taskIds: readonly string[]): Promise<void> {
  if (taskIds.length === 0) return;
  await pool.query(
    `UPDATE transactions t SET metadata=t.metadata - 'standard_reconciliation_required'
      WHERE t.id=ANY($1::text[]) AND t.metadata ? 'standard_reconciliation_required'
        AND NOT EXISTS (SELECT 1 FROM standard_security_incidents i
                         WHERE i.incident_kind='ambiguous_supplier_outcome' AND i.details->>'taskId'=t.id)`,
    [[...taskIds]],
  );
}

export async function reconcileStuckStandardTasks(now = Date.now()): Promise<WatchdogPass> {
  const result = await pool.query<OpenTask>(
    `SELECT t.id,t.standard_order_id,t.status,t.updated_at,s.slug AS service_slug,
            COALESCE(c.claimed_at + c.admitted_fulfillment_seconds * interval '1 second' <= to_timestamp($1 / 1000.0), false)
              AS overdue,
            c.fulfillment_overdue_at IS NOT NULL AS marked_overdue
       FROM transactions t
       JOIN services s ON s.id=t.service_id
       JOIN standard_dispatch_claims c ON c.transaction_id=t.id AND c.order_id=t.standard_order_id
      WHERE t.standard_order_id IS NOT NULL
        AND t.status IN ('submitted','working','input-required')`,
    [now],
  );
  let overdue = 0;
  for (const task of result.rows) {
    if (task.overdue && !task.marked_overdue && await markOverdue(task)) overdue += 1;
  }
  const cleared: string[] = [];
  const candidates: OpenTask[] = [];
  for (const task of result.rows) {
    const quiet = now - task.updated_at.getTime();
    const stalled = (task.status === "submitted" && quiet >= START_STALL_SECONDS * 1_000) ||
      (task.status === "working" && quiet >= PROGRESS_STALL_SECONDS * 1_000);
    if (stalled) candidates.push(task);
    else cleared.push(task.id);
  }
  const supervised = await supervisedWaitingTasks(candidates
    .filter((task) => task.status === "working")
    .map((task) => ({ id: task.id, serviceSlug: task.service_slug })));
  let stalled = 0;
  for (const task of candidates) {
    if (supervised.has(task.id)) {
      cleared.push(task.id);
      continue;
    }
    await recordStandardSecurityIncident({
      kind: STUCK_TASK,
      orderId: task.standard_order_id,
      identity: { taskId: task.id, orderId: task.standard_order_id },
      details: { taskId: task.id, state: task.status, quietSince: task.updated_at.toISOString() },
      reopen: true,
    });
    stalled += 1;
  }
  await clearStallFlags(await resolveTaskIncidents(STUCK_TASK, cleared));
  await resolveTaskIncidents(OVERDUE_TASK, []);
  return { stalled, overdue };
}

export function startStandardTaskWatchdog(): () => void {
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await reconcileStuckStandardTasks();
      heartbeatWorker(WORKER, 120);
    } catch {
      failWorker(WORKER);
    } finally {
      running = false;
    }
  };
  setWorkerStatus(WORKER, false, 120);
  void run();
  const timer = setInterval(() => void run(), 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
