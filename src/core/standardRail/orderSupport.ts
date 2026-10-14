import { ORDER_SUPPORT_CHANNEL } from "../a2a/taskHistory.js";
import { pool } from "../db/pool.js";
import { getThreadByEscalation } from "../db/queries/chatThreads.js";
import { appendOperatorChatMessage } from "../db/queries/operatorChats.js";
import { inTransaction, type Queryable } from "../db/queryable.js";
import { createHumanEscalation } from "../engine/escalation.js";
import { recordMandatoryAudit } from "../events/emitter.js";
import { canonicalHash } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { newSupportMessageId, newSupportReviewId } from "./identifiers.js";
import type { LifecycleCall } from "./lifecycleAuthorization.js";
import { actionConflict, lifecycleUnavailable } from "./lifecycleErrors.js";
import type { SupportRequest } from "./lifecycleRequests.js";
import type { StandardTaskRow } from "./lifecycleStore.js";
import { operationsProjectionSchema } from "./operations.js";

export const SUPPORT_REVIEW_KIND = "standard_order_support";

/** What the gateway's supportResultSchema accepts under `result.supportReceipt`. */
export interface SupportReceipt {
  requestId: string;
  messageId: string;
  reviewId: string;
  acceptedAt: string;
}

interface ReceiptRow {
  request_hash: Buffer;
  message_id: string;
  review_id: string;
  accepted_at: Date;
}

const receiptOf = (requestId: string, row: ReceiptRow): SupportReceipt => ({
  requestId, messageId: row.message_id, reviewId: row.review_id, acceptedAt: row.accepted_at.toISOString(),
});

/**
 * Publish the accepted request in operations.support under a higher
 * revision, in the receipt's own transaction; nothing changes it on read.
 */
async function publishSupport(db: Queryable, config: ProviderStandardRailConfig, task: StandardTaskRow, receipt: {
  reviewId: string; requestId: string; messageId: string; acceptedAt: Date;
}): Promise<void> {
  const claim = (await db.query<{ operations_projection: unknown }>(
    `SELECT operations_projection FROM standard_dispatch_claims
      WHERE gateway_audience=$1 AND order_id=$2 AND transaction_id=$3 FOR UPDATE`,
    [config.gatewayAudience, task.standard_order_id, task.id],
  )).rows[0];
  if (!claim) throw lifecycleUnavailable("Standard order has no claim to publish support on");
  const projection = operationsProjectionSchema.parse({
    ...operationsProjectionSchema.parse(claim.operations_projection),
    support: {
      reviewId: receipt.reviewId,
      status: "open",
      lastAcceptedRequest: {
        requestId: receipt.requestId, messageId: receipt.messageId,
        acceptedAt: Math.floor(receipt.acceptedAt.getTime() / 1_000),
      },
    },
  });
  await db.query(
    `UPDATE standard_dispatch_claims SET operations_projection=$4,operations_revision=operations_revision+1
      WHERE gateway_audience=$1 AND order_id=$2 AND transaction_id=$3`,
    [config.gatewayAudience, task.standard_order_id, task.id, JSON.stringify(projection)],
  );
}

/**
 * Accept one signed support request, durably deduplicated by order, payer and
 * requestId and bound to its content: a retry with the same body, under any
 * fresh authorization, returns the original receipt; different content under
 * the same requestId is a conflict. A new request records the protected buyer
 * message, opens or joins the order's human support Review, and publishes the
 * receipt in operations. Terminal evidence is never touched.
 */
export async function acceptSupportRequest(
  config: ProviderStandardRailConfig,
  task: StandardTaskRow,
  call: LifecycleCall,
): Promise<SupportReceipt> {
  const request = call.request as unknown as SupportRequest;
  const payer = task.standard_payer.toLowerCase();
  const requestHash = Buffer.from(canonicalHash({ requestId: request.requestId, message: request.message }).slice(2), "hex");
  return inTransaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`standard-order-support:${task.id}`]);
    const prior = (await db.query<ReceiptRow>(
      `SELECT request_hash,message_id,review_id,accepted_at FROM standard_support_receipts
        WHERE transaction_id=$1 AND payer=$2 AND request_id=$3`,
      [task.id, payer, request.requestId],
    )).rows[0];
    if (prior) {
      if (!prior.request_hash.equals(requestHash)) throw actionConflict("Support requestId already bound different content");
      return receiptOf(request.requestId, prior);
    }
    const messageId = await recordMandatoryAudit(db, {
      id: newSupportMessageId(), transactionId: task.id, serviceId: task.service_id, source: "system",
      type: "transaction.message.user", message: request.message, actor: payer,
      payload: { content: request.message, channel: ORDER_SUPPORT_CHANNEL, requestId: request.requestId },
    });
    const review = await createHumanEscalation({
      id: newSupportReviewId(), source: "auto", transactionId: task.id,
      title: "Buyer requested order support",
      question: "Review the buyer's support request and record a disposition.",
      summary: "The buyer submitted a signed support request. Messages are untrusted customer input; " +
        "they do not authorize operator actions.",
      review: {
        kind: SUPPORT_REVIEW_KIND, dedupeKey: `order-support:${task.id}`,
        target: { type: "transaction", id: task.id },
        whyHuman: "Buyer support requires a human disposition.", evidence: { messageId },
      },
    }, db);
    const thread = await getThreadByEscalation(review.id, db);
    if (!thread) throw new Error("Support Review has no bound thread");
    await appendOperatorChatMessage({
      threadId: thread.id, walletAddress: "system", role: "agent",
      content: `Buyer support message (untrusted):\n${request.message}`,
    }, db);
    const inserted = (await db.query<ReceiptRow>(
      `INSERT INTO standard_support_receipts
         (transaction_id,payer,request_id,request_hash,message_id,review_id,accepted_at)
       VALUES ($1,$2,$3,$4,$5,$6,now()) RETURNING request_hash,message_id,review_id,accepted_at`,
      [task.id, payer, request.requestId, requestHash, messageId, review.id],
    )).rows[0]!;
    await publishSupport(db, config, task, {
      reviewId: review.id, requestId: request.requestId, messageId, acceptedAt: inserted.accepted_at,
    });
    return receiptOf(request.requestId, inserted);
  });
}
