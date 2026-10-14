import type { Hex } from "viem";
import { pool } from "../db/pool.js";
import { getCurrentAssetOwner, type AssetOwner } from "../db/queries/assetOwnership.js";
import { getTransactionById } from "../db/queries/transactions.js";
import { inTransaction, type Queryable } from "../db/queryable.js";
import { canTransition, isTerminalState } from "../engine/stateMachine.js";
import { applyTaskTransition, type DeferredTaskEmits } from "../engine/taskTransitions.js";
import { recordMandatoryAudit } from "../events/emitter.js";
import { logError } from "../logger.js";
import type { AdapterResult } from "../serviceRegistry/types.js";
import { lockAssetOwnerFence, type AdmittedOwner } from "./assetOwnerFence.js";

/** The reviewed failure code of owner-only work whose admitted owner went stale. */
export const ASSET_OWNER_CHANGED = "asset_owner_changed";

const WITHHELD_MESSAGE = "The asset's owner changed before this result could be delivered.";

/** The definitive outcome persisted instead of a stale owner's deliverable. */
export const ASSET_OWNER_CHANGED_RESULT: AdapterResult = {
  status: "failed",
  failureClass: "terminal",
  error: ASSET_OWNER_CHANGED,
  message: WITHHELD_MESSAGE,
};

/**
 * Inside the caller's fenced transaction, withhold the result of owner-only
 * work admitted for an owner that is no longer current: an asset-action
 * execution ends failed with the redacted `asset_owner_changed` marker and
 * loses its staged input, the task's protected artifact fields are purged
 * so neither owner can reveal them, and a mandatory audit row names both
 * versions. With `failTask` a still-open task ends failed as well;
 * otherwise the caller persists ASSET_OWNER_CHANGED_RESULT through its own
 * finalization path.
 */
export async function withholdStaleOwnerOutcome(db: Queryable, args: {
  assetId: string;
  taskId: string;
  executionId: Buffer | null;
  admitted: AdmittedOwner;
  current: AssetOwner | null;
  phase: "execution" | "persistence";
  failTask: boolean;
  deferred: DeferredTaskEmits;
}): Promise<void> {
  if (args.executionId) {
    await db.query(
      `UPDATE standard_asset_action_executions
          SET state='failed',error_class=$2,sanitized_result=NULL,updated_at=now()
        WHERE execution_id=$1 AND state IN ('claimed','executing','attention')`,
      [args.executionId, ASSET_OWNER_CHANGED],
    );
    await db.query("DELETE FROM standard_destructive_action_payloads WHERE execution_id=$1", [args.executionId]);
  }
  await db.query("DELETE FROM artifact_secrets WHERE transaction_id=$1", [args.taskId]);
  const task = await getTransactionById(args.taskId, db);
  if (args.failTask && task && !isTerminalState(task.status)) {
    const open = canTransition(task.status, "failed")
      ? task
      : await applyTaskTransition(db, task, "working", {}, args.deferred);
    await applyTaskTransition(db, open, "failed", {
      message: WITHHELD_MESSAGE,
      failureClass: "terminal",
    }, args.deferred);
  }
  await recordMandatoryAudit(db, {
    transactionId: args.taskId,
    assetId: args.assetId,
    serviceId: task?.service_id,
    source: "system",
    severity: "warn",
    type: "asset_owner.result_withheld",
    message: "A result admitted under an earlier asset owner was withheld.",
    payload: {
      phase: args.phase,
      executionId: args.executionId ? `0x${args.executionId.toString("hex")}` : null,
      admittedVersion: args.admitted.version,
      currentVersion: args.current?.version ?? null,
    },
    actor: "system:asset-owner-fence",
  });
}

/**
 * Withhold, in its own fenced transaction, an execution whose owner went
 * stale before its supplier call: nothing was done for the stale owner, and
 * the execution and its task end failed.
 */
export async function recordStaleOwnerExecution(args: {
  assetId: string;
  taskId: string;
  executionId: Hex;
  admitted: AdmittedOwner;
}): Promise<void> {
  const deferred: DeferredTaskEmits = [];
  await inTransaction(pool, async (db) => {
    await lockAssetOwnerFence(db, args.assetId);
    await withholdStaleOwnerOutcome(db, {
      assetId: args.assetId,
      taskId: args.taskId,
      executionId: Buffer.from(args.executionId.slice(2), "hex"),
      admitted: args.admitted,
      current: await getCurrentAssetOwner(args.assetId, db),
      phase: "execution",
      failTask: true,
      deferred,
    });
  });
  for (const emit of deferred) emit();
}

/**
 * Audit a release refused at the fence. The refusal itself already holds:
 * nothing was loaded or signed, so a failure to write this row is logged
 * rather than turning the refusal into an outage.
 */
export async function recordWithheldRelease(db: Queryable, args: {
  assetId: string;
  taskId: string;
  executionId: Buffer;
  admitted: AdmittedOwner;
}): Promise<void> {
  try {
    await recordMandatoryAudit(db, {
      transactionId: args.taskId,
      assetId: args.assetId,
      source: "system",
      severity: "warn",
      type: "asset_owner.release_withheld",
      message: "A result admitted under an earlier asset owner was not released.",
      payload: {
        executionId: `0x${args.executionId.toString("hex")}`,
        admittedVersion: args.admitted.version,
      },
      actor: "system:asset-owner-fence",
    });
  } catch (error) {
    logError("Withheld asset release could not be audited", {
      errorClass: error instanceof Error ? error.name : "UnknownError",
    });
  }
}
