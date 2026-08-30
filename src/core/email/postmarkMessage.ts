import { createHash } from "node:crypto";
import { config } from "../config.js";
import type { EmailAttachmentInput } from "../db/queries/emailAttachments.js";
import { validateRelayAttachment } from "./postmarkAttachments.js";
import { computeThreadRoot } from "./threading.js";

const POSTMARK_TEST_TOKEN = "POSTMARK_API_TEST";
const BASE_MAINNET_CHAIN_ID = 8453;

export interface SendEmailArgs {
  serviceId?: string | null;
  transactionId?: string | null;
  inboundId?: string | null;
  customerId?: string | null;
  to: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  replyTo?: string | null;
  inReplyTo?: string | null;
  references?: string[];
  attachments?: EmailAttachmentInput[];
  messageStream?: string;
  sentBy: "email_agent" | "operator_agent" | "admin" | "system";
  fromAddress: string;
  idempotencyKey?: string;
}

export function preparePostmarkMessage(args: SendEmailArgs) {
  const testMode = config.POSTMARK_TEST_MODE
    ?? config.CHAIN_ID !== BASE_MAINNET_CHAIN_ID;
  const token = testMode ? POSTMARK_TEST_TOKEN : config.POSTMARK_SERVER_TOKEN;
  if (!token) {
    throw new Error(
      "POSTMARK_SERVER_TOKEN is not set — outbound email is disabled in this deployment.",
    );
  }
  const attachments = args.attachments ?? [];
  const attachmentBytes = attachments.reduce(
    (total, attachment) => total + attachment.content.length,
    0,
  );
  if (args.to.length > 320
    || (args.replyTo?.length ?? 0) > 320
    || args.subject.length > config.POSTMARK_INBOUND_MAX_SUBJECT_CHARS
    || args.bodyText.length > config.POSTMARK_INBOUND_MAX_BODY_CHARS
    || (args.bodyHtml?.length ?? 0) > config.POSTMARK_INBOUND_MAX_BODY_CHARS
    || attachments.length > config.POSTMARK_INBOUND_MAX_ATTACHMENTS
    || attachmentBytes > config.POSTMARK_INBOUND_MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new Error("outbound email exceeds configured size limits");
  }
  for (const attachment of attachments) {
    if (
      attachment.quarantineReason
      || validateRelayAttachment(attachment)
    ) {
      throw new Error("outbound email contains a non-relayable attachment");
    }
  }
  const threadRoot = computeThreadRoot({
    messageId: "",
    inReplyTo: args.inReplyTo ?? null,
    references: args.references ?? [],
  });
  const logicalKey = args.idempotencyKey
    ?? (args.inboundId ? `${args.sentBy}:inbound:${args.inboundId}` : null);
  const material = logicalKey
    ? `logical-email:v1\0${logicalKey}`
    : JSON.stringify({
      version: 1,
      sentBy: args.sentBy,
      inboundId: args.inboundId ?? null,
      transactionId: args.transactionId ?? null,
      serviceId: args.serviceId ?? null,
      from: args.fromAddress,
      to: args.to,
      subject: args.subject,
      bodyText: args.bodyText,
      bodyHtml: args.bodyHtml ?? null,
      replyTo: args.replyTo ?? null,
      inReplyTo: args.inReplyTo ?? null,
      references: args.references ?? [],
      attachments: attachments.map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.contentType,
        contentId: attachment.contentId ?? null,
        disposition: attachment.disposition ?? "attachment",
        sha256: createHash("sha256").update(attachment.content).digest("hex"),
      })),
      messageStream: args.messageStream ?? "outbound",
    });
  const idempotencyKey = createHash("sha256").update(material).digest("hex");
  const headers: Array<{ Name: string; Value: string }> = [];
  if (args.inReplyTo) headers.push({ Name: "In-Reply-To", Value: args.inReplyTo });
  if (args.references?.length) {
    headers.push({ Name: "References", Value: args.references.join(" ") });
  }
  return {
    token,
    testMode,
    insert: {
      from_address: args.fromAddress,
      to_address: args.to,
      subject: args.subject,
      body_text: args.bodyText,
      body_html: args.bodyHtml ?? null,
      in_reply_to: args.inReplyTo ?? null,
      thread_root: threadRoot || null,
      customer_id: args.customerId ?? null,
      reply_to: args.replyTo ?? null,
      service_id: args.serviceId ?? null,
      transaction_id: args.transactionId ?? null,
      inbound_id: args.inboundId ?? null,
      sent_by: args.sentBy,
      idempotency_key: idempotencyKey,
    },
    request: {
      From: args.fromAddress,
      To: args.to,
      Subject: args.subject,
      TextBody: args.bodyText,
      ...(args.bodyHtml ? { HtmlBody: args.bodyHtml } : {}),
      ...(args.replyTo ? { ReplyTo: args.replyTo } : {}),
      MessageStream: args.messageStream ?? "outbound",
      Headers: headers,
      ...(attachments.length > 0
        ? {
            Attachments: attachments.map((attachment) => ({
              Name: attachment.filename,
              Content: attachment.content.toString("base64"),
              ContentType: attachment.contentType,
              ...(attachment.contentId ? { ContentID: attachment.contentId } : {}),
            })),
          }
        : {}),
    },
    attachments,
  };
}
