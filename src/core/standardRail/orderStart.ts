import type { Hex } from "viem";
import { pool } from "../db/pool.js";
import type { Queryable } from "../db/queryable.js";
import { processAdapterResult } from "../engine/taskFinalization.js";
import type { FulfillmentJobLease } from "./fulfillmentJobs.js";
import { recordStandardSecurityIncident } from "./incidents.js";

/*
 * The start fence of an admitted paid order. Exactly one executor moves a
 * submitted order to working, either to call the service, to escalate it
 * for review or to refuse the order a start, and only while it holds the
 * order's fulfillment-job lease and no buyer lifecycle action (a
 * cancellation) holds the order. Every terminal decision taken before the
 * service was called takes this fence first, so an executor that lost the
 * race, or its lease, never ends an order another one started. The version
 * bump invalidates a lifecycle claim taken from the pre-start snapshot.
 */

/** The admitted order a fulfilment acts for. */
export interface AdmittedOrder {
  gatewayAudience: string;
  orderId: string;
  payer: Hex;
}

/** `busy`: a lifecycle action holds the order, so try again later. `lost`: another executor owns it. */
export type StartFence = "started" | "lost" | "busy";

/** Why an order was refused its start: it fails as never started, with this code. */
export type StartRefusal = "fulfillment_deadline" | "pre_execute_rejected" | "pre_start_failure";

const REFUSALS: Record<StartRefusal, { code: string; error: string; message: string }> = {
  fulfillment_deadline: {
    code: "standard_fulfillment_expired", error: "FulfillmentDeadlineError",
    message: "The admitted fulfillment deadline passed before the order started",
  },
  pre_execute_rejected: {
    code: "standard_pre_execute_rejected", error: "PreExecuteRejectedError",
    message: "The pre-execution review rejected the order before it started",
  },
  pre_start_failure: {
    code: "standard_fulfillment_failed", error: "PreStartFailureError",
    message: "The order failed definitively before it started",
  },
};

/** The refusal a start marker records; an unrecognized marker still means the order never started. */
export function startRefusal(marker: unknown): StartRefusal | null {
  if (marker === undefined || marker === null || marker === false) return null;
  return typeof marker === "string" && Object.hasOwn(REFUSALS, marker) ? marker as StartRefusal : "pre_start_failure";
}

/** The executor's fulfillment-job lease is still live, given the parameters holding its id and token. */
export const ownedLease = (id: string, token: string) => `EXISTS (SELECT 1 FROM durable_jobs j
  WHERE j.id=${id} AND j.lease_token=${token} AND j.status='running' AND j.lease_expires_at > now())`;

/**
 * Win the start fence inside the caller's transaction: move a submitted
 * order to working under this executor's lease, recording why. False when
 * the fence was not won; nothing changed then.
 */
export async function takeStartFence(
  db: Queryable,
  taskId: string,
  orderId: string,
  lease: FulfillmentJobLease,
  marker: Record<string, unknown>,
): Promise<boolean> {
  const started = await db.query(
    `UPDATE transactions t SET status='working',updated_at=now(),version=version+1,metadata=metadata || $3::jsonb
      WHERE t.id=$1 AND t.standard_order_id=$2 AND t.status='submitted' AND ${ownedLease("$4", "$5")}
        AND NOT EXISTS (SELECT 1 FROM standard_lifecycle_actions a WHERE a.transaction_id=t.id AND a.state='claimed')`,
    [taskId, orderId, JSON.stringify(marker), lease.id, lease.leaseToken],
  );
  return started.rowCount === 1;
}

/** Why this executor did not win the fence. */
export async function startFenceRefusal(
  taskId: string,
  orderId: string,
  lease: FulfillmentJobLease,
): Promise<"lost" | "busy"> {
  // Still submitted under this executor's live lease: only a lifecycle action held it back.
  const state = (await pool.query<{ waiting: boolean }>(
    `SELECT t.status='submitted' AND ${ownedLease("$3", "$4")} AS waiting
       FROM transactions t WHERE t.id=$1 AND t.standard_order_id=$2`,
    [taskId, orderId, lease.id, lease.leaseToken],
  )).rows[0];
  return state?.waiting ? "busy" : "lost";
}

/** Move a submitted order to working under this executor's lease, recording why. */
export async function claimStart(
  taskId: string,
  orderId: string,
  lease: FulfillmentJobLease,
  marker: Record<string, unknown>,
): Promise<StartFence> {
  if (await takeStartFence(pool, taskId, orderId, lease, marker)) return "started";
  return startFenceRefusal(taskId, orderId, lease);
}

export async function failAdmittedTask(
  taskId: string,
  serviceId: string,
  order: Pick<AdmittedOrder, "gatewayAudience" | "orderId">,
  error: unknown,
  code = "standard_fulfillment_failed",
  responseHash: Buffer | null = null,
): Promise<void> {
  await processAdapterResult(taskId, { status: "failed", failureClass: "terminal", error: code }, serviceId);
  await pool.query(
    "UPDATE transactions SET metadata=metadata || $2::jsonb WHERE id=$1",
    [taskId, JSON.stringify({ standardFailureClass: error instanceof Error ? error.name : "UnknownError" })],
  );
  await pool.query(
    `UPDATE standard_dispatch_claims SET state='failed',resolved_at=now(),response_hash=COALESCE($3,response_hash)
     WHERE gateway_audience=$1 AND order_id=$2`,
    [order.gatewayAudience, order.orderId, responseHash],
  );
}

/** Finish the failure of an order whose start was refused (also after a crash in between). */
export async function completeRefusedStart(
  taskId: string,
  serviceId: string,
  order: Pick<AdmittedOrder, "gatewayAudience" | "orderId">,
  refusal: StartRefusal,
  cause: unknown = null,
  responseHash: Buffer | null = null,
): Promise<void> {
  const reason = REFUSALS[refusal];
  const error = cause instanceof Error ? cause : Object.assign(new Error(reason.message), { name: reason.error });
  await failAdmittedTask(taskId, serviceId, order, error, reason.code, responseHash);
}

/** Refuse a submitted order its start and fail it as never started, if this executor wins the fence. */
export async function refuseStart(args: {
  taskId: string;
  serviceId: string;
  order: Pick<AdmittedOrder, "gatewayAudience" | "orderId">;
  lease: FulfillmentJobLease;
  refusal: StartRefusal;
  cause?: unknown;
  responseHash?: Buffer | null;
}): Promise<StartFence> {
  const fence = await claimStart(args.taskId, args.order.orderId, args.lease, { standard_start_refused: args.refusal });
  if (fence === "started") {
    await completeRefusedStart(args.taskId, args.serviceId, args.order, args.refusal, args.cause, args.responseHash);
  }
  return fence;
}

/**
 * The supplier may have acted: never guess a terminal failure. The task stays
 * nonterminal and is flagged for reconciliation from supplier truth. The
 * incident is recorded first, so a watchdog pass never drops the flag as a
 * stall flag in between.
 */
export async function parkForReconciliation(
  taskId: string,
  order: Pick<AdmittedOrder, "gatewayAudience" | "orderId">,
): Promise<void> {
  await recordStandardSecurityIncident({
    kind: "ambiguous_supplier_outcome",
    gatewayAudience: order.gatewayAudience,
    orderId: order.orderId,
    identity: { taskId, orderId: order.orderId },
    details: { taskId },
  });
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
}
