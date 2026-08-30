import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalHash, unsignedEnvelopeHash } from "../src/core/standardRail/canonical.js";
import type { ProviderStandardRailConfig } from "../src/core/standardRail/config.js";
import type { SignedEnvelope } from "../src/core/standardRail/types.js";
import {
  assertProviderWalletAvailable,
  loadProviderWalletConfig,
  type AssetActionDefinitionV1,
  type ProviderAssetActionCatalogV1,
  type ProviderServicingAdmissionV1,
} from "../src/core/standardRail/walletConfig.js";

const gatewayKey = `0x${"55".repeat(32)}` as Hex;
const providerKey = `0x${"66".repeat(32)}` as Hex;
const gateway = privateKeyToAccount(gatewayKey);
const provider = privateKeyToAccount(providerKey);
const hash = (nibble: string): Hex => `0x${nibble.repeat(64)}`;
const FAR_FUTURE = 4_000_000_000;

const actions = [
  ["get-item-info", false, "stable-result"],
  ["list-item-components", false, "stable-result"],
  ["set-item-component", false, "stable-result"],
  ["delete-item-component", false, "stable-result"],
  ["get-secondary-item-info", false, "stable-result"],
  ["rotate-item-secret", false, "redacted-after-window"],
  ["delete-secondary-item", true, "stable-result"],
  ["get-tertiary-item-info", false, "stable-result"],
  ["list-tertiary-item-artifacts", false, "stable-result"],
  ["download-tertiary-item-artifact", false, "regenerate-ephemeral"],
] as const;

const schema = (field: string) => ({
  type: "object",
  properties: { [field]: { type: "string" } },
  required: [field],
  additionalProperties: false,
});

const walletLaunchPolicy = {
  assetActions: actions.map(([actionId, destructive, replayPolicy]) => ({
    serviceSlug: "service",
    actionId,
    effect: destructive ? "destructive" as const : "mutate" as const,
    replayPolicy,
    inputSchema: schema("target"),
    resultSchema: schema("status"),
  })),
};

function action(
  actionId: string,
  destructive: boolean,
  replayPolicy: AssetActionDefinitionV1["replayPolicy"],
): AssetActionDefinitionV1 {
  const value = {
    providerAgentId: "1",
    serviceId: hash("a"),
    serviceSlug: "service",
    actionId,
    assetType: "asset",
    ownershipPolicy: "owner-only" as const,
    destructive,
    requestSchema: schema("target"),
    responseSchema: schema("status"),
    confirmationSummarySchema: destructive ? schema("target") : null,
    confirmationSummaryTemplate: destructive ? { target: "asset-1" } : null,
    endpoint: `/standard/actions/${actionId}`,
    replayPolicy,
    retentionSeconds: 3_600,
    validFrom: 1,
    validBefore: FAR_FUTURE,
  };
  return { ...value, actionDefinitionHash: canonicalHash(value) };
}

async function envelope<T>(artifactType: string, payload: T): Promise<SignedEnvelope<T>> {
  const unsigned = {
    artifactType,
    schemaVersion: 1 as const,
    environment: "testnet",
    chainId: 84_532,
    audience: "https://gateway.example",
    signerKeyId: "gateway-protocol",
    issuedAt: 1,
    validBefore: FAR_FUTURE,
    payload,
  };
  const signature = await gateway.signMessage({
    message: { raw: unsignedEnvelopeHash(unsigned as unknown as Record<string, unknown>) },
  });
  return { ...unsigned, signature };
}

function standard(): ProviderStandardRailConfig {
  return {
    environment: "testnet",
    chainId: 84_532,
    gatewayAudience: "https://gateway.example",
    gatewayOrigin: "https://gateway.example",
    providerAudience: "https://provider.example",
    gatewayDispatchSigner: gateway.address,
    gatewayQuoteSigner: gateway.address,
    gatewayLifecycleSigner: gateway.address,
    providerAuthorityKey: provider.address,
    providerAuthorityPrivateKey: providerKey,
    terminalAttestationPrivateKey: providerKey,
    terminalAttestationKey: provider.address,
    evidenceRpcUrls: ["https://rpc.example/"],
    outcomes: new Map(),
    globalPolicy: {
      chainEvidencePolicy: {
        payload: {
          canonicalToken: "0x6666666666666666666666666666666666666666",
          canonicalTokenRuntimeCodeHash: hash("1"),
          tokenImplementationAddress: "0x7777777777777777777777777777777777777777",
          tokenImplementationRuntimeCodeHash: hash("2"),
          tokenImplementationSlot: hash("3"),
          tokenDomainSeparator: hash("4"),
        },
      },
      sanctionsOracleRuntimeCodeHash: hash("d"),
    } as unknown as ProviderStandardRailConfig["globalPolicy"],
    finalityConfirmations: 12,
    sanctionsOracleAddress: "0x5555555555555555555555555555555555555555",
    reputationContract: "0x4545454545454545454545454545454545454545",
    easAddress: "0x4646464646464646464646464646464646464646",
    easRuntimeCodeHash: hash("f"),
    reputationOutcomeSchemaUid: hash("e"),
    reputationRetryDelaysSeconds: [5, 60, 3_000, 30_000],
  };
}

async function fixture() {
  const catalog: ProviderAssetActionCatalogV1 = {
    providerAgentId: "1",
    providerControlProfileHash: hash("7"),
    servicingProfileEpoch: 1,
    actionCatalogSchemaHash: hash("c"),
    actionCatalogEpoch: 1,
    actions: actions.map(([id, destructive, replay]) => action(id, destructive, replay)),
  };
  const catalogEnvelope = await envelope("ProviderAssetActionCatalogV1", catalog);
  const admission: ProviderServicingAdmissionV1 = {
    providerAgentId: "1",
    providerControlProfileHash: catalog.providerControlProfileHash,
    servicingProfileEpoch: 1,
    actionCatalogHash: canonicalHash(catalogEnvelope),
    actionCatalogSchemaHash: catalog.actionCatalogSchemaHash,
    actionCatalogEpoch: 1,
    servicingEnabled: true,
    previousAdmissionHash: hash("0"),
    validFrom: 1,
    validBefore: FAR_FUTURE,
  };
  return {
    env: {
      STANDARD_RAIL_PROVIDER_CONTROL_PROFILE_HASH: catalog.providerControlProfileHash,
      STANDARD_RAIL_SERVICING_ADMISSION_JSON: JSON.stringify(
        await envelope("ProviderServicingAdmissionV1", admission),
      ),
      STANDARD_RAIL_ASSET_ACTION_CATALOG_JSON: JSON.stringify(catalogEnvelope),
      PROVIDER_DATA_ENCRYPTION_KEY: `0x${"ab".repeat(32)}`,
    },
  };
}

describe("provider wallet launch defaults", () => {
  it("uses the provider wallet, derived cursor key, fixed limits, and gateway paths", async () => {
    const { env } = await fixture();
    const loaded = await loadProviderWalletConfig(standard(), walletLaunchPolicy, env);
    expect(loaded.assetResponsePrivateKey).toBe(providerKey);
    expect(loaded.assetResponseKey).toBe(provider.address);
    expect(loaded.assetResponseKeyId).toBe("provider-wallet");
    expect(loaded.cursorKeyRing.activeKeyId).toBe("derived-v1");
    expect(loaded.cursorKeyRing.keys.get("derived-v1")).toHaveLength(32);
    expect(loaded.destructiveActionDelaySeconds).toBe(600);
    expect(loaded.abuse.requestsGlobalPerMinute).toBe(300);
    expect(loaded.gatewayAssetQueryUrl).toBe("https://gateway.example/wallet/assets");
    expect(loaded.gatewayAssetActionUrl).toBe("https://gateway.example/wallet/assets/action");
    await expect(assertProviderWalletAvailable(loaded, loaded.catalog.actions[0]))
      .resolves.toBeUndefined();
  });

  it("rejects a catalog outside the reviewed launch surface", async () => {
    const { env } = await fixture();
    const parsed = JSON.parse(env.STANDARD_RAIL_ASSET_ACTION_CATALOG_JSON);
    parsed.payload.actions.pop();
    const tampered = await envelope("ProviderAssetActionCatalogV1", parsed.payload);
    env.STANDARD_RAIL_ASSET_ACTION_CATALOG_JSON = JSON.stringify(tampered);
    const admission = JSON.parse(env.STANDARD_RAIL_SERVICING_ADMISSION_JSON);
    admission.payload.actionCatalogHash = canonicalHash(tampered);
    env.STANDARD_RAIL_SERVICING_ADMISSION_JSON = JSON.stringify(
      await envelope("ProviderServicingAdmissionV1", admission.payload),
    );
    await expect(loadProviderWalletConfig(standard(), walletLaunchPolicy, env))
      .rejects.toThrow(/installed service action contracts/);
  });

  it("rejects duplicate IDs in provider wallet launch policy", async () => {
    const { env } = await fixture();
    await expect(loadProviderWalletConfig(standard(), {
      assetActions: [...walletLaunchPolicy.assetActions, walletLaunchPolicy.assetActions[0]!],
    }, env)).rejects.toThrow(/wallet launch policy is invalid/);
  });

  it("rejects artifacts not signed by the gateway protocol key", async () => {
    const { env } = await fixture();
    const admission = JSON.parse(env.STANDARD_RAIL_SERVICING_ADMISSION_JSON);
    admission.signature = `0x${"11".repeat(65)}`;
    env.STANDARD_RAIL_SERVICING_ADMISSION_JSON = JSON.stringify(admission);
    await expect(loadProviderWalletConfig(standard(), walletLaunchPolicy, env))
      .rejects.toThrow(/signature is invalid/);
  });
});
