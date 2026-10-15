import type { Hex } from "viem";
import { getServiceBySlug } from "../db/queries/services.js";
import { getSkillByServiceAndSkillId } from "../db/queries/skills.js";
import { executableDefinitionHash } from "../serviceRegistry/executableContracts.js";
import { serviceInvariantFailures } from "../serviceRegistry/readiness.js";
import { getAdapter, getService } from "../serviceRegistry/registry.js";
import { contractHandler } from "../serviceRegistry/retainedHandlers.js";
import type { FulfillmentAdapter } from "../serviceRegistry/types.js";
import type { ProviderStandardRailConfig } from "./config.js";
import type { AdmissionArgs } from "./dispatchClaim.js";
import { DispatchRejectedError, withDispatchRejection } from "./dispatchErrors.js";
import { dispatchOutcome } from "./dispatchOutcome.js";
import { loadAdmittedProviderQuote, verifyGatewayQuote } from "./dispatchQuoteBinding.js";
import {
  assertDispatchOutcomePolicy,
  assertFreshClaimEnvelope,
  assertNotSelfPurchase,
} from "./dispatchVerification.js";
import type { ProviderEvidenceVerifier } from "./evidence.js";
import { admitStandardEvidence } from "./evidenceAdmissions.js";
import { admittedOwnership, type ListingVersion } from "./listingVersions.js";
import { outcomeRequestValidator, validateProviderRequest } from "./schema.js";
import { orderSigningKeys } from "./signingKeys.js";
import type {
  QuoteV1,
  SignedEnvelope,
  StandardEvidenceBundleV2,
  StandardRailDispatchV2,
} from "./types.js";

export interface DispatchRequest {
  dispatch: unknown;
  quote: SignedEnvelope<QuoteV1>;
  request: Record<string, unknown>;
  evidenceBundle: StandardEvidenceBundleV2;
}

/**
 * The handler this build runs the version's admitted contract with, and the
 * capability a worker needs to resume it. Refused before admission when this
 * build cannot execute the contract or sign for the version: another replica
 * may, and the gateway retries a refused funded dispatch with a new envelope.
 */
export function admissionHandler(
  config: ProviderStandardRailConfig,
  version: ListingVersion,
): { handler: FulfillmentAdapter; capability: Hex | null } {
  const choice = contractHandler(version.serviceSlug, version.skillId, version.contract);
  if (!choice) {
    throw new DispatchRejectedError("service_unavailable", "This build has no handler for the order's admitted contract");
  }
  try {
    orderSigningKeys(config, version.signingKey);
  } catch {
    throw new DispatchRejectedError("service_unavailable", "This deployment cannot sign for the order's listing version");
  }
  if (version.fulfillmentSeconds === null) {
    throw new DispatchRejectedError("outcome_policy", "The listing version states no admissible fulfillment duration");
  }
  return {
    handler: choice.kind === "retained" ? choice.adapter : getAdapter(version.serviceSlug),
    capability: version.contract === null
      ? null
      : executableDefinitionHash(version.serviceSlug, version.skillId, version.contract),
  };
}

/**
 * Every check that must pass before a claim may be committed. Each failure is
 * a reviewed DispatchRejectedError; the caller confirms that no claim exists
 * before answering it as a definite refusal.
 */
export async function prepareDispatchAdmission(input: {
  config: ProviderStandardRailConfig;
  chainId: number;
  evidence: ProviderEvidenceVerifier;
  args: DispatchRequest;
  envelope: SignedEnvelope<StandardRailDispatchV2, 2>;
  dispatchHash: Hex;
}): Promise<{
  skill: NonNullable<Awaited<ReturnType<typeof getSkillByServiceAndSkillId>>>;
  claim: AdmissionArgs;
  handler: FulfillmentAdapter;
  /** Whether the admitted contract requires asset ownership. */
  requiresOwnership: boolean;
}> {
  const { config, args, evidence } = input;
  const dispatch = input.envelope.payload;
  // The version the order was sold under: the current head, or an earlier
  // version still owed this funded first dispatch.
  const { outcome, version } = await dispatchOutcome(config, dispatch.listingManifestHash, dispatch.providerOfferHash);
  assertDispatchOutcomePolicy(dispatch, outcome, config.retainedControlProfileHashes);
  assertFreshClaimEnvelope(input.envelope, outcome);
  assertNotSelfPurchase(config, dispatch, outcome);
  await verifyGatewayQuote({ config, chainId: input.chainId, envelope: args.quote, dispatch, outcome });
  if (outcome.pricingMode === "fixed" && dispatch.grossAmount !== outcome.fixedGrossAmount) {
    throw new DispatchRejectedError("price", "Dispatch price is not the admitted fixed price");
  }
  const providerQuote = await loadAdmittedProviderQuote({ quote: args.quote, dispatch, outcome });
  const validate = await withDispatchRejection("validator", () => outcomeRequestValidator(outcome));
  await withDispatchRejection("validator", () => validateProviderRequest(validate, args.request));
  const { handler, capability } = admissionHandler(config, version);
  // Fulfilment here is synchronous: executing during a declared product
  // outage would sign a terminal failure, whereas a refusal before admission
  // makes the gateway retry this funded order with a fresh envelope.
  const module = getService(outcome.serviceSlug);
  if (module && (await serviceInvariantFailures(module)).length > 0) {
    throw new DispatchRejectedError("service_unavailable", "Service readiness invariants are failing");
  }
  const verified = await withDispatchRejection("evidence", () => evidence.verify({
    dispatch, quote: args.quote, outcome, bundle: args.evidenceBundle,
  }));
  for (const participant of new Set([
    dispatch.payer, config.providerAuthorityKey, config.terminalAttestationKey, outcome.providerTerminalAttestationKey,
    outcome.providerPayee, outcome.daskiCommissionReceiver, ...outcome.providerControlledWallets,
  ])) await withDispatchRejection("evidence", () => evidence.assertNotSanctioned(participant));
  await withDispatchRejection("evidence", () => admitStandardEvidence(
    dispatch.orderId, args.evidenceBundle, verified.authorizationKey,
  ));
  // A funded order is an obligation: paused sales or an inactive skill row
  // never refuse it, nor does a newer head of its listing (the version it
  // was sold under is resolved above). A service or skill the provider no
  // longer installs is refused here.
  const service = await getServiceBySlug(outcome.serviceSlug);
  const skill = service ? await getSkillByServiceAndSkillId(service.id, outcome.skillId) : null;
  if (!service || !skill) throw new DispatchRejectedError("outcome_policy", "Outcome service is not installed");
  return {
    skill,
    handler,
    requiresOwnership: admittedOwnership(version, skill),
    claim: {
      dispatch, dispatchHash: input.dispatchHash, request: args.request, outcome, service,
      supplierCostCeiling: providerQuote.supplierCostCeiling,
      providerQuoteHash: providerQuote.quoteHash,
      fulfillmentSeconds: version.fulfillmentSeconds!,
      capability,
    },
  };
}
