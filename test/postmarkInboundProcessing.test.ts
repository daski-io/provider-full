import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  emitEvent: vi.fn(),
  enqueueEmailIngress: vi.fn(),
  findInboundInterceptor: vi.fn(),
  getServiceByInboundEmail: vi.fn(),
  insertInboundEmail: vi.fn(),
  parsePostmarkAttachments: vi.fn(),
  requeueFailedEmailIngress: vi.fn(),
  shouldAutoFilter: vi.fn(),
  storeEmailAttachments: vi.fn(),
  updateInboundEmailClassification: vi.fn(),
  updateInboundProcessing: vi.fn(),
}));

vi.mock("../src/core/db/queries/emails.js", () => ({
  insertInboundEmail: mocks.insertInboundEmail,
  updateInboundEmailClassification: mocks.updateInboundEmailClassification,
  updateInboundProcessing: mocks.updateInboundProcessing,
}));
vi.mock("../src/core/db/queries/emailAttachments.js", () => ({
  storeEmailAttachments: mocks.storeEmailAttachments,
}));
vi.mock("../src/core/db/pool.js", () => ({
  pool: {},
}));
vi.mock("../src/core/db/queryable.js", () => ({
  inTransaction: vi.fn(async (
    _pool: unknown,
    work: (db: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>,
  ) => work({ query: vi.fn() })),
}));
vi.mock("../src/core/db/queries/services.js", () => ({
  getServiceByInboundEmail: mocks.getServiceByInboundEmail,
}));
vi.mock("../src/core/events/emitter.js", () => ({
  emitEvent: mocks.emitEvent,
}));
vi.mock("../src/core/email/preFilter.js", () => ({
  shouldAutoFilter: mocks.shouldAutoFilter,
}));
vi.mock("../src/core/email/postmarkIngressQueue.js", () => ({
  enqueueEmailIngress: mocks.enqueueEmailIngress,
  requeueFailedEmailIngress: mocks.requeueFailedEmailIngress,
}));
vi.mock("../src/core/email/postmarkRouting.js", () => ({
  findInboundInterceptor: mocks.findInboundInterceptor,
}));
vi.mock("../src/core/email/postmarkAttachments.js", () => ({
  parsePostmarkAttachments: mocks.parsePostmarkAttachments,
}));

import { processPostmarkInbound } from "../src/core/email/postmarkInboundProcessing.js";

const passingHeaders = [
  { Name: "Received-SPF", Value: "pass (sender authorized)" },
  {
    Name: "X-Spam-Tests",
    Value: "DKIM_SIGNED,DKIM_VALID,DKIM_VALID_AU,SPF_PASS",
  },
  { Name: "X-Spam-Status", Value: "No" },
  { Name: "X-Spam-Score", Value: "0" },
];

function payload(Headers: Array<{ Name: string; Value: string }>) {
  return {
    MessageID: "postmark-message-1",
    From: "case@vendor.example",
    To: "intake@example.com",
    Subject: "Documents",
    TextBody: "Please provide documents.",
    Headers,
    Attachments: { deliberately: "malformed" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findInboundInterceptor.mockResolvedValue({
    failed: false,
    interceptor: null,
  });
  mocks.getServiceByInboundEmail.mockResolvedValue({
    id: "service-1",
    slug: "sample-service",
  });
  mocks.shouldAutoFilter.mockResolvedValue({ filter: false, reason: null });
  mocks.insertInboundEmail.mockImplementation(
    async (args: Record<string, unknown>) => ({
      row: { id: "inbound-1", ...args },
      inserted: true,
    }),
  );
  mocks.parsePostmarkAttachments.mockReturnValue({
    ok: true,
    attachments: [{
      filename: "document.pdf",
      contentType: "application/pdf",
      content: Buffer.from("%PDF-1.7", "utf8"),
      quarantineReason: null,
    }],
  });
});

describe("Postmark inbound attachment admission", () => {
  it("does not parse or store attachments from an unauthenticated sender", async () => {
    const result = await processPostmarkInbound(payload([]));

    expect(result.status).toBe(200);
    expect(mocks.parsePostmarkAttachments).not.toHaveBeenCalled();
    expect(mocks.storeEmailAttachments).not.toHaveBeenCalled();
    expect(mocks.insertInboundEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        postmark_sender_authenticated: false,
        postmark_spam_safe: false,
      }),
      expect.anything(),
    );
  });

  it("parses and stores attachments only after passing routed-mail verdicts", async () => {
    const result = await processPostmarkInbound(payload(passingHeaders));

    expect(result.status).toBe(200);
    expect(mocks.parsePostmarkAttachments).toHaveBeenCalledOnce();
    expect(mocks.storeEmailAttachments).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "inbound",
        emailId: "inbound-1",
      }),
    );
    expect(mocks.insertInboundEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        postmark_sender_authenticated: true,
        postmark_spam_safe: true,
      }),
      expect.anything(),
    );
  });
});
