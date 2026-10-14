import { getAddress, keccak256, parseAbi, type Address, type Hex } from "viem";
import { finalizedReadBlockNumber } from "../chain/finality.js";
import { publicClient } from "../chain/client.js";
import type { ActivationCrossCheck } from "./activationIdentity.js";
import type { RuntimeListingHead, SplitterActivationCheckpoint } from "./runtimeCatalog.js";
import { listGatewaySplitterWrites } from "./splitterRows.js";
import type { RegistrationRef } from "./store.js";
import type { GatewayRegistrationView, RegistrationPolicy } from "./types.js";

const splitterCheckpointAbi = parseAbi([
  "function releaseSequence() view returns (uint64)",
]);
const tokenBalanceAbi = parseAbi([
  "function balanceOf(address holder) view returns (uint256)",
]);

export interface ListingActivationEvidence {
  splitterTransactionHash: Hex | null;
  activationCheckpoint: SplitterActivationCheckpoint | null;
}

/** Each listing with the commitment and hash the cross-check resolved for it. */
export function promotedVersions(view: GatewayRegistrationView, check: ActivationCrossCheck) {
  return check.verdicts.map((verdict, index) => ({
    listing: view.prepared.listings[index]!,
    commitment: verdict.commitment,
    hash: verdict.expected,
  }));
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
 * Deployment evidence for every listing a promotion adds, by skill id: none
 * for an unchanged head, a free skill or a paid take-down; otherwise the
 * journaled splitter deployment and its activation checkpoint, read at the
 * finalized deployment block. Reads only, and throws exactly where a run's
 * promotion would, so the forecast resolves the same evidence.
 */
export async function resolveActivationEvidence(args: {
  registration: RegistrationRef;
  view: GatewayRegistrationView;
  policy: RegistrationPolicy;
  check: ActivationCrossCheck;
  priorHeads: ReadonlyMap<string, RuntimeListingHead>;
}): Promise<Map<string, ListingActivationEvidence>> {
  const writes = new Map(
    (await listGatewaySplitterWrites(args.registration.id))
      .filter((row) => row.transaction_hash !== null)
      .map((row) => [row.listing_id, row.transaction_hash as Hex]),
  );
  const evidence = new Map<string, ListingActivationEvidence>();
  for (const { listing, commitment, hash } of promotedVersions(args.view, args.check)) {
    const prior = args.priorHeads.get(listing.skillId);
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
        `${args.view.prepared.serviceSlug} has no splitter evidence for ${listing.skillId}; recover the original deployment record before promoting`,
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
  return evidence;
}
