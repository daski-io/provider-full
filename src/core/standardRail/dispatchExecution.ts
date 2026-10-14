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
import type { AdapterResult, FulfillmentAdapter, SupplierCostCeiling } from "../serviceRegistry/types.js";
import { classifySupplierError } from "../suppliers/errorClassifier.js";
import { canonicalHash } from "./canonical.js";
import { recordStandardSecurityIncident } from "./incidents.js";

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

/** The admitted order a fulfilment acts for. */
export interface AdmittedOrder {
  gatewayAudience: string;
  orderId: string;
  payer: Hex;
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

export async function failAdmittedTask(
  taskId: string,
  serviceId: string,
  order: Pick<AdmittedOrder, "gatewayAudience" | "orderId">,
  error: unknown,
  code = "standard_fulfillment_failed",
): Promise<void> {
  await processAdapterResult(taskId, { status: "failed", failureClass: "terminal", error: code }, serviceId);
  await pool.query(
    "UPDATE transactions SET metadata=metadata || $2::jsonb WHERE id=$1",
    [taskId, JSON.stringify({ standardFailureClass: error instanceof Error ? error.name : "UnknownError" })],
  );
  await pool.query(
    `UPDATE standard_dispatch_claims SET state='failed',resolved_at=now()
     WHERE gateway_audience=$1 AND order_id=$2`,
    [order.gatewayAudience, order.orderId],
  );
}

/**
 * The supplier may have acted: never guess a terminal failure. The task stays
 * nonterminal and is flagged for reconciliation from supplier truth.
 */
export async function parkForReconciliation(
  taskId: string,
  order: Pick<AdmittedOrder, "gatewayAudience" | "orderId">,
): Promise<void> {
  await pool.query(
    `UPDATE transactions SET updated_at=now(),
        metadata=metadata || '{"standard_reconciliation_required":true}'::jsonb
      WHERE id=$1 AND standard_order_id=$2`,
    [taskId, order.orderId],
  );
  await pool.query(
    "UPDATE standard_dispatch_claims SET state='working' WHERE gateway_audience=$1 AND order_id=$2",
    [order.gatewayAudience, order.orderId],
  );
  await recordStandardSecurityIncident({
    kind: "ambiguous_supplier_outcome",
    gatewayAudience: order.gatewayAudience,
    orderId: order.orderId,
    identity: { taskId, orderId: order.orderId },
    details: { taskId },
  });
}

/** Mark this executor as the one that starts the order; false when another already did. */
async function claimStart(taskId: string, orderId: string, marker: Record<string, unknown>): Promise<boolean> {
  const started = await pool.query(
    `UPDATE transactions SET status='working',updated_at=now(),metadata=metadata || $3::jsonb
      WHERE id=$1 AND standard_order_id=$2 AND status='submitted'`,
    [taskId, orderId, JSON.stringify(marker)],
  );
  return started.rowCount === 1;
}

/**
 * Past its admitted fulfillment deadline an order nobody started fails as
 * never started: no service call was made, so the failure is definitive.
 * The start fence is taken first, so no executor can start it meanwhile.
 */
export async function failUnstartedOrder(
  taskId: string,
  serviceId: string,
  order: Pick<AdmittedOrder, "gatewayAudience" | "orderId">,
): Promise<boolean> {
  if (!await claimStart(taskId, order.orderId, { standard_start_refused: "fulfillment_deadline" })) return false;
  await completeUnstartedFailure(taskId, serviceId, order);
  return true;
}

/** Finish the failure of an order whose start was refused (also after a crash in between). */
export async function completeUnstartedFailure(
  taskId: string,
  serviceId: string,
  order: Pick<AdmittedOrder, "gatewayAudience" | "orderId">,
): Promise<void> {
  const expired = Object.assign(new Error("The admitted fulfillment deadline passed before the order started"), {
    name: "FulfillmentDeadlineError",
  });
  await failAdmittedTask(taskId, serviceId, order, expired, "standard_fulfillment_expired");
}

/**
 * Fulfil an admitted paid order. A definite service failure before or during
 * execution becomes a recorded terminal failure; an ambiguous supplier
 * outcome stays nonterminal for reconciliation. A database or connection
 * failure before the service was called escapes and leaves the order
 * resumable by its fulfillment job; after the call it is ambiguous. Exactly
 * one executor wins the start fence; any other returns without acting. Once
 * the service has answered, its answer is persisted as given: an
 * infrastructure failure while persisting escapes (the caller answers
 * ambiguously) and is never rewritten into a failure.
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
  supplierCostCeiling: SupplierCostCeiling | null;
}): Promise<void> {
  const { order, service, skill, taskId } = args;
  const claimKey = [order.gatewayAudience, order.orderId];
  let asset: AssetRow | null;
  try {
    const resolved = await resolveAsset({
      service, skillId: args.skillId, payer: order.payer, request: args.request,
      requiresOwnership: skill.requires_asset_ownership,
    });
    asset = resolved.asset;
    if (asset && resolved.linkOwnership) await setTransactionAsset(taskId, asset.id);
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
  } catch (error) {
    // Nothing was started: an infrastructure failure leaves the order for
    // its fulfillment job to resume.
    if (isInfrastructureFailure(error)) throw error;
    await failAdmittedTask(taskId, service.id, order, error);
    return;
  }
  if (!await claimStart(taskId, order.orderId, { supplier_mutation_started: true })) return;
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
    return;
  }
  const processed = await processAdapterResult(taskId, result, service.id);
  await pool.query(
    `UPDATE standard_dispatch_claims SET state=$3,resolved_at=now(),response_hash=$4
     WHERE gateway_audience=$1 AND order_id=$2`,
    [...claimKey, processed.status, bytes(canonicalHash(result))],
  );
}
