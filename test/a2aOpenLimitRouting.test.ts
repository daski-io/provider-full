// The open-request limit must count every public request that can run a free
// skill. These tests mount the boundary in front of the real A2A router, as
// server.ts does, and prove that no metadata a caller adds lets a request
// reach the free-skill handler without passing the open limiter first.
import express from "express";
import type { NextFunction, Request, Response } from "express";
import type { Server } from "node:http";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const state = vi.hoisted(() => ({ refuse: false }));

vi.mock("../src/core/chain/providerIdentity.js", () => ({
  getProviderIdentityAuthorization: vi.fn(() => ({
    ok: true,
    checkedAt: new Date(),
    reason: null,
  })),
}));
vi.mock("../src/core/a2a/handlers/tasksGet.js", () => ({
  handleTasksGet: vi.fn(async (
    _params: unknown,
    _slug: string,
    res: express.Response,
    id: string,
  ) => res.json({ jsonrpc: "2.0", id, result: { routed: "GetTask" } })),
}));
vi.mock("../src/core/a2a/handlers/freeSkill.js", () => ({
  handleFreeSkill: vi.fn(async (
    _message: unknown,
    _metadata: unknown,
    _slug: string,
    res: express.Response,
    id: string,
  ) => res.json({ jsonrpc: "2.0", id, result: { routed: "freeSkill" } })),
}));
vi.mock("../src/core/a2a/freeSkillHelp.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/core/a2a/freeSkillHelp.js")>(),
  freeSkillHelp: vi.fn(async () => ({ supportedMethods: ["SendMessage", "GetTask"] })),
}));
vi.mock("../src/core/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  errorClassExtra: vi.fn(() => ({})),
}));

import { a2aRouter } from "../src/core/a2a/router.js";
import { handleFreeSkill } from "../src/core/a2a/handlers/freeSkill.js";
import { handleTasksGet } from "../src/core/a2a/handlers/tasksGet.js";
import { applyOnlyToOpenFreeRequests } from "../src/core/security/openA2aBoundary.js";

const EXT = "https://daski.io/a2a/v1";

const openLimiter = vi.fn((_req: Request, res: Response, next: NextFunction) => {
  if (state.refuse) {
    res.status(429).json({ error: "rate_limit_exceeded", namespace: "a2a-open" });
    return;
  }
  next();
});

let server: Server;
let endpoint: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/a2a", applyOnlyToOpenFreeRequests(openLimiter), a2aRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP port");
  }
  endpoint = `http://127.0.0.1:${address.port}/a2a/dummy`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

beforeEach(() => {
  state.refuse = false;
  openLimiter.mockClear();
  vi.mocked(handleFreeSkill).mockClear();
  vi.mocked(handleTasksGet).mockClear();
});

function sendMessage(metadata: Record<string, unknown>, method = "SendMessage") {
  return {
    jsonrpc: "2.0",
    id: "request-1",
    method,
    params: {
      message: {
        messageId: "message-1",
        role: "user",
        parts: [{ kind: "data", data: { itemId: "item-1" } }],
        metadata: { [EXT]: metadata },
      },
    },
  };
}

async function post(body: Record<string, unknown>) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

const METADATA_VARIANTS: Record<string, unknown>[] = [
  { skillId: "get-item" },
  { skillId: "get-item", taskId: "task-1" },
  { skillId: "get-item", taskId: "00000000-0000-4000-8000-000000000000" },
  { skillId: "get-item", taskId: "" },
  { skillId: "get-item", taskId: { nested: true } },
  { skillId: "get-item", serviceRef: "0x01" },
  { skillId: "get-item", paymentId: "42" },
  { skillId: "get-item", transactionHash: "0xab" },
  { skillId: "get-item", serviceRef: "", taskId: "task-1" },
  { taskId: "task-1" },
  {},
];

describe("open-request limit in front of the A2A router", () => {
  it("counts a free SendMessage carrying taskId before it runs the free skill", async () => {
    for (const method of ["SendMessage", "message/send"]) {
      openLimiter.mockClear();
      vi.mocked(handleFreeSkill).mockClear();
      const { body } = await post(sendMessage(
        { skillId: "get-item", taskId: "task-1" },
        method,
      ));
      expect(body.result, method).toEqual({ routed: "freeSkill" });
      expect(handleFreeSkill, method).toHaveBeenCalledOnce();
      expect(openLimiter, method).toHaveBeenCalledOnce();
    }
  });

  it("never lets any metadata reach the free-skill handler without the open limiter", async () => {
    for (const metadata of METADATA_VARIANTS) {
      for (const method of ["SendMessage", "message/send"]) {
        openLimiter.mockClear();
        vi.mocked(handleFreeSkill).mockClear();
        await post(sendMessage(metadata, method));
        const label = `${method} ${JSON.stringify(metadata)}`;
        expect(openLimiter, label).toHaveBeenCalledOnce();
      }
    }
  });

  it("refuses a free SendMessage carrying taskId once the open limit is spent", async () => {
    state.refuse = true;
    for (const metadata of METADATA_VARIANTS) {
      for (const method of ["SendMessage", "message/send"]) {
        vi.mocked(handleFreeSkill).mockClear();
        const { status, body } = await post(sendMessage(metadata, method));
        const label = `${method} ${JSON.stringify(metadata)}`;
        expect(status, label).toBe(429);
        expect(body, label).toMatchObject({ namespace: "a2a-open" });
        expect(handleFreeSkill, label).not.toHaveBeenCalled();
      }
    }
  });

  it("leaves GetTask polls on the general limit only", async () => {
    state.refuse = true;
    const { body } = await post({
      jsonrpc: "2.0",
      id: "request-2",
      method: "GetTask",
      params: { id: "task-1", taskAccessToken: "token" },
    });
    expect(body.result).toEqual({ routed: "GetTask" });
    expect(openLimiter).not.toHaveBeenCalled();
  });
});
