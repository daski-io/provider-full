import { describe, expect, it } from "vitest";
import { canonicalHash, recipeNonceV2 } from "../src/core/standardRail/canonical.js";
import {
  buildRuntimeListingCommitment,
  runtimeCommitmentHash,
  type RuntimeCommitmentInputs,
} from "../src/core/gatewayRegistration/runtimeCommitment.js";
import type {
  GatewayListingPreparationV1,
  GatewaySkillControlProfileV1,
} from "../src/core/gatewayRegistration/types.js";
import type { SignedEnvelope } from "../src/core/standardRail/types.js";

// Shared golden vectors: the gateway pins the same three values in its own
// suite (test/runtimeCommitment.test.ts there). A divergence on either side
// breaks the cross-check that guards every V2 order binding.
const GOLDEN_PAID_COMMITMENT =
  "0xd0dcaeaf88bce6b478d793d42ce33e4154dd859139acaa0850ab2fddfa4fdb70";
const GOLDEN_FREE_COMMITMENT =
  "0x5caad8a68dce18b33c11c5b75b0a3efe7649678899a5fcd9c3df8ddc3a91b662";
const GOLDEN_V2_NONCE =
  "0x6e421e6825b79637e4f46a3d0c64ae4146ae1ad218380973eadc871f5f6d1dd3";

const hash = (digit: string) => `0x${digit.repeat(64)}` as `0x${string}`;
const address = (digit: string) => `0x${digit.repeat(40)}` as `0x${string}`;

function preparationEnvelope(): SignedEnvelope<GatewayListingPreparationV1> {
  return {
    artifactType: "GatewayListingPreparationV1",
    schemaVersion: 1,
    environment: "base-sepolia",
    chainId: 84532,
    audience: "https://gateway.example",
    signerKeyId: "standard-rail-signer",
    issuedAt: 1_700_000_000,
    validBefore: 2_015_360_000,
    payload: {
      registrationId: "11111111-1111-4111-8111-111111111111",
      listingId: "22222222-2222-4222-8222-222222222222",
      listingKey: hash("8"),
      providerAgentId: "42",
      serviceId: hash("1"),
      serviceSlug: "orbital-logistics",
      serviceVersion: "1",
      skillId: "reserve-orbit",
      skillContractHash: hash("5"),
      skillContractSetHash: hash("4"),
      providerIntentHash: hash("7"),
      canonicalToken: address("a"),
      providerPayee: address("b"),
      daskiCommissionReceiver: address("c"),
      commissionBps: 500,
      splitterFactory: address("d"),
      splitterDeploymentSalt: hash("9"),
      policyVersionHash: hash("6"),
      listingEpoch: "3",
    },
    signature: `0x${"ab".repeat(65)}` as `0x${string}`,
  } as SignedEnvelope<GatewayListingPreparationV1>;
}

function controlProfileEnvelope(): SignedEnvelope<GatewaySkillControlProfileV1> {
  return {
    artifactType: "GatewaySkillControlProfileV1",
    schemaVersion: 1,
    environment: "base-sepolia",
    chainId: 84532,
    audience: "https://gateway.example",
    signerKeyId: "standard-rail-signer",
    issuedAt: 1_700_000_000,
    validBefore: 2_015_360_000,
    payload: {
      registrationId: "11111111-1111-4111-8111-111111111111",
      providerAgentId: "42",
      providerIntentHash: hash("7"),
      serviceId: hash("1"),
      serviceSlug: "orbital-logistics",
      skillId: "reserve-orbit",
      skillContractHash: hash("5"),
      policyVersionHash: hash("6"),
      providerEndpoint: "https://provider.example/standard-rail/assets/action",
      ownershipPolicy: "owner-only",
      effect: "read",
      replayPolicy: "stable-result",
      retentionSeconds: 3600,
      walletAuthorizationRequired: true,
      delayedConfirmationRequired: false,
      confirmationSummarySchemaHash: null,
      confirmationSummaryTemplateHash: null,
    },
    signature: `0x${"cd".repeat(65)}` as `0x${string}`,
  } as SignedEnvelope<GatewaySkillControlProfileV1>;
}

function inputs(
  overrides: Partial<RuntimeCommitmentInputs["listing"]> = {},
): RuntimeCommitmentInputs {
  return {
    environment: "base-sepolia",
    chainId: 84532,
    gatewayAudience: "https://gateway.example",
    providerAgentId: "42",
    serviceId: hash("1"),
    currentProviderIntentHash: hash("f"),
    currentProviderPayee: address("b"),
    policy: {
      canonicalToken: address("a"),
      daskiCommissionReceiver: address("c"),
      commissionBps: 500,
      policyVersionHash: hash("6"),
      splitterFactory: address("d"),
    },
    listing: {
      listingId: "33333333-3333-4333-8333-333333333333",
      listingKey: hash("8"),
      skillId: "reserve-orbit",
      skillContractHash: hash("5"),
      paymentRequired: true,
      splitterAddress: address("e"),
      preparation: preparationEnvelope(),
      controlProfile: controlProfileEnvelope(),
      ...overrides,
    },
  };
}

describe("runtime commitment cross-repo conformance", () => {
  it("reproduces the shared golden vectors", () => {
    const paid = buildRuntimeListingCommitment(inputs());
    const free = buildRuntimeListingCommitment(inputs({
      paymentRequired: false,
      splitterAddress: null,
      preparation: null,
      controlProfile: null,
    }));
    expect(runtimeCommitmentHash(paid)).toBe(GOLDEN_PAID_COMMITMENT);
    expect(runtimeCommitmentHash(free)).toBe(GOLDEN_FREE_COMMITMENT);
    expect(recipeNonceV2({
      chainId: 84532,
      canonicalToken: address("a"),
      payer: address("1"),
      splitter: address("e"),
      grossAmount: 1_250_000n,
      runtimeCommitmentHash: runtimeCommitmentHash(paid),
      providerIntentHash: paid.providerIntentHash,
      quoteHash: hash("0"),
      canonicalRequestHash: hash("2"),
      orderNonce: hash("3"),
    })).toBe(GOLDEN_V2_NONCE);
  });

  it("keeps an unchanged listing stable across re-registrations", () => {
    const original = runtimeCommitmentHash(buildRuntimeListingCommitment(inputs()));
    const reRegistered = runtimeCommitmentHash(buildRuntimeListingCommitment({
      ...inputs({ listingId: "44444444-4444-4444-8444-444444444444" }),
      currentProviderIntentHash: hash("0"),
      currentProviderPayee: address("9"),
    }));
    expect(reRegistered).toBe(original);
  });

  it("rejects deployment artifacts that disagree with the payment mode", () => {
    expect(() => buildRuntimeListingCommitment(inputs({ preparation: null })))
      .toThrow(/payment mode/);
    expect(() => buildRuntimeListingCommitment(inputs({ splitterAddress: null })))
      .toThrow(/payment mode/);
    expect(() => buildRuntimeListingCommitment(inputs({ paymentRequired: false })))
      .toThrow(/payment mode/);
  });

  it("rejects deep or prototype-aliasing values in canonicalization", () => {
    const nested = (depth: number): unknown => (depth === 0 ? 1 : { a: nested(depth - 1) });
    expect(() => canonicalHash(nested(70))).toThrow(/too deeply nested/);
    expect(() => canonicalHash(JSON.parse('{"constructor": 1}')))
      .toThrow(/unsafe key/);
  });
});
