import { computeRequestHash } from "../auth/requestHash.js";
import type { Queryable } from "../db/queryable.js";
import { canonicalHash } from "../standardRail/canonical.js";

/** The locked task facts a review binds its request to. */
export interface ReviewedTaskIdentity {
  id: string;
  skill_id: string;
  asset_id: string | null;
  standard_order_id: string | null;
  standard_action_execution_id: Buffer | null;
  canonical_request_hash: Buffer | null;
}

const hex = (value: Buffer): string => `0x${value.toString("hex")}`;

/**
 * Bind a pre-execute review to the request the task was admitted with,
 * inside the escalation's transaction after the task row is locked. A
 * funded standard order was admitted with the provider request its
 * dispatch verified, whose standard-rail canonical hash its dispatch claim
 * retains; the gateway's own canonical request hash the transaction also
 * carries is a different construction and is never compared here. A wallet
 * action was admitted with its signed request `{actionId, providerAssetId,
 * input}`, whose standard-rail canonical hash its task retains, and is
 * reviewed with that request's input. A free task binds the request hash it
 * was materialized under, when it recorded one. Any other request is
 * refused, so nothing is written for it.
 */
export async function assertReviewedRequestAdmitted(
  db: Queryable,
  task: ReviewedTaskIdentity,
  requestData: Record<string, unknown>,
): Promise<void> {
  if (task.standard_order_id) {
    const claim = (await db.query<{ request_hash: Buffer }>(
      "SELECT request_hash FROM standard_dispatch_claims WHERE transaction_id=$1 AND order_id=$2",
      [task.id, task.standard_order_id],
    )).rows[0];
    if (!claim) throw new Error("the funded order has no admitted dispatch claim to review against");
    if (hex(claim.request_hash) !== canonicalHash(requestData).toLowerCase()) {
      throw new Error("the reviewed request differs from the order's admitted request");
    }
    return;
  }
  if (task.standard_action_execution_id) {
    const admitted = task.canonical_request_hash ? hex(task.canonical_request_hash) : null;
    const reviewed = canonicalHash({ actionId: task.skill_id, providerAssetId: task.asset_id, input: requestData });
    if (admitted !== reviewed.toLowerCase()) {
      throw new Error("the reviewed input differs from the wallet action's admitted request");
    }
    return;
  }
  if (task.canonical_request_hash && hex(task.canonical_request_hash) !== computeRequestHash(requestData)) {
    throw new Error("canonical request changed before escalation snapshot was persisted");
  }
}
