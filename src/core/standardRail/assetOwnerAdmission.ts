import { pool } from "../db/pool.js";
import type { AssetOwner } from "../db/queries/assetOwnership.js";
import { inTransaction, type Queryable } from "../db/queryable.js";
import { admitAssetOwner, admittedOwnerOf, assertAdmittedOwnerCurrent } from "./assetOwnerFence.js";
import type { FulfillmentJobLease } from "./fulfillmentJobs.js";
import { ownedLease } from "./orderStart.js";

// Owner-only paid work on an existing asset is admitted under the asset owner
// fence like an asset action: dispatch links the order to its asset only
// while the payer is the current owner and records that admission, every
// resumption (buyer input, a reviewed execution) re-admits it, the
// consequential call checks it once more, and task finalization withholds
// the result if it went stale. Orders without an admitted owner (first-time
// provisioning, any-payer lookups) pass through every check unchanged.

interface TaskAdmissionRow {
  asset_id: string | null;
  standard_payer: string | null;
  admitted_owner: string | null;
  admitted_owner_version: number | null;
}

async function taskAdmission(db: Queryable, taskId: string): Promise<TaskAdmissionRow> {
  const row = (await db.query<TaskAdmissionRow>(
    "SELECT asset_id,standard_payer,admitted_owner,admitted_owner_version FROM transactions WHERE id=$1",
    [taskId],
  )).rows[0];
  if (!row) throw new Error(`Transaction not found: ${taskId}`);
  return row;
}

/**
 * Link an owner-only paid order to its asset under the fence, recording the
 * admitted owner. Only the executor that may still start the order admits
 * it: the order is unstarted and the executor holds its live
 * fulfillment-job lease, so an executor that lost the order never moves the
 * owner a started call was admitted under.
 */
export async function admitPaidTaskForAsset(args: {
  taskId: string;
  assetId: string;
  payer: string;
  lease: FulfillmentJobLease;
}): Promise<AssetOwner> {
  return inTransaction(pool, async (db) => {
    const owner = await admitAssetOwner(db, args.assetId, args.payer);
    const linked = await db.query(
      `UPDATE transactions t
          SET asset_id=$2,admitted_owner=$3,admitted_owner_version=$4,updated_at=now()
        WHERE t.id=$1 AND t.standard_order_id IS NOT NULL AND (t.asset_id IS NULL OR t.asset_id=$2)
          AND t.status='submitted' AND ${ownedLease("$5", "$6")}`,
      [args.taskId, args.assetId, owner.payer, owner.version, args.lease.id, args.lease.leaseToken],
    );
    if (linked.rowCount !== 1) {
      throw new Error(`Transaction ${args.taskId} is started, leased to another executor or bound to another asset`);
    }
    return owner;
  });
}

/**
 * Re-admit an owner-only order before its work resumes: the order's payer
 * must still own the asset, and the admission moves to the current version.
 * Null for an order that carries no admitted owner.
 */
export async function readmitPaidTaskOwner(taskId: string): Promise<AssetOwner | null> {
  return inTransaction(pool, async (db) => {
    const task = await taskAdmission(db, taskId);
    if (!task.asset_id || !task.admitted_owner || !task.standard_payer) return null;
    const owner = await admitAssetOwner(db, task.asset_id, task.standard_payer);
    await db.query(
      "UPDATE transactions SET admitted_owner=$2,admitted_owner_version=$3,updated_at=now() WHERE id=$1",
      [taskId, owner.payer, owner.version],
    );
    return owner;
  });
}

/** The short fenced check immediately before the consequential call; nothing stays locked. */
export async function checkPaidTaskOwner(taskId: string): Promise<void> {
  await inTransaction(pool, async (db) => {
    const task = await taskAdmission(db, taskId);
    if (!task.asset_id || !task.admitted_owner) return;
    await assertAdmittedOwnerCurrent(db, task.asset_id, admittedOwnerOf(task));
  });
}
