import { pool } from "../db/pool.js";
import {
  getTransactionById,
  mergeTransactionMetadata,
  type TransactionRow,
  type TransactionStatus,
} from "../db/queries/transactions.js";
import { inTransaction, type Queryable } from "../db/queryable.js";
import { recordMandatoryAudit } from "../events/emitter.js";
import type { AdapterResult } from "../serviceRegistry/types.js";
import { storeAsset } from "./assetManager.js";
import { storeScreeningAssetProfile } from "../screening/registry.js";
import { taskEvents } from "./events.js";
import { canTransition } from "./stateMachine.js";
import {
  applyTaskTransition,
  type DeferredTaskEmits,
  type FailureClass,
} from "./taskTransitions.js";
import { enqueueReputationOutcome } from "../standardRail/reputationOutcomeStore.js";
import { getCurrentAssetOwner } from "../db/queries/assetOwnership.js";
import {
  admittedOwnerOf,
  assertAdmittedOwnerCurrent,
  AssetOwnerChangedError,
} from "../standardRail/assetOwnerFence.js";
import {
  ASSET_OWNER_CHANGED_RESULT,
  withholdStaleOwnerOutcome,
} from "../standardRail/assetOwnerOutcome.js";

async function persistDeliverables(
  taskId: string,
  serviceId: string,
  result: AdapterResult,
  db: Parameters<typeof recordMandatoryAudit>[0],
  deferred: DeferredTaskEmits,
): Promise<void> {
  for (const artifact of result.artifacts ?? []) {
    await recordMandatoryAudit(db, {
      transactionId: taskId,
      serviceId,
      source: "adapter",
      type: "transaction.artifact.created",
      message: `Artifact: ${artifact.name}`,
      payload: {
        name: artifact.name,
        mime_type: artifact.mimeType ?? "application/json",
        url: artifact.url,
        data: artifact.data,
        access_action: artifact.accessAction,
      },
    });
    deferred.push(() =>
      taskEvents.emitTaskEvent({
        type: "artifact",
        taskId,
        artifactName: artifact.name,
      })
    );
  }
  if (result.asset) {
    const asset = await storeAsset({
      transactionId: taskId,
      serviceId,
      type: result.asset.assetType,
      identifier: result.asset.assetIdentifier,
      metadata: result.asset.assetData,
      expiresAt: result.asset.expiresAt,
    }, db);
    if (result.asset.screeningSubjects?.length) {
      const service = await db.query<{ slug: string }>(
        "SELECT slug FROM services WHERE id = $1",
        [serviceId],
      );
      const serviceSlug = service.rows[0]?.slug;
      if (!serviceSlug) throw new Error("Asset service is unavailable during screening-profile commit");
      await storeScreeningAssetProfile({
        asset,
        serviceSlug,
        subjects: result.asset.screeningSubjects,
        db,
      });
    }
  }
}

function carriesDeliverables(result: AdapterResult): boolean {
  return result.status === "completed" || (result.artifacts?.length ?? 0) > 0 || Boolean(result.asset);
}

/**
 * The admission of owner-only work whose owner is no longer current, read
 * under the asset owner fence before anything else in the transaction; null
 * for a task without an admitted owner or one whose owner is still current.
 */
async function staleOwnerAdmission(db: Queryable, taskId: string) {
  const task = (await db.query<{
    asset_id: string | null;
    admitted_owner: string | null;
    admitted_owner_version: number | null;
    standard_action_execution_id: Buffer | null;
  }>(
    `SELECT asset_id,admitted_owner,admitted_owner_version,standard_action_execution_id
       FROM transactions WHERE id=$1`,
    [taskId],
  )).rows[0];
  if (!task?.asset_id || task.admitted_owner === null) return null;
  const admitted = admittedOwnerOf(task);
  try {
    await assertAdmittedOwnerCurrent(db, task.asset_id, admitted);
    return null;
  } catch (error) {
    if (!(error instanceof AssetOwnerChangedError)) throw error;
    return {
      assetId: task.asset_id,
      taskId,
      executionId: task.standard_action_execution_id,
      admitted,
      current: await getCurrentAssetOwner(task.asset_id, db),
    };
  }
}

/**
 * Persist a service result. This is the result-persistence boundary for
 * owner-only work: when the owner the task was admitted under is no longer
 * current, no deliverable of `result` is persisted; the task ends failed
 * with the reviewed `asset_owner_changed` outcome in the same transaction,
 * and AssetOwnerChangedError is thrown once that has committed.
 */
export async function processAdapterResult(
  taskId: string,
  result: AdapterResult,
  serviceId: string,
): Promise<TransactionRow> {
  const deferred: DeferredTaskEmits = [];
  let withheld = false;
  const task = await inTransaction(pool, async (db) => {
    let persisted = result;
    if (carriesDeliverables(result)) {
      const stale = await staleOwnerAdmission(db, taskId);
      if (stale) {
        await withholdStaleOwnerOutcome(db, { ...stale, phase: "persistence", failTask: false, deferred });
        persisted = ASSET_OWNER_CHANGED_RESULT;
        withheld = true;
      }
    }
    return persistAdapterResult(db, taskId, persisted, serviceId, deferred);
  });
  for (const emit of deferred) emit();
  if (withheld) throw new AssetOwnerChangedError();
  return task;
}

async function persistAdapterResult(
  db: Queryable,
  taskId: string,
  result: AdapterResult,
  serviceId: string,
  deferred: DeferredTaskEmits,
): Promise<TransactionRow> {
  let current = await getTransactionById(taskId, db);
  if (!current) throw new Error(`Transaction not found: ${taskId}`);
  if (
    current.status !== result.status
    && !canTransition(current.status, result.status)
    && canTransition(current.status, "working")
    && canTransition("working", result.status)
  ) {
    current = await applyTaskTransition(db, current, "working", {}, deferred);
  }
  await persistDeliverables(taskId, serviceId, result, db, deferred);
  if (result.status === "failed" && result.autoRefundContext) {
    await mergeTransactionMetadata(taskId, {
      auto_refund_class: result.autoRefundContext.class,
      failure_supplier: result.autoRefundContext.supplier,
      failure_kind: result.autoRefundContext.kind,
      failure_attempts: result.autoRefundContext.attempts,
    }, db);
  }
  if (current.status === result.status) {
    if (result.message && result.status === "working") {
      await recordMandatoryAudit(db, {
        transactionId: taskId,
        serviceId,
        source: "adapter",
        type: "transaction.message.agent",
        message: result.message,
        payload: { role: "agent", content: result.message },
      });
    }
    await enqueueReputationOutcome(current, db);
    return current;
  }
  const failureClass: FailureClass | null =
    result.status === "failed" ? result.failureClass ?? "terminal" : null;
  const transitioned = await applyTaskTransition(
    db,
    current,
    result.status as TransactionStatus,
    { message: result.message, failureClass },
    deferred,
  );
  await enqueueReputationOutcome(transitioned, db);
  return transitioned;
}
