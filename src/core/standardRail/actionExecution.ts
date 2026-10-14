import type { AssetRow } from "../db/queries/assets.js";
import { executeAdapter } from "../engine/adapterExecution.js";
import { processAdapterResult } from "../engine/taskFinalization.js";
import { compileProviderSchema, validateProviderRequest } from "./schema.js";
import { completeAssetAction, markAssetActionAttention, settleAssetAction } from "./actionCompletion.js";
import type { AssetActionDefinitionV1 } from "./walletConfig.js";
import type { Hex } from "viem";
import { revealStandardActionArtifacts } from "../a2a/responseBuilder.js";
import { applyPreExecuteDecision, consultPreExecuteAgent } from "../engine/preExecuteRunner.js";
import type { ServiceRow } from "../db/queries/services.js";
import type { SkillRow } from "../db/queries/skills.js";
import {
  AssetActionTargetDeniedError,
  loadAdmittedAssetTarget,
  type AssetActionTarget,
} from "./assetActionTarget.js";
import { AssetOwnerChangedError } from "./assetOwnerFence.js";
import { recordStaleOwnerExecution } from "./assetOwnerOutcome.js";

async function sanitizedResult(
  taskId: string,
  result: Awaited<ReturnType<typeof executeAdapter>>,
): Promise<Record<string, unknown>> {
  const artifacts = await revealStandardActionArtifacts(taskId, result.artifacts ?? []);
  if (artifacts.length === 1 && artifacts[0]?.data) {
    return artifacts[0].data;
  }
  return {
    message: result.message ?? null,
    artifacts: artifacts.map((artifact, index) => ({
      name: artifact.name,
      data: artifact.data ?? null,
      mimeType: result.artifacts?.[index]?.mimeType ?? null,
    })),
  };
}

/**
 * Regenerate an ephemeral result for a replay or recovery: the execution's
 * admitted owner must still be current and its asset still an eligible
 * target. The caller releases the result under the owner fence.
 */
export async function regenerateEphemeralAssetActionResult(args: {
  definition: AssetActionDefinitionV1;
  taskId: string;
  serviceId: string;
  input: Record<string, unknown>;
  target: AssetActionTarget;
}): Promise<Record<string, unknown>> {
  const asset = await loadAdmittedAssetTarget(args);
  const result = await executeAdapter(
    args.definition.serviceSlug,
    args.definition.actionId,
    { id: args.taskId, service_id: args.serviceId, skill_id: args.definition.actionId, status: "completed" },
    args.input,
    asset,
  );
  if (result.status !== "completed") throw new Error("ephemeral result unavailable");
  const sanitized = await sanitizedResult(args.taskId, result);
  validateProviderRequest(compileProviderSchema(args.definition.responseSchema), sanitized, "Response");
  return sanitized;
}

/**
 * The asset this execution may act on now. A stale owner withholds the
 * execution (failed with the redacted marker, recorded here) and throws.
 */
async function currentTarget(args: {
  definition: AssetActionDefinitionV1;
  executionId: Hex;
  taskId: string;
  service: ServiceRow;
  input: Record<string, unknown>;
  target: AssetActionTarget;
}): Promise<AssetRow> {
  try {
    return await loadAdmittedAssetTarget({
      definition: args.definition, serviceId: args.service.id, target: args.target, input: args.input,
    });
  } catch (error) {
    if (error instanceof AssetOwnerChangedError) {
      await recordStaleOwnerExecution({
        assetId: args.target.assetId, taskId: args.taskId, executionId: args.executionId, admitted: args.target.admitted,
      });
    }
    throw error;
  }
}

/**
 * Execute an admitted asset action. The target is loaded for the review and
 * checked again immediately before the supplier call (the consequential
 * execution), and the outcome settles the task and the execution together
 * at the owner-fenced persistence boundary. A stale owner throws
 * AssetOwnerChangedError with the withheld outcome already recorded; an
 * asset that is no longer an eligible target fails the action definitively
 * without supplier work.
 */
export async function executeAssetAction(args: {
  definition: AssetActionDefinitionV1;
  executionId: Hex;
  taskId: string;
  service: ServiceRow;
  skill: SkillRow;
  input: Record<string, unknown>;
  target: AssetActionTarget;
  persistResult: boolean;
  safetyReviewed?: boolean;
}): Promise<{
  status: "completed" | "failed" | "attention";
  result: Record<string, unknown> | null;
  errorClass: string | null;
}> {
  try {
    let asset = await currentTarget(args);
    if (!args.safetyReviewed) {
      const decision = await consultPreExecuteAgent(
        args.service,
        args.skill,
        args.input,
        true,
        args.taskId,
        asset,
      );
      const reviewed = await applyPreExecuteDecision({
        decision,
        transactionId: args.taskId,
        service: args.service,
        skill: args.skill,
        requestData: args.input,
        assetContext: asset,
      });
      if (reviewed.terminal) {
        if (decision.action === "reject") {
          await completeAssetAction({
            executionId: args.executionId,
            status: "failed",
            result: null,
            errorClass: "review_rejected",
          });
          return { status: "failed", result: null, errorClass: "review_rejected" };
        }
        await markAssetActionAttention(args.executionId);
        return { status: "attention", result: null, errorClass: null };
      }
      asset = await currentTarget(args);
    }
    const adapterResult = await executeAdapter(
      args.definition.serviceSlug,
      args.definition.actionId,
      {
        id: args.taskId,
        service_id: args.service.id,
        skill_id: args.definition.actionId,
        status: "working",
      },
      args.input,
      asset,
    );
    const retryable = adapterResult.status === "working" ||
      (adapterResult.status === "failed" && adapterResult.failureClass === "retryable");
    if (retryable) {
      if (adapterResult.status === "working") {
        await processAdapterResult(args.taskId, adapterResult, args.service.id);
      }
      await markAssetActionAttention(args.executionId);
      return { status: "attention", result: null, errorClass: null };
    }
    const settled = { executionId: args.executionId, taskId: args.taskId, serviceId: args.service.id, adapterResult };
    if (adapterResult.status !== "completed") {
      const errorClass = adapterResult.status === "input-required" ? "input_required" : "provider_failed";
      await settleAssetAction({ ...settled, status: "failed", result: null, errorClass });
      return { status: "failed", result: null, errorClass };
    }
    // The answer is built and checked before anything is persisted, then the
    // task and the execution settle together under the owner fence.
    const result = await sanitizedResult(args.taskId, adapterResult);
    validateProviderRequest(compileProviderSchema(args.definition.responseSchema), result, "Response");
    await settleAssetAction({
      ...settled,
      status: "completed",
      result: args.persistResult ? result : null,
      errorClass: null,
    });
    return { status: "completed", result, errorClass: null };
  } catch (error) {
    // A stale owner's outcome is already recorded and withheld from both owners.
    if (error instanceof AssetOwnerChangedError) throw error;
    if (error instanceof AssetActionTargetDeniedError) {
      try {
        return await failUnavailableTarget(args);
      } catch (failure) {
        if (failure instanceof AssetOwnerChangedError) throw failure;
      }
    }
    await markAssetActionAttention(args.executionId).catch(() => undefined);
    return { status: "attention", result: null, errorClass: null };
  }
}

/** The asset is no longer an eligible target: the action fails without supplier work. */
async function failUnavailableTarget(args: {
  executionId: Hex;
  taskId: string;
  service: ServiceRow;
}): Promise<{ status: "failed"; result: null; errorClass: string }> {
  await settleAssetAction({
    executionId: args.executionId,
    taskId: args.taskId,
    serviceId: args.service.id,
    adapterResult: {
      status: "failed",
      failureClass: "terminal",
      error: "asset_unavailable",
      message: "The asset is no longer available for this action.",
    },
    status: "failed",
    result: null,
    errorClass: "asset_unavailable",
  });
  return { status: "failed", result: null, errorClass: "asset_unavailable" };
}
