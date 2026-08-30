import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ServiceModule } from "../src/core/serviceRegistry/types.js";

// These tests exercise the in-process registry surface plus the
// agent_domain defaulting added on top of upsertService. They mock the
// queries layer so no live DB is required; the full integration is
// covered by the boot smoke test.

// Pin BASE_URL so the agent_domain defaulting assertion has a known host
// to compare against. vi.mock is hoisted, so we lock the config module's
// BASE_URL before registry.ts evaluates.
vi.mock("../src/core/config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/core/config.js")>(
    "../src/core/config.js",
  );
  return {
    ...actual,
    config: { ...actual.config, BASE_URL: "https://provider.test" },
  };
});

const upsertServiceMock = vi.fn();
const upsertSkillMock = vi.fn();

vi.mock("../src/core/db/queries/services.js", () => ({
  upsertService: (args: unknown) => {
    upsertServiceMock(args);
    return Promise.resolve({ id: "svc-test", slug: "test-svc", version: "1" });
  },
}));

vi.mock("../src/core/db/queries/skills.js", () => ({
  upsertSkill: (args: unknown) => {
    upsertSkillMock(args);
    return Promise.resolve({ id: "skill-test", skill_id: "test-skill" });
  },
}));

vi.mock("../src/core/db/pool.js", () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

const {
  registerService,
  getService,
  getAllServices,
  getAdapter,
} = await import("../src/core/serviceRegistry/registry.js");

let slugCounter = 0;
const emptySchema = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
} as const;

function nextSlug(prefix = "test-svc"): string {
  return `${prefix}-${++slugCounter}-${Math.floor(Math.random() * 1e8)}`;
}

function makeModule(overrides: Partial<ServiceModule> = {}): ServiceModule {
  const { manifest: manifestOverride, ...rest } = overrides;
  return {
    manifest: {
      slug: nextSlug(),
      version: "1",
      name: "Test",
      categoryFamily: "other",
      serviceType: "other",
      jurisdictions: ["global"],
      description: "test",
      turnaroundEstimate: "instant",
      serviceLifecycle: "one-shot",
      dispatchMode: "one-shot",
      defaultFulfillmentMode: "automated",
      ...manifestOverride,
    },
    skills: [],
    fulfillment: {
      adapter: {
        execute: async () => ({ status: "completed" }),
        handleInput: async () => ({ status: "failed" }),
        cancel: async () => undefined,
        quote: async () => ({ ok: true, amount: 0n, currency: "USDC" }),
      },
    },
    protocol: {
      docs: { service: "# test", skills: {} },
    },
    ...rest,
  };
}

describe("serviceRegistry: in-process surface", () => {
  it("getService returns null for unknown slugs", () => {
    expect(getService("nonexistent")).toBe(null);
  });

  it("getAllServices returns an array", () => {
    expect(Array.isArray(getAllServices())).toBe(true);
  });

  it("getAdapter throws on unknown slug", () => {
    expect(() => getAdapter("nonexistent")).toThrow(/Unknown service/);
  });

  it("rejects manifests with invalid slugs", async () => {
    const bad = makeModule({
      manifest: { ...makeModule().manifest, slug: "BAD SLUG" },
    });
    await expect(registerService(bad)).rejects.toThrow(/Invalid service slug/);
  });

  it.each([
    ["lowercase ISO", ["us-wy"]],
    ["global mixed with a country", ["global", "US"]],
    ["duplicate values", ["US", "US"]],
  ])("rejects %s jurisdiction identifiers before persistence", async (_label, jurisdictions) => {
    const bad = makeModule({
      manifest: { ...makeModule().manifest, jurisdictions },
    });
    await expect(registerService(bad)).rejects.toThrow(/unique uppercase ISO values/);
    expect(upsertServiceMock).not.toHaveBeenCalled();
  });

  it("rejects unsafe ephemeral skill declarations", async () => {
    const module = makeModule({
      skills: [{
        id: "unsafe-ephemeral",
        name: "Unsafe",
        description: "Must not register.",
        examples: ["Run it"],
        pricing: { USDC: { type: "one-time", fixed_amount: "1" } },
        taskDurability: "ephemeral",
        fulfillmentMode: "human",
        requiresAssetOwnership: true,
        inputSchema: emptySchema,
        resultSchema: emptySchema,
      }],
      protocol: {
        docs: {
          service: "# Test",
          skills: { "unsafe-ephemeral": "# Unsafe" },
        },
      },
    });
    await expect(registerService(module)).rejects.toThrow(
      /must be free, open, and automated/,
    );
    expect(upsertServiceMock).not.toHaveBeenCalled();
  });
});

describe("serviceRegistry: agent_domain defaulting", () => {
  beforeEach(() => {
    upsertServiceMock.mockClear();
    upsertSkillMock.mockClear();
  });

  it("defaults agent_domain to the host of BASE_URL when manifest doesn't set it", async () => {
    await registerService(makeModule());
    expect(upsertServiceMock).toHaveBeenCalledTimes(1);
    const call = upsertServiceMock.mock.calls[0][0] as { agent_domain: string | null };
    // vi.mock above pins BASE_URL to "https://provider.test"; host = "provider.test".
    expect(call.agent_domain).toBe("provider.test");
  });

  it("preserves the manifest's agentDomain override", async () => {
    await registerService(
      makeModule({ manifest: { agentDomain: "custom.example.com" } as never }),
    );
    expect(upsertServiceMock).toHaveBeenCalledTimes(1);
    const call = upsertServiceMock.mock.calls[0][0] as { agent_domain: string | null };
    expect(call.agent_domain).toBe("custom.example.com");
  });

  it("persists service taxonomy and resolved per-skill fulfillment modes", async () => {
    const commonSkill = {
      name: "Test skill",
      description: "A test skill.",
      examples: ["Run it"],
      pricing: { USDC: { type: "one-time" as const, fixed_amount: "0" } },
      requiresAssetOwnership: false,
      requiresCapability: false,
      inputSchema: emptySchema,
      resultSchema: emptySchema,
    };
    await registerService(
      makeModule({
        manifest: {
          ...makeModule().manifest,
          slug: nextSlug("taxonomy"),
          categoryFamily: "communications",
          serviceType: "agent-mailbox",
          jurisdictions: ["global"],
          defaultFulfillmentMode: "automated",
        },
        skills: [
          { id: "inherited", ...commonSkill },
          { id: "overridden", ...commonSkill, fulfillmentMode: "human" },
        ],
        protocol: {
          docs: {
            service: "# Test",
            skills: { inherited: "# Inherited", overridden: "# Overridden" },
          },
        },
      }),
    );

    expect(upsertServiceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        category_family: "communications",
        service_type: "agent-mailbox",
        jurisdictions: ["global"],
      }),
    );
    expect(upsertSkillMock.mock.calls.map(([call]) => call)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ skill_id: "inherited", fulfillment_mode: "automated" }),
        expect.objectContaining({ skill_id: "overridden", fulfillment_mode: "human" }),
      ]),
    );
  });
});
