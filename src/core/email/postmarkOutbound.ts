import { createHash } from "node:crypto";
import {
  claimOutboundRetry,
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
  OutboundEmailError,
  OutboundSendRefusedError,
  recordAcceptedOutcome,
  recordFailedOutcome,
  recordRetryableOutcome,
  recordSkippedOutcome,
  recordUnknownOutcome,
} from "./postmarkOutcome.js";

export type { SendEmailArgs } from "./postmarkMessage.js";

export interface SendEmailHooks {
  /**
   * Runs immediately before the outbound call, once the message is journaled
   * and every database step is behind it: the last point at which a sender
   * can refuse (an asset delivery admission an owner change revoked or made
   * stale). OutboundSendRefusedError records a terminal skipped outcome; any
   * other failure records a retryable outcome with the request fingerprint,
   * so the same logical send runs again later and the hook validates again.
   */
  beforeSend?: () => Promise<void>;
}

export async function sendEmail(args: SendEmailArgs, hooks: SendEmailHooks = {}): Promise<OutboundEmailRow> {
  const prepared = preparePostmarkMessage(args);
  const requestFingerprint = createHash("sha256").update(JSON.stringify(prepared.request)).digest("hex");
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
    if (row.delivery_status === "send_skipped") {
      throw new OutboundEmailError("skipped", "outbound email was refused before sending; automatic resend refused");
    }
    if (row.delivery_status === "send_retryable") {
      // Nothing was sent: the same content may go once its cooldown passed.
      if (row.delivery_payload?.requestFingerprint !== requestFingerprint) {
        throw new OutboundEmailError("unknown", "outbound retry content changed; automatic resend refused");
      }
      if (!await claimOutboundRetry(row.id)) {
        throw new OutboundEmailError("retryable", "outbound retry is cooling down or already running");
      }
    } else if (row.delivery_status !== "send_failed") {
      await updateOutboundDeliveryStatus({ id: row.id, status: "outcome_unknown" });
      throw new Error("outbound email outcome is unknown; automatic resend refused");
    }
  }

  if (hooks.beforeSend) {
    try {
      await hooks.beforeSend();
    } catch (error) {
      if (error instanceof OutboundSendRefusedError) {
        await recordSkippedOutcome(row.id, args, error.message);
        throw new OutboundEmailError("skipped", `send refused before the outbound call: ${error.message}`);
      }
      await recordRetryableOutcome(row.id, args, requestFingerprint, error instanceof Error ? error.name : "UnknownError");
      throw new OutboundEmailError("retryable", "pre-send validation failed; the send is retryable");
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
