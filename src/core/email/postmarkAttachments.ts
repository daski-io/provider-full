import { basename, extname } from "node:path";
import { config } from "../config.js";
import type {
  AttachmentQuarantineReason,
  EmailAttachmentInput,
} from "../db/queries/emailAttachments.js";

export interface PostmarkInboundAttachment {
  Name?: string;
  Content?: string;
  ContentType?: string;
  ContentLength?: number;
  ContentID?: string;
}

const RELAYABLE_CONTENT_TYPES = new Set([
  "application/pdf",
  "application/rtf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "text/csv",
  "text/plain",
]);

const EXTENSIONS_BY_CONTENT_TYPE = new Map<string, Set<string>>([
  ["application/pdf", new Set([".pdf"])],
  ["application/rtf", new Set([".rtf"])],
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    new Set([".docx"]),
  ],
  [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    new Set([".xlsx"]),
  ],
  ["image/gif", new Set([".gif"])],
  ["image/jpeg", new Set([".jpeg", ".jpg"])],
  ["image/png", new Set([".png"])],
  ["image/tiff", new Set([".tif", ".tiff"])],
  ["text/csv", new Set([".csv"])],
  ["text/plain", new Set([".txt"])],
]);

function cleanFilename(value: string | undefined, ordinal: number): string {
  const withoutControls = (value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\\/g, "/");
  return basename(withoutControls).trim().slice(0, 255)
    || `attachment-${ordinal + 1}`;
}

function decodedBase64Length(value: string | undefined): number | null {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    return null;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function decodeBase64(value: string | undefined): Buffer | null {
  const expectedLength = decodedBase64Length(value);
  if (expectedLength === null || value === undefined) return null;
  const content = Buffer.from(value, "base64");
  if (content.length !== expectedLength) return null;
  const canonical = content.toString("base64").replace(/=+$/, "");
  return canonical === value.replace(/=+$/, "") ? content : null;
}

function normalizedType(value: string | undefined): string {
  return (value ?? "application/octet-stream")
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
}

function startsWith(content: Buffer, bytes: number[]): boolean {
  return bytes.every((value, index) => content[index] === value);
}

function containsAscii(content: Buffer, value: string): boolean {
  return content.includes(Buffer.from(value, "ascii"));
}

function contentMatchesType(content: Buffer, contentType: string): boolean {
  switch (contentType) {
    case "application/pdf":
      return content.subarray(0, 5).toString("ascii") === "%PDF-";
    case "application/rtf":
      return content.subarray(0, 5).toString("ascii") === "{\\rtf";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return startsWith(content, [0x50, 0x4b, 0x03, 0x04])
        && containsAscii(content, "[Content_Types].xml")
        && containsAscii(content, "word/");
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return startsWith(content, [0x50, 0x4b, 0x03, 0x04])
        && containsAscii(content, "[Content_Types].xml")
        && containsAscii(content, "xl/");
    case "image/gif":
      return ["GIF87a", "GIF89a"].includes(content.subarray(0, 6).toString("ascii"));
    case "image/jpeg":
      return startsWith(content, [0xff, 0xd8, 0xff]);
    case "image/png":
      return startsWith(content, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/tiff":
      return startsWith(content, [0x49, 0x49, 0x2a, 0x00])
        || startsWith(content, [0x4d, 0x4d, 0x00, 0x2a]);
    case "text/csv":
    case "text/plain":
      return !content.includes(0);
    default:
      return false;
  }
}

function filenameMatchesType(filename: string, contentType: string): boolean {
  const extensions = EXTENSIONS_BY_CONTENT_TYPE.get(contentType);
  return extensions?.has(extname(filename).toLowerCase()) === true;
}

function quarantineReason(
  content: Buffer,
  contentType: string,
  filename: string,
): AttachmentQuarantineReason | null {
  if (!RELAYABLE_CONTENT_TYPES.has(contentType)) return "unsupported_content_type";
  if (!filenameMatchesType(filename, contentType)) return "invalid_content";
  return contentMatchesType(content, contentType) ? null : "invalid_content";
}

export function validateRelayAttachment(
  attachment: EmailAttachmentInput,
): AttachmentQuarantineReason | null {
  if (attachment.content.length > config.POSTMARK_INBOUND_MAX_ATTACHMENT_BYTES) {
    return "attachment_too_large";
  }
  const contentType = normalizedType(attachment.contentType);
  return quarantineReason(attachment.content, contentType, attachment.filename);
}

export type ParsedPostmarkAttachments =
  | { ok: true; attachments: EmailAttachmentInput[] }
  | { ok: false; reason: "invalid_attachment" | "message_too_large" };

export function parsePostmarkAttachments(
  values: unknown,
): ParsedPostmarkAttachments {
  if (values !== undefined && !Array.isArray(values)) {
    return { ok: false, reason: "invalid_attachment" };
  }
  const input = values ?? [];
  if (input.length > config.POSTMARK_INBOUND_MAX_ATTACHMENTS) {
    return { ok: false, reason: "message_too_large" };
  }
  const attachments: EmailAttachmentInput[] = [];
  let totalBytes = 0;
  for (const [ordinal, itemValue] of input.entries()) {
    if (!itemValue || typeof itemValue !== "object" || Array.isArray(itemValue)) {
      return { ok: false, reason: "invalid_attachment" };
    }
    const item = itemValue as PostmarkInboundAttachment;
    if (
      (item.Name !== undefined && typeof item.Name !== "string")
      || (item.ContentType !== undefined && typeof item.ContentType !== "string")
      || (item.ContentID !== undefined && typeof item.ContentID !== "string")
      || (
        item.ContentLength !== undefined
        && !Number.isSafeInteger(item.ContentLength)
      )
    ) {
      return { ok: false, reason: "invalid_attachment" };
    }
    const decodedLength = decodedBase64Length(item.Content);
    if (decodedLength === null) {
      return { ok: false, reason: "invalid_attachment" };
    }
    if (
      decodedLength > config.POSTMARK_INBOUND_MAX_ATTACHMENT_BYTES
      || totalBytes + decodedLength > config.POSTMARK_INBOUND_MAX_TOTAL_ATTACHMENT_BYTES
    ) {
      return { ok: false, reason: "message_too_large" };
    }
    if (
      item.ContentLength !== undefined
      && item.ContentLength !== decodedLength
    ) {
      return { ok: false, reason: "invalid_attachment" };
    }
    const content = decodeBase64(item.Content);
    if (!content) return { ok: false, reason: "invalid_attachment" };
    totalBytes += decodedLength;
    const contentType = normalizedType(item.ContentType);
    const filename = cleanFilename(item.Name, ordinal);
    const contentId = item.ContentID?.trim() || null;
    attachments.push({
      filename,
      contentType,
      contentId,
      disposition: contentId ? "inline" : "attachment",
      content,
      quarantineReason: quarantineReason(content, contentType, filename),
    });
  }
  return { ok: true, attachments };
}
