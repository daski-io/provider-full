import type { Request, Response, Router } from "express";
import {
  getEmailAttachment,
  listEmailAttachmentMetadata,
  type EmailAttachmentDirection,
} from "../../../db/queries/emailAttachments.js";
import {
  escapeAttr,
  escapeHtml,
  pill,
} from "../layouts.js";

function downloadPath(
  direction: EmailAttachmentDirection,
  emailId: string,
  attachmentId: string,
): string {
  return "/admin/ui/emails/attachments/" +
    [direction, emailId, attachmentId].map(encodeURIComponent).join("/");
}

export async function renderEmailAttachmentsCard(
  direction: EmailAttachmentDirection,
  emailId: string,
): Promise<string> {
  const attachments = await listEmailAttachmentMetadata(direction, emailId);
  if (attachments.length === 0) return "";
  const rows = attachments.map((attachment) => {
    const status = attachment.relay_eligible
      ? pill("format accepted / unscanned", "warning")
      : pill(
          attachment.quarantine_reason ?? "quarantined",
          "danger",
        );
    const action = attachment.relay_eligible
      ? `<a class="btn" href="${escapeAttr(downloadPath(
          direction,
          emailId,
          attachment.id,
        ))}">Download</a>`
      : `<span class="dim">Download blocked</span>`;
    return `<tr>
      <td>${escapeHtml(attachment.filename)}</td>
      <td class="mono dim">${escapeHtml(attachment.content_type)}</td>
      <td class="mono dim">${attachment.content_bytes.toLocaleString()} bytes</td>
      <td>${status}</td>
      <td>${action}</td>
    </tr>`;
  }).join("");
  return `<div class="card">
    <h2>Attachments (${attachments.length})</h2>
    <p class="dim">Files are encrypted in the email archive and are not malware-scanned.
      Open downloads only in an isolated environment. Quarantined files cannot be downloaded or relayed.</p>
    <table>
      <thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Relay status</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function encodedFilename(filename: string): string {
  return encodeURIComponent(filename)
    .replace(/['()*]/g, (char) =>
      `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function mountEmailAttachmentDownloads(router: Router): void {
  router.get(
    "/emails/attachments/:direction/:emailId/:attachmentId",
    async (req: Request, res: Response) => {
      const directionValue = String(req.params.direction);
      if (directionValue !== "inbound" && directionValue !== "outbound") {
        res.status(404).type("text").send("Attachment not found");
        return;
      }
      const direction: EmailAttachmentDirection = directionValue;
      const emailId = String(req.params.emailId);
      const attachmentId = String(req.params.attachmentId);
      const attachment = await getEmailAttachment(direction, emailId, attachmentId);
      if (!attachment) {
        res.status(404).type("text").send("Attachment not found");
        return;
      }
      if (!attachment.relay_eligible) {
        res.status(403).type("text").send("Attachment is quarantined");
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Security-Policy", "default-src 'none'");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodedFilename(attachment.filename)}`,
      );
      res.type(attachment.content_type).send(attachment.content);
    },
  );
}
