// Pre-LLM email filter. Headers + subject patterns + per-thread reply
// rate cap. Filtered emails are stored as `auto_filtered` and never
// hand off to the Email Agent (saves OpenAI tokens on obvious bulk /
// auto-reply / vacation traffic).

import { countOutboundInThreadSince } from "../db/queries/emails.js";

interface InboundShape {
  Headers?: Array<{ Name: string; Value: string }>;
  Subject?: string;
  threadRoot?: string;
}

const AUTO_REPLY_HEADER_NAMES = new Set([
  "auto-submitted",
  "x-auto-response-suppress",
  "x-autoreply",
  "list-unsubscribe",
]);
const AUTO_PRECEDENCE_VALUES = new Set(["bulk", "list", "junk", "auto_reply"]);
const SUBJECT_PATTERNS = /^(auto:|out of office|automatic reply|ooo|vacation:)/i;
const THREAD_REPLY_CAP = 3;
const THREAD_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Postmark runs inbound mail through SpamAssassin and surfaces the verdict
// in standard headers (X-Spam-Status: Yes/No, X-Spam-Score: <float>). We
// drop on its verdict so junk never reaches the Email Agent (saves tokens
// and reduces unsolicited-content exposure). SpamAssassin's conventional
// spam cutoff is 5.0; gate on the explicit Yes verdict OR a score at/above it.
// Postmark does not make attachments malware-safe.
// NOTE: Postmark does NOT detect prompt-injection (LLM-specific) — that is
// handled separately in src/core/email/injectionFilter.ts.
const SPAM_SCORE_THRESHOLD = 5.0;

export interface FilterDecision {
  filter: boolean;
  reason?: string;
}

export async function shouldAutoFilter(email: InboundShape): Promise<FilterDecision> {
  const headers = email.Headers ?? [];
  for (const h of headers) {
    const name = h.Name.toLowerCase();
    const value = (h.Value ?? "").trim().toLowerCase();
    if (name === "auto-submitted" && value && value !== "no") {
      return { filter: true, reason: `Auto-Submitted: ${h.Value}` };
    }
    if (name === "precedence" && AUTO_PRECEDENCE_VALUES.has(value)) {
      return { filter: true, reason: `Precedence: ${h.Value}` };
    }
    if (AUTO_REPLY_HEADER_NAMES.has(name) && name !== "auto-submitted") {
      return { filter: true, reason: `header present: ${h.Name}` };
    }
    // Postmark SpamAssassin verdict.
    if (name === "x-spam-status" && value.startsWith("yes")) {
      return { filter: true, reason: `Postmark spam verdict: ${h.Value}` };
    }
    if (name === "x-spam-score") {
      const score = parseFloat(value);
      if (Number.isFinite(score) && score >= SPAM_SCORE_THRESHOLD) {
        return {
          filter: true,
          reason: `Postmark spam score ${score} ≥ ${SPAM_SCORE_THRESHOLD}`,
        };
      }
    }
  }
  if (email.Subject && SUBJECT_PATTERNS.test(email.Subject)) {
    return { filter: true, reason: `subject pattern: ${email.Subject}` };
  }
  if (email.threadRoot) {
    const recent = await countOutboundInThreadSince(
      email.threadRoot,
      Date.now() - THREAD_WINDOW_MS,
    );
    if (recent >= THREAD_REPLY_CAP) {
      return {
        filter: true,
        reason: `thread reply cap hit (${recent} replies in last hour)`,
      };
    }
  }
  return { filter: false };
}
