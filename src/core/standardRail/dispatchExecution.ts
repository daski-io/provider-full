import type { Hex } from "viem";
import { pool } from "../db/pool.js";
import { getActiveAssetByIdentifier, getAssetByIdentifierWithStatuses, type AssetRow } from "../db/queries/assets.js";
import type { ServiceRow } from "../db/queries/services.js";
import type { SkillRow } from "../db/queries/skills.js";
import { setTransactionAsset } from "../db/queries/transactions.js";
import { verifyStandardAssetOwnership } from "../engine/assetManager.js";
import { markEscalated } from "../engine/escalation.js";
import { consultPreExecuteAgent } from "../engine/preExecuteRunner.js";
import { processAdapterResult } from "../engine/taskFinalization.js";
import { getAdapter, getService } from "../serviceRegistry/registry.js";
import type { SupplierCostCeiling } from "../serviceRegistry/types.js";
import { canonicalHash } from "./canonical.js";
import type { StandardRailDispatchV2 } from "./types.js";

const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");

export function shouldLinkAssetOwnership(policy: "owner-only" | "any-payer"): boolean {
  return policy === "owner-only";
}

async function resolveAsset(args: {
  service: ServiceRow;
  skillId: string;
  payer: Hex;
  request: Record<string, unknown>;
  requiresOwnership: boolean;
}): Promise<{ asset: AssetRow | null; linkOwnership: boolean }> {
  if (!args.requiresOwnership) return { asset: null, linkOwnership: false };
  const module = getService(args.service.slug);
  const identifier = await module?.assets?.assetIdentifierFromData?.(args.skillId, args.request)
    ?? (args.request.domain as string | undefined);
  if (!identifier) throw new Error("Standard asset identifier is missing");
  const statuses = module?.assets?.assetLookupStatuses?.(args.skillId);
  const policy = module?.assets?.assetOwnershipPolicy?.(args.skillId) ?? "owner-only";
  if (policy === "any-payer") {
    const asset = statuses?.length
      ? await getAssetByIdentifierWithStatuses(args.service.id, identifier, statuses)
      : await getActiveAssetByIdentifier(args.service.id, identifier);
    if (!asset) throw new Error("Standard managed asset was not found");
    return { asset, linkOwnership: shouldLinkAssetOwnership(policy) };
  }
  const owned = await verifyStandardAssetOwnership(args.payer, identifier, args.service.id, statuses);
  if (!owned.authorized || !owned.asset) throw new Error("Standard payer does not own the managed asset");
  return { asset: owned.asset, linkOwnership: shouldLinkAssetOwnership(policy) };
}

/**
 * Fulfil an admitted paid order synchronously. Every service failure becomes
 * a recorded terminal state on the task; only an infrastructure failure while
 * recording that state escapes, and the caller then answers ambiguously.
 */
export async function fulfillAdmittedDispatch(args: {
  taskId: string;
  dispatch: StandardRailDispatchV2;
  request: Record<string, unknown>;
  skillId: string;
  service: ServiceRow;
  skill: SkillRow;
  supplierCostCeiling: SupplierCostCeiling | null;
}): Promise<void> {
  const { dispatch, service, skill, taskId } = args;
  const claimKey = [dispatch.gatewayAudience, dispatch.orderId];
  try {
    const { asset, linkOwnership } = await resolveAsset({
      service, skillId: args.skillId, payer: dispatch.payer, request: args.request,
      requiresOwnership: skill.requires_asset_ownership,
    });
    if (asset && linkOwnership) await setTransactionAsset(taskId, asset.id);
    const decision = await consultPreExecuteAgent(service, skill, args.request, true, taskId, asset);
    if (decision.action === "reject") {
      await processAdapterResult(taskId, {
        status: "failed", failureClass: "terminal", error: "standard_pre_execute_rejected",
      }, service.id);
      await pool.query(
        `UPDATE standard_dispatch_claims SET state='failed',resolved_at=now(),response_hash=$3
         WHERE gateway_audience=$1 AND order_id=$2`,
        [...claimKey, bytes(canonicalHash(decision))],
      );
      return;
    }
    if (decision.action === "escalate") {
      const escalated = await markEscalated(taskId, decision.reviewQuestion, {
        service, skill, requestData: args.request, asset,
      });
      await pool.query(
        `UPDATE standard_dispatch_claims SET state=$3,response_hash=$4
         WHERE gateway_audience=$1 AND order_id=$2`,
        [...claimKey, escalated.status, bytes(canonicalHash(decision))],
      );
      return;
    }
    const started = await pool.query(
      `UPDATE transactions SET status='working',updated_at=now(),
          metadata=metadata || '{"supplier_mutation_started":true}'::jsonb
        WHERE id=$1 AND standard_order_id=$2 AND status='submitted'`,
      [taskId, dispatch.orderId],
    );
    if (started.rowCount !== 1) throw new Error("Standard fulfillment claim was lost");
    const result = await getAdapter(service.adapter_name).execute(
      args.skillId,
      {
        id: taskId,
        service_id: service.id,
        skill_id: args.skillId,
        status: "working",
        supplierMutationStarted: true,
        ...(args.supplierCostCeiling ? { supplierCostCeiling: args.supplierCostCeiling } : {}),
      },
      args.request,
      asset ?? undefined,
    );
    const processed = await processAdapterResult(taskId, result, service.id);
    await pool.query(
      `UPDATE standard_dispatch_claims SET state=$3,resolved_at=now(),response_hash=$4
       WHERE gateway_audience=$1 AND order_id=$2`,
      [...claimKey, processed.status, bytes(canonicalHash(result))],
    );
  } catch (error) {
    await processAdapterResult(taskId, {
      status: "failed", failureClass: "terminal", error: "standard_fulfillment_failed",
    }, service.id);
    await pool.query(
      "UPDATE transactions SET metadata=metadata || $2::jsonb WHERE id=$1",
      [taskId, JSON.stringify({ standardFailureClass: error instanceof Error ? error.name : "UnknownError" })],
    );
    await pool.query(
      `UPDATE standard_dispatch_claims SET state='failed',resolved_at=now()
       WHERE gateway_audience=$1 AND order_id=$2`,
      claimKey,
    );
  }
}
