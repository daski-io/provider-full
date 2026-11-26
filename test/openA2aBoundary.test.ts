import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import {
  applyOnlyToOpenFreeRequests,
  isOpenFreeA2aRequest,
} from "../src/core/security/openA2aBoundary.js";

const EXT = "https://daski.io/a2a/v1";

function request(metadata: Record<string, unknown>, method: unknown = "SendMessage") {
  return {
    method,
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

  it("classifies the message/send alias as an open submission, so it is limited the same way", () => {
    expect(isOpenFreeA2aRequest(request({ skillId: "get-item" }, "message/send"))).toBe(true);
    expect(isOpenFreeA2aRequest(request({ skillId: "get-item", serviceRef: "0x01" }, "message/send")))
      .toBe(false);
  });

  it("does not classify other or malformed method names", () => {
    for (const method of ["tasks/send", "GetTask", "get-item", 42, null]) {
      expect(isOpenFreeA2aRequest(request({ skillId: "get-item" }, method))).toBe(false);
    }
  });

  it("runs the open-request limiter for the alias as for SendMessage", async () => {
    for (const method of ["SendMessage", "message/send"]) {
      const limiter = vi.fn();
      const next = vi.fn() as unknown as NextFunction;
      await applyOnlyToOpenFreeRequests(limiter)(
        { body: request({ skillId: "get-item" }, method) } as Request,
        {} as Response,
        next,
      );
      expect(limiter, method).toHaveBeenCalledOnce();
      expect(next, method).not.toHaveBeenCalled();
    }
  });
});
