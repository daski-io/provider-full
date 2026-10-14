import type { Hex } from "viem";
import { pool } from "../db/pool.js";
import { getActiveAssetByIdentifier, getAssetByIdentifierWithStatuses, type AssetRow } from "../db/queries/assets.js";
import type { ServiceRow } from "../db/queries/services.js";
import type { SkillRow } from "../db/queries/skills.js";
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
import { admitPaidTaskForAsset, checkPaidTaskOwner } from "./assetOwnerAdmission.js";
import { AssetOwnerChangedError } from "./assetOwnerFence.js";
import { ASSET_OWNER_CHANGED_RESULT } from "./assetOwnerOutcome.js";
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
  const asset = statuses?.length
    ? await getAssetByIdentifierWithStatuses(args.service.id, identifier, statuses)
    : await getActiveAssetByIdentifier(args.service.id, identifier);
  if (!asset) throw new Error("Standard managed asset was not found");
  // Owner-only work is admitted by the caller under the asset owner fence,
  // where the payer must be the current owner.
  return { asset, linkOwnership: shouldLinkAssetOwnership(policy) };
}

/** An owner admission step that reached no decision; never grounds to fail a funded order. */
class OwnerStepUndecidedError extends Error {
  constructor(cause: unknown) {
    super("Asset owner admission was not decided", { cause });
    this.name = "OwnerStepUndecidedError";
  }
}

/**
 * Run an owner admission step. A stale or foreign owner is a definite
 * refusal before supplier work, which fails the order as never started; any
 * other failure (the database unreachable, a conflicting link) escapes as
 * undecided and leaves the order unstarted for its fulfillment job to
 * resume, never failed on a guess.
 */
async function ownerStep(step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch (error) {
    if (error instanceof AssetOwnerChangedError) throw error;
    throw new OwnerStepUndecidedError(error);
  }
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
 * Nothing was started. An infrastructure failure, or an owner step that
 * reached no decision, escapes and leaves the order for its fulfillment job
 * to resume; a definite failure, a stale or foreign owner included, fails it
 * as never started, unless another executor took the order meanwhile.
 */
async function refuseBeforeStart(error: unknown, args: {
  taskId: string;
  serviceId: string;
  order: AdmittedOrder;
  lease: FulfillmentJobLease;
}): Promise<FulfillmentStep> {
  if (isInfrastructureFailure(error) || error instanceof OwnerStepUndecidedError) throw error;
  return step(await refuseStart({ ...args, refusal: "pre_start_failure", cause: error }));
}

/**
 * Fulfil an admitted paid order under its fulfillment-job lease. A definite
 * service failure before or during execution becomes a recorded terminal
 * failure; an ambiguous supplier outcome stays nonterminal for
 * reconciliation. A database or connection failure before the service was
 * called escapes and leaves the order resumable by its fulfillment job;
 * after the call it is ambiguous. Every decision that ends or starts the
 * order first wins its start fence (orderStart.ts); an executor that loses
 * it returns without acting, and a pre-execute escalation fences the order
 * under its own row lock. Owner-only work is admitted under the asset owner
 * fence for the order's payer and checked once more right before the start;
 * a stale or foreign owner refuses the start. Once the service has
 * answered, its answer is persisted as given: an infrastructure failure
 * while persisting escapes (the caller answers ambiguously) and is never
 * rewritten into a failure, and a deliverable whose owner went stale
 * meanwhile is withheld and the order ends failed.
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
      service, skillId: args.skillId, request: args.request,
      requiresOwnership: args.requiresOwnership,
    });
    asset = resolved.asset;
    // Linked to its asset under the asset owner fence, only while the payer
    // is the current owner, recording the owner the work is admitted under.
    const owned = resolved.linkOwnership ? resolved.asset : null;
    if (owned) await ownerStep(() => admitPaidTaskForAsset({ taskId, assetId: owned.id, payer: order.payer }));
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
    return refuseBeforeStart(error, { taskId, serviceId: service.id, order, lease });
  }
  if (decision.action === "reject") {
    return step(await refuseStart({
      taskId, serviceId: service.id, order, lease, refusal: "pre_execute_rejected",
      responseHash: bytes(canonicalHash(decision)),
    }));
  }
  try {
    // The admitted owner is still current at the consequential call.
    await ownerStep(() => checkPaidTaskOwner(taskId));
  } catch (error) {
    return refuseBeforeStart(error, { taskId, serviceId: service.id, order, lease });
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
  let state: string;
  let answered: AdapterResult = result;
  try {
    state = (await processAdapterResult(taskId, result, service.id)).status;
  } catch (error) {
    // The owner went stale meanwhile: the result was withheld and the order
    // ended failed, definitively, in the same transaction.
    if (!(error instanceof AssetOwnerChangedError)) throw error;
    state = "failed";
    answered = ASSET_OWNER_CHANGED_RESULT;
  }
  await pool.query(
    `UPDATE standard_dispatch_claims SET state=$3,resolved_at=now(),response_hash=$4
     WHERE gateway_audience=$1 AND order_id=$2`,
    [...claimKey, state, bytes(canonicalHash(answered))],
  );
  return "settled";
}
