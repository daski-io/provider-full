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
import { getService } from "../serviceRegistry/registry.js";
import { RetainedHandlerUnavailableError } from "../serviceRegistry/retainedHandlers.js";
import type {
  AdapterResult, FulfillmentAdapter, PreExecuteDecision, SupplierCostCeiling,
} from "../serviceRegistry/types.js";
import { classifySupplierError } from "../suppliers/errorClassifier.js";
import { canonicalHash } from "./canonical.js";
import type { FulfillmentJobLease } from "./fulfillmentJobs.js";
import {
  claimStart, failAdmittedTask, parkForReconciliation, refuseStart, type AdmittedOrder,
} from "./orderStart.js";

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

const INFRASTRUCTURE_CODES = /^(?:08|25P03|40|53|57|58)/;
const INFRASTRUCTURE_MESSAGES = /connection terminated|connection error|timeout exceeded when trying to connect|ECONN|ETIMEDOUT|EPIPE/i;

/**
 * A database, connection or handler-resolution failure says nothing about
 * the service's answer. Before the service was called the order stays
 * resumable; after, it is ambiguous.
 */
export function isInfrastructureFailure(error: unknown): boolean {
  if (error instanceof RetainedHandlerUnavailableError) return true;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && (INFRASTRUCTURE_CODES.test(code) || /^E[A-Z]+$/.test(code))) return true;
  return error instanceof Error && INFRASTRUCTURE_MESSAGES.test(error.message);
}

/** `busy`: a buyer lifecycle action holds the order; its fulfillment job tries again later. */
export type FulfillmentStep = "settled" | "busy";

const step = (fence: "started" | "lost" | "busy"): FulfillmentStep => fence === "busy" ? "busy" : "settled";

/**
 * Fulfil an admitted paid order under its fulfillment-job lease. A definite
 * service failure before or during execution becomes a recorded terminal
 * failure; an ambiguous supplier outcome stays nonterminal for
 * reconciliation. A database or connection failure before the service was
 * called escapes and leaves the order resumable by its fulfillment job;
 * after the call it is ambiguous. Every decision that ends or starts the
 * order first wins its start fence (orderStart.ts); an executor that loses
 * it returns without acting, and a pre-execute escalation fences the order
 * under its own row lock. Once the service has answered, its answer is
 * persisted as given: an infrastructure failure while persisting escapes
 * (the caller answers ambiguously) and is never rewritten into a failure.
 */
export async function fulfillAdmittedDispatch(args: {
  taskId: string;
  order: AdmittedOrder;
  request: Record<string, unknown>;
  skillId: string;
  service: ServiceRow;
  skill: SkillRow;
  /** The handler of the contract the order was admitted under. */
  handler: FulfillmentAdapter;
  /** Whether the admitted contract, not merely the current skill, requires asset ownership. */
  requiresOwnership: boolean;
  supplierCostCeiling: SupplierCostCeiling | null;
  /** The order's fulfillment-job lease this executor holds. */
  lease: FulfillmentJobLease;
}): Promise<FulfillmentStep> {
  const { order, service, skill, taskId, lease } = args;
  const claimKey = [order.gatewayAudience, order.orderId];
  let asset: AssetRow | null;
  let decision: PreExecuteDecision;
  try {
    const resolved = await resolveAsset({
      service, skillId: args.skillId, payer: order.payer, request: args.request,
      requiresOwnership: args.requiresOwnership,
    });
    asset = resolved.asset;
    if (asset && resolved.linkOwnership) await setTransactionAsset(taskId, asset.id);
    decision = await consultPreExecuteAgent(service, skill, args.request, true, taskId, asset);
    if (decision.action === "escalate") {
      const escalated = await markEscalated(taskId, decision.reviewQuestion, {
        service, skill, requestData: args.request, asset,
      });
      await pool.query(
        `UPDATE standard_dispatch_claims SET state=$3,response_hash=$4
         WHERE gateway_audience=$1 AND order_id=$2`,
        [...claimKey, escalated.status, bytes(canonicalHash(decision))],
      );
      return "settled";
    }
  } catch (error) {
    // Nothing was started: an infrastructure failure leaves the order for
    // its fulfillment job to resume; a definite one fails it as never
    // started, unless another executor took the order meanwhile.
    if (isInfrastructureFailure(error)) throw error;
    return step(await refuseStart({
      taskId, serviceId: service.id, order, lease, refusal: "pre_start_failure", cause: error,
    }));
  }
  if (decision.action === "reject") {
    return step(await refuseStart({
      taskId, serviceId: service.id, order, lease, refusal: "pre_execute_rejected",
      responseHash: bytes(canonicalHash(decision)),
    }));
  }
  const fence = await claimStart(taskId, order.orderId, lease, { supplier_mutation_started: true });
  if (fence !== "started") return step(fence);
  let result: AdapterResult;
  try {
    result = await args.handler.execute(
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
  } catch (error) {
    if (classifySupplierError(error)?.kind === "ambiguous" || isInfrastructureFailure(error)) {
      await parkForReconciliation(taskId, order);
    } else {
      await failAdmittedTask(taskId, service.id, order, error);
    }
    return "settled";
  }
  const processed = await processAdapterResult(taskId, result, service.id);
  await pool.query(
    `UPDATE standard_dispatch_claims SET state=$3,resolved_at=now(),response_hash=$4
     WHERE gateway_audience=$1 AND order_id=$2`,
    [...claimKey, processed.status, bytes(canonicalHash(result))],
  );
  return "settled";
}
