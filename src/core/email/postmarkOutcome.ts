import { updateOutboundDeliveryStatus } from "../db/queries/emails.js";
import { emitEvent } from "../events/emitter.js";
import type { SendEmailArgs } from "./postmarkMessage.js";

/** How long a send whose last-moment check failed for infrastructure waits before a retry. */
export const OUTBOUND_RETRY_COOLDOWN_MS = 60_000;

/**
 * A send that did not reach Postmark for a recorded reason: `skipped` (a
 * terminal refusal, never resent), `retryable` (the same logical send may
 * run again after its cooldown) or `unknown` (resend refused for review).
 */
export class OutboundEmailError extends Error {
  constructor(readonly outcome: "skipped" | "retryable" | "unknown", message: string) {
    super(message);
    this.name = "OutboundEmailError";
  }
}

/**
 * A sender's deliberate refusal immediately before the outbound call (a
 * delivery admission an owner change revoked or made stale). Only this class
 * is terminal: any other failure of the last-moment hook is infrastructure
 * (a pool acquisition, a statement timeout, a lost connection) and leaves the
 * journaled send retryable.
 */
export class OutboundSendRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundSendRefusedError";
  }
}

function eventContext(args: SendEmailArgs) {
  return {
    serviceId: args.serviceId ?? undefined,
    transactionId: args.transactionId ?? undefined,
  };
}

export async function recordUnknownOutcome(
  rowId: string,
  args: SendEmailArgs,
  status?: number,
): Promise<void> {
  await updateOutboundDeliveryStatus({ id: rowId, status: "outcome_unknown" });
  await emitEvent({
    ...eventContext(args),
    source: "email",
    severity: "error",
    type: "email.outcome_unknown",
    message: status === undefined
      ? "Postmark send outcome is unknown; automatic resend is blocked."
      : "Postmark returned success without a message identifier; automatic resend is blocked.",
    payload: { outboundId: rowId, ...(status === undefined ? {} : { status }) },
    mandatory: true,
  });
}

export async function recordFailedOutcome(
  rowId: string,
  args: SendEmailArgs,
  status: number,
): Promise<void> {
  await updateOutboundDeliveryStatus({ id: rowId, status: "send_failed" });
  await emitEvent({
    ...eventContext(args),
    source: "email",
    severity: "error",
    type: "email.send_failed",
    message: `Postmark send returned HTTP ${status}.`,
    payload: { outboundId: rowId, status },
  });
}

export async function recordAcceptedOutcome(
  rowId: string,
  args: SendEmailArgs,
  messageId: string,
  testMode: boolean,
): Promise<void> {
  await emitEvent({
    ...eventContext(args),
    source: "email",
    type: "email.sent",
    message: `Outbound email accepted by Postmark${testMode ? " test mode" : ""}.`,
    payload: { outboundId: rowId, postmarkMessageId: messageId, testMode },
  });
}

/// The sender refused immediately before the outbound call: terminal, never
/// resent automatically, with the reviewed reason on the journaled row.
export async function recordSkippedOutcome(rowId: string, args: SendEmailArgs, reason: string): Promise<void> {
  await updateOutboundDeliveryStatus({ id: rowId, status: "send_skipped", payload: { reason } });
  await emitEvent({
    ...eventContext(args),
    source: "email",
    severity: "warn",
    type: "email.skipped",
    message: "Email delivery was refused immediately before the outbound call.",
    payload: { outboundId: rowId, reason },
    mandatory: true,
  });
}

/// The last-moment check failed for a reason that is not a refusal (the
/// database was unavailable): nothing was sent, and the journaled row stays
/// retryable with its request fingerprint and a cooldown, so the same
/// logical send runs again and is validated again on that attempt.
export async function recordRetryableOutcome(
  rowId: string,
  args: SendEmailArgs,
  requestFingerprint: string,
  errorClass: string,
): Promise<void> {
  await updateOutboundDeliveryStatus({
    id: rowId,
    status: "send_retryable",
    payload: { requestFingerprint, errorClass, retryAfter: Date.now() + OUTBOUND_RETRY_COOLDOWN_MS },
  });
  await emitEvent({
    ...eventContext(args),
    source: "email",
    severity: "warn",
    type: "email.send_deferred",
    message: "Email delivery could not be validated before the outbound call; it is retryable.",
    payload: { outboundId: rowId, errorClass },
    mandatory: true,
  });
}
