import { beforeEach, describe, expect, it, vi } from "vitest";

// The stuck read-only action sweep is optional housekeeping inside the
// auth-cleanup run. A failure of its candidate query must be logged and
// reported, never fail the run: a failed run marks the auth-cleanup worker
// failed, which takes the provider out of readiness.

const mocks = vi.hoisted(() => ({
  sweep: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../src/core/db/queries/sessions.js", () => ({ purgeExpiredSessions: vi.fn(async () => 2) }));
vi.mock("../src/core/db/queries/authSecurity.js", () => ({
  purgeExpiredAuthState: vi.fn(async () => ({ siweNonces: 1, rateBuckets: 0, confirmationIntents: 0 })),
}));
vi.mock("../src/core/db/queries/confirmationIntents.js", () => ({
  classifyStaleConfirmationExecutions: vi.fn(async () => 0),
}));
vi.mock("../src/core/standardRail/actionCompletion.js", () => ({
  expireDestructiveAssetActions: vi.fn(async () => ({ expired: 0, attention: 0 })),
}));
vi.mock("../src/core/standardRail/actionAttentionSweep.js", () => ({ failStuckReadAssetActions: mocks.sweep }));
vi.mock("../src/core/logger.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/core/logger.js")>(),
  logError: mocks.logError,
}));

import { runAuthSecurityCleanup } from "../src/core/auth/securityMaintenance.js";

describe("auth security cleanup with the stuck read-only action sweep", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports the sweep's count when it succeeds", async () => {
    mocks.sweep.mockResolvedValue(3);
    await expect(runAuthSecurityCleanup()).resolves.toMatchObject({ sessions: 2, stuckReadActionsFailed: 3 });
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it("completes the run when the sweep's candidate query fails", async () => {
    mocks.sweep.mockRejectedValue(new Error("canceling statement due to statement timeout"));

    await expect(runAuthSecurityCleanup()).resolves.toMatchObject({
      sessions: 2,
      siweNonces: 1,
      stuckReadActionsFailed: -1,
    });
    expect(mocks.logError).toHaveBeenCalledWith("Stuck read-only asset action sweep failed", {
      errorClass: "Error",
      error: "canceling statement due to statement timeout",
    });
  });
});
