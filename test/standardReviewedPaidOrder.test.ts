import { beforeEach, describe, expect, it, vi } from "vitest";

// A funded order admitted while sales were paused can still be escalated to
// human review; its reviewed resolution must not depend on sales being open.
const h = vi.hoisted(() => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
  processAdapterResult: vi.fn(),
  finalizeResolution: vi.fn(async () => true),
  readmit: vi.fn(async () => null),
  getPreExecuteResolution: vi.fn(),
  saveResolutionAdapterResult: vi.fn(),
  executeAdapter: vi.fn(),
  claimSupplierMutation: vi.fn(),
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
  getPreExecuteResolution: h.getPreExecuteResolution,
  markResolutionAttention: vi.fn(),
  saveResolutionAdapterResult: h.saveResolutionAdapterResult,
}));
vi.mock("../src/core/engine/adapterExecution.js", () => ({ executeAdapter: h.executeAdapter }));
vi.mock("../src/core/engine/taskTransitions.js", () => ({ claimSupplierMutation: h.claimSupplierMutation }));
vi.mock("../src/core/standardRail/assetOwnerAdmission.js", () => ({ readmitPaidTaskOwner: h.readmit }));

const { resolveReviewedPaidOrder } = await import("../src/core/standardRail/reviewResolutionExecution.js");
const { AssetOwnerChangedError } = await import("../src/core/standardRail/assetOwnerFence.js");

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

describe("a reviewed owner-only order whose asset changed owner (F-T08)", () => {
  it("records the withheld failure without supplier work and finalizes the review", async () => {
    h.service = { ...h.service, is_active: true };
    h.readmit.mockRejectedValueOnce(new AssetOwnerChangedError("the wallet is not the asset's current owner"));
    const executing = {
      id: "review-1", status: "resolution_executing", reviewer_decision: "approved", transaction_id: "task-1",
      snapshot_service_id: "svc-1", source: "pre_execute",
    };
    let sealed: { encrypted: string; hash: string } | undefined;
    h.saveResolutionAdapterResult.mockImplementationOnce(async (_id: string, encrypted: string, hash: string) => {
      sealed = { encrypted, hash };
      return true;
    });
    h.getPreExecuteResolution
      .mockResolvedValueOnce(executing)
      .mockImplementationOnce(async () => ({
        ...executing, status: "resolution_result_ready",
        adapter_result_encrypted: sealed!.encrypted, adapter_result_hash: sealed!.hash,
      }));
    await expect(resolveReviewedPaidOrder({
      row: executing as never, snapshot: snapshot as never, input: {}, startedHere: true,
    })).resolves.toBeUndefined();
    expect(h.executeAdapter).not.toHaveBeenCalled();
    expect(h.claimSupplierMutation).not.toHaveBeenCalled();
    expect(h.processAdapterResult).toHaveBeenCalledWith(
      "task-1", expect.objectContaining({ status: "failed", error: "asset_owner_changed" }), "svc-1",
    );
    expect(h.finalizeResolution).toHaveBeenCalledWith("review-1", "approved");
    // The outcome is sealed into the review first: finalizing an approved
    // review requires its recorded result.
    expect(h.saveResolutionAdapterResult).toHaveBeenCalledWith("review-1", expect.any(String), expect.any(String));
    expect(h.saveResolutionAdapterResult.mock.invocationCallOrder[0])
      .toBeLessThan(h.finalizeResolution.mock.invocationCallOrder.at(-1)!);
  });
});
