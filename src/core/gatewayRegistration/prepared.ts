import {
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { canonicalHash } from "../standardRail/canonical.js";
import type {
  GatewayRegistrationView,
  PreparedListing,
  ProviderServiceRegistrationIntentEnvelope,
  PublishedServiceContract,
  RegistrationPolicy,
} from "./types.js";
import { verifyGatewayEnvelope } from "./wire.js";

export const factoryAbi = parseAbi([
  "function deploy(bytes32 salt,uint256 canonicalChainId,address canonicalToken,address providerPayee,address daskiCommissionReceiver,uint16 commissionBps,bytes32 policyVersionHash,bytes32 outcomeIdHash,bytes32 listingCommitmentHash,uint64 listingEpoch) returns (address splitter)",
  "function computeAddress(bytes32 salt,uint256 canonicalChainId,address canonicalToken,address providerPayee,address daskiCommissionReceiver,uint16 commissionBps,bytes32 policyVersionHash,bytes32 outcomeIdHash,bytes32 listingCommitmentHash,uint64 listingEpoch) view returns (address)",
  "function splitterCreationCodeHash() pure returns (bytes32)",
]);

/**
 * Throw naming every failed cross-check by field. Diagnostics carry field,
 * skill and listing identifiers only, never a signed body or secret.
 */
function requireMatches(message: string, checks: Record<string, boolean>): void {
  const failed = Object.entries(checks)
    .filter(([, matches]) => !matches)
    .map(([field]) => field);
  if (failed.length > 0) throw new Error(`${message} (mismatched: ${failed.join(", ")})`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function bytes32(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must be bytes32`);
  }
  return value.toLowerCase() as Hex;
}

export function parseGatewayRegistrationView(raw: unknown): GatewayRegistrationView {
  const value = record(raw, "gateway registration response");
  const prepared = record(value.prepared, "prepared registration");
  if (
    typeof value.registrationId !== "string" ||
    value.registrationId !== prepared.registrationId ||
    !["PREPARED", "EVIDENCE_PENDING", "ACTIVE", "SUPERSEDED", "REJECTED"]
      .includes(value.state as string) ||
    typeof value.providerAgentId !== "string" ||
    typeof value.serviceSlug !== "string" ||
    typeof value.serviceVersion !== "string" ||
    typeof value.agentCardUrl !== "string" ||
    typeof value.marketplaceEnabled !== "boolean" ||
    typeof value.registrationHealthy !== "boolean" ||
    !Array.isArray(prepared.listings)
  ) throw new Error("gateway registration response is malformed");
  bytes32(value.serviceId, "service id");
  try { getAddress(value.providerPayee as string); } catch {
    throw new Error("gateway registration payee is malformed");
  }
  if (value.runtimeCommitments !== undefined) {
    if (!Array.isArray(value.runtimeCommitments) || value.runtimeCommitments.length > 128) {
      throw new Error("gateway runtime commitments are malformed");
    }
    for (const item of value.runtimeCommitments as unknown[]) {
      const entry = record(item, "runtime commitment");
      if (typeof entry.listingId !== "string" || entry.listingId.length > 64) {
        throw new Error("gateway runtime commitments are malformed");
      }
      bytes32(entry.runtimeCommitmentHash, "runtime commitment hash");
    }
  }
  return value as unknown as GatewayRegistrationView;
}

function listingKey(args: {
  chainId: number;
  providerAgentId: string;
  serviceId: Hex;
  skillId: string;
}): Hex {
  return canonicalHash({
    domain: "DaskiListingKeyV1",
    chainId: args.chainId,
    providerAgentId: args.providerAgentId,
    serviceId: args.serviceId.toLowerCase(),
    skillId: args.skillId,
  });
}

async function verifyControlProfile(args: {
  listing: PreparedListing;
  skill: PublishedServiceContract["skills"][number];
  service: PublishedServiceContract;
  intentHash: Hex;
  registrationId: string;
  providerAgentId: string;
  policy: RegistrationPolicy;
  gatewaySigner: Address;
}): Promise<void> {
  const action = args.skill.contract.assetAction;
  const profile = args.listing.controlProfile;
  if (!action) {
    if (profile !== null) throw new Error("gateway added an undeclared asset action");
    return;
  }
  if (!profile) throw new Error("gateway omitted an admitted asset-action profile");
  await verifyGatewayEnvelope({
    envelope: profile,
    artifactType: "GatewaySkillControlProfileV1",
    policy: args.policy,
    gatewaySigner: args.gatewaySigner,
  });
  const payload = profile.payload;
  requireMatches(
    `gateway control profile for ${args.skill.skillId} weakens or changes the provider contract`,
    {
      registrationId: args.listing.reused || payload.registrationId === args.registrationId,
      providerIntentHash: args.listing.reused || payload.providerIntentHash === args.intentHash,
      providerAgentId: payload.providerAgentId === args.providerAgentId,
      serviceId: payload.serviceId === args.service.serviceId,
      serviceSlug: payload.serviceSlug === args.service.serviceSlug,
      skillId: payload.skillId === args.skill.skillId,
      skillContractHash: payload.skillContractHash === args.skill.skillContractHash,
      policyVersionHash: payload.policyVersionHash === args.policy.railPolicyHash,
      providerEndpoint: payload.providerEndpoint === args.service.standardRail.assetActionUrl,
      ownershipPolicy: payload.ownershipPolicy === action.ownershipPolicy,
      effect: payload.effect === action.effect,
      replayPolicy: payload.replayPolicy === action.replayPolicy,
      retentionSeconds: payload.retentionSeconds === action.retentionSeconds,
      walletAuthorizationRequired: payload.walletAuthorizationRequired === true,
      delayedConfirmationRequired:
        payload.delayedConfirmationRequired === (action.effect === "destructive"),
      confirmationSummarySchemaHash: payload.confirmationSummarySchemaHash === (
        action.confirmationSummarySchema
          ? canonicalHash(action.confirmationSummarySchema)
          : null
      ),
      confirmationSummaryTemplateHash: payload.confirmationSummaryTemplateHash === (
        action.confirmationSummaryTemplate
          ? canonicalHash(action.confirmationSummaryTemplate)
          : null
      ),
    },
  );
}

async function verifyPaidPreparation(args: {
  listing: PreparedListing;
  skill: PublishedServiceContract["skills"][number];
  service: PublishedServiceContract;
  intent: ProviderServiceRegistrationIntentEnvelope;
  registrationId: string;
  providerAgentId: string;
  providerPayee: Address;
  policy: RegistrationPolicy;
  gatewaySigner: Address;
  publicClient: any;
  finalizedBlock: bigint;
}): Promise<void> {
  const preparation = args.listing.preparation;
  if (!preparation || !args.listing.splitterAddress) {
    throw new Error("paid listing preparation is incomplete");
  }
  await verifyGatewayEnvelope({
    envelope: preparation,
    artifactType: "GatewayListingPreparationV1",
    policy: args.policy,
    gatewaySigner: args.gatewaySigner,
  });
  const payload = preparation.payload;
  const commitmentHash = canonicalHash(preparation);
  requireMatches(
    `gateway listing preparation for ${args.skill.skillId} does not match provider consent`,
    {
      registrationId: args.listing.reused || payload.registrationId === args.registrationId,
      providerIntentHash:
        args.listing.reused || payload.providerIntentHash === canonicalHash(args.intent),
      skillContractSetHash: args.listing.reused ||
        payload.skillContractSetHash === args.service.skillContractSetHash,
      listingId: payload.listingId === args.listing.listingId,
      listingKey: payload.listingKey === args.listing.listingKey,
      providerAgentId: payload.providerAgentId === args.providerAgentId,
      serviceId: payload.serviceId === args.service.serviceId,
      serviceSlug: payload.serviceSlug === args.service.serviceSlug,
      serviceVersion: payload.serviceVersion === args.service.serviceVersion,
      skillId: payload.skillId === args.skill.skillId,
      skillContractHash: payload.skillContractHash === args.skill.skillContractHash,
      canonicalToken: getAddress(payload.canonicalToken) === args.policy.canonicalToken,
      providerPayee: getAddress(payload.providerPayee) === getAddress(args.providerPayee),
      daskiCommissionReceiver:
        getAddress(payload.daskiCommissionReceiver) === args.policy.daskiCommissionReceiver,
      commissionBps: payload.commissionBps === args.policy.commissionBps,
      splitterFactory: getAddress(payload.splitterFactory) === args.policy.splitterFactory,
      policyVersionHash: payload.policyVersionHash === args.policy.railPolicyHash,
      listingEpoch: /^[1-9]\d{0,19}$/.test(payload.listingEpoch),
    },
  );

  const callArgs = [
    payload.splitterDeploymentSalt,
    BigInt(args.policy.chainId),
    args.policy.canonicalToken,
    args.providerPayee,
    args.policy.daskiCommissionReceiver,
    args.policy.commissionBps,
    args.policy.railPolicyHash,
    args.listing.listingKey,
    commitmentHash,
    BigInt(payload.listingEpoch),
  ] as const;
  const predicted = await args.publicClient.readContract({
    address: args.policy.splitterFactory,
    abi: factoryAbi,
    functionName: "computeAddress",
    args: callArgs,
    blockNumber: args.finalizedBlock,
  }) as Address;
  if (getAddress(predicted) !== getAddress(args.listing.splitterAddress)) {
    throw new Error("gateway splitter prediction does not match the trusted factory");
  }
  if (args.listing.deploymentRequired) {
    const transaction = args.listing.transaction;
    if (
      !transaction ||
      transaction.kind !== "splitter-deployment" ||
      transaction.listingId !== args.listing.listingId ||
      getAddress(transaction.to) !== args.policy.splitterFactory ||
      transaction.value !== "0" ||
      transaction.data !== encodeFunctionData({
        abi: factoryAbi,
        functionName: "deploy",
        args: callArgs,
      })
    ) throw new Error("gateway splitter calldata is not canonical");
  } else if (args.listing.transaction !== null) {
    throw new Error("reused listing unexpectedly requests another deployment");
  }
}

export async function verifyPreparedRegistration(args: {
  view: GatewayRegistrationView;
  intent: ProviderServiceRegistrationIntentEnvelope;
  service: PublishedServiceContract;
  providerAgentId: string;
  providerPayee: Address;
  serviceWallet: Address;
  policy: RegistrationPolicy;
  gatewaySigner: Address;
  publicClient: any;
  finalizedBlock: bigint;
}): Promise<void> {
  const prepared = args.view.prepared;
  requireMatches(`gateway prepared the wrong service registration ${args.view.registrationId}`, {
    registrationId: prepared.registrationId === args.view.registrationId,
    providerAgentId: prepared.providerAgentId === args.providerAgentId,
    serviceId: prepared.serviceId === args.service.serviceId &&
      args.view.serviceId === prepared.serviceId,
    serviceSlug: prepared.serviceSlug === args.service.serviceSlug,
    serviceVersion: prepared.serviceVersion === args.service.serviceVersion,
    agentCardUrl: prepared.agentCardUrl === args.service.cardUrl,
    serviceWallet: getAddress(prepared.serviceWallet) === getAddress(args.serviceWallet),
    providerPayee: getAddress(prepared.providerPayee) === getAddress(args.providerPayee) &&
      getAddress(args.view.providerPayee) === getAddress(args.providerPayee),
    providerIntentHash: prepared.providerIntentHash === canonicalHash(args.intent),
    railPolicyHash: prepared.railPolicyHash === args.policy.railPolicyHash,
    listingCount: prepared.listings.length === args.service.skills.length,
  });

  const factoryCode = await args.publicClient.getCode({
    address: args.policy.splitterFactory,
    blockNumber: args.finalizedBlock,
  }) as Hex | undefined;
  const creationCodeHash = await args.publicClient.readContract({
    address: args.policy.splitterFactory,
    abi: factoryAbi,
    functionName: "splitterCreationCodeHash",
    blockNumber: args.finalizedBlock,
  }) as Hex;
  if (
    !factoryCode ||
    keccak256(factoryCode) !== args.policy.splitterFactoryRuntimeCodeHash ||
    creationCodeHash !== args.policy.splitterCreationCodeHash
  ) throw new Error("gateway splitter factory code is not trusted");

  const listings = new Map(prepared.listings.map((listing) => [
    listing.skillId,
    listing,
  ]));
  if (listings.size !== prepared.listings.length) {
    throw new Error("gateway returned duplicate skill listings");
  }
  for (const skill of args.service.skills) {
    const listing = listings.get(skill.skillId);
    if (!listing) throw new Error(`gateway prepared no listing for ${skill.skillId}`);
    requireMatches(`gateway listing ${listing.listingId} does not match the published skill ${skill.skillId}`, {
      listingKey: bytes32(listing.listingKey, "listing key") === listingKey({
        chainId: args.policy.chainId,
        providerAgentId: args.providerAgentId,
        serviceId: args.service.serviceId,
        skillId: skill.skillId,
      }),
      skillContractHash: listing.skillContractHash === skill.skillContractHash,
      paymentRequired: listing.paymentRequired === skill.contract.paymentRequired,
      acceptingNewOrders: listing.acceptingNewOrders === skill.acceptingNewOrders,
    });
    await verifyControlProfile({
      listing,
      skill,
      service: args.service,
      intentHash: canonicalHash(args.intent),
      registrationId: args.view.registrationId,
      providerAgentId: args.providerAgentId,
      policy: args.policy,
      gatewaySigner: args.gatewaySigner,
    });
    if (listing.paymentRequired) {
      await verifyPaidPreparation({
        listing,
        skill,
        service: args.service,
        intent: args.intent,
        registrationId: args.view.registrationId,
        providerAgentId: args.providerAgentId,
        providerPayee: args.providerPayee,
        policy: args.policy,
        gatewaySigner: args.gatewaySigner,
        publicClient: args.publicClient,
        finalizedBlock: args.finalizedBlock,
      });
    } else if (
      listing.splitterAddress !== null ||
      listing.preparation !== null ||
      listing.transaction !== null ||
      listing.deploymentRequired
    ) {
      throw new Error("gateway prepared a splitter for a non-payable skill");
    }
  }
}
