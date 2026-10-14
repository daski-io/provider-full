import { getAddress, keccak256, parseAbi, type Address, type Hex } from "viem";
import { finalizedReadBlockNumber } from "../chain/finality.js";
import { providerAddress, publicClient } from "../chain/client.js";
import { logError } from "../logger.js";
import {
  ReusedListingDriftError,
  crossCheckActivationCommitments,
  describeCrossCheck,
  type ActivationCrossCheck,
} from "./activationIdentity.js";
import type { RuntimeCommitmentInputs } from "./runtimeCommitment.js";
import {
  loadRuntimeListingHeads,
  promoteRuntimeListingVersions,
  type ProviderRuntimeListingBundleV1,
  type RuntimeListingHead,
  type SplitterActivationCheckpoint,
} from "./runtimeCatalog.js";
import { listGatewaySplitterWrites, markGatewayRegistrationAttention } from "./store.js";
import type {
  GatewayRegistrationView,
  ProviderServiceRegistrationIntentEnvelope,
  PublishedServiceContract,
  RegistrationPolicy,
} from "./types.js";

const splitterCheckpointAbi = parseAbi([
  "function releaseSequence() view returns (uint64)",
]);
const tokenBalanceAbi = parseAbi([
  "function balanceOf(address holder) view returns (uint256)",
]);

/** This provider's live (unsuperseded) heads for one service, by skill id. */
export async function priorHeadsFor(
  gatewayOrigin: string,
  serviceId: Hex,
): Promise<Map<string, RuntimeListingHead>> {
  return new Map(
    (await loadRuntimeListingHeads(gatewayOrigin))
      .filter((head) => head.serviceId.toLowerCase() === serviceId.toLowerCase())
      .map((head) => [head.skillId, head]),
  );
}

function activationInputs(
  policy: RegistrationPolicy,
  prepared: GatewayRegistrationView["prepared"],
  listing: GatewayRegistrationView["prepared"]["listings"][number],
): RuntimeCommitmentInputs & { gatewayReused: boolean } {
  return {
    environment: policy.environment,
    chainId: policy.chainId,
    gatewayAudience: policy.audience,
    providerAgentId: prepared.providerAgentId,
    serviceId: prepared.serviceId,
    currentProviderIntentHash: prepared.providerIntentHash,
    currentProviderPayee: getAddress(prepared.providerPayee),
    policy: {
      canonicalToken: policy.canonicalToken,
      daskiCommissionReceiver: policy.daskiCommissionReceiver,
      commissionBps: policy.commissionBps,
      policyVersionHash: policy.railPolicyHash,
      splitterFactory: policy.splitterFactory,
    },
    listing: {
      listingId: listing.listingId,
      listingKey: listing.listingKey,
      skillId: listing.skillId,
      skillContractHash: listing.skillContractHash,
      paymentRequired: listing.paymentRequired,
      splitterAddress: listing.splitterAddress,
      preparation: listing.preparation,
      controlProfile: listing.controlProfile,
    },
    gatewayReused: listing.reused,
  };
}

/** The exact-set cross-check of an ACTIVE view against the local catalog. */
export function crossCheckActivation(args: {
  view: GatewayRegistrationView;
  policy: RegistrationPolicy;
  priorHeads: ReadonlyMap<string, RuntimeListingHead>;
}): ActivationCrossCheck {
  const prepared = args.view.prepared;
  return crossCheckActivationCommitments({
    inputs: prepared.listings.map((listing) =>
      activationInputs(args.policy, prepared, listing)),
    reported: args.view.runtimeCommitments ?? [],
    priorHeads: args.priorHeads,
  });
}

// Provider-verified chain facts for a freshly admitted paid listing. The
// checkpoint is read at the finalized deployment block; gateway responses
// are never the evidence source.
async function verifyListingActivationCheckpoint(args: {
  splitterAddress: Address;
  transactionHash: Hex;
  policy: RegistrationPolicy;
}): Promise<SplitterActivationCheckpoint> {
  const receipt = await publicClient.getTransactionReceipt({
    hash: args.transactionHash,
  });
  const finalized = await finalizedReadBlockNumber();
  if (receipt.blockNumber > finalized) {
    throw new Error("splitter deployment is not finalized");
  }
  const blockNumber = receipt.blockNumber;
  const [code, balance, sequence] = await Promise.all([
    publicClient.getCode({ address: args.splitterAddress, blockNumber }),
    publicClient.readContract({
      address: args.policy.canonicalToken,
      abi: tokenBalanceAbi,
      functionName: "balanceOf",
      args: [args.splitterAddress],
      blockNumber,
    }),
    publicClient.readContract({
      address: args.splitterAddress,
      abi: splitterCheckpointAbi,
      functionName: "releaseSequence",
      blockNumber,
    }),
  ]);
  // Immutables live in runtime code, so splitters never share one hash;
  // authenticity is the verified chain (trusted factory, exact calldata over
  // the pinned creation code, CREATE2 match at materialization). Record the
  // observed hash for settlement evidence rather than pinning it here.
  if (!code) {
    throw new Error("splitter has no runtime bytecode at its deployment block");
  }
  return {
    splitterDeploymentTransactionHash: args.transactionHash,
    splitterDeploymentBlockNumber: blockNumber.toString(),
    splitterDeploymentBlockHash: receipt.blockHash,
    splitterRuntimeCodeHash: keccak256(code),
    splitterActivationBlockNumber: blockNumber.toString(),
    splitterActivationBlockHash: receipt.blockHash,
    splitterActivationPosition: "END_OF_BLOCK",
    splitterStartingTokenBalance: (balance as bigint).toString(),
    splitterStartingReleaseSequence: (sequence as bigint).toString(),
  };
}

/**
 * Resolve every listing's runtime commitment from this provider's own copies
 * of the admitted artifacts (a reused listing keeps the commitment its
 * admission promoted; a new admission is rebuilt from the current
 * registration), cross-check the gateway's reported hashes as an exact set,
 * resolve deployment evidence, and promote the versions into the append-only
 * runtime catalog before the registration is marked active. The cross-check
 * is unconditional, so crash-recovery replays can never promote unverified
 * values, and a refusal names every disagreement.
 */
export async function promoteActiveRuntimeListings(args: {
  localId: string;
  gatewayOrigin: string;
  view: GatewayRegistrationView;
  policy: RegistrationPolicy;
  published: PublishedServiceContract;
  intent: ProviderServiceRegistrationIntentEnvelope;
  finalizedBlock: bigint;
}): Promise<void> {
  const prepared = args.view.prepared;
  const skills = new Map(args.published.skills.map((skill) => [skill.skillId, skill]));
  const priorHeads = await priorHeadsFor(args.gatewayOrigin, prepared.serviceId);
  let check: ActivationCrossCheck;
  try {
    check = crossCheckActivation({ view: args.view, policy: args.policy, priorHeads });
  } catch (error) {
    if (error instanceof ReusedListingDriftError) {
      logError("activation refused: a reused listing does not reproduce its promoted commitment", {
        serviceSlug: prepared.serviceSlug,
        registrationId: args.view.registrationId,
        skillId: error.skillId,
        listingId: error.listingId,
        fields: error.fields,
      });
      await markGatewayRegistrationAttention(args.localId, "reused_listing_drift");
    }
    throw error;
  }
  if (!check.ok) {
    const detail = describeCrossCheck(check);
    logError("activation refused: the gateway's runtime commitment set differs from the local resolution", {
      serviceSlug: prepared.serviceSlug,
      registrationId: args.view.registrationId,
      detail,
    });
    await markGatewayRegistrationAttention(args.localId, "runtime_commitment_mismatch");
    throw new Error(
      `${prepared.serviceSlug} activation did not report the exact runtime commitment set: ${detail}`,
    );
  }
  const writes = new Map(
    (await listGatewaySplitterWrites(args.localId))
      .filter((row) => row.transaction_hash !== null)
      .map((row) => [row.listing_id, row.transaction_hash as Hex]),
  );
  const versions = check.verdicts.map((verdict, index) => ({
    listing: prepared.listings[index]!,
    commitment: verdict.commitment,
    hash: verdict.expected,
  }));
  const evidence = new Map<string, {
    splitterTransactionHash: Hex | null;
    activationCheckpoint: SplitterActivationCheckpoint | null;
  }>();
  for (const { listing, commitment, hash } of versions) {
    const prior = priorHeads.get(listing.skillId);
    const unchangedHead =
      prior !== undefined &&
      prior.runtimeCommitmentHash.toLowerCase() === hash.toLowerCase();
    if (unchangedHead || !listing.paymentRequired || listing.splitterAddress === null) {
      // Unchanged heads are promotion no-ops keeping their original bundle;
      // free skills and paid take-downs have no deployment evidence.
      evidence.set(listing.skillId, {
        splitterTransactionHash: null,
        activationCheckpoint: null,
      });
      continue;
    }
    const transactionHash = writes.get(commitment.listingId);
    if (!transactionHash) {
      throw new Error(
        `${prepared.serviceSlug} has no splitter evidence for ${listing.skillId}; recover the original deployment record before promoting`,
      );
    }
    evidence.set(listing.skillId, {
      splitterTransactionHash: transactionHash,
      activationCheckpoint: await verifyListingActivationCheckpoint({
        splitterAddress: getAddress(listing.splitterAddress),
        transactionHash,
        policy: args.policy,
      }),
    });
  }
  await promoteRuntimeListingVersions(
    args.gatewayOrigin,
    prepared.serviceId,
    versions.map(({ listing, commitment, hash }) => {
      const bundle: ProviderRuntimeListingBundleV1 = {
        schemaVersion: 1,
        listing,
        skillContract: skills.get(listing.skillId) ?? null,
        intent: args.intent,
        ...evidence.get(listing.skillId)!,
        providerIdentity: {
          agentWallet: providerAddress,
          verifiedAtBlock: args.finalizedBlock.toString(),
        },
        policyRefs: {
          railPolicyHash: args.policy.railPolicyHash,
          canonicalToken: args.policy.canonicalToken,
          splitterFactory: args.policy.splitterFactory,
          splitterFactoryRuntimeCodeHash: args.policy.splitterFactoryRuntimeCodeHash,
          splitterCreationCodeHash: args.policy.splitterCreationCodeHash,
        },
      };
      return {
        listingId: commitment.listingId,
        listingKey: listing.listingKey,
        skillId: listing.skillId,
        paymentRequired: listing.paymentRequired,
        runtimeCommitmentHash: hash,
        runtimeCommitment: commitment,
        bundle,
      };
    }),
  );
}
