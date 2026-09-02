import { describe, expect, it } from "vitest";
import { isOpenFreeA2aRequest } from "../src/core/security/openA2aBoundary.js";

const EXT = "https://daski.io/a2a/v1";

function request(metadata: Record<string, unknown>) {
  return {
    method: "SendMessage",
    params: {
      message: {
        metadata: { [EXT]: metadata },
      },
    },
  };
}

describe("open A2A request boundary", () => {
  it("identifies anonymous open skill submissions", () => {
    expect(isOpenFreeA2aRequest(request({ skillId: "get-pricing" }))).toBe(true);
  });

  it("cannot be bypassed by adding payment metadata to a free submission", () => {
    expect(isOpenFreeA2aRequest(request({
      skillId: "create-item",
      serviceRef: "0x01",
    }))).toBe(false);
    expect(isOpenFreeA2aRequest(request({
      skillId: "get-item",
      paymentId: "42",
    }))).toBe(true);
    expect(isOpenFreeA2aRequest(request({ taskId: "task-1" }))).toBe(false);
  });
});
