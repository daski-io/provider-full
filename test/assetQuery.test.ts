import { type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { unsignedEnvelopeHash } from "../src/core/standardRail/canonical.js";
import type { ProviderStandardRailConfig } from "../src/core/standardRail/config.js";
import type {
  ProviderAssetQueryResponseV1,
  ProviderWalletActionGrantV1,
  SignedEnvelope,
  WalletActionAuthorizationV1,
} from "../src/core/standardRail/types.js";
import type { ProviderWalletConfig } from "../src/core/standardRail/walletConfig.js";
import {
  requestHash,
  utf8Hash,
  walletAuthorizationHash,
  ZERO_HASH,
} from "../src/core/standardRail/walletAuthorization.js";

vi.mock("../src/core/db/pool.js", () => ({
  pool: {
    connect: async () => ({
      query: async () => ({ rows: [], rowCount: 1 }),
      release: () => {},
    }),
  },
}));
vi.mock("../src/core/standardRail/assetRateLimit.js", () => ({
  consumeAssetEndpointRate: async () => {},
}));
vi.mock("../src/core/db/queries/assetOwnership.js", () => ({
  listAssetsForStandardPayer: async () => ({
    assets: [{
      id: "11111111-1111-4111-8111-111111111111",
      service_slug: "sample-service",
      type: "sample-item",
      identifier: "item-123",
      status: "active",
      created_at: new Date("2026-08-01T00:00:00Z"),
      created_at_cursor: "2026-08-01 00:00:00+00",
      expires_at: null,
    }],
    hasMore: false,
  }),
}));
vi.mock("../src/core/standardRail/providerResponse.js", () => ({
  signProviderResponse: async (args: { payload: unknown }) => ({
    artifactType: "ProviderAssetQueryResponseV1",
    payload: args.payload,
  }),
}));

const { ProviderAssetQueryService } = await import("../src/core/standardRail/assetQuery.js");

const payer = privateKeyToAccount(
  "0x1000000000000000000000000000000000000000000000000000000000000001",
);
const gateway = privateKeyToAccount(
  "0x2000000000000000000000000000000000000000000000000000000000000002",
);
const responder = privateKeyToAccount(
  "0x3000000000000000000000000000000000000000000000000000000000000003",
);
const chainId = 84532;
const providerAgentId = "77";
const queryUrl = "https://gateway.test/wallet/assets";
const hash = (nibble: string): Hex => `0x${nibble.repeat(64)}`;

const walletTypes = {
  WalletActionAuthorizationV1: [
    { name: "payer", type: "address" },
    { name: "providerAgentId", type: "uint256" },
    { name: "serviceId", type: "bytes32" },
    { name: "providerControlProfileHash", type: "bytes32" },
    { name: "servicingAdmissionHash", type: "bytes32" },
    { name: "actionCatalogHash", type: "bytes32" },
    { name: "actionCatalogSchemaHash", type: "bytes32" },
    { name: "actionDefinitionHash", type: "bytes32" },
    { name: "actionCatalogEpoch", type: "uint64" },
    { name: "actionHash", type: "bytes32" },
    { name: "methodHash", type: "bytes32" },
    { name: "absoluteResourceUriHash", type: "bytes32" },
    { name: "requestHash", type: "bytes32" },
    { name: "audienceHash", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "validBefore", type: "uint64" },
  ],
} as const;

const standard = {
  environment: "test",
  chainId,
  gatewayAudience: "gateway-audience",
  providerAudience: "provider-audience",
  gatewayLifecycleSigner: gateway.address,
} as unknown as ProviderStandardRailConfig;

function walletConfig(): ProviderWalletConfig {
  const now = Math.floor(Date.now() / 1_000);
  return {
    providerAgentId,
    providerControlProfileHash: hash("1"),
    servicingAdmissionHash: hash("2"),
    admission: {
      providerAgentId,
      providerControlProfileHash: hash("1"),
      servicingProfileEpoch: 3,
      actionCatalogHash: hash("3"),
      actionCatalogSchemaHash: hash("4"),
      actionCatalogEpoch: 0,
      servicingEnabled: true,
      previousAdmissionHash: ZERO_HASH,
      validFrom: now - 60,
      validBefore: now + 3_600,
    },
    actionCatalogHash: hash("3"),
    catalog: {
      providerAgentId,
      providerControlProfileHash: hash("1"),
      servicingProfileEpoch: 3,
      actionCatalogSchemaHash: hash("4"),
      actionCatalogEpoch: 0,
      actions: [],
    },
    assetResponsePrivateKey:
      "0x3000000000000000000000000000000000000000000000000000000000000003",
    assetResponseKey: responder.address,
    assetResponseKeyId: "asset-response-1",
    artifactValidBefore: now + 3_600,
    cursorKeyRing: { activeKeyId: "k1", keys: new Map([["k1", Buffer.alloc(32, 7)]]) },
    destructiveActionDelaySeconds: 300,
    gatewayAssetQueryUrl: queryUrl,
    gatewayAssetActionUrl: "https://gateway.test/wallet/assets/action",
    abuse: {
      requestsPerGatewaySignerPerMinute: 100,
      requestsPerPayerPerMinute: 100,
      requestsPerActionPerMinute: 100,
      requestsGlobalPerMinute: 100,
      destructiveOutstandingPerPayer: 10,
      destructiveOutstandingPerProvider: 10,
      destructiveOutstandingGlobal: 10,
    },
  };
}

function queryMessage(walletRequest: unknown): WalletActionAuthorizationV1 {
  const now = Math.floor(Date.now() / 1_000);
  return {
    payer: payer.address.toLowerCase() as Hex,
    providerAgentId: "0",
    serviceId: ZERO_HASH,
    providerControlProfileHash: ZERO_HASH,
    servicingAdmissionHash: ZERO_HASH,
    actionCatalogHash: ZERO_HASH,
    actionCatalogSchemaHash: ZERO_HASH,
    actionDefinitionHash: ZERO_HASH,
    actionCatalogEpoch: 0,
    actionHash: utf8Hash("list-assets"),
    methodHash: utf8Hash("POST"),
    absoluteResourceUriHash: utf8Hash(queryUrl),
    requestHash: requestHash(walletRequest),
    audienceHash: utf8Hash("gateway-audience"),
    nonce: hash("d"),
    issuedAt: now - 1,
    validBefore: now + 120,
  };
}

async function signedAuthorization(value: WalletActionAuthorizationV1) {
  const signature = await payer.signTypedData({
    domain: { name: "DaskiStandardWallet", version: "1", chainId },
    primaryType: "WalletActionAuthorizationV1",
    types: walletTypes,
    message: {
      ...value,
      providerAgentId: BigInt(value.providerAgentId),
      actionCatalogEpoch: BigInt(value.actionCatalogEpoch),
      issuedAt: BigInt(value.issuedAt),
      validBefore: BigInt(value.validBefore),
    },
  });
  return { message: value, signature };
}

async function signedGrant(
  message: WalletActionAuthorizationV1,
  providerBody: { limit: number; cursor: string | null },
): Promise<SignedEnvelope<ProviderWalletActionGrantV1>> {
  const now = Math.floor(Date.now() / 1_000);
  const envelope: SignedEnvelope<ProviderWalletActionGrantV1> = {
    artifactType: "ProviderWalletActionGrantV1",
    schemaVersion: 1,
    environment: "test",
    chainId,
    audience: "provider-audience",
    signerKeyId: "gateway-lifecycle-1",
    issuedAt: now - 1,
    validBefore: now + 120,
    payload: {
      payer: message.payer,
      providerAgentId,
      serviceId: ZERO_HASH,
      actionHash: utf8Hash("list-assets"),
      methodHash: utf8Hash("POST"),
      absoluteResourceUriHash: utf8Hash(queryUrl),
      requestHash: requestHash(providerBody),
      walletAuthorizationHash: walletAuthorizationHash(message, chainId),
      providerControlProfileHash: hash("1"),
      servicingAdmissionHash: hash("2"),
      servicingProfileEpoch: 3,
      actionCatalogHash: ZERO_HASH,
      actionCatalogSchemaHash: ZERO_HASH,
      actionCatalogEpoch: 0,
      actionDefinitionHash: ZERO_HASH,
      gatewayAudienceHash: utf8Hash("gateway-audience"),
      providerAudienceHash: utf8Hash("provider-audience"),
      grantNonce: hash("e"),
    },
    signature: `0x${"00".repeat(65)}`,
  };
  envelope.signature = await gateway.signMessage({
    message: { raw: unsignedEnvelopeHash(envelope as unknown as Record<string, unknown>) },
  });
  return envelope;
}

// walletRequest is what the payer wallet signed at the gateway (the federated
// pre-image); providerBody is what the gateway actually dispatched to the
// provider and committed to in its grant. A rogue gateway can make them
// disagree; the provider must refuse to serve the disagreement.
async function performQuery(
  walletRequest: unknown,
  providerBody: { limit: number; cursor: string | null },
) {
  const message = queryMessage(walletRequest);
  const authorization = await signedAuthorization(message);
  const grant = await signedGrant(message, providerBody);
  const service = new ProviderAssetQueryService(standard, walletConfig(), chainId);
  const result = await service.query({ request: providerBody, authorization, grant }) as {
    payload: ProviderAssetQueryResponseV1;
  };
  return { payload: result.payload, message };
}

describe("standard asset query wallet binding", () => {
  it("serves a query scoped to this provider when the wallet signed it exactly", async () => {
    const { payload, message } = await performQuery(
      { providerAgentId, limit: 25, cursor: null },
      { limit: 25, cursor: null },
    );
    expect(payload.assets).toHaveLength(1);
    expect(payload.payer).toBe(payer.address.toLowerCase());
    expect(payload.requestHash).toBe(requestHash({ limit: 25, cursor: null }));
    expect(payload.walletAuthorizationHash).toBe(walletAuthorizationHash(message, chainId));
  });

  it("serves a null-scoped federated first page the wallet signed", async () => {
    const { payload } = await performQuery(
      { providerAgentId: null, limit: 25, cursor: null },
      { limit: 25, cursor: null },
    );
    expect(payload.assets).toHaveLength(1);
  });

  it("rejects a gateway-altered limit the wallet never signed", async () => {
    await expect(performQuery(
      { providerAgentId, limit: 1, cursor: null },
      { limit: 100, cursor: null },
    )).rejects.toThrow(/denied/);
  });

  it("rejects a gateway-altered cursor the wallet never signed", async () => {
    await expect(performQuery(
      { providerAgentId, limit: 25, cursor: "cursor-a" },
      { limit: 25, cursor: "cursor-b" },
    )).rejects.toThrow(/denied/);
  });

  it("rejects an authorization the payer scoped to a different provider", async () => {
    await expect(performQuery(
      { providerAgentId: "88", limit: 25, cursor: null },
      { limit: 25, cursor: null },
    )).rejects.toThrow(/denied/);
  });

  it("rejects a null-scoped authorization combined with a cursor", async () => {
    await expect(performQuery(
      { providerAgentId: null, limit: 25, cursor: "cursor-a" },
      { limit: 25, cursor: "cursor-a" },
    )).rejects.toThrow(/denied/);
  });
});
