import type { Request, Response, Router } from "express";
import {
  getInboundEmailById,
  getOutboundEmailById,
  listInboundEmails,
  listOutboundEmails,
  countInboundEmails,
  countOutboundEmails,
  type InboundEmailRow,
  type OutboundEmailRow,
} from "../../../db/queries/emails.js";
import { listAllServices } from "../../../db/queries/services.js";
import {
  mountEmailAttachmentDownloads,
  renderEmailAttachmentsCard,
} from "./emailAttachments.js";
import { walletShortFromReq } from "../util.js";
import {
  escapeAttr,
  escapeHtml,
  mono,
  pill,
  renderLayout,
} from "../layouts.js";

export function classificationPill(c: string | null): string {
  if (!c) return pill("unclassified", "warning");
  if (c === "auto_filtered") return pill("auto-filtered", "neutral");
  if (c === "unrouted") return pill("unrouted", "warning");
  if (c === "informational") return pill("informational", "info");
  if (c === "refund_request") return pill("refund request", "warning");
  if (c === "question") return pill("question", "info");
  if (c === "unknown") return pill("unknown", "warning");
  return pill(c, "info");
}

// Link the buyer-side address to the buyer detail page when we know the
// buyer; otherwise just show the address.
function buyerLink(customerId: string | null, address: string): string {
  return customerId
    ? `<a href="/admin/ui/customers/${escapeAttr(customerId)}">${escapeHtml(address)}</a>`
    : escapeHtml(address);
}

export function deliveryPill(s: string | null): string {
  if (!s) return pill("sent", "info");
  if (s === "delivery") return pill("delivered", "success");
  if (s === "bounce" || s === "bouncereply") return pill("bounce", "danger");
  if (s === "spamcomplaint") return pill("spam complaint", "danger");
  if (s === "send_failed") return pill("send failed", "danger");
  return pill(s, "neutral");
}

export async function renderEmailsPage(
  req: Request,
  walletShort: string | undefined,
): Promise<string> {
  const q = req.query as Record<string, string | undefined>;
  const services = await listAllServices();
  const filter: { serviceId?: string; unclassified?: boolean } = {};
  if (q.service) filter.serviceId = q.service;
  if (q.filter === "unclassified") filter.unclassified = true;
  const pageSize = 50;
  const offset = Math.max(0, Number.parseInt(q.offset ?? "0", 10) || 0);

  const [inbound, outbound, inboundTotal, outboundTotal] = await Promise.all([
    listInboundEmails({ ...filter, limit: pageSize, offset }),
    listOutboundEmails({ serviceId: filter.serviceId, limit: pageSize, offset }),
    countInboundEmails(filter),
    countOutboundEmails(filter.serviceId),
  ]);
  const services_lite = services.map((s) => ({ id: s.id, slug: s.slug }));
  const slugFor = (sid: string | null) =>
    sid ? services_lite.find((s) => s.id === sid)?.slug ?? "?" : "—";

  const filterControls = `
    <form method="GET" action="/admin/ui/emails" class="row" style="margin-bottom:14px;">
      <select name="service">
        <option value="">All services</option>
        ${services.map((s) => `<option value="${escapeAttr(s.id)}"${filter.serviceId === s.id ? " selected" : ""}>${escapeHtml(s.name)}</option>`).join("")}
      </select>
      <select name="filter">
        <option value="">All inbound</option>
        <option value="unclassified" ${filter.unclassified ? "selected" : ""}>unclassified only</option>
      </select>
      <button class="btn" type="submit">Apply</button>
      <a class="btn" href="/admin/ui/emails">Reset</a>
    </form>
  `;
  const pageQuery = new URLSearchParams();
  if (filter.serviceId) pageQuery.set("service", filter.serviceId);
  if (filter.unclassified) pageQuery.set("filter", "unclassified");
  const pageLink = (nextOffset: number) => {
    const params = new URLSearchParams(pageQuery);
    params.set("offset", String(nextOffset));
    return `/admin/ui/emails?${params.toString()}`;
  };
  const pager = `
    <div class="row" style="margin:8px 0 16px;">
      ${offset > 0 ? `<a class="btn" href="${escapeAttr(pageLink(Math.max(0, offset - pageSize)))}">Previous</a>` : ""}
      ${(offset + pageSize) < Math.max(inboundTotal, outboundTotal)
        ? `<a class="btn" href="${escapeAttr(pageLink(offset + pageSize))}">Next</a>`
        : ""}
    </div>`;

  // Whole row navigates to the detail view; the inner tx link stops
  // propagation so it still goes to the transaction.
  const txCell = (txId: string | null): string =>
    txId
      ? `<a class="mono" href="/admin/ui/transactions/${escapeAttr(txId)}">tx</a>`
      : `<span class="dim">—</span>`;

  const inboundRow = (e: InboundEmailRow): string => `
    <tr class="row-link" data-href="/admin/ui/emails/${escapeAttr(e.id)}">
      <td class="mono dim">${escapeHtml(e.received_at.toISOString().slice(0, 19).replace("T", " "))}</td>
      <td>${escapeHtml(slugFor(e.service_id))}</td>
      <td>${escapeHtml(e.from_address)}</td>
      <td>${escapeHtml(e.subject ?? "(no subject)")}</td>
      <td>${classificationPill(e.classification)}</td>
      <td>${txCell(e.transaction_id)}</td>
      <td class="row-chev">›</td>
    </tr>`;

  const outboundRow = (e: OutboundEmailRow): string => `
    <tr class="row-link" data-href="/admin/ui/emails/out/${escapeAttr(e.id)}">
      <td class="mono dim">${escapeHtml(e.sent_at.toISOString().slice(0, 19).replace("T", " "))}</td>
      <td>${escapeHtml(slugFor(e.service_id))}</td>
      <td>${escapeHtml(e.to_address)}</td>
      <td>${escapeHtml(e.subject ?? "")}</td>
      <td>${mono(e.sent_by)}</td>
      <td>${deliveryPill(e.delivery_status)}</td>
      <td>${txCell(e.transaction_id)}</td>
      <td class="row-chev">›</td>
    </tr>`;

  const body = `
    ${filterControls}
    <div class="card">
      <h2>Inbound (${offset + 1}–${Math.min(offset + inbound.length, inboundTotal)} of ${inboundTotal})</h2>
      ${inbound.length === 0
        ? `<p class="dim">No inbound mail yet. Postmark webhook posts to <span class="mono">/webhooks/postmark/inbound</span>.</p>`
        : `<table>
            <thead><tr><th>Received</th><th>Service</th><th>From</th><th>Subject</th><th>Classification</th><th>Tx</th><th></th></tr></thead>
            <tbody>${inbound.map(inboundRow).join("")}</tbody>
          </table>`}
    </div>
    <div class="card">
      <h2>Outbound (${offset + 1}–${Math.min(offset + outbound.length, outboundTotal)} of ${outboundTotal})</h2>
      ${outbound.length === 0
        ? `<p class="dim">No outbound mail sent yet.</p>`
        : `<table>
            <thead><tr><th>Sent</th><th>Service</th><th>To</th><th>Subject</th><th>By</th><th>Delivery</th><th>Tx</th><th></th></tr></thead>
            <tbody>${outbound.map(outboundRow).join("")}</tbody>
          </table>`}
    </div>
    ${pager}
  `;
  return renderLayout({ page: "emails", title: "Email", body, walletShort });
}

// Render the complete inbound email so the operator can read exactly what
// the customer sent. The body_text is shown raw (escaped) for fidelity;
// body_html is rendered inside a locked-down iframe — sandbox="" disables
// scripts/forms/navigation and a strict CSP meta blocks all remote content
// (only inline data: images allowed), so a hostile HTML email can't run
// code or phone home. Per the spec there is NO injection flag/highlight —
// the LLM input is sanitized separately (injectionFilter.ts); the operator
// view is truthful and shows the raw message.
function renderHtmlBodyFrame(html: string): string {
  const csp =
    `<meta http-equiv="Content-Security-Policy" ` +
    `content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">`;
  const doc = `<!doctype html><html><head><meta charset="utf-8">${csp}</head><body>${html}</body></html>`;
  return `<iframe sandbox="" referrerpolicy="no-referrer" srcdoc="${escapeAttr(doc)}" style="width:100%; min-height:360px; border:1px solid var(--pro-border); border-radius:8px; background:#fff;"></iframe>`;
}

export async function renderInboundEmailDetail(
  id: string,
  walletShort: string | undefined,
): Promise<string | null> {
  const email = await getInboundEmailById(id);
  if (!email) return null;
  const services = await listAllServices();
  const slug = email.service_id
    ? services.find((s) => s.id === email.service_id)?.slug ?? "?"
    : "—";

  const metaRow = (label: string, value: string): string => `
    <tr>
      <td class="mono dim" style="width:160px; vertical-align:top;">${escapeHtml(label)}</td>
      <td style="word-break:break-word;">${value}</td>
    </tr>`;

  const headersJson = email.headers
    ? JSON.stringify(email.headers, null, 2)
    : "";

  const body = `
    <div style="margin-bottom:14px;">
      <a class="dim" href="/admin/ui/emails">← Email</a>
    </div>
    <div class="card">
      <div class="mono-caption">Inbound email</div>
      <h2 style="margin:6px 0 14px;">${escapeHtml(email.subject ?? "(no subject)")}</h2>
      <table style="font-size:13px;"><tbody>
        ${metaRow("From", buyerLink(email.customer_id, email.from_address))}
        ${metaRow("To", escapeHtml(email.to_address))}
        ${metaRow("Service", escapeHtml(slug))}
        ${metaRow("Received", escapeHtml(email.received_at.toISOString().slice(0, 19).replace("T", " ")))}
        ${metaRow("Classification", classificationPill(email.classification) + (email.classification_reason ? ` <span class="dim">${escapeHtml(email.classification_reason)}</span>` : ""))}
        ${metaRow("Transaction", email.transaction_id ? `<a class="mono" href="/admin/ui/transactions/${escapeAttr(email.transaction_id)}">${escapeHtml(email.transaction_id)}</a>` : `<span class="dim">—</span>`)}
        ${metaRow("Message-ID", mono(email.message_id))}
      </tbody></table>
    </div>

    ${await renderEmailAttachmentsCard("inbound", email.id)}

    <div class="card">
      <h2>Body (text)</h2>
      ${email.body_text
        ? `<pre style="white-space:pre-wrap; word-break:break-word; margin:0; font-family:var(--font-mono); font-size:12.5px; line-height:1.55;">${escapeHtml(email.body_text)}</pre>`
        : `<p class="dim">No plain-text body.</p>`}
    </div>

    ${email.body_html
      ? `<div class="card">
          <h2>Body (HTML)</h2>
          <p class="dim" style="font-size:11.5px; margin-top:0;">Rendered in a sandboxed frame — scripts and remote content are blocked.</p>
          ${renderHtmlBodyFrame(email.body_html)}
        </div>`
      : ""}

    ${headersJson
      ? `<div class="card">
          <details>
            <summary style="cursor:pointer; color:var(--fg-3); font-family:var(--font-mono); font-size:12px;">Raw headers</summary>
            <pre style="margin:10px 0 0; padding:12px; background:var(--pro-bg); border:1px solid var(--pro-border); border-radius:6px; font-size:11px; max-height:340px; overflow:auto;">${escapeHtml(headersJson)}</pre>
          </details>
        </div>`
      : ""}
  `;
  return renderLayout({
    page: "emails",
    title: `Email · ${email.subject ?? "(no subject)"}`,
    body,
    walletShort,
  });
}

// The complete outbound (sent) email — same locked-down rendering as the
// inbound view, plus delivery status.
export async function renderOutboundEmailDetail(
  id: string,
  walletShort: string | undefined,
): Promise<string | null> {
  const email = await getOutboundEmailById(id);
  if (!email) return null;
  const services = await listAllServices();
  const slug = email.service_id
    ? services.find((s) => s.id === email.service_id)?.slug ?? "?"
    : "—";

  const metaRow = (label: string, value: string): string => `
    <tr>
      <td class="mono dim" style="width:160px; vertical-align:top;">${escapeHtml(label)}</td>
      <td style="word-break:break-word;">${value}</td>
    </tr>`;

  const body = `
    <div style="margin-bottom:14px;">
      <a class="dim" href="/admin/ui/emails">← Email</a>
    </div>
    <div class="card">
      <div class="mono-caption">Outbound email</div>
      <h2 style="margin:6px 0 14px;">${escapeHtml(email.subject ?? "(no subject)")}</h2>
      <table style="font-size:13px;"><tbody>
        ${metaRow("To", buyerLink(email.customer_id, email.to_address))}
        ${metaRow("From", escapeHtml(email.from_address))}
        ${metaRow("Service", escapeHtml(slug))}
        ${metaRow("Sent", escapeHtml(email.sent_at.toISOString().slice(0, 19).replace("T", " ")))}
        ${metaRow("Sent by", mono(email.sent_by))}
        ${metaRow("Delivery", deliveryPill(email.delivery_status))}
        ${metaRow("Transaction", email.transaction_id ? `<a class="mono" href="/admin/ui/transactions/${escapeAttr(email.transaction_id)}">${escapeHtml(email.transaction_id)}</a>` : `<span class="dim">—</span>`)}
        ${metaRow("Message-ID", email.message_id ? mono(email.message_id) : `<span class="dim">—</span>`)}
      </tbody></table>
    </div>

    ${await renderEmailAttachmentsCard("outbound", email.id)}

    <div class="card">
      <h2>Body (text)</h2>
      ${email.body_text
        ? `<pre style="white-space:pre-wrap; word-break:break-word; margin:0; font-family:var(--font-mono); font-size:12.5px; line-height:1.55;">${escapeHtml(email.body_text)}</pre>`
        : `<p class="dim">No plain-text body.</p>`}
    </div>

    ${email.body_html
      ? `<div class="card">
          <h2>Body (HTML)</h2>
          <p class="dim" style="font-size:11.5px; margin-top:0;">Rendered in a sandboxed frame — scripts and remote content are blocked.</p>
          ${renderHtmlBodyFrame(email.body_html)}
        </div>`
      : ""}
  `;
  return renderLayout({
    page: "emails",
    title: `Email · ${email.subject ?? "(no subject)"}`,
    body,
    walletShort,
  });
}

export function mountEmailsPage(router: Router): void {
  mountEmailAttachmentDownloads(router);
  router.get("/emails", async (req: Request, res: Response) => {
    const wallet = (req as Request & { _adminWallet?: string })._adminWallet;
    const walletShort = wallet ? wallet.slice(0, 6) + "…" + wallet.slice(-4) : undefined;
    const html = await renderEmailsPage(req, walletShort);
    res.type("html").send(html);
  });

  // Outbound detail — registered before the generic /emails/:id so the
  // two-segment path is unambiguous.
  router.get("/emails/out/:id", async (req: Request, res: Response) => {
    const html = await renderOutboundEmailDetail(
      req.params.id as string,
      walletShortFromReq(req),
    );
    if (!html) {
      res.status(404).type("html").send("Email not found");
      return;
    }
    res.type("html").send(html);
  });

  router.get("/emails/:id", async (req: Request, res: Response) => {
    const html = await renderInboundEmailDetail(
      req.params.id as string,
      walletShortFromReq(req),
    );
    if (!html) {
      res.status(404).type("html").send("Email not found");
      return;
    }
    res.type("html").send(html);
  });
}
