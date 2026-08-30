// Prompt-injection neutralizer for untrusted email bodies.
//
// Applied to the inbound body (and thread-history bodies) BEFORE they're
// inserted into the Email Agent prompt, so an email can't smuggle in
// instructions that hijack the agent. This is silent and LLM-input-only:
// the operator-facing admin UI still renders the raw email (truthful for
// review). The prompt already fences untrusted content; this removes the
// high-signal override phrases outright as defense-in-depth.
//
// Postmark supplies SpamAssassin signals that are evaluated at ingress.
// It does not make attachments malware-safe; those follow a separate,
// human-reviewed relay policy. Prompt injection is LLM-specific, so
// this stays ours.
//
// Conservative by design: it targets imperative override phrases that have
// essentially no legitimate place in a support email (a buyer asking about
// their domain doesn't write "ignore all previous instructions"). Matched
// spans are replaced with a single space rather than flagged.

import { neutralizePromptText } from "../security/promptInjection.js";

/// Strip high-signal prompt-injection phrases from untrusted text. Returns
/// "" for null/undefined/empty input. Idempotent: re-running on already-
/// neutralized text changes nothing.
export function neutralizeInjection(input: string | null | undefined): string {
  return neutralizePromptText(input).text;
}
