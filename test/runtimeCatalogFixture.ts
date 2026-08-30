import { concatHex, encodeAbiParameters, getAddress, getCreate2Address, keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalHash, unsignedEnvelopeHash } from "../src/core/standardRail/canonical.js";
import type { SignedEnvelope } from "../src/core/standardRail/types.js";
import type { StandardRailGlobalPolicy } from "../src/core/standardRail/catalogOutcomes.js";
import type {
  ProviderRuntimeListingBundleV1,
  RuntimeListingHead,
  SplitterActivationCheckpoint,
} from "../src/core/gatewayRegistration/runtimeCatalog.js";
import type { RuntimeListingCommitmentV1 } from "../src/core/gatewayRegistration/runtimeCommitment.js";

/**
 * Hash-true runtime-catalog fixtures for catalog-driven checkout tests: every
 * derived value (listing key, preparation hash, runtime commitment hash,
 * CREATE2 splitter address, init-code hash) is computed with the production
 * derivations, so `materializeOutcome`'s fail-closed cross-checks pass — and
 * any single mutated field makes them fail, which is what the negative tests
 * exercise.
 */

export const testGatewaySignerKey = `0x${"77".repeat(32)}` as Hex;
export const testGatewaySigner = privateKeyToAccount(testGatewaySignerKey).address;

const dummySignature = (`0x${"ab".repeat(65)}`) as Hex;
const hash32 = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex;

// Small but valid EVM-ish creation code; provenance only needs bytes.
export const testSplitterCreationCode = `0x${"600160015260206000f3".repeat(4)}` as Hex;

export async function signTestEnvelope<T>(args: {
  artifactType: string;
  schemaVersion: 1 | 2;
  environment: string;
  chainId: number;
  audience: string;
  signerKeyId: string;
  payload: T;
  signerKey?: Hex;
  issuedAt?: number;
  validBefore?: number;
}): Promise<SignedEnvelope<T, 1 | 2>> {
  const unsigned = {
    artifactType: args.artifactType,
    schemaVersion: args.schemaVersion,
    environment: args.environment,
    chainId: args.chainId,
    audience: args.audience,
    signerKeyId: args.signerKeyId,
    issuedAt: args.issuedAt ?? 100,
    validBefore: args.validBefore ?? Math.floor(Date.now() / 1_000) + 86_400,
    payload: args.payload,
  };
  const account = privateKeyToAccount(args.signerKey ?? testGatewaySignerKey);
  const signature = await account.signMessage({
    message: { raw: unsignedEnvelopeHash(unsigned as unknown as Record<string, unknown>) },
  });
  return { ...unsigned, signature } as SignedEnvelope<T, 1 | 2>;
}

export interface GlobalPolicyFixtureArgs {
  environment?: string;
  chainId?: number;
  gatewayAudience?: string;
  canonicalToken?: Address;
  signerKey?: Hex;
}

export async function buildGlobalPolicyFixture(
  args: GlobalPolicyFixtureArgs = {},
): Promise<StandardRailGlobalPolicy> {
  const environment = args.environment ?? "testnet";
  const chainId = args.chainId ?? 84_532;
  const gatewayAudience = args.gatewayAudience ?? "https://gateway.example";
  const canonicalToken = args.canonicalToken ?? "0x6666666666666666666666666666666666666666";
  const chainEvidencePolicy = await signTestEnvelope({
    artifactType: "ChainEvidencePolicyV2",
    schemaVersion: 2,
    environment,
    chainId,
    audience: gatewayAudience,
    signerKeyId: "gateway-protocol",
    signerKey: args.signerKey,
    payload: {
      policyId: "test-chain-policy",
      canonicalToken,
      canonicalTokenRuntimeCodeHash: hash32("5"),
      tokenImplementationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      tokenImplementationRuntimeCodeHash: hash32("a"),
      tokenImplementationSlot: hash32("b"),
      tokenDomainSeparator: hash32("c"),
      maximumSourceLagBlocks: 3,
      finalityBlockTimeSeconds: 2,
      maximumLogPageEvents: 10_000,
    },
  });
  const activeRailProfile = await signTestEnvelope({
    artifactType: "ActiveRailProfileV1",
    schemaVersion: 1,
    environment,
    chainId,
    audience: gatewayAudience,
    signerKeyId: "gateway-protocol",
    signerKey: args.signerKey,
    payload: {
      railEpoch: "1",
      facilitatorProfileHash: hash32("1"),
      priorRailEpoch: "0",
      priorActiveRailProfileHash: hash32("0"),
      environment,
      chainId,
      activatedAt: 100,
      admissionValidBefore: Math.floor(Date.now() / 1_000) + 86_400,
      recoveryValidBefore: Math.floor(Date.now() / 1_000) + 172_800,
    },
  });
  const railCapabilityRequirements = await signTestEnvelope({
    artifactType: "RailCapabilityRequirementsV1",
    schemaVersion: 1,
    environment,
    chainId,
    audience: gatewayAudience,
    signerKeyId: "gateway-protocol",
    signerKey: args.signerKey,
    payload: {
      requirementId: "test-rail-capabilities",
      scheme: "exact",
      network: `eip155:${chainId}`,
      asset: canonicalToken,
      assetTransferMethod: "eip3009",
      authenticatedResponseEvidence: "cdp-jwt-v1",
      screeningCoverage: "gateway-and-facilitator-v1",
      calldataSemantics: "transferWithAuthorization-v1",
      allowedExtensionSetHash: hash32("e"),
    },
  });
  return {
    chainEvidencePolicy: chainEvidencePolicy as StandardRailGlobalPolicy["chainEvidencePolicy"],
    activeRailProfile: activeRailProfile as StandardRailGlobalPolicy["activeRailProfile"],
    railCapabilityRequirements:
      railCapabilityRequirements as StandardRailGlobalPolicy["railCapabilityRequirements"],
    splitterCreationCode: testSplitterCreationCode,
    sanctionsOracleRuntimeCodeHash: hash32("d"),
  };
}

export function encodeGlobalPolicy(policy: StandardRailGlobalPolicy): string {
  return JSON.stringify(policy);
}

export interface RuntimeHeadFixtureArgs {
  globalPolicy: StandardRailGlobalPolicy;
  serviceSlug: string;
  skillId: string;
  gatewayOrigin?: string;
  gatewayAudience?: string;
  environment?: string;
  chainId?: number;
  providerAgentId?: string;
  serviceId?: Hex;
  providerPayee?: Address;
  daskiCommissionReceiver?: Address;
  commissionBps?: number;
  splitterFactory?: Address;
  agentWallet?: Address;
  pricing?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  capacity?: { maxOpenOrders: number };
  deadlines?: { dispatchSeconds?: number };
  listingEpoch?: string;
}

export function buildRuntimeHeadFixture(args: RuntimeHeadFixtureArgs): RuntimeListingHead {
  const environment = args.environment ?? "testnet";
  const chainId = args.chainId ?? 84_532;
  const gatewayOrigin = args.gatewayOrigin ?? "https://gateway.example";
  const gatewayAudience = args.gatewayAudience ?? gatewayOrigin;
  const providerAgentId = args.providerAgentId ?? "8327";
  const serviceId = (args.serviceId ?? hash32("0")) as Hex;
  const providerPayee = args.providerPayee ?? "0x1111111111111111111111111111111111111111";
  const daskiCommissionReceiver =
    args.daskiCommissionReceiver ?? "0x2222222222222222222222222222222222222222";
  const commissionBps = args.commissionBps ?? 500;
  const splitterFactory = args.splitterFactory ?? "0x3333333333333333333333333333333333333333";
  const agentWallet = args.agentWallet ?? providerPayee;
  const listingEpoch = args.listingEpoch ?? "1";
  const chainPolicy = args.globalPolicy.chainEvidencePolicy;
  const canonicalToken = chainPolicy.payload.canonicalToken;
  const splitterFactoryRuntimeCodeHash = hash32("7");
  // The gateway's dynamic listing policy hash, reproduced with the
  // production preimage so materializeOutcome's recompute agrees.
  const policyVersionHash = canonicalHash({
    artifactType: "GatewayDynamicListingPolicyV1",
    chainId,
    canonicalToken: getAddress(canonicalToken),
    daskiCommissionReceiver: getAddress(
      args.daskiCommissionReceiver ?? "0x2222222222222222222222222222222222222222",
    ),
    commissionBps: args.commissionBps ?? 500,
    splitterFactory: getAddress(
      args.splitterFactory ?? "0x3333333333333333333333333333333333333333",
    ),
    splitterCreationCodeHash: keccak256(args.globalPolicy.splitterCreationCode),
    splitterFactoryRuntimeCodeHash,
    chainEvidencePolicyHash: canonicalHash(chainPolicy),
    railCapabilityRequirementsHash: canonicalHash(args.globalPolicy.railCapabilityRequirements),
  });
  const listingId = `00000000-0000-4000-8000-${args.skillId.length.toString().padStart(12, "0")}`;
  const listingKey = canonicalHash({
    domain: "DaskiListingKeyV1",
    chainId,
    providerAgentId,
    serviceId: serviceId.toLowerCase(),
    skillId: args.skillId,
  });
  const skillContractHash = canonicalHash({ skill: args.skillId, fixture: true });
  const providerIntentHash = canonicalHash({ intent: args.skillId, fixture: true });
  const salt = canonicalHash({ salt: args.skillId, listingEpoch });
  const preparation: SignedEnvelope<Record<string, unknown>> = {
    artifactType: "GatewayListingPreparationV1",
    schemaVersion: 1,
    environment,
    chainId,
    audience: gatewayAudience,
    signerKeyId: "gateway-protocol",
    issuedAt: 100,
    validBefore: Math.floor(Date.now() / 1_000) + 86_400,
    payload: {
      registrationId: listingId,
      listingId,
      listingKey,
      providerAgentId,
      serviceId,
      serviceSlug: args.serviceSlug,
      serviceVersion: "1",
      skillId: args.skillId,
      skillContractHash,
      skillContractSetHash: hash32("4"),
      providerIntentHash,
      canonicalToken,
      providerPayee,
      daskiCommissionReceiver,
      commissionBps,
      splitterFactory,
      splitterDeploymentSalt: salt,
      policyVersionHash,
      listingEpoch,
    },
    signature: dummySignature,
  };
  const preparationHash = canonicalHash(preparation);
  const constructorArgs = encodeAbiParameters(
    [
      { type: "uint256" }, { type: "address" }, { type: "address" },
      { type: "address" }, { type: "uint16" }, { type: "bytes32" },
      { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" },
    ],
    [
      BigInt(chainId), canonicalToken, providerPayee, daskiCommissionReceiver,
      commissionBps, policyVersionHash, listingKey, preparationHash,
      BigInt(listingEpoch),
    ],
  );
  const initCodeHash = keccak256(concatHex([
    args.globalPolicy.splitterCreationCode, constructorArgs,
  ]));
  const splitterAddress = getCreate2Address({
    from: splitterFactory,
    salt,
    bytecodeHash: initCodeHash,
  });
  const commitment: RuntimeListingCommitmentV1 = {
    schemaVersion: 1,
    environment,
    chainId,
    gatewayAudience,
    listingId,
    listingKey,
    listingEpoch,
    providerAgentId,
    serviceId,
    skillId: args.skillId,
    skillContractHash,
    providerIntentHash,
    paymentRequired: true,
    preparationHash,
    controlProfileHash: null,
    policyVersionHash,
    canonicalToken,
    daskiCommissionReceiver,
    commissionBps,
    providerPayee,
    splitterFactory,
    splitterAddress,
  } as unknown as RuntimeListingCommitmentV1;
  const checkpoint: SplitterActivationCheckpoint = {
    splitterDeploymentTransactionHash: hash32("e"),
    splitterDeploymentBlockNumber: "100",
    splitterDeploymentBlockHash: hash32("f"),
    splitterRuntimeCodeHash: hash32("9"),
    splitterActivationBlockNumber: "124",
    splitterActivationBlockHash: hash32("8"),
    splitterActivationPosition: "END_OF_BLOCK",
    splitterStartingTokenBalance: "0",
    splitterStartingReleaseSequence: "0",
  };
  const intent = {
    artifactType: "ProviderServiceRegistrationIntentV1",
    schemaVersion: 1,
    environment,
    chainId,
    audience: gatewayAudience,
    signerKeyId: "provider-authority",
    issuedAt: 100,
    validBefore: Math.floor(Date.now() / 1_000) + 86_400,
    payload: {
      providerAgentId,
      serviceId,
      serviceSlug: args.serviceSlug,
      serviceVersion: "1",
      providerPayee,
      serviceContractHash: hash32("3"),
      skillContractSetHash: hash32("4"),
      skills: [{ skillId: args.skillId, skillContractHash }],
      railPolicyHash: hash32("2"),
      registrationNonce: hash32("6"),
    },
    signature: dummySignature,
  };
  const bundle: ProviderRuntimeListingBundleV1 = {
    schemaVersion: 1,
    listing: {
      listingId,
      listingKey,
      skillId: args.skillId,
      skillContractHash,
      paymentRequired: true,
      acceptingNewOrders: true,
      deploymentRequired: true,
      reused: false,
      splitterAddress,
      preparation: preparation as never,
      controlProfile: null,
      transaction: null,
    },
    skillContract: {
      skillId: args.skillId,
      skillContractHash,
      acceptingNewOrders: true,
      contract: {
        paymentRequired: true,
        assetAction: null,
        inputSchema: args.inputSchema ?? {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        resultSchema: {
          type: "object",
          properties: { note: { type: "string" } },
          required: ["note"],
          additionalProperties: false,
        },
        pricing: args.pricing ?? {
          USDC: { type: "one-time", min_amount: "1000000", max_amount: "50000000" },
        },
        ...(args.capacity ? { capacity: args.capacity } : {}),
        ...(args.deadlines ? { deadlines: args.deadlines } : {}),
      },
    },
    intent: intent as never,
    splitterTransactionHash: hash32("e"),
    activationCheckpoint: checkpoint,
    providerIdentity: {
      agentWallet,
      verifiedAtBlock: "90",
    },
    policyRefs: {
      railPolicyHash: policyVersionHash,
      canonicalToken,
      splitterFactory,
      splitterFactoryRuntimeCodeHash,
      splitterCreationCodeHash: keccak256(args.globalPolicy.splitterCreationCode),
    },
  };
  return {
    gatewayOrigin,
    serviceId,
    skillId: args.skillId,
    listingId,
    listingKey,
    paymentRequired: true,
    runtimeCommitmentHash: canonicalHash(commitment),
    runtimeCommitment: commitment,
    bundle,
    promotedAt: new Date(1_700_000_000_000),
  };
}
