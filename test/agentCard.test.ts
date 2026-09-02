import { describe, it, expect, vi } from "vitest";
import type { ServiceRow } from "../src/core/db/queries/services.js";
import type { SkillRow } from "../src/core/db/queries/skills.js";

// Pin URLs so the AgentCard assertions are deterministic. PROVIDER_NAME
// is set by test/setup.ts; the website + icon vars are optional in
// config but populated here so the v1.0 `provider` and `iconUrl` blocks
// are exercised.
process.env.BASE_URL = "https://provider.test";
process.env.GATEWAY_BASE_URL = "https://gateway.test";
// A public BASE_URL is only legal outside mock chain mode (mock binds to
// loopback), so pin live mode against ambient CI env.
process.env.CHAIN_MODE = "live";
process.env.PROVIDER_WEBSITE_URL = "https://provider.test/about";
process.env.PROVIDER_ICON_URL = "https://provider.test/icon.png";

// The generator reads per-asset-type lifecycle from the registered service
// module (ServiceManifest.assetLifecycle) rather than a hardcoded core table.
// Stub the registry so "sample-service" resolves to a sample item lifecycle.
vi.mock("../src/core/serviceRegistry/registry.js", async (importActual) => {
  const actual = await importActual<
    typeof import("../src/core/serviceRegistry/registry.js")
  >();
  const skillIds = [
    "preview-item",
    "create-item",
    "refresh-item",
    "update-item",
    "review-item",
  ];
  return {
    ...actual,
    getService: (slug: string) =>
      slug === "sample-service"
        ? ({
            manifest: {
              slug: "sample-service",
              version: "1",
              defaultFulfillmentMode: "automated",
              assetLifecycle: {
                item: {
                  states: ["active", "deleted"],
                  terminalStates: ["deleted"],
                  transitions: [
                    { from: null, to: "active", skill: "create-item" },
                    { from: "active", to: "active", skill: "refresh-item" },
                    {
                      from: "active",
                      to: "deleted",
                      skill: "archive-item",
                    },
                  ],
                },
              },
            },
            skills: skillIds.map((id) => ({
              id,
              name: id,
              description: `Contract for ${id}`,
              examples: [id],
              tags: ["sample"],
              pricing: {
                USDC: { type: "one-time", fixed_amount: "0" },
              },
              requiresAssetOwnership: id === "update-item",
              inputSchema: {
                type: "object",
                properties: {},
                required: [],
                additionalProperties: false,
              },
              resultSchema: {
                type: "object",
                properties: {},
                required: [],
                additionalProperties: false,
              },
            })),
          } as never)
        : null,
  };
});

const { generateAgentCard } = await import("../src/core/agentCards/generator.js");

const DASKI_EXT_URI = "https://daski.io/a2a/v1";

const DASKI_CONTRACT_EXT_URI = "https://daski.io/a2a/v2";
function makeService(overrides: Partial<ServiceRow> = {}): ServiceRow {
  return {
    id: "svc-1",
    name: "Sample Service",
    slug: "sample-service",
    version: "1",
    category_family: "other",
    service_type: "sample-service",
    jurisdictions: ["global"],
    turnaround_estimate: "5-10 minutes",
    service_lifecycle: "asset-lifecycle",
    service_description: "Create and manage sample items.",
    adapter_name: "sample-service",
    agent_domain: "provider.test",
    supplier: "api-supplier",
    outbound_email_from: null,
    inbound_email_address: null,
    on_chain_id: Buffer.from("cb1364fd17b03b01", "hex"),
    service_wallet: null,
    is_active: true,
    created_at: new Date(),
    updated_at: new Date(),
    config_revision: "0",
    operator_updated_by: null,
    operator_updated_at: null,
    ...overrides,
  };
}

function makeSkill(overrides: Partial<SkillRow> = {}): SkillRow {
  return {
    id: "skill-row-1",
    service_id: "svc-1",
    skill_id: "create-item",
    name: "Create Item",
    description: "Create an item.",
    tags: ["sample"],
    pricing: { USDC: { type: "one-time", min_amount: "0" } },
    required_fields: ["title"],
    optional_fields: null,
    requires_asset_ownership: false,
    asset_type: null,
    sort_order: 0,
    is_active: true,
    human_parties: null,
    fulfillment_mode: "automated",
    config: {},
    examples: ["Create a sample item"],
    documentation_url: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe("agent card generator", () => {
  it("advertises the gateway's x402 V2 facilitator boundary", () => {
    const card = generateAgentCard(makeService(), [makeSkill()]);
    const ext = card.extensions[DASKI_EXT_URI] as Record<string, unknown>;

    expect(ext.x402Version).toBe(2);
    expect(ext.facilitatorUrl).toBe("https://gateway.test");
  });

  it("publishes the manifest-derived v2 contract projection with stable hashes", () => {
    const card = generateAgentCard(makeService(), [makeSkill()]);
    const ext = card.extensions[DASKI_CONTRACT_EXT_URI] as {
      schemaVersion: number;
      skillContractSetHash: string;
      skills: Array<{
        skillId: string;
        skillContractHash: string;
        acceptingNewOrders: boolean;
      }>;
    };
    const registered = ext.skills.find((skill) => skill.skillId === "create-item");
    expect(ext.schemaVersion).toBe(1);
    expect(ext.skillContractSetHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(registered?.skillContractHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(registered?.acceptingNewOrders).toBe(true);
  });

  it("emits service taxonomy and per-skill fulfillment without the legacy category", () => {
    const card = generateAgentCard(makeService(), [
      makeSkill({ fulfillment_mode: "automated" }),
    ]);
    const ext = card.extensions[DASKI_EXT_URI] as Record<string, unknown>;
    const skills = ext.skills as Record<string, Record<string, unknown>>;

    expect(ext.categoryFamily).toBe("other");
    expect(ext.serviceType).toBe("sample-service");
    expect(ext.jurisdictions).toEqual(["global"]);
    expect(ext.category).toBeUndefined();
    expect(skills["create-item"].fulfillmentMode).toBe("automated");
    expect(card.skills[0]?.tags).toEqual(
      expect.arrayContaining(["other", "sample-service"]),
    );
  });

  it("emits the complete legal object under the Daski extension", () => {
    const card = generateAgentCard(makeService(), [makeSkill()]);
    const ext = card.extensions[DASKI_EXT_URI] as Record<string, unknown>;

    expect(ext.legal).toEqual({
      marketplaceTermsUrl: "https://marketplace.test/terms-of-use",
      marketplacePrivacyUrl: "https://marketplace.test/privacy-policy",
      providerLegalName: "Test Provider",
      providerTermsUrl: "https://provider.test/terms-of-use",
      providerPrivacyUrl: "https://provider.test/privacy-policy",
    });
  });

  it("emits a service-level pricing block inside the daski extension", () => {
    // Gateway's issuePaymentRequirements gates on `ext.pricing` being
    // present, so this block must always be there — even for v4 providers
    // whose pricing source-of-truth is per-skill.
    const card = generateAgentCard(makeService(), [makeSkill()]);
    const ext = card.extensions[DASKI_EXT_URI] as Record<string, unknown>;
    const pricing = ext.pricing as Record<string, unknown>;
    expect(pricing).toBeDefined();
    expect(pricing.currency).toBe("USDC");
    expect(pricing.billingModel).toBe("one-time");
    // The single skill is variable (min_amount only), so the service-level
    // summary flips on variable / model="live".
    expect(pricing.variable).toBe(true);
    expect(pricing.variablePricing).toBe(true);
    expect(pricing.model).toBe("live");
  });

  it("marks the service as non-variable when no priceable skill is variable", () => {
    // A service whose only paid skill carries a fixed_amount has no
    // variable pricing — gateway should be able to surface a basePrice.
    const fixedSkill = makeSkill({
      pricing: { USDC: { type: "one-time", fixed_amount: "1000000" } },
    });
    const card = generateAgentCard(makeService(), [fixedSkill]);
    const ext = card.extensions[DASKI_EXT_URI] as Record<string, unknown>;
    const pricing = ext.pricing as Record<string, unknown>;
    expect(pricing.variable).toBe(false);
    expect(pricing.variablePricing).toBe(false);
    expect(pricing.model).toBeUndefined();
  });

  it("emits per-skill pricing under extensions[uri].skills[skillId].pricing", () => {
    const card = generateAgentCard(makeService(), [makeSkill()]);
    const ext = card.extensions[DASKI_EXT_URI] as Record<string, unknown>;
    const skills = ext.skills as Record<string, Record<string, unknown>>;
    expect(skills["create-item"]).toBeDefined();
    expect(skills["create-item"].serviceSlug).toBe("sample-service");
    expect(skills["create-item"].pricing).toBeDefined();
    const skillPricing = skills["create-item"].pricing as Record<string, unknown>;
    expect(skillPricing.type).toBe("one-time");
    expect(skillPricing.minAmount).toBe("0");
  });

  it("surfaces the humanParties marker per skill when declared", () => {
    const card = generateAgentCard(makeService(), [
      makeSkill({ skill_id: "create-item", human_parties: "required" }),
      makeSkill({ skill_id: "refresh-item", human_parties: "none" }),
      makeSkill({ skill_id: "review-item", human_parties: "varies" }),
    ]);
    const skills = (card.extensions[DASKI_EXT_URI] as Record<string, unknown>)
      .skills as Record<string, Record<string, unknown>>;
    expect(skills["create-item"].humanParties).toBe("required");
    expect(skills["refresh-item"].humanParties).toBe("none");
    expect(skills["review-item"].humanParties).toBe("varies");
  });

  it("omits humanParties when unspecified (null column)", () => {
    const card = generateAgentCard(makeService(), [makeSkill({ human_parties: null })]);
    const skills = (card.extensions[DASKI_EXT_URI] as Record<string, unknown>)
      .skills as Record<string, Record<string, unknown>>;
    expect("humanParties" in skills["create-item"]).toBe(false);
  });

  it("declares the daski extension in capabilities.extensions[]", () => {
    const card = generateAgentCard(makeService(), [makeSkill()]);
    expect(card.capabilities.pushNotifications).toBe(false);
    const ext = card.capabilities.extensions ?? [];
    expect(ext).toContainEqual(
      expect.objectContaining({ uri: DASKI_EXT_URI }),
    );
  });

  it("emits an A2A v1.0-shaped supportedInterfaces entry (no top-level url/protocolVersion)", () => {
    // A2A v1.0 moved url, protocolVersion, and preferredTransport off the
    // root and into per-interface entries; transport was renamed to
    // protocolBinding. This test guards against regressions back to v0.3.
    const card = generateAgentCard(makeService(), [makeSkill()]);
    const root = card as unknown as Record<string, unknown>;
    expect(root.url).toBeUndefined();
    expect(root.protocolVersion).toBeUndefined();

    expect(card.supportedInterfaces).toHaveLength(1);
    const iface = card.supportedInterfaces[0] as unknown as Record<string, unknown>;
    expect(iface.url).toBe("https://provider.test/a2a/sample-service");
    expect(iface.protocolBinding).toBe("JSONRPC");
    expect(iface.protocolVersion).toBe("1.0");
    expect(iface.transport).toBeUndefined();
  });

  it("does NOT emit iconUrl or provider on the AgentCard (provider identity lives on the ERC-8004 registration)", () => {
    // Provider-level identity (logo, website, organization) is shared
    // across every service this provider offers and lives on the ERC-8004
    // registration file at /.well-known/agent.json. The per-service
    // AgentCard intentionally omits those slots even though A2A v1.0
    // defines them — duplicating provider info per-service drifts.
    const card = generateAgentCard(makeService(), [makeSkill()]);
    const root = card as unknown as Record<string, unknown>;
    expect(root.iconUrl).toBeUndefined();
    expect(root.provider).toBeUndefined();
  });

  it("places the support contact under the daski extension, not at the card root", () => {
    // Pre-A2A-v1.0 the support block lived at the card root. To keep the
    // standard schema clean, the contact moved into
    // extensions[DASKI_EXT_URI].support — anything reading card.support
    // will break.
    const card = generateAgentCard(makeService(), [makeSkill()]);
    const root = card as unknown as Record<string, unknown>;
    expect(root.support).toBeUndefined();

    const ext = card.extensions[DASKI_EXT_URI] as Record<string, unknown>;
    const support = ext.support as Record<string, unknown>;
    expect(support).toBeDefined();
    expect(support.email).toBe("support@example.com");
    expect(support.responseSla).toBeDefined();
  });

  it("emits assetTypes lifecycle map for asset-lifecycle services that touch known asset types", () => {
    // Asset-lifecycle services declare which states an asset can be in
    // and which skills transition between them, so agents can reason
    // about reversibility before they call a terminal skill.
    const ownershipSkill = makeSkill({
      skill_id: "refresh-item",
      requires_asset_ownership: true,
      asset_type: "item",
    });
    const card = generateAgentCard(makeService(), [ownershipSkill]);
    const ext = card.extensions[DASKI_EXT_URI] as Record<string, unknown>;
    const assetTypes = ext.assetTypes as Record<string, Record<string, unknown>>;
    expect(assetTypes).toBeDefined();
    expect(assetTypes.item).toBeDefined();
    // Canonical AssetStatus vocabulary (matches what the service reports).
    expect(assetTypes.item.terminalStates).toEqual(["deleted"]);
    const transitions = assetTypes.item.transitions as Array<Record<string, unknown>>;
    expect(transitions).toContainEqual({
      from: "active",
      to: "deleted",
      skill: "archive-item",
    });
  });

  it("omits assetTypes when no skill references a known asset type", () => {
    // A service that only ships open free skills shouldn't leak the
    // global ASSET_TYPES map.
    const ext = generateAgentCard(makeService(), [makeSkill()]).extensions[
      DASKI_EXT_URI
    ] as Record<string, unknown>;
    expect(ext.assetTypes).toBeUndefined();
  });

  it("marks owner-only skills as gateway-managed", () => {
    const managedSkill = makeSkill({
      skill_id: "update-item",
      requires_asset_ownership: true,
      asset_type: "item",
      required_fields: ["itemId", "value"],
    });
    const ext = generateAgentCard(makeService(), [managedSkill]).extensions[
      DASKI_EXT_URI
    ] as Record<string, unknown>;
    const skillsMeta = ext.skills as Record<string, Record<string, unknown>>;
    expect(skillsMeta["update-item"].access).toBe("gateway-managed-wallet");
    expect(skillsMeta["update-item"].callPhases).toBeUndefined();
  });

  it("bumps card version for the breaking taxonomy extension shape", () => {
    const card = generateAgentCard(makeService(), [makeSkill()]);
    expect(card.version).toBe("2.0.0");
  });

  it("emits optionalFields on skill metadata when the manifest declares them", () => {
    // Optional inputs such as an execution mode belong
    // on the AgentCard so buyer agents can pre-validate before paying
    // for a round-trip. The gateway's daski_search_services flattening
    // reads from here.
    const skillWithOptional = makeSkill({
      skill_id: "create-item",
      required_fields: ["title"],
      optional_fields: ["option"],
    });
    const ext = generateAgentCard(makeService(), [skillWithOptional])
      .extensions[DASKI_EXT_URI] as Record<string, unknown>;
    const skillsMeta = ext.skills as Record<string, Record<string, unknown>>;
    expect(skillsMeta["create-item"].optionalFields).toEqual(["option"]);
  });

  it("omits optionalFields from skill metadata when none are declared", () => {
    // Empty / null optionalFields shouldn't leak as an empty array — the
    // gateway treats absence as "no declared optionals".
    const ext = generateAgentCard(makeService(), [makeSkill()]).extensions[
      DASKI_EXT_URI
    ] as Record<string, unknown>;
    const skillsMeta = ext.skills as Record<string, Record<string, unknown>>;
    expect(skillsMeta["create-item"].optionalFields).toBeUndefined();
  });

  it("directs managed order and asset authority to the gateway", () => {
    const ext = generateAgentCard(makeService(), [makeSkill()]).extensions[
      DASKI_EXT_URI
    ] as Record<string, unknown>;
    expect(ext.auth).toEqual({
      openFreeA2aOnly: true,
      managedOrdersAndAssets: "Daski gateway wallet authorization",
    });
  });

  it("surfaces open versus gateway-managed access per skill", () => {
    const openFree = makeSkill({
      skill_id: "preview-item",
      pricing: { USDC: { type: "one-time", fixed_amount: "0" } },
      requires_asset_ownership: false,
    });
    const managedFree = makeSkill({
      skill_id: "update-item",
      pricing: { USDC: { type: "one-time", fixed_amount: "0" } },
      requires_asset_ownership: true,
    });
    const paid = makeSkill({
      skill_id: "create-item",
      pricing: { USDC: { type: "one-time", min_amount: "0" } },
      requires_asset_ownership: false,
    });
    const ext = generateAgentCard(makeService(), [openFree, managedFree, paid])
      .extensions[DASKI_EXT_URI] as Record<string, unknown>;
    const skillsMeta = ext.skills as Record<string, Record<string, unknown>>;
    expect(skillsMeta["preview-item"].access).toBe("open-free-a2a");
    expect(skillsMeta["update-item"].access).toBe("gateway-managed-wallet");
    expect(skillsMeta["create-item"].access).toBe("gateway-managed-wallet");
  });
});
