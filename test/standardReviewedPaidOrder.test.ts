import { beforeEach, describe, expect, it, vi } from "vitest";

// A funded order admitted while sales were paused can still be escalated to
// human review; its reviewed resolution must not depend on sales being open.
const h = vi.hoisted(() => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
  processAdapterResult: vi.fn(),
  finalizeResolution: vi.fn(async () => true),
  service: { is_active: false } as Record<string, unknown>,
  skill: { is_active: false } as Record<string, unknown>,
}));
vi.mock("../src/core/db/pool.js", () => ({ pool: { query: h.query } }));
vi.mock("../src/core/db/queries/transactions.js", () => ({
  getTransactionById: async () => ({
    id: "task-1", status: "working", service_id: "svc-1", skill_id: "skill-1", metadata: {},
    standard_order_id: "ord_1", version: "2",
  }),
}));
vi.mock("../src/core/db/queries/services.js", () => ({ getServiceById: async () => h.service }));
vi.mock("../src/core/db/queries/skills.js", () => ({ getSkillByServiceAndSkillId: async () => h.skill }));
vi.mock("../src/core/db/queries/assets.js", () => ({ getAssetById: async () => null }));
vi.mock("../src/core/engine/taskFinalization.js", () => ({ processAdapterResult: h.processAdapterResult }));
vi.mock("../src/core/engine/escalationResolutionStore.js", () => ({
  finalizeResolution: h.finalizeResolution,
  getPreExecuteResolution: vi.fn(),
  markResolutionAttention: vi.fn(),
  saveResolutionAdapterResult: vi.fn(),
}));
vi.mock("../src/core/engine/adapterExecution.js", () => ({ executeAdapter: vi.fn() }));
vi.mock("../src/core/engine/taskTransitions.js", () => ({ claimSupplierMutation: vi.fn() }));

const { resolveReviewedPaidOrder } = await import("../src/core/standardRail/reviewResolutionExecution.js");

const updatedAt = new Date("2026-10-01T00:00:00Z");
const snapshot = {
  version: 1 as const, createdAt: updatedAt.toISOString(), transactionId: "task-1", customerId: null,
  requestHash: "0x", requestData: {},
  service: { id: "svc-1", slug: "fixture", version: "1", adapterName: "fixture", configRevision: "7" },
  skill: { id: "skill-row", serviceId: "svc-1", skillId: "skill-1", requiredFields: [], optionalFields: [], updatedAt: updatedAt.toISOString() },
  asset: null,
};

beforeEach(() => {
  h.processAdapterResult.mockResolvedValue({ id: "task-1", status: "failed", standard_order_id: "ord_1" });
  h.service = {
    id: "svc-1", slug: "fixture", version: "1", adapter_name: "fixture", config_revision: "7", is_active: false,
  };
  h.skill = { id: "skill-row", updated_at: updatedAt, is_active: false };
});

describe("reviewed resolution of a funded order", () => {
  it("resolves while sales are paused", async () => {
    await expect(resolveReviewedPaidOrder({
      row: { id: "review-1", status: "resolution_executing", reviewer_decision: "rejected", transaction_id: "task-1" } as never,
      snapshot: snapshot as never,
      input: {},
      startedHere: true,
    })).resolves.toBeUndefined();
    expect(h.processAdapterResult).toHaveBeenCalledWith("task-1", expect.objectContaining({ status: "failed" }), "svc-1");
    expect(h.finalizeResolution).toHaveBeenCalledWith("review-1", "rejected");
  });

  it("still refuses when the executed configuration changed after the snapshot", async () => {
    h.service = { ...h.service, config_revision: "8" };
    await expect(resolveReviewedPaidOrder({
      row: { id: "review-1", status: "resolution_executing", reviewer_decision: "rejected", transaction_id: "task-1" } as never,
      snapshot: snapshot as never,
      input: {},
      startedHere: true,
    })).rejects.toThrow("reviewed execution context changed");
  });
});
