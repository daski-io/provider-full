import { concatHex, encodeAbiParameters, getAddress, keccak256, type Address, type Hex } from "viem";
import { recoverMessageAddress } from "viem";
import type { ProviderOutcomeConfig, SignedEnvelope } from "./types.js";
import {
  SIGNED_ENVELOPE_KEYS,
  assertExactKeys,
  assertNoDuplicateJsonKeys,
  canonicalHash,
  unsignedEnvelopeHash,
} from "./canonical.js";
import { getFloor, isPaymentRequired, isVariable, validatePricing } from "../pricing/index.js";
import type { RuntimeListingHead } from "../gatewayRegistration/runtimeCatalog.js";

/**
 * Catalog-driven outcome materialization: build the exact
 * `ProviderOutcomeConfig` shape the standard rail has always validated, but
 * from the promoted runtime-catalog heads (each a self-contained
 * `ProviderRuntimeListingBundleV1`) joined with the deployment-owned global
 * rail-policy bundle, instead of the retired `STANDARD_RAIL_OUTCOMES_JSON`
 * env blob.
 *
 * Binding is `recipe-bound-v2` with the approved Option A slot layout: the
 * `listingManifestHash` slot carries the runtime listing commitment hash and
 * the `providerOfferHash` slot carries the provider intent hash. The intent
 * hash is required to equal the one embedded in the runtime commitment (and
 * in the gateway-signed preparation the splitter's commitment hash pins), so
 * a dispatch verifier that matches both slots has transitively matched the
 * signed intent.
 */

/**
 * Deployment-owned global rail policy (`STANDARD_RAIL_GLOBAL_POLICY_JSON`):
 * the schema-independent envelopes and constants every listing shares. The
 * chain-evidence policy and active rail profile are gateway-protocol-signed
 * envelopes; the splitter creation code is self-verifying against each
 * listing's pinned creation-code hash and CREATE2 address; the sanctions
 * oracle pin is deployment configuration on par with the oracle address.
 */
export interface StandardRailGlobalPolicy {
  chainEvidencePolicy: SignedEnvelope<ChainEvidencePolicyPayload, 2>;
  activeRailProfile: SignedEnvelope<Record<string, unknown>>;
  railCapabilityRequirements: SignedEnvelope<Record<string, unknown>>;
  splitterCreationCode: Hex;
  sanctionsOracleRuntimeCodeHash: Hex;
}

interface ChainEvidencePolicyPayload {
  policyId: string;
  canonicalToken: Address;
  canonicalTokenRuntimeCodeHash: Hex;
  tokenImplementationAddress: Address;
  tokenImplementationRuntimeCodeHash: Hex;
  tokenImplementationSlot: Hex;
  tokenDomainSeparator: Hex;
  maximumSourceLagBlocks: number;
  finalityBlockTimeSeconds: number;
  maximumLogPageEvents: number;
  [key: string]: unknown;
}

// Gateway-default listing policies for card contracts that do not override
// them. These MUST mirror the gateway's own defaults (the dispatch carries
// the resolved deadline and this side cross-checks it), and they match the
// values every sealed listing shipped with.
export const DEFAULT_MAX_OPEN_ORDERS = 10;
export const DEFAULT_DISPATCH_DEADLINE_SECONDS = 300;
export const DEFAULT_QUOTE_MAXIMUM_LIFETIME_SECONDS = 180;
export const DEFAULT_QUOTE_MINIMUM_PAYMENT_WINDOW_SECONDS = 30;

const hex32 = /^0x[0-9a-fA-F]{64}$/;

function needHex32(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !hex32.test(value)) {
    throw new Error(`${label} must be bytes32`);
  }
  return value as Hex;
}

async function verifyGlobalEnvelope(args: {
  envelope: SignedEnvelope<unknown, 1 | 2>;
  artifactType: string;
  schemaVersion: 1 | 2;
  environment: string;
  chainId: number;
  gatewayAudience: string;
  gatewaySigner: Address;
}): Promise<void> {
  assertExactKeys(
    args.envelope as unknown as Record<string, unknown>,
    SIGNED_ENVELOPE_KEYS,
    `${args.artifactType} envelope`,
  );
  if (
    args.envelope.artifactType !== args.artifactType ||
    args.envelope.schemaVersion !== args.schemaVersion ||
    args.envelope.environment !== args.environment ||
    args.envelope.chainId !== args.chainId ||
    args.envelope.audience !== args.gatewayAudience ||
    args.envelope.validBefore <= Math.floor(Date.now() / 1_000)
  ) throw new Error(`${args.artifactType} domain is invalid`);
  let recovered: Address;
  try {
    recovered = await recoverMessageAddress({
      message: {
        raw: unsignedEnvelopeHash(args.envelope as unknown as Record<string, unknown>),
      },
      signature: args.envelope.signature,
    });
  } catch {
    throw new Error(`${args.artifactType} signature is invalid`);
  }
  if (getAddress(recovered) !== getAddress(args.gatewaySigner)) {
    throw new Error(`${args.artifactType} signature is invalid`);
  }
}

export async function loadStandardRailGlobalPolicy(args: {
  environment: string;
  chainId: number;
  gatewayAudience: string;
  gatewaySigner: Address;
  env?: NodeJS.ProcessEnv;
}): Promise<StandardRailGlobalPolicy> {
  const env = args.env ?? process.env;
  const source = env.STANDARD_RAIL_GLOBAL_POLICY_JSON?.trim();
  if (!source) {
    throw new Error("STANDARD_RAIL_GLOBAL_POLICY_JSON is required for the standard rail");
  }
  let parsed: StandardRailGlobalPolicy;
  try {
    assertNoDuplicateJsonKeys(source);
    parsed = JSON.parse(source) as StandardRailGlobalPolicy;
  } catch {
    throw new Error("STANDARD_RAIL_GLOBAL_POLICY_JSON is malformed");
  }
  assertExactKeys(parsed as unknown as Record<string, unknown>, [
    "chainEvidencePolicy", "activeRailProfile", "railCapabilityRequirements",
    "splitterCreationCode", "sanctionsOracleRuntimeCodeHash",
  ], "standard-rail global policy");
  await verifyGlobalEnvelope({
    envelope: parsed.railCapabilityRequirements,
    artifactType: "RailCapabilityRequirementsV1",
    schemaVersion: 1,
    environment: args.environment,
    chainId: args.chainId,
    gatewayAudience: args.gatewayAudience,
    gatewaySigner: args.gatewaySigner,
  });
  await verifyGlobalEnvelope({
    envelope: parsed.chainEvidencePolicy,
    artifactType: "ChainEvidencePolicyV2",
    schemaVersion: 2,
    environment: args.environment,
    chainId: args.chainId,
    gatewayAudience: args.gatewayAudience,
    gatewaySigner: args.gatewaySigner,
  });
  await verifyGlobalEnvelope({
    envelope: parsed.activeRailProfile,
    artifactType: "ActiveRailProfileV1",
    schemaVersion: 1,
    environment: args.environment,
    chainId: args.chainId,
    gatewayAudience: args.gatewayAudience,
    gatewaySigner: args.gatewaySigner,
  });
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(parsed.splitterCreationCode)) {
    throw new Error("Global policy splitter creation code is invalid");
  }
  needHex32(parsed.sanctionsOracleRuntimeCodeHash, "sanctionsOracleRuntimeCodeHash");
  const policy = parsed.chainEvidencePolicy.payload;
  getAddress(policy.canonicalToken);
  getAddress(policy.tokenImplementationAddress);
  for (const field of [
    "canonicalTokenRuntimeCodeHash", "tokenImplementationRuntimeCodeHash",
    "tokenImplementationSlot", "tokenDomainSeparator",
  ] as const) {
    needHex32(policy[field], `chain evidence policy ${field}`);
  }
  if (
    !Number.isSafeInteger(policy.maximumSourceLagBlocks) || policy.maximumSourceLagBlocks < 0 ||
    !Number.isSafeInteger(policy.maximumLogPageEvents) || policy.maximumLogPageEvents < 1
  ) throw new Error("Chain evidence policy bounds are invalid");
  return parsed;
}

const splitterConstructorTypes = [
  { type: "uint256" }, { type: "address" }, { type: "address" },
  { type: "address" }, { type: "uint16" }, { type: "bytes32" },
  { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" },
] as const;

/**
 * Materialize one paid runtime-catalog head into the exact outcome shape.
 * Every cryptographic fact is re-derived or cross-checked; a head that does
 * not reproduce its own splitter provenance fails closed.
 */
export function materializeOutcome(args: {
  head: RuntimeListingHead;
  globalPolicy: StandardRailGlobalPolicy;
  chainId: number;
  /** Provider-wide endpoint control profile hash (walletConfig domain). */
  providerControlProfileHash: Hex;
}): ProviderOutcomeConfig {
  const { head, globalPolicy, chainId } = args;
  const bundle = head.bundle;
  const commitment = head.runtimeCommitment;
  const preparation = bundle.listing.preparation;
  const checkpoint = bundle.activationCheckpoint;
  const skillContract = bundle.skillContract;
  const label = `runtime listing ${head.skillId}`;
  if (!preparation || !checkpoint || !skillContract) {
    throw new Error(`${label} is missing its preparation, checkpoint, or skill contract`);
  }
  if (!bundle.listing.splitterAddress) {
    throw new Error(`${label} is paid but has no splitter address`);
  }
  if (head.runtimeCommitmentHash !== canonicalHash(commitment)) {
    throw new Error(`${label} runtime commitment hash does not match its content`);
  }
  const splitterAddress = commitment.splitterAddress;
  if (
    commitment.listingId !== head.listingId ||
    commitment.listingKey.toLowerCase() !== head.listingKey.toLowerCase() ||
    commitment.serviceId.toLowerCase() !== head.serviceId.toLowerCase() ||
    commitment.skillId !== head.skillId ||
    commitment.paymentRequired !== true ||
    !splitterAddress ||
    splitterAddress.toLowerCase() !== bundle.listing.splitterAddress.toLowerCase()
  ) throw new Error(`${label} runtime commitment does not match its head`);
  if (!splitterAddress) throw new Error(`${label} has no committed splitter address`);
  const splitterFactory = commitment.splitterFactory;
  if (!splitterFactory) throw new Error(`${label} has no committed splitter factory`);
  const prepared = preparation.payload;
  if (
    prepared.providerIntentHash.toLowerCase() !== commitment.providerIntentHash.toLowerCase() ||
    prepared.listingKey.toLowerCase() !== commitment.listingKey.toLowerCase() ||
    prepared.listingEpoch !== commitment.listingEpoch ||
    prepared.policyVersionHash.toLowerCase() !== commitment.policyVersionHash.toLowerCase() ||
    canonicalHash(preparation) !== commitment.preparationHash
  ) throw new Error(`${label} preparation does not match its runtime commitment`);
  const chainPolicy = globalPolicy.chainEvidencePolicy.payload;
  const expectedPolicyVersionHash = canonicalHash({
    artifactType: "GatewayDynamicListingPolicyV1",
    chainId,
    canonicalToken: getAddress(commitment.canonicalToken),
    daskiCommissionReceiver: getAddress(commitment.daskiCommissionReceiver),
    commissionBps: commitment.commissionBps,
    splitterFactory: getAddress(splitterFactory),
    splitterCreationCodeHash: keccak256(globalPolicy.splitterCreationCode),
    splitterFactoryRuntimeCodeHash: bundle.policyRefs.splitterFactoryRuntimeCodeHash,
    chainEvidencePolicyHash: canonicalHash(globalPolicy.chainEvidencePolicy),
    railCapabilityRequirementsHash: canonicalHash(globalPolicy.railCapabilityRequirements),
  });
  if (expectedPolicyVersionHash.toLowerCase() !== commitment.policyVersionHash.toLowerCase()) {
    throw new Error(`${label} pins a different rail policy than the global bundle reproduces`);
  }
  if (getAddress(chainPolicy.canonicalToken) !== getAddress(commitment.canonicalToken)) {
    throw new Error(`${label} canonical token differs from the chain-evidence policy`);
  }
  const creationCodeHash = keccak256(globalPolicy.splitterCreationCode);
  if (creationCodeHash.toLowerCase() !== bundle.policyRefs.splitterCreationCodeHash.toLowerCase()) {
    throw new Error(`${label} splitter creation code differs from the promoted policy pin`);
  }
  const contract = skillContract.contract as Record<string, unknown>;
  const requestSchema = contract.inputSchema as ProviderOutcomeConfig["requestSchema"];
  if (!requestSchema || typeof requestSchema !== "object") {
    throw new Error(`${label} skill contract lacks an input schema`);
  }
  const pricing = validatePricing(contract.pricing);
  if (!isPaymentRequired(pricing)) {
    throw new Error(`${label} is promoted as paid but its card pricing is free`);
  }
  const dynamic = isVariable(pricing);
  const floor = getFloor(pricing);
  const fixedAmount = dynamic ? "0" : (floor ?? 0n).toString();
  if (!dynamic && (floor === null || floor <= 0n)) {
    throw new Error(`${label} fixed pricing amount is invalid`);
  }
  const capacity = (contract.capacity as { maxOpenOrders?: number } | undefined)?.maxOpenOrders;
  const deadlines = contract.deadlines as { dispatchSeconds?: number } | undefined;
  const intentPayload = bundle.intent.payload;
  if (intentPayload.serviceId.toLowerCase() !== head.serviceId.toLowerCase()) {
    throw new Error(`${label} intent serves a different service`);
  }
  const outcome: ProviderOutcomeConfig = {
    outcomeId: head.skillId,
    serviceSlug: intentPayload.serviceSlug,
    serviceId: head.serviceId,
    skillId: head.skillId,
    listingManifestHash: head.runtimeCommitmentHash,
    providerOfferHash: commitment.providerIntentHash,
    pricingMode: dynamic ? "dynamic" : "fixed",
    fixedGrossAmount: fixedAmount,
    quoteMaximumLifetimeSeconds: dynamic ? DEFAULT_QUOTE_MAXIMUM_LIFETIME_SECONDS : 0,
    quoteMinimumPaymentWindowSeconds: dynamic ? DEFAULT_QUOTE_MINIMUM_PAYMENT_WINDOW_SECONDS : 0,
    providerControlProfileHash: args.providerControlProfileHash,
    activeRailProfileHash: canonicalHash(globalPolicy.activeRailProfile),
    customerIdentityPolicyId: "none",
    token: getAddress(commitment.canonicalToken),
    splitter: getAddress(splitterAddress),
    splitterFactory: getAddress(splitterFactory),
    splitterFactoryRuntimeCodeHash: bundle.policyRefs.splitterFactoryRuntimeCodeHash,
    splitterCreationCode: globalPolicy.splitterCreationCode,
    splitterCreationCodeHash: creationCodeHash,
    splitterInitCodeHash: "0x" as Hex,
    splitterDeploymentSalt: prepared.splitterDeploymentSalt,
    splitterRuntimeCodeHash: checkpoint.splitterRuntimeCodeHash,
    splitterDeploymentTransaction: checkpoint.splitterDeploymentTransactionHash,
    splitterDeploymentBlockNumber: checkpoint.splitterDeploymentBlockNumber,
    splitterDeploymentBlockHash: checkpoint.splitterDeploymentBlockHash,
    splitterActivationBlockNumber: checkpoint.splitterActivationBlockNumber,
    splitterActivationBlockHash: checkpoint.splitterActivationBlockHash,
    splitterActivationPosition: checkpoint.splitterActivationPosition,
    splitterStartingTokenBalance: checkpoint.splitterStartingTokenBalance,
    splitterStartingReleaseSequence: checkpoint.splitterStartingReleaseSequence,
    tokenRuntimeCodeHash: chainPolicy.canonicalTokenRuntimeCodeHash,
    tokenImplementationAddress: getAddress(chainPolicy.tokenImplementationAddress),
    tokenImplementationRuntimeCodeHash: chainPolicy.tokenImplementationRuntimeCodeHash,
    tokenImplementationSlot: chainPolicy.tokenImplementationSlot,
    tokenDomainSeparator: chainPolicy.tokenDomainSeparator,
    sanctionsOracleRuntimeCodeHash: globalPolicy.sanctionsOracleRuntimeCodeHash,
    providerControlledWallets: [],
    maximumSourceLagBlocks: chainPolicy.maximumSourceLagBlocks,
    maximumLogPageEvents: chainPolicy.maximumLogPageEvents,
    listingCommitmentHash: commitment.preparationHash,
    outcomeIdHash: head.listingKey,
    policyVersionHash: expectedPolicyVersionHash,
    listingEpoch: commitment.listingEpoch,
    providerPayee: getAddress(commitment.providerPayee),
    providerTerminalAttestationKey: getAddress(bundle.providerIdentity.agentWallet),
    daskiCommissionReceiver: getAddress(commitment.daskiCommissionReceiver),
    commissionBps: commitment.commissionBps,
    maxOpenOrders: capacity ?? DEFAULT_MAX_OPEN_ORDERS,
    dispatchDeadlineSeconds: deadlines?.dispatchSeconds ?? DEFAULT_DISPATCH_DEADLINE_SECONDS,
    bindingProfile: "recipe-bound-v2",
    requestSchema,
  };
  const constructorArgs = encodeAbiParameters(splitterConstructorTypes, [
    BigInt(chainId), getAddress(outcome.token), getAddress(outcome.providerPayee),
    getAddress(outcome.daskiCommissionReceiver), outcome.commissionBps,
    outcome.policyVersionHash, outcome.outcomeIdHash, outcome.listingCommitmentHash,
    BigInt(outcome.listingEpoch),
  ]);
  outcome.splitterInitCodeHash = keccak256(concatHex([
    globalPolicy.splitterCreationCode, constructorArgs,
  ]));
  return outcome;
}

/**
 * Materialize every paid head for one gateway origin. Unknown heads (paid
 * heads whose skill is not installed as paid) and duplicate outcome ids fail
 * closed; an installed paid skill without a head is reported, never fatal —
 * the reset-cutover boots the provider BEFORE the bootstrap registration
 * promotes its listings, and completeness is proven by release acceptance.
 */
export function materializeCatalogOutcomes(args: {
  heads: readonly RuntimeListingHead[];
  globalPolicy: StandardRailGlobalPolicy;
  chainId: number;
  providerControlProfileHash: Hex;
  installedPaidSkills: ReadonlySet<string>;
  warn?: (message: string) => void;
}): Map<string, ProviderOutcomeConfig> {
  const paidHeads = args.heads.filter((head) => head.paymentRequired);
  const outcomes = new Map<string, ProviderOutcomeConfig>();
  const coveredSkills = new Set<string>();
  for (const head of paidHeads) {
    const outcome = materializeOutcome({
      head, globalPolicy: args.globalPolicy, chainId: args.chainId,
      providerControlProfileHash: args.providerControlProfileHash,
    });
    const skillKey = `${outcome.serviceSlug}:${outcome.skillId}`;
    if (!args.installedPaidSkills.has(skillKey)) {
      throw new Error(`Runtime catalog head ${skillKey} is not an installed paid skill`);
    }
    if (outcomes.has(outcome.outcomeId) || coveredSkills.has(skillKey)) {
      throw new Error(`Runtime catalog head ${skillKey} duplicates outcome ${outcome.outcomeId}`);
    }
    coveredSkills.add(skillKey);
    outcomes.set(outcome.outcomeId, outcome);
  }
  for (const skillKey of args.installedPaidSkills) {
    if (!coveredSkills.has(skillKey)) {
      args.warn?.(
        `installed paid skill ${skillKey} has no promoted runtime listing yet — not purchasable until registration`,
      );
    }
  }
  return outcomes;
}
