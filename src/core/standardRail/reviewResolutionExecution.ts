import { pool } from "../db/pool.js";
import { getAssetById, type AssetRow } from "../db/queries/assets.js";
import { getServiceById, type ServiceRow } from "../db/queries/services.js";
import { getSkillByServiceAndSkillId, type SkillRow } from "../db/queries/skills.js";
import { getTransactionById, type TransactionRow } from "../db/queries/transactions.js";
import { executeAdapter } from "../engine/adapterExecution.js";
import {
  finalizeResolution,
  getPreExecuteResolution,
  markResolutionAttention,
  saveResolutionAdapterResult,
  type PreExecuteEscalationRow,
} from "../engine/escalationResolutionStore.js";
import {
  openAdapterResult,
  sealAdapterResult,
  hashCanonical as hashSnapshot,
  type ExecutionSnapshot,
} from "../engine/escalationSnapshot.js";
import { processAdapterResult } from "../engine/taskFinalization.js";
import { claimSupplierMutation } from "../engine/taskTransitions.js";
import { admittedSupplierCostCeiling } from "../serviceRegistry/supplierCostCeiling.js";
import { canonicalHash } from "./canonical.js";

interface CurrentContext {
  task: TransactionRow;
  service: ServiceRow;
  skill: SkillRow;
  asset: AssetRow | null;
}

async function loadCurrentContext(
  row: PreExecuteEscalationRow,
  snapshot: ExecutionSnapshot,
): Promise<CurrentContext> {
  const [task, service, skill, asset] = await Promise.all([
    row.transaction_id ? getTransactionById(row.transaction_id) : Promise.resolve(null),
    getServiceById(snapshot.service.id),
    getSkillByServiceAndSkillId(snapshot.service.id, snapshot.skill.skillId),
    snapshot.asset ? getAssetById(snapshot.asset.id) : Promise.resolve(null),
  ]);
  if (!task || !service || !skill || Boolean(asset) !== Boolean(snapshot.asset)) {
    throw new Error("reviewed execution context no longer exists");
  }
  if (
    task.id !== snapshot.transactionId || task.status !== "working" ||
    task.service_id !== snapshot.service.id || task.skill_id !== snapshot.skill.skillId ||
    service.slug !== snapshot.service.slug || service.version !== snapshot.service.version ||
    service.adapter_name !== snapshot.service.adapterName ||
    service.config_revision !== snapshot.service.configRevision || !service.is_active ||
    skill.id !== snapshot.skill.id || skill.updated_at.toISOString() !== snapshot.skill.updatedAt ||
    !skill.is_active ||
    (asset && snapshot.asset && (
      asset.service_id !== snapshot.asset.serviceId || asset.identifier !== snapshot.asset.identifier ||
      asset.status !== snapshot.asset.status ||
      hashSnapshot(asset.metadata) !== hashSnapshot(snapshot.asset.metadata)
    ))
  ) throw new Error("reviewed execution context changed after its protected snapshot");
  return { task, service, skill, asset };
}

async function persistDispatchState(task: TransactionRow, result: object, state: string): Promise<void> {
  if (!task.standard_order_id) throw new Error("reviewed paid task has no standard order id");
  await pool.query(
    `UPDATE standard_dispatch_claims
        SET state=$2,response_hash=$3,
            resolved_at=CASE WHEN $2 IN ('completed','failed','canceled') THEN now() ELSE NULL END
      WHERE order_id=$1 AND transaction_id=$4`,
    [task.standard_order_id, state, Buffer.from(canonicalHash(result).slice(2), "hex"), task.id],
  );
}

export async function finishReviewedPaidOrder(row: PreExecuteEscalationRow): Promise<void> {
  if (row.status !== "resolution_result_ready" || !row.reviewer_decision) {
    throw new Error("reviewed paid result is not ready");
  }
  const result = openAdapterResult(row);
  const task = await processAdapterResult(row.transaction_id!, result, row.snapshot_service_id);
  await persistDispatchState(task, result, task.status);
  if (!await finalizeResolution(row.id, row.reviewer_decision)) {
    const current = await getPreExecuteResolution(row.id);
    if (current?.status !== row.reviewer_decision) throw new Error("paid review finalization claim was lost");
  }
}

export async function resolveReviewedPaidOrder(args: {
  row: PreExecuteEscalationRow;
  snapshot: ExecutionSnapshot;
  input: Record<string, unknown>;
  startedHere: boolean;
}): Promise<void> {
  if (args.row.status === "resolution_result_ready") return finishReviewedPaidOrder(args.row);
  const context = await loadCurrentContext(args.row, args.snapshot);
  if (args.row.reviewer_decision === "rejected") {
    const result = {
      status: "failed" as const,
      failureClass: "terminal" as const,
      error: "standard_review_rejected",
      message: "Human reviewer rejected the protected request.",
    };
    const task = await processAdapterResult(context.task.id, result, context.service.id);
    await persistDispatchState(task, result, task.status);
    if (!await finalizeResolution(args.row.id, "rejected")) {
      throw new Error("paid rejection finalization claim was lost");
    }
    return;
  }
  if (!args.startedHere) {
    await markResolutionAttention(
      args.row.id,
      "Execution ownership was recovered without a durable supplier result; refusing duplicate supplier work",
    );
    return;
  }
  let task = context.task;
  // Parsed before the mutation claim: a reviewed re-execution spends under
  // the same admitted ceiling as the original attempt, never a new one.
  const supplierCostCeiling = admittedSupplierCostCeiling(task.metadata);
  if (args.row.source === "pre_execute") {
    const claimed = await claimSupplierMutation({
      taskId: task.id,
      expectedStatus: task.status,
      expectedVersion: task.version,
    });
    if (!claimed) throw new Error("reviewed supplier mutation claim was lost");
    task = claimed;
  }
  let result;
  try {
    result = await executeAdapter(
      context.service.adapter_name,
      context.skill.skill_id,
      {
        id: task.id,
        service_id: task.service_id,
        skill_id: task.skill_id,
        status: task.status,
        supplierMutationStarted: true,
        supplierCostCeiling,
      },
      args.input,
      context.asset ?? undefined,
    );
  } catch (error) {
    await markResolutionAttention(args.row.id, "Reviewed supplier outcome is ambiguous and requires reconciliation");
    throw error;
  }
  const current = await getPreExecuteResolution(args.row.id);
  if (!current || current.status !== "resolution_executing") {
    await markResolutionAttention(args.row.id, "Review state changed after supplier execution");
    throw new Error("review result persistence claim was lost");
  }
  const sealed = sealAdapterResult(current, result);
  if (!await saveResolutionAdapterResult(current.id, sealed.encrypted, sealed.hash)) {
    await markResolutionAttention(args.row.id, "Supplier result could not be durably persisted");
    throw new Error("review result persistence claim was lost");
  }
  const ready = await getPreExecuteResolution(args.row.id);
  if (!ready) throw new Error("review disappeared after result persistence");
  await finishReviewedPaidOrder(ready);
}
