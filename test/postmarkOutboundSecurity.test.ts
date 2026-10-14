import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboundEmailRow } from "../src/core/db/queries/emails.js";
import type { SendEmailArgs } from "../src/core/email/postmarkOutbound.js";

const mocks = vi.hoisted(() => ({
  claimOutboundRetry: vi.fn(),
  insertOutboundEmail: vi.fn(),
  setOutboundMessageId: vi.fn(),
  updateOutboundDeliveryStatus: vi.fn(),
  emitEvent: vi.fn(),
  boundedFetch: vi.fn(),
  storeEmailAttachments: vi.fn(),
}));

vi.mock("../src/core/db/queries/emails.js", () => ({
  claimOutboundRetry: mocks.claimOutboundRetry,
  insertOutboundEmail: mocks.insertOutboundEmail,
  setOutboundMessageId: mocks.setOutboundMessageId,
  updateOutboundDeliveryStatus: mocks.updateOutboundDeliveryStatus,
}));
vi.mock("../src/core/db/queries/emailAttachments.js", () => ({
  storeEmailAttachments: mocks.storeEmailAttachments,
}));
vi.mock("../src/core/db/pool.js", () => ({ pool: {} }));
vi.mock("../src/core/db/queryable.js", () => ({
  inTransaction: vi.fn(async (
    _pool: unknown, work: (db: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>,
  ) => work({ query: vi.fn() })),
}));
vi.mock("../src/core/events/emitter.js", () => ({ emitEvent: mocks.emitEvent }));
vi.mock("../src/core/security/outboundHttp.js", () => ({ boundedFetch: mocks.boundedFetch }));

import { sendEmail } from "../src/core/email/postmarkOutbound.js";
import { OutboundSendRefusedError } from "../src/core/email/postmarkOutcome.js";

const baseArgs: SendEmailArgs = {
  serviceId: "service-1",
  transactionId: "transaction-1",
  inboundId: "inbound-1",
  customerId: "customer-1",
  to: "buyer@example.com",
  subject: "Initial reply",
  bodyText: "First generated response",
  sentBy: "email_agent",
  fromAddress: "support@example.com",
  idempotencyKey: "reply-to-inbound-1",
};

function outboundRow(overrides: Partial<OutboundEmailRow> = {}): OutboundEmailRow {
  return {
    id: "outbound-1",
    message_id: null,
    from_address: baseArgs.fromAddress,
    to_address: baseArgs.to,
    subject: baseArgs.subject,
    body_text: baseArgs.bodyText,
    body_html: null,
    in_reply_to: null,
    thread_root: null,
    reply_to: null,
    customer_id: baseArgs.customerId ?? null,
    service_id: baseArgs.serviceId ?? null,
    transaction_id: baseArgs.transactionId ?? null,
    inbound_id: baseArgs.inboundId ?? null,
    sent_by: baseArgs.sentBy,
    sent_at: new Date("2026-07-10T00:00:00Z"),
    delivery_status: "send_pending",
    delivery_payload: null,
    ...overrides,
  };
}

function response(status: number, body: unknown) {
  const text = JSON.stringify(body);
  return {
    status,
    statusText: status === 200 ? "OK" : "Error",
    ok: status >= 200 && status < 300,
    headers: new Headers({ "content-type": "application/json" }),
    body: Buffer.from(text),
    text: () => text,
    json: () => body,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.emitEvent.mockResolvedValue(undefined);
  mocks.setOutboundMessageId.mockResolvedValue(undefined);
  mocks.updateOutboundDeliveryStatus.mockResolvedValue(undefined);
  mocks.storeEmailAttachments.mockResolvedValue([]);
});

describe("Postmark outbound replay safety", () => {
  it("deduplicates the same logical send when regenerated body content changes", async () => {
    const stored = outboundRow();
    mocks.insertOutboundEmail.mockImplementation(async () => {
      if (!stored.message_id) return { row: stored, inserted: true };
      return { row: stored, inserted: false };
    });
    mocks.setOutboundMessageId.mockImplementation(async (_id: string, messageId: string) => {
      stored.message_id = messageId;
    });
    mocks.boundedFetch.mockResolvedValue(response(200, { MessageID: "postmark-message-1" }));

    await sendEmail(baseArgs);
    const replay = await sendEmail({
      ...baseArgs,
      subject: "A newly generated subject",
      bodyText: "A materially different model response",
      bodyHtml: "<p>A materially different model response</p>",
    });

    const firstInsert = mocks.insertOutboundEmail.mock.calls[0][0];
    const replayInsert = mocks.insertOutboundEmail.mock.calls[1][0];
    expect(firstInsert.idempotency_key).toMatch(/^[0-9a-f]{64}$/);
    expect(replayInsert.idempotency_key).toBe(firstInsert.idempotency_key);
    expect(replayInsert.body_text).not.toBe(firstInsert.body_text);
    expect(mocks.boundedFetch).toHaveBeenCalledTimes(1);
    expect(replay.message_id).toBe("postmark-message-1");
  });

  it("marks a network failure outcome_unknown and refuses an automatic logical retry", async () => {
    const stored = outboundRow();
    let inserted = true;
    mocks.insertOutboundEmail.mockImplementation(async () => {
      const result = { row: stored, inserted };
      inserted = false;
      return result;
    });
    mocks.updateOutboundDeliveryStatus.mockImplementation(async (args: { status: string }) => {
      stored.delivery_status = args.status;
    });
    mocks.boundedFetch.mockRejectedValue(new Error("socket closed after request upload"));

    await expect(sendEmail(baseArgs)).rejects.toThrow("socket closed after request upload");
    expect(mocks.updateOutboundDeliveryStatus).toHaveBeenCalledWith({
      id: stored.id,
      status: "outcome_unknown",
    });
    expect(mocks.emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "email.outcome_unknown",
      mandatory: true,
      payload: { outboundId: stored.id },
    }));

    await expect(sendEmail({ ...baseArgs, bodyText: "Regenerated retry body" }))
      .rejects.toThrow("automatic resend refused");
    expect(mocks.boundedFetch).toHaveBeenCalledTimes(1);
  });

  it("treats a 2xx response without MessageID as outcome_unknown", async () => {
    const stored = outboundRow();
    mocks.insertOutboundEmail.mockResolvedValue({ row: stored, inserted: true });
    mocks.boundedFetch.mockResolvedValue(response(200, { ErrorCode: 0, Message: "OK" }));

    await expect(sendEmail(baseArgs)).rejects.toThrow(
      "Postmark returned success without MessageID; outcome is unknown",
    );
    expect(mocks.setOutboundMessageId).not.toHaveBeenCalled();
    expect(mocks.updateOutboundDeliveryStatus).toHaveBeenCalledWith({
      id: stored.id,
      status: "outcome_unknown",
    });
    expect(mocks.emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "email.outcome_unknown",
      mandatory: true,
      payload: { outboundId: stored.id, status: 200 },
    }));
  });
});

describe("the last-moment refusal hook", () => {
  const refusal = () => new OutboundSendRefusedError("the delivery admission was revoked");

  it("runs after the journal write and before the outbound call", async () => {
    const order: string[] = [];
    mocks.insertOutboundEmail.mockImplementation(async () => {
      order.push("journal");
      return { row: outboundRow(), inserted: true };
    });
    mocks.boundedFetch.mockImplementation(async () => {
      order.push("postmark");
      return response(200, { MessageID: "postmark-message-2" });
    });
    await sendEmail(baseArgs, { beforeSend: async () => { order.push("check"); } });
    expect(order).toEqual(["journal", "check", "postmark"]);
  });

  it("records an explicit refusal as a terminal skip and never calls Postmark, even on replay", async () => {
    const stored = outboundRow();
    mocks.insertOutboundEmail.mockResolvedValue({ row: stored, inserted: true });
    await expect(sendEmail(baseArgs, { beforeSend: async () => { throw refusal(); } }))
      .rejects.toMatchObject({ name: "OutboundEmailError", outcome: "skipped" });
    expect(mocks.boundedFetch).not.toHaveBeenCalled();
    expect(mocks.updateOutboundDeliveryStatus).toHaveBeenCalledWith({
      id: stored.id, status: "send_skipped", payload: { reason: "the delivery admission was revoked" },
    });
    expect(mocks.emitEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "email.skipped", mandatory: true }));
    mocks.insertOutboundEmail.mockResolvedValue({
      row: outboundRow({ delivery_status: "send_skipped" }), inserted: false,
    });
    let checked = 0;
    await expect(sendEmail(baseArgs, { beforeSend: async () => { checked += 1; } }))
      .rejects.toMatchObject({ outcome: "skipped" });
    expect(checked).toBe(0);
    expect(mocks.boundedFetch).not.toHaveBeenCalled();
  });

  it("keeps an infrastructure failure of the hook retryable, and the cooled-down retry validates again", async () => {
    mocks.insertOutboundEmail.mockResolvedValue({ row: outboundRow(), inserted: true });
    const outage = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    await expect(sendEmail(baseArgs, { beforeSend: async () => { throw outage; } }))
      .rejects.toMatchObject({ name: "OutboundEmailError", outcome: "retryable" });
    expect(mocks.boundedFetch).not.toHaveBeenCalled();
    const recorded = mocks.updateOutboundDeliveryStatus.mock.calls.at(-1)![0] as {
      status: string; payload: { requestFingerprint: string; retryAfter: number; errorClass: string };
    };
    expect(recorded.status).toBe("send_retryable");
    expect(recorded.payload.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(recorded.payload.retryAfter).toBeGreaterThan(Date.now());
    // Only the error class is recorded, never the message.
    expect(recorded.payload.errorClass).toBe("Error");
    expect(mocks.emitEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "email.send_deferred" }));

    const retryable = outboundRow({ delivery_status: "send_retryable", delivery_payload: recorded.payload });
    mocks.insertOutboundEmail.mockResolvedValue({ row: retryable, inserted: false });
    mocks.claimOutboundRetry.mockResolvedValueOnce(false);
    await expect(sendEmail(baseArgs, { beforeSend: async () => undefined }))
      .rejects.toMatchObject({ outcome: "retryable" });
    expect(mocks.boundedFetch).not.toHaveBeenCalled();
    mocks.claimOutboundRetry.mockResolvedValueOnce(true);
    mocks.boundedFetch.mockResolvedValue(response(200, { MessageID: "postmark-message-3" }));
    let checked = 0;
    const sent = await sendEmail(baseArgs, { beforeSend: async () => { checked += 1; } });
    expect(checked).toBe(1);
    expect(mocks.claimOutboundRetry).toHaveBeenLastCalledWith(retryable.id);
    expect(sent.message_id).toBe("postmark-message-3");
    // A retry whose request changed is refused for review, never resent.
    await expect(sendEmail({ ...baseArgs, subject: "A different subject" }, { beforeSend: async () => undefined }))
      .rejects.toMatchObject({ outcome: "unknown" });
    expect(mocks.boundedFetch).toHaveBeenCalledTimes(1);
  });
});
