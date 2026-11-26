import express from "express";
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
import type { ServiceModule } from "../src/core/serviceRegistry/types.js";

// The public free-skill endpoint as an agent calling it by hand meets it:
// every wrong guess at the request shape answers with one working request,
// and that request works when sent back.

const SLUG = "free-help";
const BASE_URL = "https://provider.test";
const EXT = "https://daski.io/a2a/v1";

const state = vi.hoisted(() => ({
  helpFails: false,
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock("../src/core/config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/core/config.js")>(
    "../src/core/config.js",
  );
  return { ...actual, config: { ...actual.config, BASE_URL } };
});
vi.mock("../src/core/chain/providerIdentity.js", () => ({
  getProviderIdentityAuthorization: vi.fn(() => ({ ok: true })),
}));
vi.mock("../src/core/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  errorClassExtra: vi.fn(() => ({})),
}));
vi.mock("../src/core/events/emitter.js", () => ({
  emitEvent: vi.fn(async () => undefined),
  recordMandatoryAudit: vi.fn(async () => undefined),
}));
vi.mock("../src/core/db/pool.js", () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));
vi.mock("../src/core/db/queries/services.js", () => ({
  upsertService: vi.fn(async () => ({ id: "svc-1", slug: SLUG, version: "1" })),
  getServiceBySlug: vi.fn(async (slug: string) => {
    if (state.helpFails) throw new Error("database unavailable");
    return slug === SLUG
      ? { id: "svc-1", slug: SLUG, version: "1", is_active: true }
      : null;
  }),
}));
vi.mock("../src/core/db/queries/skills.js", () => ({
  upsertSkill: vi.fn(async () => ({ id: "skill-row" })),
  getActiveSkillsByServiceId: vi.fn(async () =>
    state.rows.filter((row) => row.is_active)),
  getSkillByServiceAndSkillId: vi.fn(async (_service: string, skillId: string) =>
    state.rows.find((row) => row.skill_id === skillId) ?? null),
}));
vi.mock("../src/core/a2a/handlers/freeSkill/materialize.js", () => ({
  materializeFreeSkill: vi.fn(async () => ({
    taskId: "task-1",
    transaction: { id: "task-1" },
    anonymousAccess: null,
    replayed: false,
  })),
}));
vi.mock("../src/core/a2a/handlers/freeSkill/execution.js", () => ({
  executeFreeSkill: vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: "task-1",
    status: { state: "TASK_STATE_COMPLETED" },
    priced: args.data,
  })),
}));

const { registerService } = await import(
  "../src/core/serviceRegistry/registry.js"
);
const { a2aRouter } = await import("../src/core/a2a/router.js");
const { A2A_ERR, JSON_RPC } = await import("../src/core/a2a/jsonrpc.js");
const { executeFreeSkill } = await import(
  "../src/core/a2a/handlers/freeSkill/execution.js"
);

const FREE = { USDC: { type: "one-time" as const, fixed_amount: "0" } };
const QUOTED = { USDC: { type: "one-time" as const, min_amount: "0" } };
const PRICING_SCHEMA = {
  type: "object",
  properties: {
    units: { type: "integer", minimum: 2, maximum: 16 },
    sizeGiB: { type: "integer", minimum: 1, maximum: 64 },
    days: { type: "integer", minimum: 1, maximum: 30 },
    tier: { type: "string", enum: ["standard", "priority"] },
  },
  required: ["units", "sizeGiB", "days"],
  additionalProperties: false,
  maxProperties: 4,
};
const ITEM_SCHEMA = {
  type: "object",
  properties: { itemId: { type: "string", minLength: 1, maxLength: 64 } },
  required: ["itemId"],
  additionalProperties: false,
};
const RESULT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

function skill(id: string, extra: Record<string, unknown>) {
  return {
    id,
    name: id,
    description: `${id} skill`,
    examples: [`Run ${id}`],
    inputSchema: ITEM_SCHEMA,
    resultSchema: RESULT_SCHEMA,
    requiresAssetOwnership: false,
    pricing: FREE,
    ...extra,
  };
}

const module = {
  manifest: {
    slug: SLUG,
    version: "1",
    name: "Free help",
    categoryFamily: "other",
    serviceType: "other",
    jurisdictions: ["global"],
    description: "test",
    turnaroundEstimate: "instant",
    serviceLifecycle: "one-shot",
    dispatchMode: "one-shot",
    defaultFulfillmentMode: "automated",
  },
  skills: [
    skill("get-pricing", {
      inputSchema: PRICING_SCHEMA,
      taskDurability: "ephemeral",
      requiredFields: ["units", "sizeGiB", "days"],
      optionalFields: ["tier"],
    }),
    skill("check-item", { requiredFields: ["itemId"] }),
    skill("create-item", { pricing: QUOTED, requiredFields: ["itemId"] }),
    skill("get-item", { requiresAssetOwnership: true, requiredFields: ["itemId"] }),
  ],
  fulfillment: {
    adapter: {
      execute: async () => ({ status: "completed" }),
      handleInput: async () => ({ status: "failed" }),
      cancel: async () => undefined,
      quote: async () => ({ ok: true, amount: 0n, currency: "USDC" }),
    },
  },
  protocol: {
    docs: {
      service: "# free help",
      skills: {
        "get-pricing": "# get-pricing",
        "check-item": "# check-item",
        "create-item": "# create-item",
        "get-item": "# get-item",
      },
    },
  },
} as unknown as ServiceModule;

function row(skillId: string, extra: Record<string, unknown> = {}) {
  return {
    skill_id: skillId,
    is_active: true,
    pricing: FREE,
    requires_asset_ownership: false,
    required_fields: [],
    optional_fields: [],
    documentation_url: null,
    ...extra,
  };
}

let server: Server;
let origin: string;

beforeAll(async () => {
  await registerService(module);
  const app = express();
  app.use(express.json());
  app.use("/a2a", a2aRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP port");
  }
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

beforeEach(() => {
  state.helpFails = false;
  state.rows = [
    row("get-pricing", {
      required_fields: ["units", "sizeGiB", "days"],
      optional_fields: ["tier"],
    }),
    row("create-item", { pricing: QUOTED }),
    row("get-item", { requires_asset_ownership: true }),
    row("retired-free", { is_active: false }),
  ];
  vi.mocked(executeFreeSkill).mockClear();
});

async function post(
  body: Record<string, unknown>,
  slug = SLUG,
): Promise<Record<string, any>> {
  const response = await fetch(`${origin}/a2a/${slug}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json() as Promise<Record<string, any>>;
}

function send(
  method: string,
  message: Record<string, unknown>,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id: "r1", method, params: { message } };
}

function pricingMessage(
  data: unknown,
  skillId = "get-pricing",
): Record<string, unknown> {
  return {
    role: "user",
    messageId: crypto.randomUUID(),
    parts: [{ kind: "data", data }],
    metadata: { [EXT]: { skillId } },
  };
}

const VALID = { units: 2, sizeGiB: 4, days: 2 };

describe("A2A free-skill help: unknown methods", () => {
  it("names SendMessage and returns a request that works as sent", async () => {
    const body = await post({ jsonrpc: "2.0", id: "r1", method: "tasks/send", params: {} });
    expect(body.error.code).toBe(JSON_RPC.METHOD_NOT_FOUND);
    expect(body.error.message).toBe(
      "Unknown method: tasks/send. Use SendMessage. error.data.example is a working request.",
    );
    expect(body.error.data).toMatchObject({
      useMethod: "SendMessage",
      supportedMethods: ["SendMessage", "GetTask"],
      freeSkillIds: ["get-pricing"],
      agentCardUrl: `${BASE_URL}/agent-cards/${SLUG}.json`,
      documentationUrl: `${BASE_URL}/skills/${SLUG}/get-pricing.md`,
    });
    const example = body.error.data.example;
    expect(example).toMatchObject({
      httpMethod: "POST",
      url: `${BASE_URL}/a2a/${SLUG}`,
      headers: { "A2A-Version": "1.0" },
    });
    expect(example.placeholders).toBeUndefined();
    expect(example.body.params.message).toMatchObject({
      parts: [{ kind: "data", data: { units: 2, sizeGiB: 1, days: 1 } }],
      metadata: { [EXT]: { skillId: "get-pricing" } },
    });

    const replay = await post(example.body);
    expect(replay.error).toBeUndefined();
    expect(replay.result).toMatchObject({ id: "task-1" });
    expect(executeFreeSkill).toHaveBeenCalledOnce();
  });

  it("gives every example a fresh messageId", async () => {
    const first = await post({ jsonrpc: "2.0", id: "a", method: "rpc.discover" });
    const second = await post({ jsonrpc: "2.0", id: "b", method: "rpc.discover" });
    expect(first.error.data.example.body.params.message.messageId)
      .not.toBe(second.error.data.example.body.params.message.messageId);
  });

  it("explains a skill id sent as the method", async () => {
    const body = await post({ jsonrpc: "2.0", id: "r1", method: "get-pricing" });
    expect(body.error.code).toBe(JSON_RPC.METHOD_NOT_FOUND);
    expect(body.error.message).toContain("get-pricing is a skill id, not a method");
    expect(body.error.data.example.body.params.message.metadata[EXT].skillId)
      .toBe("get-pricing");
  });

  it("points a task read at GetTask with a GetTask example", async () => {
    const body = await post({ jsonrpc: "2.0", id: "r1", method: "tasks/get", params: { id: "t" } });
    expect(body.error.code).toBe(JSON_RPC.METHOD_NOT_FOUND);
    expect(body.error.message).toContain("Use GetTask.");
    expect(body.error.message).toContain("replace the values listed in error.data.example.placeholders");
    expect(body.error.data.useMethod).toBe("GetTask");
    expect(body.error.data.example.body).toEqual({
      jsonrpc: "2.0",
      id: "1",
      method: "GetTask",
      params: { id: "<taskId>", taskAccessToken: "<taskAccessToken>" },
    });
    expect(body.error.data.example.placeholders)
      .toEqual(["body.params.id", "body.params.taskAccessToken"]);
    expect(body.error.data.hint).toContain("anonymous_task_access");
  });

  it("prefers a free skill whose example works as sent", async () => {
    state.rows.unshift(row("check-item"));
    const body = await post({ jsonrpc: "2.0", id: "r1", method: "tools/list" });
    expect(body.error.data.freeSkillIds).toEqual(["check-item", "get-pricing"]);
    expect(body.error.data.example.body.params.message.metadata[EXT].skillId)
      .toBe("get-pricing");
  });

  it("names no substitute for a v1.0 method this endpoint does not serve", async () => {
    const body = await post({ jsonrpc: "2.0", id: "r1", method: "CancelTask", params: {} });
    expect(body.error.code).toBe(JSON_RPC.METHOD_NOT_FOUND);
    expect(body.error.data.useMethod).toBeUndefined();
    expect(body.error.message).toContain("serves only SendMessage and GetTask");
  });

  it("keeps SubscribeToTask an unsupported operation", async () => {
    const body = await post({ jsonrpc: "2.0", id: "r1", method: "SubscribeToTask", params: {} });
    expect(body.error.code).toBe(A2A_ERR.UNSUPPORTED_OPERATION);
  });

  it("lists only skills the free gate admits", async () => {
    const body = await post({ jsonrpc: "2.0", id: "r1", method: "tools/list" });
    expect(body.error.data.freeSkillIds).toEqual(["get-pricing"]);
  });

  it("points an unknown service at the catalog without echoing it", async () => {
    const body = await post({ jsonrpc: "2.0", id: "r1", method: "tools/list" }, "no-such-service");
    expect(body.error.code).toBe(JSON_RPC.METHOD_NOT_FOUND);
    expect(body.error.data.catalogUrl).toBe(`${BASE_URL}/.well-known/agent.json`);
    expect(body.error.data.freeSkillIds).toBeUndefined();
    expect(body.error.data.example.url).toBe(`${BASE_URL}/a2a/<service-slug>`);
    expect(body.error.data.example.placeholders).toEqual([
      "url",
      "body.params.message.parts[0].data",
      `body.params.message.metadata["${EXT}"].skillId`,
    ]);
    expect(body.error.message).toContain("error.data.example.placeholders");
  });

  it("still answers as a caller error when the help lookup fails", async () => {
    state.helpFails = true;
    const body = await post({ jsonrpc: "2.0", id: "r1", method: "tools/list" });
    expect(body.error.code).toBe(JSON_RPC.METHOD_NOT_FOUND);
    expect(body.error.data.supportedMethods).toEqual(["SendMessage", "GetTask"]);
  });

  it("bounds the echoed method name", async () => {
    const body = await post({ jsonrpc: "2.0", id: "r1", method: "x".repeat(500) });
    expect(body.error.message).toContain(`Unknown method: ${"x".repeat(64)}.`);
    expect(body.error.message).not.toContain("x".repeat(65));
  });
});

describe("A2A free-skill help: message/send alias", () => {
  it("serves a free skill through the A2A 0.x method name", async () => {
    const body = await post(send("message/send", pricingMessage(VALID)));
    expect(body.error).toBeUndefined();
    expect(body.result).toMatchObject({ priced: VALID });
  });

  it("still refuses paid and owner-only skills", async () => {
    for (const skillId of ["create-item", "get-item"]) {
      const body = await post(send("message/send", pricingMessage({ itemId: "i-1" }, skillId)));
      expect(body.error.code).toBe(JSON_RPC.INVALID_PARAMS);
      expect(body.error.message).toContain("requires standard-rail order authority");
    }
    expect(executeFreeSkill).not.toHaveBeenCalled();
  });

  it("still refuses native payment metadata", async () => {
    const message = pricingMessage(VALID);
    message.metadata = { [EXT]: { skillId: "get-pricing", paymentId: "42" } };
    const body = await post(send("message/send", message));
    expect(body.error.message).toContain("Native payment metadata is retired");
  });
});

describe("A2A free-skill help: missing skillId", () => {
  it("keeps the message and shows the metadata shape", async () => {
    const message = pricingMessage(VALID);
    message.metadata = {};
    const body = await post(send("SendMessage", message));
    expect(body.error.code).toBe(JSON_RPC.INVALID_REQUEST);
    expect(body.error.message).toBe(
      `metadata[${EXT}].skillId is required for public free skills`,
    );
    expect(body.error.data).toMatchObject({
      required: `params.message.metadata["${EXT}"].skillId`,
      freeSkillIds: ["get-pricing"],
    });
    expect(body.error.data.example.body.params.message.metadata)
      .toEqual({ [EXT]: { skillId: "get-pricing" } });
  });

  it("builds the example for a skill id put in the wrong place", async () => {
    // Its code definition exists; only this test serves its row.
    state.rows.push(row("check-item"));
    const message = pricingMessage({});
    message.metadata = { skillId: "check-item" };
    const body = await post(send("SendMessage", message));
    expect(body.error.data.freeSkillIds).toEqual(["get-pricing", "check-item"]);
    expect(body.error.data.example.body.params.message).toMatchObject({
      parts: [{ kind: "data", data: { itemId: "<itemId>" } }],
      metadata: { [EXT]: { skillId: "check-item" } },
    });
    expect(body.error.data.example.placeholders)
      .toEqual(["body.params.message.parts[0].data.itemId"]);
  });

  it("helps with an empty skill id", async () => {
    const body = await post(send("SendMessage", pricingMessage(VALID, "")));
    expect(body.error.code).toBe(JSON_RPC.INVALID_PARAMS);
    expect(body.error.message).toBe("Missing skillId in metadata");
    expect(body.error.data.freeSkillIds).toEqual(["get-pricing"]);
  });

  it("points an unknown service reached with SendMessage at the catalog", async () => {
    const body = await post(send("SendMessage", pricingMessage(VALID)), "no-such-service");
    expect(body.error.message).toBe("Service not found or inactive: no-such-service");
    expect(body.error.data.catalogUrl).toBe(`${BASE_URL}/.well-known/agent.json`);
  });

  it("lists the free skills for an unknown skill id", async () => {
    const body = await post(send("SendMessage", pricingMessage(VALID, "pricing")));
    expect(body.error.code).toBe(JSON_RPC.INVALID_PARAMS);
    expect(body.error.message).toBe("Invalid skill: pricing");
    expect(body.error.data.freeSkillIds).toEqual(["get-pricing"]);
  });
});

describe("A2A free-skill help: contract mismatch", () => {
  it("names the failing fields and returns the published input schema", async () => {
    const body = await post(send("SendMessage", pricingMessage({ ...VALID, units: 1, tier: "fast" })));
    expect(body.error.code).toBe(JSON_RPC.INVALID_PARAMS);
    expect(body.error.message).toMatch(
      /^Input does not match the published skill contract: units, tier\./,
    );
    expect(body.error.data.errors).toEqual([
      { field: "units", problem: "must be >= 2" },
      {
        field: "tier",
        problem: 'must be equal to one of the allowed values: "standard", "priority"',
      },
    ]);
    expect(body.error.data).toMatchObject({
      skillId: "get-pricing",
      inputSchema: PRICING_SCHEMA,
      documentationUrl: `${BASE_URL}/skills/${SLUG}/get-pricing.md`,
    });
    expect(body.error.data.inputPart).toBeUndefined();
    expect(JSON.stringify(body.error)).not.toContain("fast");
  });

  it("says when no data part was found", async () => {
    const message = pricingMessage(VALID);
    message.parts = [{ data: VALID }];
    const body = await post(send("SendMessage", message));
    expect(body.error.code).toBe(JSON_RPC.INVALID_PARAMS);
    expect(body.error.data.errors.map((error: { field: string }) => error.field))
      .toEqual(["units", "sizeGiB", "days"]);
    expect(body.error.data.inputPart).toContain('kind "data"');
  });

  it("returns the schema with an undeclared field", async () => {
    const body = await post(send("SendMessage", pricingMessage({ ...VALID, region: "eu" })));
    expect(body.error.message).toBe("Undeclared fields: region");
    expect(body.error.data.inputSchema).toEqual(PRICING_SCHEMA);
  });

  it("returns the schema when a field the skill row requires is missing", async () => {
    state.rows[0] = row("get-pricing", {
      required_fields: ["units", "sizeGiB", "days", "tier"],
      optional_fields: [],
    });
    const body = await post(send("SendMessage", pricingMessage(VALID)));
    expect(body.error.message).toBe("Missing required fields: tier");
    expect(body.error.data.inputSchema).toEqual(PRICING_SCHEMA);
  });

  it("shows a working request when messageId is missing", async () => {
    const message = pricingMessage(VALID);
    delete message.messageId;
    const body = await post(send("SendMessage", message));
    expect(body.error.message).toContain("message.messageId is required");
    expect(body.error.data.inputSchema).toBeUndefined();
    expect(typeof body.error.data.example.body.params.message.messageId).toBe("string");
  });
});
