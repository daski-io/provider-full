import { createHash, randomUUID } from "node:crypto";
import {
  decryptString,
  encryptString,
} from "../../chain/encryption.js";
import { pool } from "../pool.js";
import type { Queryable } from "../queryable.js";

export type EmailAttachmentDirection = "inbound" | "outbound";
export type AttachmentQuarantineReason =
  | "unsupported_content_type"
  | "invalid_content"
  | "attachment_too_large";

export interface EmailAttachmentInput {
  filename: string;
  contentType: string;
  contentId?: string | null;
  disposition?: "attachment" | "inline";
  content: Buffer;
  quarantineReason?: AttachmentQuarantineReason | null;
}

interface StoredEmailAttachmentRow {
  id: string;
  inbound_id: string | null;
  outbound_id: string | null;
  ordinal: number;
  filename: string;
  content_type: string;
  content_id: string | null;
  content_disposition: "attachment" | "inline";
  content_encrypted: string;
  content_sha256: string;
  content_bytes: number;
  relay_eligible: boolean;
  quarantine_reason: AttachmentQuarantineReason | null;
  created_at: Date;
}

type StoredEmailAttachmentMetadataRow =
  Omit<StoredEmailAttachmentRow, "content_encrypted">;

export interface EmailAttachmentMetadataRow
  extends Omit<StoredEmailAttachmentMetadataRow, "filename" | "content_id"> {
  filename: string;
  contentId: string | null;
}

export interface EmailAttachmentRow extends EmailAttachmentMetadataRow {
  content: Buffer;
}

function attachmentContext(
  id: string,
  field: "filename" | "content_id" | "content_encrypted",
) {
  return {
    purpose: field === "content_encrypted"
      ? "email-attachment"
      : "email-attachment-metadata",
    table: "email_attachments",
    recordId: id,
    field,
  } as const;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function revealMetadata(
  row: StoredEmailAttachmentMetadataRow,
): EmailAttachmentMetadataRow {
  const { filename, content_id: contentId, ...metadata } = row;
  return {
    ...metadata,
    filename: decryptString(filename, attachmentContext(row.id, "filename")),
    contentId: contentId
      ? decryptString(contentId, attachmentContext(row.id, "content_id"))
      : null,
  };
}

function reveal(row: StoredEmailAttachmentRow): EmailAttachmentRow {
  const { content_encrypted: _contentEncrypted, ...metadata } = row;
  const content = Buffer.from(
    decryptString(
      row.content_encrypted,
      attachmentContext(row.id, "content_encrypted"),
    ),
    "base64",
  );
  if (
    content.length !== row.content_bytes
    || sha256(content) !== row.content_sha256
  ) {
    throw new Error("email attachment integrity check failed");
  }
  return {
    ...revealMetadata(metadata),
    content,
  };
}

const EMAIL_ATTACHMENT_METADATA_COLUMNS = [
  "id",
  "inbound_id",
  "outbound_id",
  "ordinal",
  "filename",
  "content_type",
  "content_id",
  "content_disposition",
  "content_sha256",
  "content_bytes",
  "relay_eligible",
  "quarantine_reason",
  "created_at",
].join(", ");

export async function listEmailAttachmentMetadata(
  direction: EmailAttachmentDirection,
  emailId: string,
  db: Queryable = pool,
): Promise<EmailAttachmentMetadataRow[]> {
  const column = direction === "inbound" ? "inbound_id" : "outbound_id";
  const result = await db.query<StoredEmailAttachmentMetadataRow>(
    `SELECT ${EMAIL_ATTACHMENT_METADATA_COLUMNS}
       FROM email_attachments
      WHERE ${column} = $1
      ORDER BY ordinal`,
    [emailId],
  );
  return result.rows.map(revealMetadata);
}

export async function getEmailAttachment(
  direction: EmailAttachmentDirection,
  emailId: string,
  attachmentId: string,
  db: Queryable = pool,
): Promise<EmailAttachmentRow | null> {
  const column = direction === "inbound" ? "inbound_id" : "outbound_id";
  const result = await db.query<StoredEmailAttachmentRow>(
    `SELECT * FROM email_attachments
      WHERE ${column} = $1 AND id = $2`,
    [emailId, attachmentId],
  );
  return result.rows[0] ? reveal(result.rows[0]) : null;
}

export async function listEmailAttachments(
  direction: EmailAttachmentDirection,
  emailId: string,
  db: Queryable = pool,
): Promise<EmailAttachmentRow[]> {
  const column = direction === "inbound" ? "inbound_id" : "outbound_id";
  const result = await db.query(
    `SELECT * FROM email_attachments
      WHERE ${column} = $1
      ORDER BY ordinal`,
    [emailId],
  );
  return (result.rows as StoredEmailAttachmentRow[]).map(reveal);
}

export async function storeEmailAttachments(args: {
  direction: EmailAttachmentDirection;
  emailId: string;
  attachments: EmailAttachmentInput[];
  db?: Queryable;
}): Promise<EmailAttachmentMetadataRow[]> {
  const db = args.db ?? pool;
  if (args.attachments.length > 50) {
    throw new Error("email attachment count exceeds storage limit");
  }
  const parentColumn = args.direction === "inbound" ? "inbound_id" : "outbound_id";
  for (const [ordinal, attachment] of args.attachments.entries()) {
    const id = randomUUID();
    const filename = attachment.filename.trim().slice(0, 255) || "attachment";
    const contentType = attachment.contentType.trim().toLowerCase().slice(0, 255);
    const digest = sha256(attachment.content);
    await db.query(
      `INSERT INTO email_attachments (
         id, ${parentColumn}, ordinal, filename, content_type, content_id,
         content_disposition, content_encrypted, content_sha256, content_bytes,
         relay_eligible, quarantine_reason
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (${parentColumn}, ordinal) WHERE ${parentColumn} IS NOT NULL
       DO NOTHING`,
      [
        id,
        args.emailId,
        ordinal,
        encryptString(filename, attachmentContext(id, "filename")),
        contentType,
        attachment.contentId
          ? encryptString(
              attachment.contentId.slice(0, 255),
              attachmentContext(id, "content_id"),
            )
          : null,
        attachment.disposition ?? "attachment",
        encryptString(
          attachment.content.toString("base64"),
          attachmentContext(id, "content_encrypted"),
        ),
        digest,
        attachment.content.length,
        !attachment.quarantineReason,
        attachment.quarantineReason ?? null,
      ],
    );
  }
  const persisted = await listEmailAttachmentMetadata(args.direction, args.emailId, db);
  if (persisted.length !== args.attachments.length) {
    throw new Error("email attachment retry changed the attachment count");
  }
  for (const [ordinal, row] of persisted.entries()) {
    const expected = args.attachments[ordinal]!;
    if (
      row.content_sha256 !== sha256(expected.content)
      || row.content_bytes !== expected.content.length
      || row.filename !== (expected.filename.trim().slice(0, 255) || "attachment")
      || row.content_type !== expected.contentType.trim().toLowerCase().slice(0, 255)
      || row.contentId !== (expected.contentId?.slice(0, 255) ?? null)
      || row.content_disposition !== (expected.disposition ?? "attachment")
      || row.quarantine_reason !== (expected.quarantineReason ?? null)
    ) {
      throw new Error("email attachment retry changed durable message content");
    }
  }
  return persisted;
}
