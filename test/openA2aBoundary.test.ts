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
    expect(isOpenFreeA2aRequest(request({ skillId: "get-item" }))).toBe(true);
  });

  it("counts every SendMessage whatever its metadata, so no key moves it off the open limit", () => {
    for (const metadata of [
      { skillId: "get-item", taskId: "task-1" },
      { skillId: "get-item", taskId: "" },
      { skillId: "create-item", serviceRef: "0x01" },
      { skillId: "get-item", paymentId: "42" },
      { skillId: "get-item", transactionHash: "0xab" },
      {
        skillId: "get-item",
        taskId: "task-1",
        serviceRef: "0x01",
        paymentId: "42",
        transactionHash: "0xab",
      },
      { taskId: "task-1" },
      { skillId: 42 },
      {},
    ]) {
      expect(isOpenFreeA2aRequest(request(metadata)), JSON.stringify(metadata)).toBe(true);
    }
    expect(isOpenFreeA2aRequest({ method: "SendMessage" })).toBe(true);
    expect(isOpenFreeA2aRequest({ method: "SendMessage", params: { message: {} } })).toBe(true);
  });

  it("classifies the message/send alias as an open submission, so it is limited the same way", () => {
    expect(isOpenFreeA2aRequest(request({ skillId: "get-item" }, "message/send"))).toBe(true);
    expect(isOpenFreeA2aRequest(request({ skillId: "get-item", taskId: "task-1" }, "message/send")))
      .toBe(true);
    expect(isOpenFreeA2aRequest(request({ skillId: "get-item", serviceRef: "0x01" }, "message/send")))
      .toBe(true);
  });

  it("does not classify other or malformed method names", () => {
    for (const method of ["tasks/send", "GetTask", "get-item", 42, null]) {
      expect(isOpenFreeA2aRequest(request({ skillId: "get-item" }, method))).toBe(false);
    }
    for (const body of [null, undefined, "SendMessage", [request({ skillId: "get-item" })]]) {
      expect(isOpenFreeA2aRequest(body)).toBe(false);
    }
  });

  it("runs the open-request limiter for a SendMessage carrying taskId", async () => {
    for (const method of ["SendMessage", "message/send"]) {
      const limiter = vi.fn();
      const next = vi.fn() as unknown as NextFunction;
      await applyOnlyToOpenFreeRequests(limiter)(
        { body: request({ skillId: "get-item", taskId: "task-1" }, method) } as Request,
        {} as Response,
        next,
      );
      expect(limiter, method).toHaveBeenCalledOnce();
      expect(next, method).not.toHaveBeenCalled();
    }
  });
});
