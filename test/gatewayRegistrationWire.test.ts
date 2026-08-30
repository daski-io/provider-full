import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import {
  normalizedGatewayOrigin,
  parsePublishedServiceContract,
  parseRegistrationPolicy,
  requestBoundedJson,
  signProviderEnvelope,
} from "../src/core/gatewayRegistration/wire.js";

const hash = (digit: string) => `0x${digit.repeat(64)}` as Hex;
const address = (digit: string) => `0x${digit.repeat(40)}` as const;
const serviceId = hash("1");

function contract(paymentRequired: boolean, action: Record<string, unknown> | null) {
  return {
    inputSchema: {
      type: "object",
      properties: { target: { type: "string" } },
      required: ["target"],
      additionalProperties: false,
    },
    resultSchema: {
      type: "object",
      properties: { accepted: { type: "boolean" } },
      required: ["accepted"],
      additionalProperties: false,
    },
    pricing: {
      USDC: {
        type: "one-time",
        fixed_amount: paymentRequired ? "1000000" : "0",
      },
    },
    paymentRequired,
    requiresAssetOwnership: action !== null,
    assetType: action ? "orbital-slot" : null,
    fulfillmentMode: "automated",
    capacity: { maxOpenOrders: 10 },
    deadlines: { dispatchSeconds: 60 },
    assetAction: action,
  };
}

function card() {
  const serviceSlug = "orbital-logistics";
  const serviceVersion = "1";
  const definitions = [
    {
      skillId: "move-orbit",
      contract: contract(false, {
        ownershipPolicy: "owner-only",
        effect: "mutate",
        replayPolicy: "stable-result",
        retentionSeconds: 3600,
      }),
    },
    {
      skillId: "reserve-orbit",
      contract: contract(true, null),
    },
  ].map((skill) => ({
    ...skill,
    acceptingNewOrders: true,
    skillContractHash: canonicalHash({
      schemaVersion: 1,
      serviceSlug,
      serviceVersion,
      skillId: skill.skillId,
      contract: skill.contract,
    }),
    presentation: {
      name: skill.skillId,
      description: skill.skillId,
      examples: [skill.skillId],
      tags: ["space"],
      documentationUrl: `https://provider.example/skills/${skill.skillId}.md`,
    },
  }));
  return {
    extensions: {
      "https://daski.xyz/a2a/v1": {
        legal: {
          marketplaceTermsUrl: "https://daski.example/terms",
          marketplacePrivacyUrl: "https://daski.example/privacy",
          providerLegalName: "Orbital Logistics LLC",
          providerTermsUrl: "https://provider.example/terms",
          providerPrivacyUrl: "https://provider.example/privacy",
        },
      },
      "https://daski.xyz/a2a/v2": {
        schemaVersion: 1,
        providerAgentId: "42",
        service: {
          serviceId,
          slug: serviceSlug,
          version: serviceVersion,
          categoryFamily: "space-operations",
          serviceType: "orbital-logistics",
          jurisdictions: ["LEO"],
          lifecycle: "asset-lifecycle",
          turnaroundEstimate: "one orbit",
          acceptingNewOrders: true,
        },
        standardRail: {
          origin: "https://provider.example",
          providerAudience: "https://provider.example/",
          quoteUrl: "https://provider.example/standard-rail/quote",
          dispatchUrl: "https://provider.example/standard-rail/dispatch",
          dispatchStatusUrl: "https://provider.example/standard-rail/dispatch/status",
          lifecycleUrl: "https://provider.example/standard-rail/lifecycle",
          assetQueryUrl: "https://provider.example/standard-rail/assets/query",
          assetActionUrl: "https://provider.example/standard-rail/assets/action",
        },
        skillContractSetHash: canonicalHash(definitions.map((skill) => ({
          skillId: skill.skillId,
          skillContractHash: skill.skillContractHash,
        }))),
        skills: definitions,
      },
    },
  };
}

describe("gateway registration wire contract", () => {
  it("accepts a previously unseen taxonomy and binds paid and free action skills", () => {
    const parsed = parsePublishedServiceContract(card(), {
      cardUrl: "https://provider.example/agent-cards/orbital-logistics.json",
      providerAgentId: "42",
      serviceId,
      serviceSlug: "orbital-logistics",
      serviceVersion: "1",
    });
    expect(parsed.skills.map((skill) => skill.skillId)).toEqual([
      "move-orbit",
      "reserve-orbit",
    ]);
    expect(parsed.skills[0]?.contract.assetAction).toMatchObject({
      effect: "mutate",
    });
    expect(parsed.legal.providerLegalName).toBe("Orbital Logistics LLC");
  });

  it("separates refreshable presentation from the signed service contract", () => {
    const expected = {
      cardUrl: "https://provider.example/agent-cards/orbital-logistics.json",
      providerAgentId: "42",
      serviceId,
      serviceSlug: "orbital-logistics",
      serviceVersion: "1",
    };
    const first = parsePublishedServiceContract(card(), expected);
    const refreshed = card();
    refreshed.extensions["https://daski.xyz/a2a/v2"].service.turnaroundEstimate =
      "two orbits";
    expect(parsePublishedServiceContract(refreshed, expected).serviceContractHash)
      .toBe(first.serviceContractHash);
    refreshed.extensions["https://daski.xyz/a2a/v1"].legal.providerTermsUrl =
      "https://provider.example/revised-terms";
    expect(parsePublishedServiceContract(refreshed, expected).serviceContractHash)
      .not.toBe(first.serviceContractHash);
  });

  it("rejects action drift that no longer matches the published contract hash", () => {
    const raw = card();
    const extension = raw.extensions["https://daski.xyz/a2a/v2"];
    extension.skills[0]!.contract.assetAction!.effect = "read";
    expect(() => parsePublishedServiceContract(raw, {
      cardUrl: "https://provider.example/agent-cards/orbital-logistics.json",
      providerAgentId: "42",
      serviceId,
      serviceSlug: "orbital-logistics",
      serviceVersion: "1",
    })).toThrow("published skill contract is invalid");
  });

  it("validates the gateway policy domain and signs a full-set provider intent", async () => {
    const policy = parseRegistrationPolicy({
      schemaVersion: 1,
      environment: "testnet",
      chainId: 84532,
      audience: "https://gateway.example",
      providerSignerKeyId: "provider-authority",
      serviceRegistry: address("2"),
      defaultMarketplaceEnabled: true,
      railPolicyHash: hash("3"),
      canonicalToken: address("4"),
      daskiCommissionReceiver: address("5"),
      commissionBps: 1000,
      splitterFactory: address("6"),
      splitterCreationCodeHash: hash("7"),
      splitterFactoryRuntimeCodeHash: hash("8"),
      intentMaximumLifetimeSeconds: 600,
    }, {
      gatewayOrigin: "https://gateway.example",
      chainId: 84532,
      serviceRegistry: address("2"),
      canonicalToken: address("4"),
    });
    const published = parsePublishedServiceContract(card(), {
      cardUrl: "https://provider.example/agent-cards/orbital-logistics.json",
      providerAgentId: "42",
      serviceId,
      serviceSlug: "orbital-logistics",
      serviceVersion: "1",
    });
    const signed = await signProviderEnvelope({
      artifactType: "ProviderServiceRegistrationIntentV1",
      environment: policy.environment,
      chainId: policy.chainId,
      audience: policy.audience,
      validForSeconds: policy.intentMaximumLifetimeSeconds,
      privateKey: `0x${"11".repeat(32)}`,
      payload: {
        providerAgentId: "42",
        serviceId,
        serviceSlug: "orbital-logistics",
        serviceVersion: "1",
        providerPayee: address("a"),
        serviceContractHash: published.serviceContractHash,
        skillContractSetHash: published.skillContractSetHash,
        skills: published.skills.map(({ skillId, skillContractHash }) => ({
          skillId,
          skillContractHash,
        })),
        railPolicyHash: policy.railPolicyHash,
        registrationNonce: hash("b"),
      },
    });
    expect(signed.payload.skills).toHaveLength(2);
    expect(signed.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(normalizedGatewayOrigin("https://gateway.example/"))
      .toBe("https://gateway.example");
    expect(() => normalizedGatewayOrigin("https://gateway.example/path"))
      .toThrow("HTTPS origin");
  });

  it("preserves bounded gateway error codes for crash recovery", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({
        error: {
          code: "PREPARED_REGISTRATION_DRIFT",
          message: "safe public error",
        },
      }),
      {
        status: 409,
        headers: { "content-type": "application/json" },
      },
    )));
    try {
      await expect(requestBoundedJson("https://gateway.example/register"))
        .rejects.toMatchObject({
          status: 409,
          code: "PREPARED_REGISTRATION_DRIFT",
        });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
