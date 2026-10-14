import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeAdapter: vi.fn(),
  processAdapterResult: vi.fn(),
  completeAssetAction: vi.fn(),
  markAssetActionAttention: vi.fn(),
  consultPreExecuteAgent: vi.fn(),
  applyPreExecuteDecision: vi.fn(),
  loadAdmittedAssetTarget: vi.fn(),
}));

vi.mock("../src/core/engine/adapterExecution.js", () => ({
  executeAdapter: mocks.executeAdapter,
}));
vi.mock("../src/core/engine/taskFinalization.js", () => ({
  processAdapterResult: mocks.processAdapterResult,
}));
vi.mock("../src/core/standardRail/actionCompletion.js", () => ({
  completeAssetAction: mocks.completeAssetAction,
  markAssetActionAttention: mocks.markAssetActionAttention,
  settleAssetAction: vi.fn(),
}));
vi.mock("../src/core/standardRail/assetActionTarget.js", () => ({
  AssetActionTargetDeniedError: class extends Error {},
  loadAdmittedAssetTarget: mocks.loadAdmittedAssetTarget,
}));
vi.mock("../src/core/standardRail/assetOwnerOutcome.js", () => ({
  recordStaleOwnerExecution: vi.fn(),
}));
vi.mock("../src/core/a2a/responseBuilder.js", () => ({
  revealStandardActionArtifacts: vi.fn(),
}));
vi.mock("../src/core/engine/preExecuteRunner.js", () => ({
  consultPreExecuteAgent: mocks.consultPreExecuteAgent,
  applyPreExecuteDecision: mocks.applyPreExecuteDecision,
}));

import { executeAssetAction } from "../src/core/standardRail/actionExecution.js";

describe("asset-action pre-execution denial", () => {
  beforeEach(() => vi.clearAllMocks());

  it("closes a terminal reject as failed without dispatching supplier work", async () => {
    mocks.loadAdmittedAssetTarget.mockResolvedValue({ id: "asset-1" });
    mocks.consultPreExecuteAgent.mockResolvedValue({ action: "reject", reason: "policy" });
    mocks.applyPreExecuteDecision.mockResolvedValue({ terminal: true });
    mocks.completeAssetAction.mockResolvedValue(undefined);

    await expect(executeAssetAction({
      definition: {}, executionId: `0x${"11".repeat(32)}`, taskId: "task-1",
      service: {}, skill: {}, input: {}, persistResult: false,
      target: { assetId: "asset-1", admitted: { payer: `0x${"aa".repeat(20)}`, version: 0 } },
    } as never)).resolves.toEqual({
      status: "failed", result: null, errorClass: "review_rejected",
    });
    expect(mocks.completeAssetAction).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed", errorClass: "review_rejected",
    }));
    // The review saw the admitted owner's current asset; nothing ran after it.
    expect(mocks.loadAdmittedAssetTarget).toHaveBeenCalledTimes(1);
    expect(mocks.executeAdapter).not.toHaveBeenCalled();
    expect(mocks.markAssetActionAttention).not.toHaveBeenCalled();
  });
});
