import { randomUUID } from "node:crypto";
import type { Hex } from "viem";
import {
  claimDurableJob,
  completeDurableJob,
  failDurableJob,
  withDurableJobLease,
} from "../db/queries/durableJobs.js";
import { getAssetById } from "../db/queries/assets.js";
import { getServiceById } from "../db/queries/services.js";
import { getSkillByServiceAndSkillId } from "../db/queries/skills.js";
import { getTransactionById } from "../db/queries/transactions.js";
import {
  ESCALATION_RESOLUTION_QUEUE,
  finalizeStandardActionResolution,
  getPreExecuteResolution,
  markResolutionAttention,
  startResolutionExecution,
} from "../engine/escalationResolutionStore.js";
import {
  openExecutionSnapshot,
  openReviewEvidence,
  validateAndMergeReviewerEdits,
} from "../engine/escalationSnapshot.js";
import { transitionTask } from "../engine/taskManager.js";
import { failWorker, heartbeatWorker, setWorkerStatus } from "../health.js";
import { errorExtra, logError, logInfo } from "../logger.js";
import { workerCycleFailed, workerCycleSucceeded } from "../observability/workerConditions.js";
import { assetActionHandler, contractHandler } from "../serviceRegistry/retainedHandlers.js";
import { admittedActionDefinition } from "./actionDefinitions.js";
import { executeAssetAction } from "./actionExecution.js";
import { completeAssetAction } from "./actionCompletion.js";
import { admitAssetActionResumption, loadAssetActionForTask } from "./actionStore.js";
import { targetOf } from "./assetActionTarget.js";
import { admittedOwnerOf, AssetOwnerChangedError } from "./assetOwnerFence.js";
import { recordStaleOwnerExecution } from "./assetOwnerOutcome.js";
import { assertProviderWalletAvailable, type ProviderWalletConfig } from "./walletConfig.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { listingVersion } from "./listingVersions.js";
import { finishReviewedPaidOrder, resolveReviewedPaidOrder } from "./reviewResolutionExecution.js";

const workerId = `standard-review:${process.pid}:${randomUUID()}`;
const hex = (value: Buffer): Hex => `0x${value.toString("hex")}`;

async function resolveStandardAction(
  escalationId: string,
  standardRail: ProviderStandardRailConfig,
  wallet: ProviderWalletConfig,
): Promise<void> {
  let row = await getPreExecuteResolution(escalationId);
  if (!row) throw new Error("review not found");
  if (["approved", "edited", "rejected", "resolution_attention"].includes(row.status)) return;
  const actionExecution = row.transaction_id
    ? await loadAssetActionForTask(row.transaction_id)
    : null;
  if (row.status === "resolution_result_ready") {
    if (actionExecution) throw new Error("asset action unexpectedly stored a paid-order result");
    await finishReviewedPaidOrder(row);
    return;
  }
  let startedHere = false;
  if (row.status === "resolution_queued" || row.status === "rejection_queued") {
    const started = await startResolutionExecution(row.id);
    if (!started) throw new Error("review execution claim was lost");
    row = started;
    startedHere = true;
  }
  if (row.status !== "resolution_executing" || !row.transaction_id || !row.reviewer_decision) {
    throw new Error(`unexpected review state ${row.status}`);
  }
  const snapshot = openExecutionSnapshot(row);
  const review = openReviewEvidence(row);
  const input = validateAndMergeReviewerEdits(snapshot, review.edits);
  const task = await getTransactionById(row.transaction_id);
  if (!task) throw new Error("reviewed transaction no longer exists");
  if (!actionExecution) {
    // The order runs under the listing version it was sold under, whatever
    // the current head: refuse before any mutation claim when this build has
    // no handler for that version's contract.
    const version = task.standard_listing_manifest_hash
      ? await listingVersion(standardRail, hex(task.standard_listing_manifest_hash))
      : null;
    if (
      !version || version.serviceSlug !== snapshot.service.slug || version.skillId !== snapshot.skill.skillId ||
      !contractHandler(version.serviceSlug, version.skillId, version.contract)
    ) throw new Error("reviewed paid order's admitted contract is not executable by this build");
    await resolveReviewedPaidOrder({ row, snapshot, input, startedHere });
    return;
  }
  const execution = actionExecution;
  if (["completed", "failed"].includes(execution.state)) {
    if (!await finalizeStandardActionResolution(row.id, row.reviewer_decision)) {
      throw new Error("terminal standard action could not finalize its review");
    }
    return;
  }
  if (!startedHere) {
    await markResolutionAttention(row.id, "Execution ownership was recovered without a terminal action journal; refusing duplicate supplier work");
    return;
  }
  if (task.status !== "working" || task.service_id !== snapshot.service.id ||
      task.skill_id !== snapshot.skill.skillId || snapshot.transactionId !== task.id) {
    throw new Error("reviewed transaction changed after snapshot");
  }
  // The signed definition the execution was admitted under, current or retained.
  const definition = await admittedActionDefinition(wallet, hex(execution.action_definition_hash));
  if (
    !definition || definition.actionId !== task.skill_id || definition.serviceSlug !== snapshot.service.slug ||
    !assetActionHandler(definition)
  ) throw new Error("reviewed action definition is no longer admitted or executable");
  await assertProviderWalletAvailable(wallet, definition);
  const [service, skill, asset] = await Promise.all([
    getServiceById(snapshot.service.id),
    getSkillByServiceAndSkillId(snapshot.service.id, snapshot.skill.skillId),
    snapshot.asset ? getAssetById(snapshot.asset.id) : Promise.resolve(null),
  ]);
  if (!service || !skill || !asset || service.slug !== snapshot.service.slug ||
      service.version !== snapshot.service.version || service.config_revision !== snapshot.service.configRevision ||
      skill.id !== snapshot.skill.id || skill.updated_at.toISOString() !== snapshot.skill.updatedAt ||
      asset.service_id !== snapshot.asset?.serviceId || asset.identifier !== snapshot.asset?.identifier) {
    throw new Error("reviewed service, skill, or asset changed after snapshot");
  }
  const executionId = hex(execution.execution_id);
  // Resuming is a new admission under the asset owner fence: the execution's
  // payer must still own the asset, or its outcome is withheld.
  let resumed;
  try {
    resumed = await admitAssetActionResumption(executionId, task.id);
  } catch (error) {
    if (!(error instanceof AssetOwnerChangedError)) throw error;
    await recordStaleOwnerExecution({
      assetId: execution.provider_asset_id, taskId: task.id, executionId, admitted: admittedOwnerOf(execution),
    });
    if (!await finalizeStandardActionResolution(row.id, row.reviewer_decision)) {
      throw new Error("standard action review finalization claim was lost");
    }
    return;
  }
  if (!resumed) throw new Error("standard action review lost its execution claim");
  try {
    if (row.reviewer_decision === "rejected") {
      await transitionTask(task.id, "failed", "Human reviewer rejected the protected request.", "terminal");
      await completeAssetAction({ executionId, status: "failed", result: null, errorClass: "review_rejected" });
    } else {
      const result = await executeAssetAction({
        definition,
        executionId,
        taskId: task.id,
        service,
        skill,
        input,
        target: targetOf(resumed),
        persistResult: definition.replayPolicy !== "regenerate-ephemeral",
        safetyReviewed: true,
      });
      if (result.status === "attention") {
        await markResolutionAttention(row.id, "Reviewed action needs reconciliation before it can be retried");
        return;
      }
    }
  } catch (error) {
    // A stale owner's outcome is recorded and withheld; the review is done.
    if (!(error instanceof AssetOwnerChangedError)) throw error;
  }
  if (!await finalizeStandardActionResolution(row.id, row.reviewer_decision)) {
    throw new Error("standard action review finalization claim was lost");
  }
}

export function startStandardReviewResolutionWorker(
  standardRail: ProviderStandardRailConfig,
  wallet: ProviderWalletConfig,
): () => Promise<void> {
  let stopping = false;
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  setWorkerStatus("standard-review-resolution", false);
  const tick = async () => {
    try {
      while (!stopping) {
        const job = await claimDurableJob({ queue: ESCALATION_RESOLUTION_QUEUE, workerId, leaseSeconds: 300 });
        if (!job) break;
        const escalationId = String(job.payload.escalationId ?? "");
        try {
          await withDurableJobLease({
            id: job.id, workerId, leaseToken: job.lease_token, leaseSeconds: 300,
            work: async (assertOwned) => {
              await resolveStandardAction(escalationId, standardRail, wallet);
              assertOwned();
            },
          });
          if (!await completeDurableJob({ id: job.id, workerId, leaseToken: job.lease_token })) {
            throw new Error("review job completion lease was lost");
          }
        } catch (error) {
          const status = await failDurableJob({
            id: job.id, workerId, leaseToken: job.lease_token,
            error: error instanceof Error ? error.message : "review resolution failed",
            retryAt: new Date(Date.now() + Math.min(3_600, 5 * 2 ** Math.min(job.attempts, 10)) * 1_000),
          });
          if (status === "dead_letter" && escalationId) {
            await markResolutionAttention(escalationId, "Review resolution retry budget was exhausted");
          }
          logError("Standard review resolution failed", errorExtra(error, { jobId: job.id }));
        }
      }
      heartbeatWorker("standard-review-resolution");
      if (workerCycleSucceeded("standard-review-resolution")) logInfo("Standard review worker recovered", {});
    } catch (error) {
      failWorker("standard-review-resolution");
      if (workerCycleFailed("standard-review-resolution", error)) logError("Standard review worker failed", errorExtra(error));
    } finally {
      running = null;
      if (!stopping) { timer = setTimeout(start, 5_000); timer.unref(); }
    }
  };
  const start = () => { if (!running && !stopping) running = tick(); };
  start();
  return async () => { stopping = true; if (timer) clearTimeout(timer); if (running) await running; };
}
