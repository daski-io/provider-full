import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ failures: [] as string[] }));

vi.mock("../src/core/db/queries/services.js", () => ({
  getServiceBySlug: async (slug: string) => ({ id: "service-1", slug, is_active: true }),
}));
vi.mock("../src/core/db/queries/skills.js", () => ({
  getSkillByServiceAndSkillId: async (_serviceId: string, skillId: string) => ({
    skill_id: skillId,
    is_active: true,
    pricing: { USDC: { type: "one-time", fixed_amount: "0" } },
    requires_asset_ownership: false,
    required_fields: ["text"],
    optional_fields: [],
  }),
}));
vi.mock("../src/core/serviceRegistry/registry.js", () => ({
  getService: (slug: string) => ({
    manifest: { slug },
    skills: [{ id: "echo" }],
    operations: { readiness: { checkInvariants: async () => [...state.failures] } },
  }),
  validateSkillInput: () => undefined,
}));

const { resolveFreeSkillRequest } = await import("../src/core/a2a/handlers/freeSkill/request.js");
const { DASKI_ERR, JSON_RPC } = await import("../src/core/a2a/jsonrpc.js");

// C05: with readiness split, a replica stays routable during a service's
// declared outage, so a free skill call must wait it out itself instead of
// running into it. Invalid calls are still answered as invalid.
const message = (data: Record<string, unknown>) => ({
  messageId: "message-1",
  parts: [{ kind: "data", data }],
});
const resolve = (data: Record<string, unknown>) => resolveFreeSkillRequest({
  message: message(data), metadata: { skillId: "echo" }, serviceSlug: "dummy",
});

beforeEach(() => {
  state.failures.length = 0;
});

describe("free skill calls during a declared service outage", () => {
  it("answers a recoverable unavailability while the service declares an outage", async () => {
    state.failures.push("supplier unreachable");
    await expect(resolve({ text: "hello" })).resolves.toEqual({
      ok: false,
      code: DASKI_ERR.SERVICE_UNAVAILABLE,
      message: "Service is temporarily unavailable",
      data: { recoverable: true },
    });
  });

  it("still refuses an invalid call as invalid", async () => {
    state.failures.push("supplier unreachable");
    await expect(resolve({})).resolves.toMatchObject({ ok: false, code: JSON_RPC.INVALID_PARAMS });
  });

  it("admits the call once the outage clears", async () => {
    await expect(resolve({ text: "hello" })).resolves.toMatchObject({ ok: true, skillId: "echo" });
  });
});
