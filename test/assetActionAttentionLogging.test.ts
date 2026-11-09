import { beforeEach, describe, expect, it, vi } from "vitest";

// An asset action that fails unexpectedly after its claim is parked in
// attention. The catch-all logs the error class and a bounded message first,
// never the request input, the adapter result or the payer, and reports a
// failed attention transition instead of swallowing it.

const mocks = vi.hoisted(() => ({
  executeAdapter: vi.fn(),
  processAdapterResult: vi.fn(),
  completeAssetAction: vi.fn(),
  settleAssetAction: vi.fn(),
  markAssetActionAttention: vi.fn(),
  loadAdmittedAssetTarget: vi.fn(),
  revealStandardActionArtifacts: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../src/core/engine/adapterExecution.js", () => ({ executeAdapter: mocks.executeAdapter }));
vi.mock("../src/core/engine/taskFinalization.js", () => ({ processAdapterResult: mocks.processAdapterResult }));
vi.mock("../src/core/standardRail/actionCompletion.js", () => ({
  completeAssetAction: mocks.completeAssetAction,
  markAssetActionAttention: mocks.markAssetActionAttention,
  settleAssetAction: mocks.settleAssetAction,
}));
vi.mock("../src/core/standardRail/assetActionTarget.js", () => ({
  AssetActionTargetDeniedError: class extends Error {},
  loadAdmittedAssetTarget: mocks.loadAdmittedAssetTarget,
}));
vi.mock("../src/core/standardRail/assetOwnerOutcome.js", () => ({ recordStaleOwnerExecution: vi.fn() }));
vi.mock("../src/core/a2a/responseBuilder.js", () => ({
  revealStandardActionArtifacts: mocks.revealStandardActionArtifacts,
}));
vi.mock("../src/core/engine/preExecuteRunner.js", () => ({
  consultPreExecuteAgent: vi.fn(),
  applyPreExecuteDecision: vi.fn(),
}));
vi.mock("../src/core/logger.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/core/logger.js")>(),
  logError: mocks.logError,
}));

import { executeAssetAction } from "../src/core/standardRail/actionExecution.js";
import { errorClassExtra } from "../src/core/logger.js";

const PAYER = "0x1111111111111111111111111111111111111111";
const SECRET_INPUT = { note: "buyer-secret-note", detail: "private-value-123" };
const EXECUTION_ID = `0x${"22".repeat(32)}`;
const args = {
  definition: { replayPolicy: "stable-result", actionId: "peek-note", serviceSlug: "example-notes" },
  executionId: EXECUTION_ID,
  taskId: "asset-action-task",
  service: { id: "svc" },
  skill: {},
  input: SECRET_INPUT,
  target: { assetId: "asset-1", admitted: { payer: PAYER, version: 0 } },
  persistResult: true,
  safetyReviewed: true,
} as never;

function completedAdapter(): void {
  mocks.executeAdapter.mockResolvedValue({
    status: "completed",
    artifacts: [{ name: "note", data: { body: "private-value-123" } }],
  });
}

describe("asset-action catch-all observability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadAdmittedAssetTarget.mockResolvedValue({ id: "asset-1" });
    completedAdapter();
    mocks.markAssetActionAttention.mockResolvedValue(undefined);
  });

  it("logs the error class and message, without request or result values, before parking", async () => {
    mocks.revealStandardActionArtifacts.mockRejectedValue(new Error("canonical JSON must not contain undefined values"));

    await expect(executeAssetAction(args)).resolves.toEqual({ status: "attention", result: null, errorClass: null });

    expect(mocks.logError).toHaveBeenCalledTimes(1);
    const [message, extra] = mocks.logError.mock.calls[0]!;
    expect(message).toBe("Asset action parked in attention after an unexpected error");
    expect(extra).toEqual({
      errorClass: "Error",
      error: "canonical JSON must not contain undefined values",
      actionId: "peek-note",
      serviceSlug: "example-notes",
      taskId: "asset-action-task",
    });
    const logged = JSON.stringify(mocks.logError.mock.calls);
    expect(logged).not.toContain("private-value-123");
    expect(logged).not.toContain("buyer-secret-note");
    expect(logged).not.toContain(PAYER);
    expect(mocks.markAssetActionAttention).toHaveBeenCalledWith(EXECUTION_ID);
    expect(mocks.logError.mock.invocationCallOrder[0]!)
      .toBeLessThan(mocks.markAssetActionAttention.mock.invocationCallOrder[0]!);
  });

  it("also reports a failed attention transition instead of swallowing it", async () => {
    mocks.revealStandardActionArtifacts.mockRejectedValue(new TypeError("boom"));
    mocks.markAssetActionAttention.mockRejectedValue(new Error("asset action attention transition lost its claim"));

    await expect(executeAssetAction(args)).resolves.toMatchObject({ status: "attention" });

    expect(mocks.logError).toHaveBeenCalledTimes(2);
    expect(mocks.logError.mock.calls[0]![1]).toMatchObject({ errorClass: "TypeError", error: "boom" });
    expect(mocks.logError.mock.calls[1]).toEqual([
      "Asset action attention transition failed",
      {
        errorClass: "Error",
        error: "asset action attention transition lost its claim",
        actionId: "peek-note",
        taskId: "asset-action-task",
      },
    ]);
  });
});

describe("asset-action catch-all robustness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadAdmittedAssetTarget.mockResolvedValue({ id: "asset-1" });
    completedAdapter();
    mocks.markAssetActionAttention.mockResolvedValue(undefined);
  });

  it("parks the row even when the thrown error has a non-string message", async () => {
    const odd = new Error("placeholder");
    Object.defineProperty(odd, "message", { value: { not: "a string" } });
    mocks.revealStandardActionArtifacts.mockRejectedValue(odd);

    await expect(executeAssetAction(args)).resolves.toMatchObject({ status: "attention" });

    expect(mocks.markAssetActionAttention).toHaveBeenCalledWith(EXECUTION_ID);
    expect(mocks.logError.mock.calls[0]![1]).toMatchObject({ errorClass: "Error", error: "[object Object]" });
  });

  it("parks the row even when logging itself throws", async () => {
    mocks.revealStandardActionArtifacts.mockRejectedValue(new Error("canonical JSON must not contain undefined values"));
    mocks.logError.mockImplementationOnce(() => { throw new Error("log sink down"); });

    await expect(executeAssetAction(args)).resolves.toMatchObject({ status: "attention" });

    expect(mocks.markAssetActionAttention).toHaveBeenCalledWith(EXECUTION_ID);
  });
});

describe("errorClassExtra", () => {
  it("names custom classes, bounds the message and never includes a stack", () => {
    class SupplierBoom extends Error {}
    const extra = errorClassExtra(new SupplierBoom("x".repeat(500)));
    expect(extra.errorClass).toBe("SupplierBoom");
    expect(extra.error).toHaveLength(300);
    expect(Object.keys(extra)).toEqual(["errorClass", "error"]);
    expect(errorClassExtra("raw string")).toEqual({ errorClass: "string", error: "non-error value thrown" });
  });

  it("never throws for an error with a hostile message or name", () => {
    const missing = new Error("x");
    Object.defineProperty(missing, "message", { value: undefined });
    expect(errorClassExtra(missing)).toEqual({ errorClass: "Error", error: "" });
    const hostile = new Error("x");
    Object.defineProperty(hostile, "message", { get() { throw new Error("getter"); } });
    expect(errorClassExtra(hostile)).toEqual({ errorClass: "unknown", error: "error could not be described" });
  });
});
