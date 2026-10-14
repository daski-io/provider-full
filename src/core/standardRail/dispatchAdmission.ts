import type { ValidateFunction } from "ajv";
import type { Hex } from "viem";
import { getServiceBySlug } from "../db/queries/services.js";
import { getSkillByServiceAndSkillId } from "../db/queries/skills.js";
import { serviceInvariantFailures } from "../serviceRegistry/readiness.js";
import { getService } from "../serviceRegistry/registry.js";
import type { ProviderStandardRailConfig } from "./config.js";
import type { AdmissionArgs } from "./dispatchClaim.js";
import { DispatchRejectedError, withDispatchRejection } from "./dispatchErrors.js";
import { loadAdmittedProviderQuote, verifyGatewayQuote } from "./dispatchQuoteBinding.js";
import {
  assertFreshClaimEnvelope,
  assertNotSelfPurchase,
  findDispatchOutcome,
} from "./dispatchVerification.js";
import type { ProviderEvidenceVerifier } from "./evidence.js";
import { admitStandardEvidence } from "./evidenceAdmissions.js";
import { validateProviderRequest } from "./schema.js";
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
 * Every check that must pass before a claim may be committed. Each failure is
 * a reviewed DispatchRejectedError; the caller confirms that no claim exists
 * before answering it as a definite refusal.
 */
export async function prepareDispatchAdmission(input: {
  config: ProviderStandardRailConfig;
  chainId: number;
  evidence: ProviderEvidenceVerifier;
  validate: ReadonlyMap<string, ValidateFunction>;
  args: DispatchRequest;
  envelope: SignedEnvelope<StandardRailDispatchV2, 2>;
  dispatchHash: Hex;
}): Promise<{ skill: NonNullable<Awaited<ReturnType<typeof getSkillByServiceAndSkillId>>>; claim: AdmissionArgs }> {
  const { config, args, evidence } = input;
  const dispatch = input.envelope.payload;
  const outcome = findDispatchOutcome(config, dispatch);
  assertFreshClaimEnvelope(input.envelope, outcome);
  assertNotSelfPurchase(config, dispatch, outcome);
  await verifyGatewayQuote({ config, chainId: input.chainId, envelope: args.quote, dispatch, outcome });
  if (outcome.pricingMode === "fixed" && dispatch.grossAmount !== outcome.fixedGrossAmount) {
    throw new DispatchRejectedError("price", "Dispatch price is not the admitted fixed price");
  }
  const providerQuote = await loadAdmittedProviderQuote({ quote: args.quote, dispatch, outcome });
  const validate = input.validate.get(outcome.outcomeId);
  if (!validate) throw new DispatchRejectedError("validator", "Provider outcome validator is unavailable");
  await withDispatchRejection("validator", () => validateProviderRequest(validate, args.request));
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
  for (const participant of [
    dispatch.payer, config.providerAuthorityKey, config.terminalAttestationKey,
    outcome.providerPayee, outcome.daskiCommissionReceiver, ...outcome.providerControlledWallets,
  ]) await withDispatchRejection("evidence", () => evidence.assertNotSanctioned(participant));
  await withDispatchRejection("evidence", () => admitStandardEvidence(
    dispatch.orderId, args.evidenceBundle, verified.authorizationKey,
  ));
  // A funded order is an obligation: paused sales or an inactive skill row
  // never refuse it. A service or skill the provider no longer installs is
  // refused here; a listing version no longer in the runtime catalog was
  // already refused as an unknown outcome (retained versions are separate).
  const service = await getServiceBySlug(outcome.serviceSlug);
  const skill = service ? await getSkillByServiceAndSkillId(service.id, outcome.skillId) : null;
  if (!service || !skill) throw new DispatchRejectedError("outcome_policy", "Outcome service is not installed");
  return {
    skill,
    claim: {
      dispatch, dispatchHash: input.dispatchHash, request: args.request, outcome, service,
      supplierCostCeiling: providerQuote.supplierCostCeiling,
      providerQuoteHash: providerQuote.quoteHash,
    },
  };
}
