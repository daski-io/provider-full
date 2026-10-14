import type { Chain, Hex } from "viem";
import { logError } from "../logger.js";
import { canonicalHash } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { prepareDispatchAdmission, type DispatchRequest } from "./dispatchAdmission.js";
import {
  admitDispatchClaim,
  findDispatchClaim,
  probeDispatchClaim,
  type AdmissionOutcome,
  type ClaimKey,
  type DispatchClaim,
} from "./dispatchClaim.js";
import {
  DispatchAmbiguousError,
  DispatchCommitUncertainError,
  DispatchRejectedError,
  DispatchStatusError,
} from "./dispatchErrors.js";
import { fulfillAdmittedDispatch } from "./dispatchExecution.js";
import { underFulfillmentLease } from "./fulfillmentJobs.js";
import { assertForwardedQuoteIntegrity } from "./dispatchQuoteBinding.js";
import { signedDispatchSnapshot, type DispatchSnapshotV1 } from "./dispatchResponse.js";
import { ORDER_ID, verifyDispatchEnvelope } from "./dispatchVerification.js";
import { ProviderEvidenceVerifier } from "./evidence.js";
import { verifyGatewayEnvelope } from "./gatewayEnvelope.js";
import { recordStandardSecurityIncident } from "./incidents.js";
import type { DispatchStatusQueryV1 } from "./types.js";

export { shouldLinkAssetOwnership } from "./dispatchExecution.js";
export type { DispatchRequest } from "./dispatchAdmission.js";

const HASH = /^0x[0-9a-f]{64}$/;
const UNCERTAIN_COMMIT_PROBES = 10;
const UNCERTAIN_COMMIT_PROBE_DELAY_MS = 100;

/**
 * Standard dispatch admission and reconciliation status. A dispatch ends in
 * exactly one of three outcomes: a definite pre-admission refusal
 * (DispatchRejectedError, only while no claim exists for the order), the
 * signed snapshot of the admitted claim, or an ambiguous failure that the
 * route answers with an empty 503 so the gateway reconciles by status.
 */
export class StandardDispatchService {
  private readonly evidence: ProviderEvidenceVerifier;

  constructor(
    private readonly config: ProviderStandardRailConfig,
    chain: Chain,
    private readonly chainId: number,
  ) {
    this.evidence = new ProviderEvidenceVerifier(config, chain);
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
    // Offline and outcome-independent: never look up state for a request
    // whose forwarded quote the signed dispatch does not bind.
    await assertForwardedQuoteIntegrity({ config: this.config, envelope: args.quote, dispatch });
    // Whether a claim exists decides between replay and refusal, so a failed
    // lookup proves nothing and the answer must stay ambiguous.
    const existing = await findDispatchClaim(key).catch((error: unknown) => {
      throw new DispatchAmbiguousError("Dispatch claim lookup failed", { cause: error });
    });
    if (existing) return this.answerExisting(existing, key, dispatchHash);
    let admission: Awaited<ReturnType<typeof prepareDispatchAdmission>>;
    try {
      admission = await prepareDispatchAdmission({
        config: this.config, chainId: this.chainId, evidence: this.evidence,
        args, envelope, dispatchHash,
      });
    } catch (error) {
      if (error instanceof DispatchRejectedError) return this.confirmRefusal(error, key, dispatchHash);
      throw error;
    }
    let admitted: AdmissionOutcome;
    try {
      admitted = await admitDispatchClaim(admission.claim);
    } catch (error) {
      if (error instanceof DispatchRejectedError) return this.confirmRefusal(error, key, dispatchHash);
      if (!(error instanceof DispatchCommitUncertainError)) throw error;
      admitted = await this.resolveUncertainCommit(error, key, dispatchHash);
    }
    if (admitted.kind === "existing") return this.answerExisting(admitted.claim, key, dispatchHash);
    const { taskId, job } = admitted;
    try {
      // The admission created the order's fulfillment job leased to this
      // request; if the request dies before the order starts, a worker
      // resumes it once the lease expires.
      await underFulfillmentLease(job, () => fulfillAdmittedDispatch({
        taskId,
        order: { gatewayAudience: dispatch.gatewayAudience, orderId: dispatch.orderId, payer: dispatch.payer },
        request: args.request,
        skillId: admission.claim.outcome.skillId,
        service: admission.claim.service,
        skill: admission.skill,
        handler: admission.handler,
        supplierCostCeiling: admission.claim.supplierCostCeiling,
      }));
      return await signedDispatchSnapshot(this.config, { ...key, dispatchHash });
    } catch (error) {
      throw new DispatchAmbiguousError("Admitted dispatch cannot be answered", { cause: error });
    }
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
  ): Promise<AdmissionOutcome> {
    // The committing backend may still hold the order lock for a moment.
    let probe: Awaited<ReturnType<typeof probeDispatchClaim>> | null = null;
    for (let attempt = 0; attempt < UNCERTAIN_COMMIT_PROBES; attempt += 1) {
      probe = await probeDispatchClaim(key).catch(() => null);
      if (probe?.kind !== "busy") break;
      await new Promise((resolve) => setTimeout(resolve, UNCERTAIN_COMMIT_PROBE_DELAY_MS));
    }
    if (probe?.kind !== "claim") throw uncertain;
    if (probe.claim.dispatchHash === dispatchHash && probe.claim.transactionId === uncertain.taskId && uncertain.job) {
      return { kind: "admitted", taskId: uncertain.taskId, job: uncertain.job };
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
