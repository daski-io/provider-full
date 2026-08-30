import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboundEmailRow } from "../src/core/db/queries/emails.js";
import type { SendEmailArgs } from "../src/core/email/postmarkOutbound.js";

const mocks = vi.hoisted(() => ({
  insertOutboundEmail: vi.fn(),
  setOutboundMessageId: vi.fn(),
  updateOutboundDeliveryStatus: vi.fn(),
  emitEvent: vi.fn(),
  boundedFetch: vi.fn(),
  storeEmailAttachments: vi.fn(),
}));

vi.mock("../src/core/db/queries/emails.js", () => ({
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
