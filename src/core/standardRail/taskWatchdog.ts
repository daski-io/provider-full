import { pool } from "../db/pool.js";
import { failWorker, heartbeatWorker, setWorkerStatus } from "../health.js";
import { recordStandardSecurityIncident } from "./incidents.js";
import type { ProviderStandardRailConfig } from "./config.js";

const WORKER = "standard-task-watchdog";

interface StuckTask {
  id: string;
  standard_order_id: string;
  standard_listing_manifest_hash: Buffer;
  status: string;
  updated_at: Date;
}

export async function reconcileStuckStandardTasks(
  config: ProviderStandardRailConfig,
  now = Date.now(),
): Promise<number> {
  const result = await pool.query<StuckTask>(
    `SELECT id,standard_order_id,standard_listing_manifest_hash,status,updated_at
       FROM transactions
      WHERE standard_order_id IS NOT NULL
        AND status IN ('submitted','dispatching','working')`,
  );
  const deadlines = new Map([...config.outcomes.values()].map((outcome) => [
    outcome.listingManifestHash.toLowerCase(), outcome.dispatchDeadlineSeconds,
  ]));
  let incidents = 0;
  for (const task of result.rows) {
    const hash = `0x${task.standard_listing_manifest_hash.toString("hex")}`.toLowerCase();
    const deadline = deadlines.get(hash);
    if (!deadline || task.updated_at.getTime() + deadline * 1_000 > now) continue;
    await recordStandardSecurityIncident({
      kind: "stuck_standard_task",
      orderId: task.standard_order_id,
      identity: { taskId: task.id, orderId: task.standard_order_id },
      details: { taskId: task.id, state: task.status, listingManifestHash: hash },
    });
    await pool.query(
      `UPDATE transactions
          SET metadata=metadata || '{"standard_reconciliation_required":true}'::jsonb
        WHERE id=$1 AND standard_order_id=$2`,
      [task.id, task.standard_order_id],
    );
    incidents += 1;
  }
  return incidents;
}

export function startStandardTaskWatchdog(config: ProviderStandardRailConfig): () => void {
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await reconcileStuckStandardTasks(config);
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
