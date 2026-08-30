import {
  insertOutboundEmail,
  setOutboundMessageId,
  updateOutboundDeliveryStatus,
  type OutboundEmailRow,
} from "../db/queries/emails.js";
import { storeEmailAttachments } from "../db/queries/emailAttachments.js";
import { pool } from "../db/pool.js";
import { inTransaction } from "../db/queryable.js";
import { sendPostmarkMessage } from "./postmarkClient.js";
import {
  preparePostmarkMessage,
  type SendEmailArgs,
} from "./postmarkMessage.js";
import {
  recordAcceptedOutcome,
  recordFailedOutcome,
  recordUnknownOutcome,
} from "./postmarkOutcome.js";

export type { SendEmailArgs } from "./postmarkMessage.js";

export async function sendEmail(args: SendEmailArgs): Promise<OutboundEmailRow> {
  const prepared = preparePostmarkMessage(args);
  const inserted = await inTransaction(pool, async (db) => {
    const persisted = await insertOutboundEmail(prepared.insert, db);
    await storeEmailAttachments({
      direction: "outbound",
      emailId: persisted.row.id,
      attachments: prepared.attachments,
      db,
    });
    return persisted;
  });
  const row = inserted.row;

  if (!inserted.inserted) {
    if (row.message_id) return row;
    if (row.delivery_status !== "send_failed") {
      await updateOutboundDeliveryStatus({ id: row.id, status: "outcome_unknown" });
      throw new Error("outbound email outcome is unknown; automatic resend refused");
    }
  }

  let response;
  try {
    response = await sendPostmarkMessage(prepared.token, prepared.request);
  } catch (error) {
    await recordUnknownOutcome(row.id, args);
    throw error;
  }

  if (!response.ok) {
    await recordFailedOutcome(row.id, args, response.status);
    throw new Error(`Postmark send failed with HTTP ${response.status}`);
  }
  if (!response.messageId) {
    await recordUnknownOutcome(row.id, args, response.status);
    throw new Error("Postmark returned success without MessageID; outcome is unknown");
  }

  await setOutboundMessageId(row.id, response.messageId);
  await recordAcceptedOutcome(row.id, args, response.messageId, prepared.testMode);
  return { ...row, message_id: response.messageId };
}
