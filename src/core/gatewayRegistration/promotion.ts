import { getAddress, type Hex } from "viem";
import { providerAddress } from "../chain/client.js";
import { logError } from "../logger.js";
import { promotedVersions, resolveActivationEvidence } from "./activationEvidence.js";
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
} from "./runtimeCatalog.js";
import { markGatewayRegistrationAttention, type RegistrationRef } from "./store.js";
import type {
  GatewayRegistrationView,
  ProviderServiceRegistrationIntentEnvelope,
  PublishedServiceContract,
  RegistrationPolicy,
} from "./types.js";

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

/**
 * The activation verdict a promotion acts on: this provider's prior heads and
 * the exact-set cross-check of the gateway's reported commitments against
 * the local resolution (a reused listing keeps the commitment its admission
 * promoted; a new admission is rebuilt from the current registration).
 * Reads only; throws ReusedListingDriftError for a reused listing that no
 * longer reproduces its promoted commitment. The run and the forecast both
 * judge an activation here.
 */
export async function judgeActivation(args: {
  gatewayOrigin: string;
  view: GatewayRegistrationView;
  policy: RegistrationPolicy;
}): Promise<{ priorHeads: Map<string, RuntimeListingHead>; check: ActivationCrossCheck }> {
  const priorHeads = await priorHeadsFor(args.gatewayOrigin, args.view.prepared.serviceId);
  return {
    priorHeads,
    check: crossCheckActivation({ view: args.view, policy: args.policy, priorHeads }),
  };
}

/**
 * Judge the activation, resolve deployment evidence, and promote the
 * versions into the append-only runtime catalog before the registration is
 * marked active. The cross-check is unconditional, so crash-recovery replays
 * can never promote unverified values, and a refusal names every
 * disagreement.
 */
export async function promoteActiveRuntimeListings(args: {
  registration: RegistrationRef;
  gatewayOrigin: string;
  view: GatewayRegistrationView;
  policy: RegistrationPolicy;
  published: PublishedServiceContract;
  intent: ProviderServiceRegistrationIntentEnvelope;
  finalizedBlock: bigint;
}): Promise<void> {
  const prepared = args.view.prepared;
  const skills = new Map(args.published.skills.map((skill) => [skill.skillId, skill]));
  let judged: Awaited<ReturnType<typeof judgeActivation>>;
  try {
    judged = await judgeActivation(args);
  } catch (error) {
    if (error instanceof ReusedListingDriftError) {
      logError("activation refused: a reused listing does not reproduce its promoted commitment", {
        serviceSlug: prepared.serviceSlug,
        registrationId: args.view.registrationId,
        drifts: error.drifts,
      });
      await markGatewayRegistrationAttention(args.registration, "reused_listing_drift");
    }
    throw error;
  }
  const { check } = judged;
  if (!check.ok) {
    const detail = describeCrossCheck(check);
    logError("activation refused: the gateway's runtime commitment set differs from the local resolution", {
      serviceSlug: prepared.serviceSlug,
      registrationId: args.view.registrationId,
      detail,
    });
    await markGatewayRegistrationAttention(args.registration, "runtime_commitment_mismatch");
    throw new Error(
      `${prepared.serviceSlug} activation did not report the exact runtime commitment set: ${detail}`,
    );
  }
  const evidence = await resolveActivationEvidence({
    registration: args.registration,
    view: args.view,
    policy: args.policy,
    check,
    priorHeads: judged.priorHeads,
  });
  await promoteRuntimeListingVersions(
    args.gatewayOrigin,
    prepared.serviceId,
    promotedVersions(args.view, check).map(({ listing, commitment, hash }) => {
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
