import type { AssetRow } from "../db/queries/assets.js";
import { executeAdapter } from "../engine/adapterExecution.js";
import { processAdapterResult } from "../engine/taskFinalization.js";
import { compileProviderSchema, validateProviderRequest } from "./schema.js";
import { completeAssetAction, markAssetActionAttention } from "./actionStore.js";
import type { AssetActionDefinitionV1 } from "./walletConfig.js";
import type { Hex } from "viem";
import { revealStandardActionArtifacts } from "../a2a/responseBuilder.js";
import { applyPreExecuteDecision, consultPreExecuteAgent } from "../engine/preExecuteRunner.js";
import type { ServiceRow } from "../db/queries/services.js";
import type { SkillRow } from "../db/queries/skills.js";

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

export async function regenerateEphemeralAssetActionResult(args: {
  definition: AssetActionDefinitionV1;
  taskId: string;
  serviceId: string;
  input: Record<string, unknown>;
  asset: AssetRow;
}): Promise<Record<string, unknown>> {
  const result = await executeAdapter(
    args.definition.serviceSlug,
    args.definition.actionId,
    { id: args.taskId, service_id: args.serviceId, skill_id: args.definition.actionId, status: "completed" },
    args.input,
    args.asset,
  );
  if (result.status !== "completed") throw new Error("ephemeral result unavailable");
  const sanitized = await sanitizedResult(args.taskId, result);
  validateProviderRequest(compileProviderSchema(args.definition.responseSchema), sanitized, "Response");
  return sanitized;
}

export async function executeAssetAction(args: {
  definition: AssetActionDefinitionV1;
  executionId: Hex;
  taskId: string;
  service: ServiceRow;
  skill: SkillRow;
  input: Record<string, unknown>;
  asset: AssetRow;
  persistResult: boolean;
  safetyReviewed?: boolean;
}): Promise<{
  status: "completed" | "failed" | "attention";
  result: Record<string, unknown> | null;
  errorClass: string | null;
}> {
  try {
    if (!args.safetyReviewed) {
      const decision = await consultPreExecuteAgent(
        args.service,
        args.skill,
        args.input,
        true,
        args.taskId,
        args.asset,
      );
      const reviewed = await applyPreExecuteDecision({
        decision,
        transactionId: args.taskId,
        service: args.service,
        skill: args.skill,
        requestData: args.input,
        assetContext: args.asset,
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
      args.asset,
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
    await processAdapterResult(args.taskId, adapterResult, args.service.id);
    if (adapterResult.status !== "completed") {
      await completeAssetAction({
        executionId: args.executionId,
        status: "failed",
        result: null,
        errorClass: adapterResult.status === "input-required" ? "input_required" : "provider_failed",
      });
      return {
        status: "failed",
        result: null,
        errorClass: adapterResult.status === "input-required" ? "input_required" : "provider_failed",
      };
    }
    const result = await sanitizedResult(args.taskId, adapterResult);
    validateProviderRequest(compileProviderSchema(args.definition.responseSchema), result, "Response");
    await completeAssetAction({
      executionId: args.executionId,
      status: "completed",
      result: args.persistResult ? result : null,
      errorClass: null,
    });
    return { status: "completed", result, errorClass: null };
  } catch {
    await markAssetActionAttention(args.executionId).catch(() => undefined);
    return { status: "attention", result: null, errorClass: null };
  }
}
