import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { unsignedEnvelopeHash } from "../src/core/standardRail/canonical.js";
import type { ProviderStandardRailConfig } from "../src/core/standardRail/config.js";
import type {
  ProviderWalletActionGrantV1,
  SignedEnvelope,
  WalletActionAuthorizationV1,
} from "../src/core/standardRail/types.js";
import type { AssetActionDefinitionV1, ProviderWalletConfig } from "../src/core/standardRail/walletConfig.js";
import { requestHash, utf8Hash, walletAuthorizationHash, ZERO_HASH } from "../src/core/standardRail/walletAuthorization.js";

// F-T07 ordering: the asset action and asset query surfaces verify the
// gateway's grant (an offline recovery) before the payer signature, whose
// contract-account path is a bounded chain call, so an ungranted request
// never spends a verification and nothing is looked up for it.
const verified = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../src/core/standardRail/payerSignature.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/core/standardRail/payerSignature.js")>();
  return {
    ...actual,
    verifyPayerTypedData: (...args: Parameters<typeof actual.verifyPayerTypedData>) => {
      verified.calls += 1;
      return actual.verifyPayerTypedData(...args);
    },
  };
});
const lookups = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/core/db/pool.js", () => ({
  pool: {
    query: async () => { lookups.count += 1; return { rows: [], rowCount: 0 }; },
    connect: async () => { lookups.count += 1; throw new Error("no database in this test"); },
  },
}));

const { ProviderAssetQueryService } = await import("../src/core/standardRail/assetQuery.js");
const { ProviderAssetActionService } = await import("../src/core/standardRail/assetAction.js");

const gateway = privateKeyToAccount(`0x${"21".repeat(32)}` as Hex);
const impostor = privateKeyToAccount(`0x${"22".repeat(32)}` as Hex);
const payer = privateKeyToAccount(`0x${"23".repeat(32)}` as Hex);
const chainId = 84532;
const hash = (nibble: string): Hex => `0x${nibble.repeat(64)}` as Hex;
const now = () => Math.floor(Date.now() / 1_000);
// Not a 65-byte ECDSA signature: only the contract path could accept it.
const contractSignature = `0x${"ab".repeat(120)}` as Hex;

const standard = {
  environment: "test", chainId, gatewayAudience: "gateway-audience",
  providerAudience: "provider-audience", gatewayLifecycleSigner: gateway.address,
} as unknown as ProviderStandardRailConfig;

const definition: AssetActionDefinitionV1 = {
  providerAgentId: "77", serviceId: hash("5"), serviceSlug: "sample-service", actionId: "touch-item",
  assetType: "sample-item", ownershipPolicy: "owner-only", destructive: false,
  requestSchema: { type: "object", properties: {}, additionalProperties: false },
  responseSchema: { type: "object", properties: {}, additionalProperties: false },
  confirmationSummarySchema: null, confirmationSummaryTemplate: null,
  endpoint: "https://provider.example/standard-rail/assets/action", replayPolicy: "stable-result",
  retentionSeconds: 3_600, validFrom: now() - 60, validBefore: now() + 3_600, actionDefinitionHash: hash("6"),
};

const wallet = {
  providerAgentId: "77", providerControlProfileHash: hash("1"), servicingAdmissionHash: hash("2"),
  admission: {
    providerAgentId: "77", providerControlProfileHash: hash("1"), servicingProfileEpoch: 3,
    actionCatalogHash: hash("3"), actionCatalogSchemaHash: hash("4"), actionCatalogEpoch: 0,
    servicingEnabled: true, previousAdmissionHash: ZERO_HASH, validFrom: now() - 60, validBefore: now() + 3_600,
  },
  actionCatalogHash: hash("3"),
  catalog: {
    providerAgentId: "77", providerControlProfileHash: hash("1"), servicingProfileEpoch: 3,
    actionCatalogSchemaHash: hash("4"), actionCatalogEpoch: 0, actions: [definition],
  },
  artifactValidBefore: now() + 3_600,
  gatewayAssetQueryUrl: "https://gateway.test/wallet/assets",
  gatewayAssetActionUrl: "https://gateway.test/wallet/assets/action",
} as unknown as ProviderWalletConfig;

function walletMessage(action: string, request: unknown): WalletActionAuthorizationV1 {
  return {
    payer: payer.address.toLowerCase() as Hex, providerAgentId: "77", serviceId: hash("5"),
    providerControlProfileHash: hash("1"), servicingAdmissionHash: hash("2"), actionCatalogHash: hash("3"),
    actionCatalogSchemaHash: hash("4"), actionDefinitionHash: hash("6"), actionCatalogEpoch: 0,
    actionHash: utf8Hash(action), methodHash: utf8Hash("POST"),
    absoluteResourceUriHash: utf8Hash(wallet.gatewayAssetActionUrl), requestHash: requestHash(request),
    audienceHash: utf8Hash("gateway-audience"), nonce: hash("7"), issuedAt: now() - 1, validBefore: now() + 120,
  };
}

async function grant(message: WalletActionAuthorizationV1, signer = gateway) {
  const envelope: SignedEnvelope<ProviderWalletActionGrantV1> = {
    artifactType: "ProviderWalletActionGrantV1", schemaVersion: 1, environment: "test", chainId,
    audience: "provider-audience", signerKeyId: "gateway-lifecycle", issuedAt: now() - 1, validBefore: now() + 120,
    payload: {
      payer: message.payer, providerAgentId: "77", serviceId: message.serviceId, actionHash: message.actionHash,
      methodHash: message.methodHash, absoluteResourceUriHash: message.absoluteResourceUriHash,
      requestHash: message.requestHash, walletAuthorizationHash: walletAuthorizationHash(message, chainId),
      providerControlProfileHash: hash("1"), servicingAdmissionHash: hash("2"), servicingProfileEpoch: 3,
      actionCatalogHash: hash("3"), actionCatalogSchemaHash: hash("4"), actionCatalogEpoch: 0,
      actionDefinitionHash: hash("6"), gatewayAudienceHash: utf8Hash("gateway-audience"),
      providerAudienceHash: utf8Hash("provider-audience"), grantNonce: hash("8"),
    },
    signature: `0x${"00".repeat(65)}` as Hex,
  };
  envelope.signature = await signer.signMessage({
    message: { raw: unsignedEnvelopeHash(envelope as unknown as Record<string, unknown>) },
  });
  return envelope;
}

beforeEach(() => {
  verified.calls = 0;
  lookups.count = 0;
});

describe("asset surfaces verify the gateway grant before the payer signature", () => {
  it("never verifies a payer signature or reads state for an ungranted asset query", async () => {
    const request = { limit: 5, cursor: null };
    const message = walletMessage("list-assets", request);
    const service = new ProviderAssetQueryService(standard, wallet, chainId);
    const body = (envelope: SignedEnvelope<ProviderWalletActionGrantV1>) =>
      ({ request, authorization: { message, signature: contractSignature }, grant: envelope });
    await expect(service.query(body(await grant(message, impostor)))).rejects.toThrow(/grant denied/);
    expect(verified.calls).toBe(0);
    expect(lookups.count).toBe(0);
    // With a valid grant the payer signature is verified next, and the
    // EOA-only default refuses a contract-account signature.
    await expect(service.query(body(await grant(message)))).rejects.toThrow(/wallet authorization denied/);
    expect(verified.calls).toBe(1);
    expect(lookups.count).toBe(0);
  });

  it("never verifies a payer signature or reads state for an ungranted asset action", async () => {
    const request = { actionId: "touch-item", providerAssetId: "11111111-1111-4111-8111-111111111111", input: {} };
    const message = walletMessage("use-asset:77:touch-item", request);
    const service = new ProviderAssetActionService(standard, wallet, chainId);
    const body = (envelope: SignedEnvelope<ProviderWalletActionGrantV1>) =>
      ({ request, authorization: { message, signature: contractSignature }, grant: envelope });
    await expect(service.perform(body(await grant(message, impostor)))).rejects.toThrow(/grant denied/);
    expect(verified.calls).toBe(0);
    expect(lookups.count).toBe(0);
    await expect(service.perform(body(await grant(message)))).rejects.toThrow(/wallet authorization denied/);
    expect(verified.calls).toBe(1);
    expect(lookups.count).toBe(0);
  });
});
