import { config } from "../config.js";
import {
  insertInboundEmail,
  updateInboundEmailClassification,
  updateInboundProcessing,
} from "../db/queries/emails.js";
import {
  storeEmailAttachments,
  type EmailAttachmentInput,
} from "../db/queries/emailAttachments.js";
import { pool } from "../db/pool.js";
import { inTransaction } from "../db/queryable.js";
import { parsePostmarkAttachments } from "./postmarkAttachments.js";
import {
  assessPostmarkInboundSecurity,
  type PostmarkHeader,
} from "./postmarkInboundSecurity.js";
import { getServiceByInboundEmail } from "../db/queries/services.js";
import { emitEvent } from "../events/emitter.js";
import { shouldAutoFilter } from "./preFilter.js";
import { enqueueEmailIngress, requeueFailedEmailIngress } from "./postmarkIngressQueue.js";
import { findInboundInterceptor } from "./postmarkRouting.js";
import { computeThreadRoot, normalizeMessageId } from "./threading.js";

interface PostmarkInboundPayload {
  MessageID?: string;
  From?: string;
  To?: string;
  OriginalRecipient?: string;
  Subject?: string;
  TextBody?: string;
  HtmlBody?: string;
  Headers?: PostmarkHeader[];
  Attachments?: unknown;
}

export interface PostmarkIngressResult {
  status: number;
  body: { ok: boolean; reason?: string; inboundId?: string; duplicate?: boolean };
}

function header(payload: PostmarkInboundPayload, name: string): string | null {
  return payload.Headers
    ?.find((item) => item.Name.toLowerCase() === name.toLowerCase())
    ?.Value.trim() || null;
}

function references(payload: PostmarkInboundPayload): string[] {
  return (header(payload, "references") ?? "").split(/\s+/).filter(Boolean);
}

function headersObject(payload: PostmarkInboundPayload): Record<string, string> {
  return Object.fromEntries((payload.Headers ?? []).map((item) => [item.Name, item.Value]));
}

function validOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function validHeaders(value: unknown): value is PostmarkHeader[] | undefined {
  if (value === undefined) return true;
  return Array.isArray(value) && value.every(
    (item) =>
      Boolean(item)
      && typeof item === "object"
      && typeof (item as PostmarkHeader).Name === "string"
      && typeof (item as PostmarkHeader).Value === "string",
  );
}

function validatePayload(payload: PostmarkInboundPayload): PostmarkIngressResult | null {
  if (
    typeof payload.MessageID !== "string"
    || payload.MessageID.length === 0
    || typeof payload.From !== "string"
    || payload.From.length === 0
    || typeof payload.To !== "string"
    || payload.To.length === 0
  ) {
    return { status: 400, body: { ok: false, reason: "missing_fields" } };
  }
  const optionalStrings = [
    payload.OriginalRecipient,
    payload.Subject,
    payload.TextBody,
    payload.HtmlBody,
  ];
  if (
    !optionalStrings.every(validOptionalString)
    || !validHeaders(payload.Headers)
  ) {
    return { status: 400, body: { ok: false, reason: "invalid_payload" } };
  }
  const headers = payload.Headers ?? [];
  const tooLarge = payload.MessageID.length > 255
    || payload.From.length > 320
    || payload.To.length > 2_048
    || (payload.OriginalRecipient?.length ?? 0) > 2_048
    || (payload.Subject?.length ?? 0) > config.POSTMARK_INBOUND_MAX_SUBJECT_CHARS
    || (payload.TextBody?.length ?? 0) > config.POSTMARK_INBOUND_MAX_BODY_CHARS
    || (payload.HtmlBody?.length ?? 0) > config.POSTMARK_INBOUND_MAX_BODY_CHARS
    || headers.length > config.POSTMARK_INBOUND_MAX_HEADERS
    || headers.some((item) => item.Name.length > 100 || item.Value.length > 2_000);
  return tooLarge ? { status: 413, body: { ok: false, reason: "message_too_large" } } : null;
}

export async function processPostmarkInbound(payloadValue: unknown): Promise<PostmarkIngressResult> {
  const payload = (payloadValue ?? {}) as PostmarkInboundPayload;
  const invalid = validatePayload(payload);
  if (invalid) return invalid;
  const messageId = payload.MessageID!;
  const from = payload.From!;
  const recipient = (payload.OriginalRecipient ?? payload.To!).toLowerCase();
  const security = assessPostmarkInboundSecurity(payload.Headers ?? []);
  const routing = await findInboundInterceptor(recipient);
  const interceptor = routing.interceptor;
  const service = routing.failed
    ? null
    : interceptor?.serviceRow ?? await getServiceByInboundEmail(recipient);
  const rfcMessageId = normalizeMessageId(header(payload, "message-id") ?? messageId);
  const inReplyTo = header(payload, "in-reply-to");
  const threadRoot = computeThreadRoot({
    messageId: rfcMessageId,
    inReplyTo,
    references: references(payload),
  });
  const filter = interceptor || routing.failed
    ? { filter: false as const, reason: null }
    : await shouldAutoFilter({ Headers: payload.Headers, Subject: payload.Subject, threadRoot });
  const mode = routing.failed || filter.filter || !service
    ? null
    : interceptor ? "interceptor" as const : "email-agent" as const;
  let attachments: EmailAttachmentInput[] = [];
  if (mode && security.senderAuthenticated && security.spamSafe) {
    const parsed = parsePostmarkAttachments(payload.Attachments);
    if (!parsed.ok) {
      const status = parsed.reason === "message_too_large" ? 413 : 400;
      return { status, body: { ok: false, reason: parsed.reason } };
    }
    attachments = parsed.attachments;
  }
  const { row, inserted } = await inTransaction(pool, async (db) => {
    const persisted = await insertInboundEmail({
      message_id: messageId,
      rfc_message_id: rfcMessageId,
      from_address: from,
      to_address: recipient,
      subject: payload.Subject ?? null,
      body_text: payload.TextBody ?? null,
      body_html: payload.HtmlBody ?? null,
      headers: headersObject(payload),
      postmark_sender_authenticated: security.senderAuthenticated,
      postmark_spam_safe: security.spamSafe,
      in_reply_to: inReplyTo,
      thread_root: threadRoot,
      service_id: service?.id ?? null,
      customer_id: null,
      classification: routing.failed ? "unknown" : filter.filter ? "auto_filtered" : null,
      classification_reason: routing.failed
        ? "inbound routing matcher failed; human review required"
        : filter.reason ?? null,
      processing_mode: mode,
      processing_service_slug: service?.slug ?? null,
    }, db);
    if (persisted.inserted && attachments.length > 0) {
      await storeEmailAttachments({
        direction: "inbound",
        emailId: persisted.row.id,
        attachments,
        db,
      });
    }
    return persisted;
  });
  if (!inserted) {
    if (routing.failed) {
      await updateInboundProcessing({
        id: row.id,
        status: "dead_letter",
        error: "inbound routing matcher failed",
      });
    } else if (mode && service) {
      await requeueFailedEmailIngress(row.id, mode, service.slug);
    }
    return { status: 200, body: { ok: true, inboundId: row.id, duplicate: true } };
  }
  if (routing.failed) {
    await updateInboundProcessing({
      id: row.id,
      status: "dead_letter",
      error: "inbound routing matcher failed",
    });
    await emitEvent({
      source: "email",
      severity: "error",
      type: "email.routing_matcher_failed",
      message: "Inbound email routing failed closed and requires human review.",
      payload: { inboundId: row.id },
    });
  } else if (filter.filter) {
    await updateInboundProcessing({ id: row.id, status: "completed" });
    await emitEvent({
      serviceId: service?.id,
      source: "email",
      severity: "debug",
      type: "email.auto_filtered",
      message: "Inbound email was filtered by deterministic policy.",
      payload: { inboundId: row.id },
    });
  } else if (!service) {
    await updateInboundEmailClassification({
      id: row.id,
      classification: "unrouted",
      reason: "no configured service matched the recipient",
    });
    await updateInboundProcessing({ id: row.id, status: "completed" });
    await emitEvent({
      source: "email",
      severity: "warn",
      type: "email.unrouted",
      message: "Inbound email did not match a configured service recipient.",
      payload: { inboundId: row.id },
    });
  } else {
    await emitEvent({
      serviceId: service.id,
      source: "email",
      type: interceptor ? "email.intercepted" : "email.received",
      message: interceptor
        ? `Inbound email routed to ${interceptor.module.manifest.slug} handler.`
        : "Inbound email accepted for processing.",
      payload: { inboundId: row.id },
    });
    await enqueueEmailIngress(
      row.id,
      mode!,
      interceptor?.module.manifest.slug ?? service.slug,
    );
  }
  return { status: 200, body: { ok: true, inboundId: row.id } };
}
