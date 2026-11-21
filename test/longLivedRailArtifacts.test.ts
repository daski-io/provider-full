import { afterEach, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalHash, unsignedEnvelopeHash } from "../src/core/standardRail/canonical.js";
import { loadProviderStandardRailConfig, type ProviderStandardRailConfig } from "../src/core/standardRail/config.js";
import { destructiveClaim } from "../src/core/standardRail/destructiveAction.js";
import type { SignedEnvelope } from "../src/core/standardRail/types.js";
import {
  assertProviderWalletAvailable,
  loadProviderWalletConfig,
  type AssetActionDefinitionV1,
  type ProviderServicingAdmissionV1,
} from "../src/core/standardRail/walletConfig.js";
import { utf8Hash } from "../src/core/standardRail/walletAuthorization.js";
import {
  AFTER_EXPIRY,
  ARTIFACT_ISSUED_AT,
  ENVELOPE_VALID_BEFORE,
  RAIL_ADMISSION_VALID_BEFORE,
  SERVICING_VALID_BEFORE,
  restoreClock,
  setClock,
} from "./longLivedRailDates.js";
import {
  buildGlobalPolicyFixture,
  buildRuntimeHeadFixture,
  encodeGlobalPolicy,
  testGatewaySigner,
  testGatewaySignerKey,
} from "./runtimeCatalogFixture.js";

/*
 * The long-lived standard-rail artifacts a provider loads at start (the
 * global rail policy, the servicing admission, the asset-action catalog and
 * its definitions) keep their signed dates, and the provider keeps serving
 * with them after those dates. Every signature, signer, network and hash
 * binding is still enforced.
 */

const hash = (byte: string): Hex => `0x${byte.repeat(64)}`;
const providerWalletKey = `0x${"44".repeat(32)}` as Hex;
const providerWallet = privateKeyToAccount(providerWalletKey);
const strangerKey = `0x${"55".repeat(32)}` as Hex;
const gatewayAudience = "https://gateway.example";

const paidSkills = [
  { serviceSlug: "catalog-a", skillId: "paid-alpha" },
  { serviceSlug: "catalog-b", skillId: "paid-beta" },
] as const;
const policyDates = {
  issuedAt: ARTIFACT_ISSUED_AT,
  validBefore: ENVELOPE_VALID_BEFORE,
  admissionValidBefore: RAIL_ADMISSION_VALID_BEFORE,
  recoveryValidBefore: SERVICING_VALID_BEFORE,
};
const globalPolicy = await buildGlobalPolicyFixture(policyDates);

const heads = (policy = globalPolicy) => paidSkills.map((skill) => buildRuntimeHeadFixture({
  globalPolicy: policy, serviceSlug: skill.serviceSlug, skillId: skill.skillId, agentWallet: providerWallet.address,
}));

function railEnvironment(policy = globalPolicy): NodeJS.ProcessEnv {
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
    STANDARD_RAIL_GATEWAY_AUDIENCE: gatewayAudience,
    STANDARD_RAIL_GATEWAY_ORIGIN: gatewayAudience,
    STANDARD_RAIL_PROVIDER_AUDIENCE: "https://provider.example",
    STANDARD_RAIL_GATEWAY_SIGNER: testGatewaySigner,
    STANDARD_RAIL_PROVIDER_CONTROL_PROFILE_HASH: hash("3"),
    STANDARD_RAIL_GLOBAL_POLICY_JSON: encodeGlobalPolicy(policy),
  };
}

const bootRail = (env = railEnvironment(), listingHeads = heads()) =>
  loadProviderStandardRailConfig({ paidSkills }, env, { headsOverride: listingHeads });

// The wallet servicing artifacts, signed with the long-lived dates.
const schema = (field: string) => ({
  type: "object", properties: { [field]: { type: "string" } }, required: [field], additionalProperties: false,
});
const actionSpecs = [
  ["get-item-info", false, "stable-result"],
  ["rotate-item-secret", false, "redacted-after-window"],
  ["delete-secondary-item", true, "stable-result"],
  ["download-tertiary-item-artifact", false, "regenerate-ephemeral"],
] as const;
const walletLaunchPolicy = {
  assetActions: actionSpecs.map(([actionId, destructive, replayPolicy]) => ({
    serviceSlug: "service", actionId, effect: destructive ? "destructive" as const : "mutate" as const,
    replayPolicy, inputSchema: schema("target"), resultSchema: schema("status"),
  })),
};

function definition(
  actionId: string, destructive: boolean, replayPolicy: AssetActionDefinitionV1["replayPolicy"],
): AssetActionDefinitionV1 {
  const value = {
    providerAgentId: "1", serviceId: hash("a"), serviceSlug: "service", actionId, assetType: "asset",
    ownershipPolicy: "owner-only" as const, destructive,
    requestSchema: schema("target"), responseSchema: schema("status"),
    confirmationSummarySchema: destructive ? schema("target") : null,
    confirmationSummaryTemplate: destructive ? { target: "asset-1" } : null,
    endpoint: "https://provider.example/standard-rail/assets/action", replayPolicy, retentionSeconds: 3_600,
    validFrom: ARTIFACT_ISSUED_AT, validBefore: SERVICING_VALID_BEFORE,
  };
  return { ...value, actionDefinitionHash: canonicalHash(value) };
}

async function sign<T>(artifactType: string, payload: T, key: Hex = testGatewaySignerKey): Promise<SignedEnvelope<T>> {
  const unsigned = {
    artifactType, schemaVersion: 1 as const, environment: "testnet", chainId: 84_532, audience: gatewayAudience,
    signerKeyId: "gateway-protocol", issuedAt: ARTIFACT_ISSUED_AT, validBefore: ENVELOPE_VALID_BEFORE, payload,
  };
  const signature = await privateKeyToAccount(key).signMessage({
    message: { raw: unsignedEnvelopeHash(unsigned as unknown as Record<string, unknown>) },
  });
  return { ...unsigned, signature };
}

async function servicing(actions = actionSpecs.map(([id, destructive, replay]) => definition(id, destructive, replay))) {
  const catalog = await sign("ProviderAssetActionCatalogV1", {
    providerAgentId: "1", providerControlProfileHash: hash("7"), servicingProfileEpoch: 1,
    actionCatalogSchemaHash: hash("c"), actionCatalogEpoch: 1, actions,
  });
  const admission: ProviderServicingAdmissionV1 = {
    providerAgentId: "1", providerControlProfileHash: hash("7"), servicingProfileEpoch: 1,
    actionCatalogHash: canonicalHash(catalog), actionCatalogSchemaHash: hash("c"), actionCatalogEpoch: 1,
    servicingEnabled: true, previousAdmissionHash: hash("0"),
    validFrom: ARTIFACT_ISSUED_AT, validBefore: SERVICING_VALID_BEFORE,
  };
  return { catalog, admission };
}

function walletStandard(): ProviderStandardRailConfig {
  return {
    environment: "testnet", chainId: 84_532, gatewayAudience, gatewayOrigin: gatewayAudience,
    providerAudience: "https://provider.example", gatewayArtifactSigners: [testGatewaySigner],
    gatewayDispatchSigner: testGatewaySigner, gatewayPreviousSigner: null,
    providerAuthorityKey: providerWallet.address, providerAuthorityPrivateKey: providerWalletKey,
  } as unknown as ProviderStandardRailConfig;
}

async function bootWallet(artifacts: { catalog: unknown; admission: unknown }, key?: Hex) {
  return loadProviderWalletConfig(walletStandard(), walletLaunchPolicy, {
    STANDARD_RAIL_PROVIDER_CONTROL_PROFILE_HASH: hash("7"),
    STANDARD_RAIL_ASSET_ACTION_CATALOG_JSON: JSON.stringify(artifacts.catalog),
    STANDARD_RAIL_SERVICING_ADMISSION_JSON: JSON.stringify(
      await sign("ProviderServicingAdmissionV1", artifacts.admission, key),
    ),
    PROVIDER_DATA_ENCRYPTION_KEY: `0x${"ab".repeat(32)}`,
  });
}

afterEach(restoreClock);

describe.each(AFTER_EXPIRY)("long-lived rail artifacts past their signed dates, at %s", (clock) => {
  it("starts from the global policy and builds every catalog outcome with the same rail bindings", async () => {
    const now = setClock(clock);
    expect(now).toBeGreaterThan(ENVELOPE_VALID_BEFORE);
    const config = await bootRail();
    expect([...config.outcomes.keys()].sort()).toEqual(["paid-alpha", "paid-beta"]);
    for (const outcome of config.outcomes.values()) {
      expect(outcome.activeRailProfileHash).toBe(canonicalHash(globalPolicy.activeRailProfile));
      expect(outcome.policyVersionHash).toBe(
        heads().find((head) => head.skillId === outcome.skillId)!.runtimeCommitment.policyVersionHash,
      );
    }
  });

  it("still refuses a global policy with a broken signature, an untrusted signer or another network", async () => {
    setClock(clock);
    const broken = structuredClone(globalPolicy);
    broken.activeRailProfile.signature = `0x${"11".repeat(65)}` as Hex;
    await expect(bootRail(railEnvironment(broken))).rejects.toThrow(/ActiveRailProfileV1 signature is invalid/);
    const foreign = await buildGlobalPolicyFixture({ ...policyDates, signerKey: strangerKey });
    await expect(bootRail(railEnvironment(foreign))).rejects.toThrow(/signature is invalid/);
    const mainnet = await buildGlobalPolicyFixture({ ...policyDates, environment: "mainnet" });
    await expect(bootRail(railEnvironment(mainnet))).rejects.toThrow(/domain is invalid/);
  });

  it("still refuses listings whose policyVersionHash the policy does not reproduce", async () => {
    setClock(clock);
    // Re-signing the policy with new dates changes its hashes, which no existing listing pins.
    const resigned = await buildGlobalPolicyFixture({ ...policyDates, validBefore: ENVELOPE_VALID_BEFORE + 5 * 31_536_000 });
    await expect(bootRail(railEnvironment(resigned), heads(globalPolicy)))
      .rejects.toThrow(/pins a different rail policy than the global bundle reproduces/);
  });

  it("starts wallet servicing from the admission and catalog and serves every action", async () => {
    const now = setClock(clock);
    const wallet = await bootWallet(await servicing());
    expect(wallet.admission.validBefore).toBeLessThan(now);
    for (const action of wallet.catalog.actions) {
      await expect(assertProviderWalletAvailable(wallet, action)).resolves.toBeUndefined();
    }
  });

  it("stages a destructive action with a deadline from its own retention", async () => {
    const now = setClock(clock);
    const wallet = await bootWallet(await servicing());
    const action = wallet.catalog.actions.find((item) => item.destructive)!;
    const claim = destructiveClaim({
      definition: action, wallet, executionId: utf8Hash("execution"),
      request: { actionId: action.actionId, providerAssetId: "asset-1", input: { target: "item-1" } },
    });
    expect(claim.earliestExecutionAt).toBe(now + 600);
    expect(claim.stageValidBefore).toBe(now + action.retentionSeconds);
  });

  it("still refuses wallet artifacts with a broken signature, an untrusted signer or a broken binding", async () => {
    const now = setClock(clock);
    const artifacts = await servicing();
    const forged = { ...artifacts, catalog: { ...artifacts.catalog, signature: `0x${"11".repeat(65)}` } };
    await expect(bootWallet(forged)).rejects.toThrow(/ProviderAssetActionCatalogV1 signature is invalid/);
    await expect(bootWallet(artifacts, strangerKey)).rejects.toThrow(/ProviderServicingAdmissionV1 signature is invalid/);
    await expect(bootWallet({ ...artifacts, admission: { ...artifacts.admission, actionCatalogHash: hash("9") } }))
      .rejects.toThrow(/wallet servicing artifacts are inconsistent/);
    await expect(bootWallet({ ...artifacts, admission: { ...artifacts.admission, servicingEnabled: false } }))
      .rejects.toThrow(/inconsistent/);
    await expect(bootWallet({ ...artifacts, admission: { ...artifacts.admission, validFrom: now + 3_600 } }))
      .rejects.toThrow(/inconsistent/);
    const [first, ...rest] = artifacts.catalog.payload.actions;
    await expect(bootWallet(await servicing([{ ...first!, retentionSeconds: 7_200 }, ...rest])))
      .rejects.toThrow(/asset action definition is invalid/);
  });
});
