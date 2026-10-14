import type { ValidateFunction } from "ajv";
import type { Chain, Hex } from "viem";
import { getServiceBySlug } from "../db/queries/services.js";
import { getSkillByServiceAndSkillId } from "../db/queries/skills.js";
import { logError } from "../logger.js";
import { canonicalHash } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import {
  admitDispatchClaim,
  findDispatchClaim,
  probeDispatchClaim,
  type ClaimKey,
  type DispatchClaim,
} from "./dispatchClaim.js";
import {
  DispatchAmbiguousError,
  DispatchCommitUncertainError,
  DispatchRejectedError,
  DispatchStatusError,
  withDispatchRejection,
} from "./dispatchErrors.js";
import { fulfillAdmittedDispatch } from "./dispatchExecution.js";
import { loadAdmittedProviderQuote, verifyGatewayQuote } from "./dispatchQuoteBinding.js";
import { signedDispatchSnapshot, type DispatchSnapshotV1 } from "./dispatchResponse.js";
import {
  assertFreshClaimEnvelope,
  assertNotSelfPurchase,
  findDispatchOutcome,
  ORDER_ID,
  verifyDispatchEnvelope,
} from "./dispatchVerification.js";
import { ProviderEvidenceVerifier } from "./evidence.js";
import { admitStandardEvidence } from "./evidenceAdmissions.js";
import { verifyGatewayEnvelope } from "./gatewayEnvelope.js";
import { recordStandardSecurityIncident } from "./incidents.js";
import { compileProviderSchema, validateProviderRequest } from "./schema.js";
import type {
  DispatchStatusQueryV1,
  QuoteV1,
  SignedEnvelope,
  StandardEvidenceBundleV2,
} from "./types.js";

export { shouldLinkAssetOwnership } from "./dispatchExecution.js";

const HASH = /^0x[0-9a-f]{64}$/;

export interface DispatchRequest {
  dispatch: unknown;
  quote: SignedEnvelope<QuoteV1>;
  request: Record<string, unknown>;
  evidenceBundle: StandardEvidenceBundleV2;
}

/**
 * Standard dispatch admission and reconciliation status. A dispatch ends in
 * exactly one of three outcomes: a definite pre-admission refusal
 * (DispatchRejectedError, only while no claim exists for the order), the
 * signed snapshot of the admitted claim, or an ambiguous failure that the
 * route answers with an empty 503 so the gateway reconciles by status.
 */
export class StandardDispatchService {
  private readonly evidence: ProviderEvidenceVerifier;
  private readonly requestValidators = new Map<string, ValidateFunction>();

  constructor(
    private readonly config: ProviderStandardRailConfig,
    chain: Chain,
    private readonly chainId: number,
  ) {
    this.evidence = new ProviderEvidenceVerifier(config, chain);
    for (const outcome of config.outcomes.values()) {
      this.requestValidators.set(
        outcome.outcomeId,
        compileProviderSchema(outcome.requestSchema as unknown as Record<string, unknown>),
      );
    }
  }

  /**
   * Answer a reconciliation query. The query is verified before any claim is
   * looked up, and `noClaim()` is used only when an authoritative probe
   * proves that no claim exists and no admission is in flight.
   */
  async status(value: unknown): Promise<DispatchSnapshotV1> {
    const envelope = await verifyGatewayEnvelope<DispatchStatusQueryV1>(value, {
      artifactType: "DispatchStatusQueryV1",
      schemaVersion: 1,
      payloadKeys: ["orderId", "dispatchHash", "issuedAt", "validBefore"],
      environment: this.config.environment,
      chainId: this.chainId,
      audience: this.config.providerAudience,
      signer: this.config.gatewayDispatchSigner,
      lifetime: { maxRemainingSeconds: 120, maxAgeSeconds: 120 },
    }).catch((error: unknown) => { throw DispatchStatusError.rejected(error); });
    const query = envelope.payload;
    if (
      query.issuedAt !== envelope.issuedAt || query.validBefore !== envelope.validBefore ||
      typeof query.orderId !== "string" || !ORDER_ID.test(query.orderId) ||
      typeof query.dispatchHash !== "string" || !HASH.test(query.dispatchHash)
    ) throw DispatchStatusError.rejected(null);
    const key = { gatewayAudience: this.config.gatewayAudience, orderId: query.orderId };
    let claim: DispatchClaim | null;
    try {
      claim = await findDispatchClaim(key);
      if (!claim) {
        const probe = await probeDispatchClaim(key);
        if (probe.kind === "busy") throw DispatchStatusError.unavailable("admission_in_progress");
        if (probe.kind === "absent") throw DispatchStatusError.noClaim();
        claim = probe.claim;
      }
    } catch (error) {
      if (error instanceof DispatchStatusError) throw error;
      throw DispatchStatusError.unavailable();
    }
    if (claim.dispatchHash !== query.dispatchHash) throw DispatchStatusError.conflict();
    try {
      return await signedDispatchSnapshot(this.config, { ...key, dispatchHash: query.dispatchHash });
    } catch {
      throw DispatchStatusError.unavailable();
    }
  }

  async accept(args: DispatchRequest): Promise<DispatchSnapshotV1> {
    const envelope = await verifyDispatchEnvelope({
      config: this.config, chainId: this.chainId, envelope: args.dispatch, request: args.request,
    });
    const dispatch = envelope.payload;
    const dispatchHash = canonicalHash(envelope);
    const key = { gatewayAudience: dispatch.gatewayAudience, orderId: dispatch.orderId };
    // Whether a claim exists decides between replay and refusal, so a failed
    // lookup proves nothing and the answer must stay ambiguous.
    const existing = await findDispatchClaim(key).catch((error: unknown) => {
      throw new DispatchAmbiguousError("Dispatch claim lookup failed", { cause: error });
    });
    if (existing) return this.answerExisting(existing, key, dispatchHash);
    let admission: Awaited<ReturnType<StandardDispatchService["prepareAdmission"]>>;
    try {
      admission = await this.prepareAdmission(args, envelope, dispatchHash);
    } catch (error) {
      if (error instanceof DispatchRejectedError) return this.confirmRefusal(error, key, dispatchHash);
      throw error;
    }
    let admitted: Awaited<ReturnType<typeof admitDispatchClaim>>;
    try {
      admitted = await admitDispatchClaim(admission.claim);
    } catch (error) {
      if (error instanceof DispatchRejectedError) return this.confirmRefusal(error, key, dispatchHash);
      if (!(error instanceof DispatchCommitUncertainError)) throw error;
      admitted = await this.resolveUncertainCommit(error, key, dispatchHash);
    }
    if (admitted.kind === "existing") return this.answerExisting(admitted.claim, key, dispatchHash);
    try {
      await fulfillAdmittedDispatch({
        taskId: admitted.taskId,
        dispatch,
        request: args.request,
        skillId: admission.claim.outcome.skillId,
        service: admission.claim.service,
        skill: admission.skill,
        supplierCostCeiling: admission.claim.supplierCostCeiling,
      });
      return await signedDispatchSnapshot(this.config, { ...key, dispatchHash });
    } catch (error) {
      throw new DispatchAmbiguousError("Admitted dispatch cannot be answered", { cause: error });
    }
  }

  /** Every check that must pass before a claim may be committed. */
  private async prepareAdmission(
    args: DispatchRequest,
    envelope: Awaited<ReturnType<typeof verifyDispatchEnvelope>>,
    dispatchHash: Hex,
  ) {
    const dispatch = envelope.payload;
    const outcome = findDispatchOutcome(this.config, dispatch);
    assertFreshClaimEnvelope(envelope, outcome);
    assertNotSelfPurchase(this.config, dispatch, outcome);
    await verifyGatewayQuote({ config: this.config, chainId: this.chainId, envelope: args.quote, dispatch, outcome });
    if (outcome.pricingMode === "fixed" && dispatch.grossAmount !== outcome.fixedGrossAmount) {
      throw new DispatchRejectedError("price", "Dispatch price is not the admitted fixed price");
    }
    const providerQuote = await loadAdmittedProviderQuote({ quote: args.quote, dispatch, outcome });
    const validate = this.requestValidators.get(outcome.outcomeId);
    if (!validate) throw new DispatchRejectedError("validator", "Provider outcome validator is unavailable");
    await withDispatchRejection("validator", () => validateProviderRequest(validate, args.request));
    const verified = await withDispatchRejection("evidence", () => this.evidence.verify({
      dispatch, quote: args.quote, outcome, bundle: args.evidenceBundle,
    }));
    for (const participant of [
      dispatch.payer, this.config.providerAuthorityKey, this.config.terminalAttestationKey,
      outcome.providerPayee, outcome.daskiCommissionReceiver, ...outcome.providerControlledWallets,
    ]) await withDispatchRejection("evidence", () => this.evidence.assertNotSanctioned(participant));
    await withDispatchRejection("evidence", () => admitStandardEvidence(
      dispatch.orderId, args.evidenceBundle, verified.authorizationKey,
    ));
    // A funded order is an obligation: paused sales or an inactive skill row
    // never refuse it. Only a service or skill the provider no longer has
    // installed is a definite pre-admission refusal.
    const service = await getServiceBySlug(outcome.serviceSlug);
    const skill = service ? await getSkillByServiceAndSkillId(service.id, outcome.skillId) : null;
    if (!service || !skill) throw new DispatchRejectedError("outcome_policy", "Outcome service is not installed");
    return {
      skill,
      claim: {
        dispatch, dispatchHash, request: args.request, outcome, service,
        supplierCostCeiling: providerQuote.supplierCostCeiling,
        providerQuoteHash: providerQuote.quoteHash,
      },
    };
  }

  /**
   * An existing claim answers an exact replay with its signed snapshot, even
   * after the envelope expired. A different envelope never replaces admitted
   * work and never receives a definite refusal: it is ambiguous by design.
   */
  private async answerExisting(claim: DispatchClaim, key: ClaimKey, dispatchHash: Hex): Promise<DispatchSnapshotV1> {
    if (claim.dispatchHash !== dispatchHash || !claim.transactionId) {
      await recordStandardSecurityIncident({
        kind: "changed_dispatch_replay",
        gatewayAudience: key.gatewayAudience,
        orderId: key.orderId,
        identity: { gatewayAudience: key.gatewayAudience, orderId: key.orderId },
        details: { presentedDispatchHash: dispatchHash },
      }).catch((error: unknown) => {
        logError("Changed dispatch replay incident could not be recorded", {
          errorClass: error instanceof Error ? error.name : "UnknownError",
        });
      });
      throw new DispatchAmbiguousError("A different envelope cannot replace an admitted dispatch");
    }
    try {
      return await signedDispatchSnapshot(this.config, { ...key, dispatchHash });
    } catch (error) {
      throw new DispatchAmbiguousError("Admitted dispatch cannot be answered", { cause: error });
    }
  }

  /**
   * After an unknown COMMIT outcome, the claim's task id shows whether this
   * request's transaction committed; only then may this request fulfil it.
   * Anything else, including absence, stays ambiguous for the gateway.
   */
  private async resolveUncertainCommit(
    uncertain: DispatchCommitUncertainError,
    key: ClaimKey,
    dispatchHash: Hex,
  ): Promise<{ kind: "admitted"; taskId: string } | { kind: "existing"; claim: DispatchClaim }> {
    const probe = await probeDispatchClaim(key).catch(() => null);
    if (probe?.kind !== "claim") throw uncertain;
    if (probe.claim.dispatchHash === dispatchHash && probe.claim.transactionId === uncertain.taskId) {
      return { kind: "admitted", taskId: uncertain.taskId };
    }
    return { kind: "existing", claim: probe.claim };
  }

  /**
   * A refusal is definite only if the order still has no claim and no
   * admission in flight; a concurrent copy of the same envelope may have been
   * admitted meanwhile.
   */
  private async confirmRefusal(
    refusal: DispatchRejectedError,
    key: ClaimKey,
    dispatchHash: Hex,
  ): Promise<DispatchSnapshotV1> {
    const probe = await probeDispatchClaim(key).catch((error: unknown) => {
      throw new DispatchAmbiguousError("Dispatch refusal could not be confirmed", { cause: error });
    });
    if (probe.kind === "busy") throw new DispatchAmbiguousError("Another admission for the order is in flight");
    if (probe.kind === "claim") return this.answerExisting(probe.claim, key, dispatchHash);
    throw refusal;
  }
}
