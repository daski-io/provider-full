import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadProviderStandardRailConfig } from "../src/core/standardRail/config.js";
import { compileProviderSchema, validateProviderRequest } from "../src/core/standardRail/schema.js";
import { recipeNonce, recipeNonceV2 } from "../src/core/standardRail/canonical.js";
import { shouldLinkAssetOwnership } from "../src/core/standardRail/dispatch.js";
import { signProviderOutcomeOffer } from "../src/core/standardRail/offer.js";
import type { RuntimeListingHead } from "../src/core/gatewayRegistration/runtimeCatalog.js";
import {
  buildGlobalPolicyFixture,
  buildRuntimeHeadFixture,
  encodeGlobalPolicy,
  testGatewaySigner,
} from "./runtimeCatalogFixture.js";

const authorityKey = `0x${"11".repeat(32)}` as Hex;
const providerWalletKey = `0x${"44".repeat(32)}` as Hex;
const providerWallet = privateKeyToAccount(providerWalletKey).address;
const hash = (byte: string) => `0x${byte.repeat(64)}`;

const outcomeLaunchPolicy = {
  paidSkills: [
    { serviceSlug: "catalog-a", skillId: "paid-alpha" },
    { serviceSlug: "catalog-b", skillId: "paid-beta" },
    { serviceSlug: "catalog-c", skillId: "paid-gamma" },
  ],
} as const;

const globalPolicy = await buildGlobalPolicyFixture();

function fixtureHeads(): RuntimeListingHead[] {
  return outcomeLaunchPolicy.paidSkills.map((skill) => buildRuntimeHeadFixture({
    globalPolicy,
    serviceSlug: skill.serviceSlug,
    skillId: skill.skillId,
    agentWallet: providerWallet,
  }));
}

function environment(): NodeJS.ProcessEnv {
  return {
    PROVIDER_WALLET_PRIVATE_KEY: providerWalletKey,
    BASE_RPC_URL: "https://rpc.example",
    CHAIN_ID: "84532",
    USDC_ADDRESS: "0x6666666666666666666666666666666666666666",
    SANCTIONS_ORACLE_ADDRESS: "0x5555555555555555555555555555555555555555",
    REPUTATION_STORAGE_ADDRESS: "0x4545454545454545454545454545454545454545",
    EAS_ADDRESS: "0x4646464646464646464646464646464646464646",
    EAS_RUNTIME_CODE_HASH: hash("f"),
    EAS_OUTCOME_SCHEMA_UID: hash("e"),
    STANDARD_RAIL_ENVIRONMENT: "testnet",
    STANDARD_RAIL_GATEWAY_AUDIENCE: "https://gateway.example",
    STANDARD_RAIL_GATEWAY_ORIGIN: "https://gateway.example",
    STANDARD_RAIL_PROVIDER_AUDIENCE: "https://provider.example",
    STANDARD_RAIL_GATEWAY_SIGNER: testGatewaySigner,
    STANDARD_RAIL_PROVIDER_CONTROL_PROFILE_HASH: hash("3"),
    STANDARD_RAIL_GLOBAL_POLICY_JSON: encodeGlobalPolicy(globalPolicy),
  };
}

function loadConfig(
  env: NodeJS.ProcessEnv = environment(),
  heads: RuntimeListingHead[] = fixtureHeads(),
  warn?: (message: string) => void,
) {
  return loadProviderStandardRailConfig(outcomeLaunchPolicy, env, {
    headsOverride: heads,
    warn,
  });
}

describe("provider standard rail configuration", () => {
  it("keeps any-payer execution from taking over the asset ownership link", () => {
    expect(shouldLinkAssetOwnership("any-payer")).toBe(false);
    expect(shouldLinkAssetOwnership("owner-only")).toBe(true);
  });

  it("signs a closed provider outcome offer", async () => {
    const offer = await signProviderOutcomeOffer({
      artifactType: "ProviderOutcomeOfferV1",
      schemaVersion: 1,
      environment: "testnet",
      chainId: 84532,
      audience: "https://gateway.example",
      signerKeyId: "provider-authority",
      issuedAt: 100,
      validBefore: 200,
      payload: {
        listingManifestHash: hash("1") as Hex,
        outcomeId: "stock-note-v1",
        skillId: "create-note",
        providerAgentId: "provider-1",
        providerPayee: "0x1111111111111111111111111111111111111111",
        pricingMode: "dynamic",
        fixedGrossAmount: "0",
        quotePolicyHash: hash("2") as Hex,
        capacityPolicyHash: hash("3") as Hex,
        deadlinePolicyHash: hash("4") as Hex,
        deliveryCommitment: hash("5") as Hex,
        termsHash: hash("6") as Hex,
        issuedAt: 100,
        validBefore: 200,
        offerNonce: hash("8") as Hex,
      },
    }, authorityKey);
    const { signature, ...unsignedOffer } = offer;
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    await expect(signProviderOutcomeOffer({
      ...unsignedOffer,
      payload: { ...offer.payload, pricingMode: "unsupported" as "fixed" },
    }, authorityKey)).rejects.toThrow("payload is invalid");
  });

  it("materializes catalog heads into consolidated recipe-bound-v2 outcomes", async () => {
    const config = await loadConfig();
    const outcome = config.outcomes.get("paid-alpha");
    expect(outcome?.bindingProfile).toBe("recipe-bound-v2");
    expect(outcome?.maxOpenOrders).toBe(10);
    expect(outcome?.dispatchDeadlineSeconds).toBe(300);
    expect(outcome?.listingManifestHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(outcome?.providerOfferHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(config.gatewayDispatchSigner).toBe(config.gatewayQuoteSigner);
    expect(config.providerAuthorityKey).toBe(config.terminalAttestationKey);
    expect([...config.outcomes.keys()].sort()).toEqual([
      "paid-alpha", "paid-beta", "paid-gamma",
    ]);
  });

  it("carries the Option A slot layout end to end", async () => {
    const config = await loadConfig();
    const outcome = config.outcomes.get("paid-beta")!;
    const head = fixtureHeads().find((entry) => entry.skillId === "paid-beta")!;
    expect(outcome.listingManifestHash).toBe(head.runtimeCommitmentHash);
    expect(outcome.providerOfferHash).toBe(head.runtimeCommitment.providerIntentHash);
    expect(outcome.outcomeIdHash).toBe(head.listingKey);
    expect(outcome.listingCommitmentHash).toBe(head.runtimeCommitment.preparationHash);
  });

  it("accepts the provider's exact outcome set instead of a core-owned service list", async () => {
    const heads = [buildRuntimeHeadFixture({
      globalPolicy,
      serviceSlug: "example",
      skillId: "create-note",
      agentWallet: providerWallet,
    })];
    const config = await loadProviderStandardRailConfig(
      { paidSkills: [{ serviceSlug: "example", skillId: "create-note" }] },
      environment(),
      { headsOverride: heads },
    );
    expect([...config.outcomes.keys()]).toEqual(["create-note"]);
  });

  it("rejects duplicate service and skill entries in provider launch policy", async () => {
    await expect(loadProviderStandardRailConfig({
      paidSkills: [
        ...outcomeLaunchPolicy.paidSkills,
        { serviceSlug: "catalog-a", skillId: "paid-alpha" },
      ],
    }, environment(), { headsOverride: [] })).rejects.toThrow(/paid-skill launch policy is invalid/);
  });

  it("boots with an unregistered paid skill and reports it, never silently", async () => {
    const heads = fixtureHeads().slice(0, 2);
    const warnings: string[] = [];
    const config = await loadConfig(environment(), heads, (message) => warnings.push(message));
    expect(config.outcomes.size).toBe(2);
    expect(warnings.join("\n")).toMatch(/catalog-c:paid-gamma has no promoted runtime listing/);
  });

  it("fails closed on a paid head that is not an installed paid skill", async () => {
    const heads = [...fixtureHeads(), buildRuntimeHeadFixture({
      globalPolicy,
      serviceSlug: "unknown-service",
      skillId: "unknown-skill",
      agentWallet: providerWallet,
    })];
    await expect(loadConfig(environment(), heads))
      .rejects.toThrow(/not an installed paid skill/);
  });

  it("requires the deployment-owned global rail policy", async () => {
    const env = environment();
    delete env.STANDARD_RAIL_GLOBAL_POLICY_JSON;
    await expect(loadConfig(env)).rejects.toThrow(/STANDARD_RAIL_GLOBAL_POLICY_JSON is required/);
    env.STANDARD_RAIL_GLOBAL_POLICY_JSON = "{not json";
    await expect(loadConfig(env)).rejects.toThrow(/malformed/);
  });

  it("rejects a global policy signed by an unexpected key", async () => {
    const env = environment();
    const foreign = await buildGlobalPolicyFixture({ signerKey: `0x${"55".repeat(32)}` as Hex });
    env.STANDARD_RAIL_GLOBAL_POLICY_JSON = encodeGlobalPolicy(foreign);
    await expect(loadConfig(env)).rejects.toThrow(/signature is invalid/);
  });

  it("requires the complete end-of-block activation checkpoint", async () => {
    const heads = fixtureHeads();
    const checkpoint = heads[0]!.bundle.activationCheckpoint!;
    (checkpoint as unknown as Record<string, unknown>).splitterActivationBlockHash = undefined;
    await expect(loadConfig(environment(), heads)).rejects.toThrow(/is invalid|missing/);
  });

  it("rejects a checkpoint before splitter deployment", async () => {
    const heads = fixtureHeads();
    heads[0]!.bundle.activationCheckpoint!.splitterActivationBlockNumber = "99";
    await expect(loadConfig(environment(), heads)).rejects.toThrow(/activation checkpoint/);
  });

  it("rejects a head whose creation code does not match the promoted policy pin", async () => {
    const env = environment();
    const tampered = { ...globalPolicy, splitterCreationCode: "0x6001" as Hex };
    env.STANDARD_RAIL_GLOBAL_POLICY_JSON = encodeGlobalPolicy(tampered);
    await expect(loadConfig(env)).rejects.toThrow(
      /creation code differs from the promoted policy pin|pins a different rail policy/,
    );
  });

  it("rejects a tampered runtime commitment", async () => {
    const heads = fixtureHeads();
    (heads[0]!.runtimeCommitment as { commissionBps: number }).commissionBps = 400;
    await expect(loadConfig(environment(), heads))
      .rejects.toThrow(/runtime commitment hash does not match its content/);
  });

  it("rejects a paid head whose card pricing is free", async () => {
    const heads = fixtureHeads();
    heads[2] = buildRuntimeHeadFixture({
      globalPolicy,
      serviceSlug: "catalog-c",
      skillId: "paid-gamma",
      agentWallet: providerWallet,
      pricing: { USDC: { type: "one-time", fixed_amount: "0" } },
    });
    await expect(loadConfig(environment(), heads)).rejects.toThrow(/card pricing is free/);
  });

  it("uses the primary RPC with an optional fallback", async () => {
    const env = environment();
    env.BASE_RPC_FALLBACK_URLS = "https://rpc-fallback.example";
    expect((await loadConfig(env)).evidenceRpcUrls).toEqual([
      "https://rpc.example/",
      "https://rpc-fallback.example/",
    ]);
  });

  it("uses the launch reputation retry schedule without configuration", async () => {
    expect((await loadConfig()).reputationRetryDelaysSeconds)
      .toEqual([5, 60, 3_000, 30_000]);
  });

  it("pins the reviewed EAS runtime code hash", async () => {
    expect((await loadConfig()).easRuntimeCodeHash).toBe(hash("f"));
    for (const invalid of [undefined, "0x1234", `0x${"00".repeat(32)}`]) {
      const env = environment();
      env.EAS_RUNTIME_CODE_HASH = invalid;
      await expect(loadConfig(env)).rejects.toThrow(/EAS_RUNTIME_CODE_HASH/);
    }
  });

  it("derives fixed pricing from the card contract floor", async () => {
    const heads = fixtureHeads();
    heads[0] = buildRuntimeHeadFixture({
      globalPolicy,
      serviceSlug: "catalog-a",
      skillId: "paid-alpha",
      agentWallet: providerWallet,
      pricing: { USDC: { type: "one-time", fixed_amount: "17990000" } },
      capacity: { maxOpenOrders: 4 },
      deadlines: { dispatchSeconds: 600 },
    });
    const config = await loadConfig(environment(), heads);
    const outcome = config.outcomes.get("paid-alpha")!;
    expect(outcome.pricingMode).toBe("fixed");
    expect(outcome.fixedGrossAmount).toBe("17990000");
    expect(outcome.quoteMaximumLifetimeSeconds).toBe(0);
    expect(outcome.maxOpenOrders).toBe(4);
    expect(outcome.dispatchDeadlineSeconds).toBe(600);
  });

  it("rejects open nested request objects", () => {
    expect(() => compileProviderSchema({
      type: "object",
      properties: { nested: { type: "object", properties: {} } },
      additionalProperties: false,
    })).toThrow(/close or bound object/);
    expect(() => compileProviderSchema({
      type: "object",
      properties: { unconstrained: {} },
      additionalProperties: false,
    })).toThrow(/explicit type/);
    expect(() => compileProviderSchema({
      type: "object",
      properties: { conditional: { anyOf: [{ type: "string" }, { type: "object" }] } },
      additionalProperties: false,
    })).toThrow(/unsupported keyword/);
  });

  it("validates request types and rejects extra fields", () => {
    const validate = compileProviderSchema({
      type: "object",
      properties: { text: { type: "string", minLength: 1 } },
      required: ["text"],
      additionalProperties: false,
    });
    expect(() => validateProviderRequest(validate, { text: "hello" })).not.toThrow();
    expect(() => validateProviderRequest(validate, { text: "hello", hidden: true })).toThrow(/provider outcome schema/);
  });

  it("derives the interoperable recipe nonce", () => {
    expect(recipeNonce({
      chainId: 84532,
      canonicalToken: "0x1111111111111111111111111111111111111111",
      payer: "0x2222222222222222222222222222222222222222",
      splitter: "0x3333333333333333333333333333333333333333",
      grossAmount: 123456n,
      listingManifestHash: hash("4") as Hex,
      providerOfferHash: hash("5") as Hex,
      quoteHash: hash("6") as Hex,
      canonicalRequestHash: hash("7") as Hex,
      orderNonce: hash("8") as Hex,
    })).toBe("0x3211fa4ddf9da6c936cf364755153e800ce61ae0418afb54775fc559770ec1a6");
  });

  it("separates the V2 order-binding domain from V1", () => {
    const shared = {
      chainId: 84532,
      canonicalToken: "0x1111111111111111111111111111111111111111",
      payer: "0x2222222222222222222222222222222222222222",
      splitter: "0x3333333333333333333333333333333333333333",
      grossAmount: 123456n,
      quoteHash: hash("6") as Hex,
      canonicalRequestHash: hash("7") as Hex,
      orderNonce: hash("8") as Hex,
    } as const;
    const v2 = recipeNonceV2({
      ...shared,
      runtimeCommitmentHash: hash("4") as Hex,
      providerIntentHash: hash("5") as Hex,
    });
    const v1 = recipeNonce({
      ...shared,
      listingManifestHash: hash("4") as Hex,
      providerOfferHash: hash("5") as Hex,
    });
    expect(v2).toMatch(/^0x[0-9a-f]{64}$/);
    expect(v2).not.toBe(v1);
  });
});
