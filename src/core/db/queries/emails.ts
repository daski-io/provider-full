import { pool } from "../pool.js";
import { randomUUID } from "node:crypto";
import {
  decryptString,
  encryptString,
  protectedLookupHash,
  protectedLookupHashes,
} from "../../chain/encryption.js";
import { redactSensitiveValue } from "../../security/redaction.js";
import type { Queryable } from "../queryable.js";

// Inbound + outbound email storage. Backs the Postmark webhook handler
// (writes to emails_inbound) and the outbound sender (writes to
// emails_outbound). Used by the Email Agent at classification time and
// by the admin Emails page for the operator view.

export interface InboundEmailRow {
  id: string;
  message_id: string;
  rfc_message_id?: string | null;
  from_address: string;
  to_address: string;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  headers: Record<string, unknown> | null;
  postmark_sender_authenticated: boolean;
  postmark_spam_safe: boolean;
  in_reply_to: string | null;
  thread_root: string | null;
  customer_id: string | null;
  service_id: string | null;
  transaction_id: string | null;
  classification: string | null;
  classification_reason: string | null;
  processing_error?: string | null;
  received_at: Date;
}

export interface OutboundEmailRow {
  id: string;
  message_id: string | null;
  from_address: string;
  to_address: string;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  in_reply_to: string | null;
  thread_root: string | null;
  reply_to: string | null;
  customer_id: string | null;
  service_id: string | null;
  transaction_id: string | null;
  inbound_id: string | null;
  sent_by: string;
  sent_at: Date;
  delivery_status: string | null;
  delivery_payload: Record<string, unknown> | null;
}

export interface InsertInboundResult {
  row: InboundEmailRow;
  /** true if this call inserted the row; false if a row with the same
   *  message_id already existed (Postmark retry / duplicate delivery). */
  inserted: boolean;
}

function emailContext(
  direction: "inbound" | "outbound",
  id: string,
  field: string,
) {
  return {
    purpose: "email-content",
    table: `emails_${direction}`,
    recordId: id,
    field,
  } as const;
}

function encryptOptionalEmailValue(
  value: string | null | undefined,
  direction: "inbound" | "outbound",
  id: string,
  field: string,
): string | null {
  return value ? encryptString(value, emailContext(direction, id, field)) : null;
}

export function decryptInboundEmailRow(row: InboundEmailRow): InboundEmailRow {
  const decryptOptional = (value: string | null, field: string) => value
    ? decryptString(value, emailContext("inbound", row.id, field))
    : null;
  const storedHeaders = row.headers as unknown;
  return {
    ...row,
    from_address: decryptString(row.from_address, emailContext("inbound", row.id, "from_address")),
    to_address: decryptString(row.to_address, emailContext("inbound", row.id, "to_address")),
    rfc_message_id: decryptOptional(row.rfc_message_id ?? null, "rfc_message_id"),
    subject: decryptOptional(row.subject, "subject"),
    body_text: decryptOptional(row.body_text, "body_text"),
    body_html: decryptOptional(row.body_html, "body_html"),
    headers: typeof storedHeaders === "string"
      ? JSON.parse(decryptString(storedHeaders, emailContext("inbound", row.id, "headers")))
      : null,
    in_reply_to: decryptOptional(row.in_reply_to, "in_reply_to"),
    thread_root: decryptOptional(row.thread_root, "thread_root"),
    classification_reason: decryptOptional(row.classification_reason, "classification_reason"),
    processing_error: decryptOptional(row.processing_error ?? null, "processing_error"),
  };
}

function decryptOutboundEmailRow(row: OutboundEmailRow): OutboundEmailRow {
  const decryptOptional = (value: string | null, field: string) => value
    ? decryptString(value, emailContext("outbound", row.id, field))
    : null;
  return {
    ...row,
    to_address: decryptString(row.to_address, emailContext("outbound", row.id, "to_address")),
    subject: decryptOptional(row.subject, "subject"),
    body_text: decryptOptional(row.body_text, "body_text"),
    body_html: decryptOptional(row.body_html, "body_html"),
    in_reply_to: decryptOptional(row.in_reply_to, "in_reply_to"),
    thread_root: decryptOptional(row.thread_root, "thread_root"),
    reply_to: decryptOptional(row.reply_to, "reply_to"),
  };
}

export async function insertInboundEmail(args: {
  message_id: string;
  rfc_message_id?: string | null;
  from_address: string;
  to_address: string;
  subject?: string | null;
  body_text?: string | null;
  body_html?: string | null;
  headers?: Record<string, unknown> | null;
  postmark_sender_authenticated: boolean;
  postmark_spam_safe: boolean;
  in_reply_to?: string | null;
  thread_root?: string | null;
  service_id?: string | null;
  customer_id?: string | null;
  transaction_id?: string | null;
  classification?: string | null;
  classification_reason?: string | null;
  processing_mode?: "email-agent" | "interceptor" | null;
  processing_service_slug?: string | null;
}, db: Queryable = pool): Promise<InsertInboundResult> {
  const id = randomUUID();
  const result = await db.query(
    `INSERT INTO emails_inbound (
       id, message_id, rfc_message_id, from_address, to_address, subject,
       body_text, body_html, headers,
       postmark_sender_authenticated, postmark_spam_safe, in_reply_to, thread_root,
       thread_root_hash, to_address_hash,
       customer_id, service_id, transaction_id,
       classification, classification_reason, processing_mode, processing_service_slug
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     ON CONFLICT (message_id) DO NOTHING
     RETURNING *`,
    [
      id,
      args.message_id,
      encryptOptionalEmailValue(args.rfc_message_id, "inbound", id, "rfc_message_id"),
      encryptString(args.from_address, emailContext("inbound", id, "from_address")),
      encryptString(args.to_address, emailContext("inbound", id, "to_address")),
      args.subject ? encryptString(args.subject, emailContext("inbound", id, "subject")) : null,
      args.body_text ? encryptString(args.body_text, emailContext("inbound", id, "body_text")) : null,
      args.body_html ? encryptString(args.body_html, emailContext("inbound", id, "body_html")) : null,
      args.headers
        ? JSON.stringify(encryptString(JSON.stringify(args.headers), emailContext("inbound", id, "headers")))
        : null,
      args.postmark_sender_authenticated,
      args.postmark_spam_safe,
      encryptOptionalEmailValue(args.in_reply_to, "inbound", id, "in_reply_to"),
      encryptOptionalEmailValue(args.thread_root, "inbound", id, "thread_root"),
      args.thread_root ? protectedLookupHash(args.thread_root, "email-thread") : null,
      protectedLookupHash(args.to_address, "email-recipient"),
      args.customer_id ?? null,
      args.service_id ?? null,
      args.transaction_id ?? null,
      args.classification ?? null,
      encryptOptionalEmailValue(
        args.classification_reason,
        "inbound",
        id,
        "classification_reason",
      ),
      args.processing_mode ?? null,
      args.processing_service_slug ?? null,
    ],
  );
  if (result.rows.length === 0) {
    // ON CONFLICT skipped — a row with this message_id already exists.
    // Fetch it and signal the caller this was a duplicate delivery so it
    // doesn't re-dispatch the Email Agent.
    const existing = await db.query(
      `SELECT * FROM emails_inbound WHERE message_id = $1`,
      [args.message_id],
    );
    return { row: decryptInboundEmailRow(existing.rows[0] as InboundEmailRow), inserted: false };
  }
  return { row: decryptInboundEmailRow(result.rows[0] as InboundEmailRow), inserted: true };
}

/// Bind an inbound email to the transaction (and optionally buyer) the
/// Email Agent matched it to, so the admin transaction-detail page can
/// render the thread. Only overwrites with non-null values.
export async function setInboundEmailTransaction(
  id: string,
  args: { transaction_id?: string | null; customer_id?: string | null },
): Promise<void> {
  await pool.query(
    `UPDATE emails_inbound
        SET transaction_id = COALESCE($2, transaction_id),
            customer_id       = COALESCE($3, customer_id)
      WHERE id = $1`,
    [id, args.transaction_id ?? null, args.customer_id ?? null],
  );
}

export async function updateInboundEmailClassification(args: {
  id: string;
  classification: string;
  reason?: string | null;
  transaction_id?: string | null;
  customer_id?: string | null;
}): Promise<void> {
  await pool.query(
    `UPDATE emails_inbound
        SET classification = $2,
            classification_reason = COALESCE($3, classification_reason),
            transaction_id = COALESCE($4, transaction_id),
            customer_id = COALESCE($5, customer_id)
      WHERE id = $1`,
    [
      args.id,
      args.classification,
      encryptOptionalEmailValue(args.reason, "inbound", args.id, "classification_reason"),
      args.transaction_id ?? null,
      args.customer_id ?? null,
    ],
  );
}

export async function updateInboundProcessing(args: {
  id: string;
  status: "queued" | "running" | "retry" | "completed" | "dead_letter";
  error?: string | null;
  workerId?: string | null;
  leaseExpiresAt?: Date | null;
}): Promise<void> {
  await pool.query(
    `UPDATE emails_inbound
        SET processing_status = $2,
            processing_attempts = CASE WHEN $2 = 'running' THEN processing_attempts + 1 ELSE processing_attempts END,
            processing_error = $3,
            processing_lease_owner = $4,
            processing_lease_expires_at = $5,
            processed_at = CASE WHEN $2 IN ('completed','dead_letter') THEN now() ELSE processed_at END
      WHERE id = $1`,
    [
      args.id,
      args.status,
      encryptOptionalEmailValue(args.error, "inbound", args.id, "processing_error"),
      args.workerId ?? null,
      args.leaseExpiresAt ?? null,
    ],
  );
}

export async function getInboundEmailById(id: string): Promise<InboundEmailRow | null> {
  const result = await pool.query(
    `SELECT * FROM emails_inbound WHERE id = $1`,
    [id],
  );
  const row = result.rows[0] as InboundEmailRow | undefined;
  return row ? decryptInboundEmailRow(row) : null;
}

export async function getOutboundEmailById(id: string): Promise<OutboundEmailRow | null> {
  const result = await pool.query(
    `SELECT * FROM emails_outbound WHERE id = $1`,
    [id],
  );
  const row = result.rows[0] as OutboundEmailRow | undefined;
  return row ? decryptOutboundEmailRow(row) : null;
}

export async function countOutboundInThreadSince(
  threadRoot: string,
  sinceMs: number,
): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM emails_outbound
      WHERE thread_root_hash = ANY($1::text[]) AND sent_at >= $2`,
    [protectedLookupHashes(threadRoot, "email-thread"), new Date(sinceMs)],
  );
  return (result.rows[0] as { n: number }).n;
}

export async function listInboundEmails(args: {
  serviceId?: string;
  transactionId?: string;
  unclassified?: boolean;
  limit?: number;
  offset?: number;
} = {}): Promise<InboundEmailRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (args.serviceId !== undefined) {
    params.push(args.serviceId);
    where.push(`service_id = $${params.length}`);
  }
  if (args.transactionId !== undefined) {
    params.push(args.transactionId);
    where.push(`transaction_id = $${params.length}`);
  }
  if (args.unclassified === true) {
    where.push(`(classification IS NULL OR classification = 'unknown')`);
  }
  params.push(args.limit ?? 100, args.offset ?? 0);
  const sql =
    `SELECT * FROM emails_inbound` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY received_at DESC, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
  const result = await pool.query(sql, params);
  return (result.rows as InboundEmailRow[]).map(decryptInboundEmailRow);
}

export async function listOutboundEmails(args: {
  serviceId?: string;
  transactionId?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<OutboundEmailRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (args.serviceId !== undefined) {
    params.push(args.serviceId);
    where.push(`service_id = $${params.length}`);
  }
  if (args.transactionId !== undefined) {
    params.push(args.transactionId);
    where.push(`transaction_id = $${params.length}`);
  }
  params.push(args.limit ?? 100, args.offset ?? 0);
  const sql =
    `SELECT * FROM emails_outbound` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY sent_at DESC, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
  const result = await pool.query(sql, params);
  return (result.rows as OutboundEmailRow[]).map(decryptOutboundEmailRow);
}

export async function countInboundEmails(args: {
  serviceId?: string;
  unclassified?: boolean;
} = {}): Promise<number> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (args.serviceId) {
    params.push(args.serviceId);
    where.push(`service_id = $${params.length}`);
  }
  if (args.unclassified) where.push(`(classification IS NULL OR classification = 'unknown')`);
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count FROM emails_inbound${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`,
    params,
  );
  return (result.rows[0] as { count: number }).count;
}

export async function countOutboundEmails(serviceId?: string): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count FROM emails_outbound${serviceId ? " WHERE service_id = $1" : ""}`,
    serviceId ? [serviceId] : [],
  );
  return (result.rows[0] as { count: number }).count;
}

export async function insertOutboundEmail(args: {
  message_id?: string | null;
  from_address: string;
  to_address: string;
  subject?: string | null;
  body_text?: string | null;
  body_html?: string | null;
  in_reply_to?: string | null;
  thread_root?: string | null;
  customer_id?: string | null;
  reply_to?: string | null;
  service_id?: string | null;
  transaction_id?: string | null;
  inbound_id?: string | null;
  sent_by: "email_agent" | "operator_agent" | "admin" | "system";
  idempotency_key?: string | null;
}, db: Queryable = pool): Promise<{ row: OutboundEmailRow; inserted: boolean }> {
  const id = randomUUID();
  const result = await db.query(
    `INSERT INTO emails_outbound (
       id, message_id, from_address, to_address, subject,
       body_text, body_html, in_reply_to, thread_root, thread_root_hash,
       customer_id, service_id, transaction_id, inbound_id, sent_by, idempotency_key, reply_to,
       delivery_status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'send_pending')
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [
      id,
      args.message_id ?? null,
      args.from_address,
      encryptString(args.to_address, emailContext("outbound", id, "to_address")),
      args.subject ? encryptString(args.subject, emailContext("outbound", id, "subject")) : null,
      args.body_text ? encryptString(args.body_text, emailContext("outbound", id, "body_text")) : null,
      args.body_html ? encryptString(args.body_html, emailContext("outbound", id, "body_html")) : null,
      encryptOptionalEmailValue(args.in_reply_to, "outbound", id, "in_reply_to"),
      encryptOptionalEmailValue(args.thread_root, "outbound", id, "thread_root"),
      args.thread_root ? protectedLookupHash(args.thread_root, "email-thread") : null,
      args.customer_id ?? null,
      args.service_id ?? null,
      args.transaction_id ?? null,
      args.inbound_id ?? null,
      args.sent_by,
      args.idempotency_key ?? null,
      encryptOptionalEmailValue(args.reply_to, "outbound", id, "reply_to"),
    ],
  );
  if (result.rows[0]) {
    return { row: decryptOutboundEmailRow(result.rows[0] as OutboundEmailRow), inserted: true };
  }
  const existing = await db.query(
    `SELECT * FROM emails_outbound WHERE idempotency_key = $1`,
    [args.idempotency_key],
  );
  return {
    row: decryptOutboundEmailRow(existing.rows[0] as OutboundEmailRow),
    inserted: false,
  };
}

/// Stamp the Postmark-assigned MessageID on an outbound row after a
/// successful /email send. Separate from updateOutboundDeliveryStatus
/// because we get the MessageID at send time, not via the delivery webhook.
export async function setOutboundMessageId(
  id: string,
  messageId: string,
): Promise<void> {
  await pool.query(
    `UPDATE emails_outbound SET message_id = $2 WHERE id = $1`,
    [id, messageId],
  );
}

export async function updateOutboundDeliveryStatus(args: {
  id?: string;
  message_id?: string;
  status: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  if (args.id) {
    await pool.query(
      `UPDATE emails_outbound SET delivery_status = $2, delivery_payload = $3 WHERE id = $1`,
      [args.id, args.status, args.payload ? JSON.stringify(redactSensitiveValue(args.payload)) : null],
    );
  } else if (args.message_id) {
    await pool.query(
      `UPDATE emails_outbound SET delivery_status = $2, delivery_payload = $3 WHERE message_id = $1`,
      [args.message_id, args.status, args.payload ? JSON.stringify(redactSensitiveValue(args.payload)) : null],
    );
  }
}
