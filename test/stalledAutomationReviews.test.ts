import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  createHumanEscalation: vi.fn(),
  closeEscalation: vi.fn(),
}));

vi.mock("../src/core/db/pool.js", () => ({ pool: {} }));
vi.mock("../src/core/db/queryable.js", () => ({
  inTransaction: vi.fn(async (_pool, work) => work({ query: h.query })),
}));
vi.mock("../src/core/engine/escalation.js", () => ({
  createHumanEscalation: h.createHumanEscalation,
}));
vi.mock("../src/core/db/queries/escalations.js", () => ({
  closeEscalation: h.closeEscalation,
}));

import {
  reconcileStalledAutomationReviews,
  STALLED_AUTOMATION_REVIEW_KIND,
} from "../src/core/operations/stalledAutomationReviews.js";

const stoppedAt = new Date("2026-08-22T12:00:00Z");
const createdAt = new Date("2026-08-21T12:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  h.createHumanEscalation.mockResolvedValue({});
  h.closeEscalation.mockResolvedValue({ id: "review-completed" });
  h.query.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT e.id,j.status")) {
      return {
        rows: [{ id: "review-completed", status: "completed" }],
        rowCount: 1,
      };
    }
    if (sql.includes("SELECT id,queue,attempts")) {
      return {
        rows: [{
          id: "job-1",
          queue: "fulfillment-sync",
          attempts: 12,
          max_attempts: 12,
          last_error: "supplier unavailable",
          created_at: createdAt,
          updated_at: stoppedAt,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("UPDATE durable_jobs SET dead_letter_surfaced_at")) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
});

describe("stalled automation Reviews", () => {
  it("surfaces an exact retry decision and closes a job that already recovered", async () => {
    await expect(reconcileStalledAutomationReviews()).resolves.toEqual({
      opened: 1,
      closed: 1,
    });

    expect(h.closeEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "review-completed",
        response: "The automation completed successfully.",
      }),
      expect.objectContaining({ query: h.query }),
    );
    expect(h.createHumanEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "auto",
        question: "fulfillment sync stopped and needs a retry decision.",
        review: expect.objectContaining({
          kind: STALLED_AUTOMATION_REVIEW_KIND,
          severity: "critical",
          target: { type: "durable_job", id: "job-1" },
          evidence: expect.objectContaining({
            jobId: "job-1",
            queue: "fulfillment-sync",
            attempts: 12,
          }),
        }),
        suggestedActions: [
          expect.objectContaining({ label: "Retry automation" }),
        ],
      }),
      expect.objectContaining({ query: h.query }),
    );
    const review = h.createHumanEscalation.mock.calls[0]![0];
    expect(JSON.parse(review.suggestedActions[0].value)).toEqual({
      tool: "retry_stalled_automation",
      arguments: { job_id: "job-1" },
    });
    expect(review.review.evidence).not.toHaveProperty("lastError");
  });

  it("excludes queues that already surface their bound Review directly", async () => {
    await reconcileStalledAutomationReviews(10);
    const stalledQuery = h.query.mock.calls.find((call) =>
      String(call[0]).includes("SELECT id,queue,attempts")
    );
    expect(stalledQuery?.[1]).toEqual([
      ["operator-escalation", "escalation-resolution"],
      10,
    ]);
  });
});
