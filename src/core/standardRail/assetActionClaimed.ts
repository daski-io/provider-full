import type { Hex } from "viem";
import type { ServiceRow } from "../db/queries/services.js";
import type { SkillRow } from "../db/queries/skills.js";
import { executeAssetAction, regenerateEphemeralAssetActionResult } from "./actionExecution.js";
import {
  loadAssetActionExecution,
  transitionAssetAction,
  type AssetActionExecutionRow,
} from "./actionStore.js";
import { releaseFinalResponse, type ResponseContext } from "./assetActionResponse.js";
import { targetOf } from "./assetActionTarget.js";
import type { SignedEnvelope } from "./types.js";
import type { AssetActionDefinitionV1 } from "./walletConfig.js";

/**
 * Answer a claimed non-destructive action. The request that moves the
 * execution from claimed to executing runs it; a replay of a finished
 * execution receives its stored result, or a regenerated ephemeral one for
 * the same admitted owner. Every final answer is released under the asset
 * owner fence, so a stale owner is never signed a result.
 */
export async function answerClaimedAssetAction(args: {
  claim: { row: AssetActionExecutionRow; taskId: string };
  executionId: Hex;
  definition: AssetActionDefinitionV1;
  service: ServiceRow;
  skill: SkillRow;
  input: Record<string, unknown>;
  context: ResponseContext;
}): Promise<SignedEnvelope<unknown>> {
  const { claim, definition, context } = args;
  const ownsExecution = claim.row.state === "claimed" &&
    await transitionAssetAction(args.executionId, "claimed", "executing", claim.taskId);
  if (ownsExecution) {
    const completed = await executeAssetAction({
      definition, executionId: args.executionId, taskId: claim.taskId,
      service: args.service, skill: args.skill, input: args.input, target: targetOf(claim.row),
      persistResult: definition.replayPolicy !== "regenerate-ephemeral",
    });
    if (completed.status === "attention") throw new Error("asset action unavailable");
    return releaseFinalResponse({
      row: { ...claim.row, state: completed.status, error_class: completed.errorClass },
      definition, context, stored: false, result: completed.result,
    });
  }
  const current = await loadAssetActionExecution(args.executionId);
  if (["claimed", "executing", "attention"].includes(current.state)) {
    throw new Error("asset action unavailable");
  }
  if (definition.replayPolicy === "regenerate-ephemeral" && current.state === "completed") {
    if (current.result_valid_before <= new Date()) throw new Error("asset action recovery expired");
    const result = await regenerateEphemeralAssetActionResult({
      definition, taskId: claim.taskId, serviceId: args.service.id, input: args.input, target: targetOf(current),
    });
    return releaseFinalResponse({ row: current, definition, context, stored: false, result });
  }
  return releaseFinalResponse({
    row: current, definition, context,
    stored: current.state === "completed" && definition.replayPolicy !== "regenerate-ephemeral",
  });
}
