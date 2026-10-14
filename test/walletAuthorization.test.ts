import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { unsignedEnvelopeHash } from "../src/core/standardRail/canonical.js";
import { ERC1271_MAGIC_RETURN } from "../src/core/standardRail/payerSignature.js";
import type {
  ProviderWalletActionGrantV1,
  SignedEnvelope,
  WalletActionAuthorizationV1,
} from "../src/core/standardRail/types.js";
import {
  deriveActionExecutionId,
  requestHash,
  utf8Hash,
  verifyProviderGrant,
  verifyWalletAuthorization,
  walletAuthorizationHash,
} from "../src/core/standardRail/walletAuthorization.js";

const payer = privateKeyToAccount(
  "0x1000000000000000000000000000000000000000000000000000000000000001",
);
const gateway = privateKeyToAccount(
  "0x2000000000000000000000000000000000000000000000000000000000000002",
);
const attacker = privateKeyToAccount(
  "0x3000000000000000000000000000000000000000000000000000000000000003",
);
const chainId = 8453;
const now = 2_000_000_000;
const hash = (label: string): Hex => utf8Hash(label);

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

function message(
  overrides: Partial<WalletActionAuthorizationV1> = {},
): WalletActionAuthorizationV1 {
  return {
    payer: payer.address.toLowerCase() as Hex,
    providerAgentId: "42",
    serviceId: hash("service"),
    providerControlProfileHash: hash("control"),
    servicingAdmissionHash: hash("admission"),
    actionCatalogHash: hash("catalog"),
    actionCatalogSchemaHash: hash("catalog-schema"),
    actionDefinitionHash: hash("action-definition"),
    actionCatalogEpoch: 7,
    actionHash: hash("action"),
    methodHash: hash("POST"),
    absoluteResourceUriHash: hash("https://provider.example/assets/action"),
    requestHash: requestHash({ providerAssetId: "asset-1", operation: "read" }),
    audienceHash: hash("gateway-audience"),
    nonce: hash("wallet-nonce"),
    issuedAt: now - 1,
    validBefore: now + 120,
    ...overrides,
  };
}

async function signedAuthorization(
  value = message(),
  signer = payer,
) {
  const signature = await signer.signTypedData({
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

function grantPayload(walletHash: Hex): ProviderWalletActionGrantV1 {
  const value = message();
  return {
    payer: value.payer,
    providerAgentId: value.providerAgentId,
    serviceId: value.serviceId,
    actionHash: value.actionHash,
    methodHash: value.methodHash,
    absoluteResourceUriHash: value.absoluteResourceUriHash,
    requestHash: value.requestHash,
    walletAuthorizationHash: walletHash,
    providerControlProfileHash: value.providerControlProfileHash,
    servicingAdmissionHash: value.servicingAdmissionHash,
    servicingProfileEpoch: 3,
    actionCatalogHash: value.actionCatalogHash,
    actionCatalogSchemaHash: value.actionCatalogSchemaHash,
    actionCatalogEpoch: value.actionCatalogEpoch,
    actionDefinitionHash: value.actionDefinitionHash,
    gatewayAudienceHash: value.audienceHash,
    providerAudienceHash: hash("provider-audience"),
    grantNonce: hash("grant-nonce"),
  };
}

async function signedGrant(
  payload: ProviderWalletActionGrantV1,
  signer = gateway,
  overrides: Partial<SignedEnvelope<ProviderWalletActionGrantV1>> = {},
): Promise<SignedEnvelope<ProviderWalletActionGrantV1>> {
  const envelope: SignedEnvelope<ProviderWalletActionGrantV1> = {
    artifactType: "ProviderWalletActionGrantV1",
    schemaVersion: 1,
    environment: "test",
    chainId,
    audience: "provider-audience",
    signerKeyId: "gateway-lifecycle-1",
    issuedAt: now - 1,
    validBefore: now + 120,
    payload,
    signature: `0x${"00".repeat(65)}`,
    ...overrides,
  };
  envelope.signature = await signer.signMessage({
    message: { raw: unsignedEnvelopeHash(envelope as unknown as Record<string, unknown>) },
  });
  return envelope;
}

describe("standard wallet authorization", () => {
  it("accepts the exact payer signature and returns the typed-data hash", async () => {
    const value = message();
    const authorization = await signedAuthorization(value);
    await expect(verifyWalletAuthorization({
      authorization,
      chainId,
      expectedPayer: getAddress(value.payer),
      expectedRequestHash: value.requestHash,
      expectedActionHash: value.actionHash,
      expectedAudienceHash: value.audienceHash,
      now,
    })).resolves.toBe(walletAuthorizationHash(value, chainId));
  });

  it("rejects wrong bindings, signer, fields, and validity windows", async () => {
    const value = message();
    const base = {
      chainId,
      expectedPayer: getAddress(value.payer),
      expectedRequestHash: value.requestHash,
      expectedActionHash: value.actionHash,
      expectedAudienceHash: value.audienceHash,
      now,
    };
    await expect(verifyWalletAuthorization({
      ...base,
      authorization: await signedAuthorization(value, attacker),
    })).rejects.toThrow(/denied/);
    for (const changed of [
      message({ payer: attacker.address.toLowerCase() as Hex }),
      message({ requestHash: hash("wrong-request") }),
      message({ actionHash: hash("wrong-action") }),
      message({ audienceHash: hash("wrong-audience") }),
      message({ issuedAt: now + 31 }),
      message({ validBefore: now }),
      message({ issuedAt: now - 301, validBefore: now + 1 }),
    ]) {
      await expect(verifyWalletAuthorization({
        ...base,
        authorization: await signedAuthorization(changed),
      })).rejects.toThrow(/denied/);
    }
    const authorization = await signedAuthorization(value) as Record<string, unknown>;
    authorization.extra = true;
    await expect(verifyWalletAuthorization({
      ...base,
      authorization: authorization as never,
    })).rejects.toThrow(/fields/);
  });

  it("verifies a configured contract account through the bounded verifier", async () => {
    const value = message();
    const base = {
      chainId,
      expectedPayer: getAddress(value.payer),
      expectedRequestHash: value.requestHash,
      expectedActionHash: value.actionHash,
      expectedAudienceHash: value.audienceHash,
      now,
    };
    // A deployed account's signature is not a 65-byte ECDSA signature.
    const authorization = { message: value, signature: `0x${"ab".repeat(120)}` as Hex };
    const policy = (answer: () => Promise<{ kind: "returned"; data: Hex } | { kind: "reverted" }>) => ({
      accountTypes: new Set(["eoa", "contract"] as const),
      verifyTimeoutMs: 1_000,
      endpoints: [{ host: "rpc", getCode: async () => "0x6080" as Hex, isValidSignature: answer }],
    });
    await expect(verifyWalletAuthorization({
      ...base, authorization,
      payerSignature: policy(async () => ({ kind: "returned", data: ERC1271_MAGIC_RETURN })),
    })).resolves.toBe(walletAuthorizationHash(value, chainId));
    await expect(verifyWalletAuthorization({
      ...base, authorization, payerSignature: policy(async () => ({ kind: "reverted" })),
    })).rejects.toThrow(/wallet authorization denied/);
    // Unavailable verification is retryable, never a wrong signature.
    await expect(verifyWalletAuthorization({
      ...base, authorization,
      payerSignature: policy(async () => { throw new Error("ECONNRESET"); }),
    })).rejects.toMatchObject({ name: "PayerSignatureError", retryable: true });
    // The default policy admits EOAs only.
    await expect(verifyWalletAuthorization({ ...base, authorization })).rejects.toThrow(/denied/);
  });

  it("verifies the exact signed provider grant envelope", async () => {
    const walletHash = walletAuthorizationHash(message(), chainId);
    const envelope = await signedGrant(grantPayload(walletHash));
    await expect(verifyProviderGrant({
      envelope,
      environment: "test",
      chainId,
      providerAudience: "provider-audience",
      gatewayLifecycleSigner: gateway.address,
      now,
    })).resolves.toBe(unsignedEnvelopeHash(envelope as unknown as Record<string, unknown>));
  });

  it("rejects stale, misbound, or incorrectly signed provider grants", async () => {
    const payload = grantPayload(walletAuthorizationHash(message(), chainId));
    const base = {
      environment: "test",
      chainId,
      providerAudience: "provider-audience",
      gatewayLifecycleSigner: gateway.address,
      now,
    };
    await expect(verifyProviderGrant({
      ...base,
      envelope: await signedGrant(payload, attacker),
    })).rejects.toThrow(/denied/);
    for (const overrides of [
      { environment: "production" },
      { audience: "wrong-audience" },
      { issuedAt: now + 31 },
      { validBefore: now },
      { issuedAt: now - 301, validBefore: now + 1 },
      { artifactType: "WrongGrant" },
    ]) {
      await expect(verifyProviderGrant({
        ...base,
        envelope: await signedGrant(payload, gateway, overrides),
      })).rejects.toThrow(/denied/);
    }
  });

  it("derives an execution id from every immutable action binding", () => {
    const value = message();
    const first = deriveActionExecutionId({
      walletAuthorizationHash: walletAuthorizationHash(value, chainId),
      providerAgentId: 42n,
      serviceId: value.serviceId,
      providerControlProfileHash: value.providerControlProfileHash,
      servicingAdmissionHash: value.servicingAdmissionHash,
      actionCatalogHash: value.actionCatalogHash,
      actionCatalogSchemaHash: value.actionCatalogSchemaHash,
      actionCatalogEpoch: 7n,
      actionDefinitionHash: value.actionDefinitionHash,
      requestHash: value.requestHash,
    });
    expect(first).toMatch(/^0x[0-9a-f]{64}$/);
    expect(deriveActionExecutionId({
      walletAuthorizationHash: walletAuthorizationHash(value, chainId),
      providerAgentId: 42n,
      serviceId: value.serviceId,
      providerControlProfileHash: value.providerControlProfileHash,
      servicingAdmissionHash: value.servicingAdmissionHash,
      actionCatalogHash: value.actionCatalogHash,
      actionCatalogSchemaHash: value.actionCatalogSchemaHash,
      actionCatalogEpoch: 7n,
      actionDefinitionHash: value.actionDefinitionHash,
      requestHash: hash("different-request"),
    })).not.toBe(first);
  });
});
