import { randomUUID } from "node:crypto";
import {
  getAddress,
  keccak256,
  recoverMessageAddress,
  stringToHex,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { pool } from "../db/pool.js";
import { getActiveAssetByIdentifier, getAssetByIdentifierWithStatuses, type AssetRow } from "../db/queries/assets.js";
import { getServiceBySlug } from "../db/queries/services.js";
import { getSkillByServiceAndSkillId } from "../db/queries/skills.js";
import { setTransactionAsset } from "../db/queries/transactions.js";
import { setCustomerLastKnownEmail, upsertCustomer } from "../db/queries/customers.js";
import { getAdapter, getService } from "../serviceRegistry/registry.js";
import { consultPreExecuteAgent } from "../engine/preExecuteRunner.js";
import { markEscalated } from "../engine/escalation.js";
import { processAdapterResult } from "../engine/taskFinalization.js";
import { verifyStandardAssetOwnership } from "../engine/assetManager.js";
import { encryptString } from "../chain/encryption.js";
import { assertExactKeys, canonicalHash, SIGNED_ENVELOPE_KEYS, unsignedEnvelopeHash } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { ProviderEvidenceVerifier } from "./evidence.js";
import {
  assertDispatchWithinQuoteSettlementWindow,
  assertQuoteWindowPolicy,
} from "./paymentBinding.js";
import type {
  SignedEnvelope,
  DispatchStatusQueryV1,
  ProviderOutcomeConfig,
  QuoteV1,
  StandardEvidenceBundleV2,
  StandardRailDispatchV2,
} from "./types.js";
import { compileProviderSchema, validateProviderRequest } from "./schema.js";
import type { ValidateFunction } from "ajv";
import type { SupplierCostCeiling } from "../serviceRegistry/types.js";
import { fetchStandardTaskResponse } from "../a2a/responseBuilder.js";
import { admitStandardEvidence } from "./evidenceAdmissions.js";
import { recordStandardSecurityIncident } from "./incidents.js";
import { STANDARD_DISPATCH_PAYLOAD_KEYS } from "./dispatchContract.js";

const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");

interface ExistingClaim {
  dispatch_hash: Buffer;
  transaction_id: string | null;
  state: string;
  completed_at?: Date | null;
}

export function shouldLinkAssetOwnership(policy: "owner-only" | "any-payer"): boolean {
  return policy === "owner-only";
}

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

  async status(envelope: SignedEnvelope<DispatchStatusQueryV1>): Promise<Record<string, unknown>> {
    assertExactKeys(envelope, SIGNED_ENVELOPE_KEYS, "dispatch status envelope");
    assertExactKeys(envelope.payload, [
      "orderId", "dispatchHash", "issuedAt", "validBefore",
    ], "dispatch status payload");
    const now = Math.floor(Date.now() / 1_000);
    if (
      envelope.artifactType !== "DispatchStatusQueryV1" || envelope.schemaVersion !== 1 ||
      envelope.environment !== this.config.environment || envelope.chainId !== this.chainId ||
      envelope.audience !== this.config.providerAudience || envelope.issuedAt !== envelope.payload.issuedAt ||
      envelope.validBefore !== envelope.payload.validBefore || envelope.issuedAt > now + 30 ||
      envelope.validBefore <= now || envelope.validBefore > now + 120
    ) throw new Error("Dispatch status query domain is invalid");
    const recovered = await recoverMessageAddress({
      message: { raw: unsignedEnvelopeHash(envelope as unknown as Record<string, unknown>) },
      signature: envelope.signature,
    });
    if (getAddress(recovered) !== this.config.gatewayDispatchSigner) {
      throw new Error("Dispatch status query signature is invalid");
    }
    const claim = await this.findExistingClaim(this.config.gatewayAudience, envelope.payload.orderId);
    if (
      !claim?.transaction_id ||
      `0x${claim.dispatch_hash.toString("hex")}` !== envelope.payload.dispatchHash
    ) throw new Error("Dispatch status is unavailable");
    return this.signedResponse(claim.transaction_id, envelope.payload.dispatchHash, claim.state);
  }

  async accept(args: {
    dispatch: SignedEnvelope<StandardRailDispatchV2, 2>;
    quote: SignedEnvelope<QuoteV1>;
    request: Record<string, unknown>;
    evidenceBundle: StandardEvidenceBundleV2;
  }): Promise<{ taskId: string; dispatchHash: Hex; signature: Hex; state: string; terminalAttestation?: { payload: Record<string, unknown>; signature: Hex } }> {
    await this.verifyDispatch(args.dispatch, args.request, true);
    const dispatch = args.dispatch.payload;
    const dispatchHash = canonicalHash(args.dispatch);
    const existing = await this.findExistingClaim(dispatch.gatewayAudience, dispatch.orderId);
    if (existing) {
      if (`0x${existing.dispatch_hash.toString("hex")}` !== dispatchHash || !existing.transaction_id) {
        await recordStandardSecurityIncident({
          kind: "changed_dispatch_replay",
          gatewayAudience: dispatch.gatewayAudience,
          orderId: dispatch.orderId,
          identity: { gatewayAudience: dispatch.gatewayAudience, orderId: dispatch.orderId },
          details: { presentedDispatchHash: dispatchHash },
        });
        throw new Error("Changed dispatch replay rejected");
      }
      return this.signedResponse(existing.transaction_id, dispatchHash, existing.state);
    }
    const outcome = [...this.config.outcomes.values()].find((item) =>
      item.listingManifestHash === dispatch.listingManifestHash &&
      item.providerOfferHash === dispatch.providerOfferHash,
    );
    if (!outcome) throw new Error("Dispatch references an unknown outcome");
    this.assertDispatchIsCurrent(args.dispatch, outcome);
    if (
      outcome.providerControlProfileHash !== dispatch.providerControlProfileHash ||
      outcome.serviceId !== dispatch.serviceId ||
      outcome.activeRailProfileHash !== dispatch.activeRailProfileHash ||
      outcome.customerIdentityPolicyId !== "none" ||
      dispatch.buyerIdentityProofHash.toLowerCase() !== `0x${"00".repeat(32)}` ||
      outcome.bindingProfile !== dispatch.bindingProfile
    ) throw new Error("Dispatch conflicts with the provider outcome policy");
    const forbiddenPayers = [
      this.config.providerAuthorityKey,
      this.config.terminalAttestationKey,
      outcome.providerPayee,
      outcome.daskiCommissionReceiver,
      outcome.splitter,
      ...outcome.providerControlledWallets,
    ].map((address) => getAddress(address).toLowerCase());
    if (forbiddenPayers.includes(getAddress(dispatch.payer).toLowerCase())) {
      throw new Error("Known provider or operational self-purchase is forbidden");
    }
    await this.verifyQuote(args.quote, dispatch, outcome);
    const admittedQuote = await this.loadProviderQuote(args.quote, dispatch, outcome);
    if (
      (outcome.pricingMode === "fixed" && dispatch.grossAmount !== outcome.fixedGrossAmount) ||
      (outcome.pricingMode === "dynamic" && !admittedQuote)
    ) throw new Error("Dispatch price is not admitted by the provider offer");
    const supplierCostCeiling = admittedQuote?.supplierCostCeiling ?? null;
    const validate = this.requestValidators.get(outcome.outcomeId);
    if (!validate) throw new Error("Provider outcome validator is unavailable");
    validateProviderRequest(validate, args.request);
    const verifiedEvidence = await this.evidence.verify({
      dispatch,
      quote: args.quote,
      outcome,
      bundle: args.evidenceBundle,
    });
    for (const participant of [
      dispatch.payer,
      this.config.providerAuthorityKey,
      this.config.terminalAttestationKey,
      outcome.providerPayee,
      outcome.daskiCommissionReceiver,
      ...outcome.providerControlledWallets,
    ]) await this.evidence.assertNotSanctioned(participant);
    await admitStandardEvidence(
      dispatch.orderId,
      args.evidenceBundle,
      verifiedEvidence.authorizationKey,
    );

    const service = await getServiceBySlug(outcome.serviceSlug);
    if (!service?.is_active) throw new Error("Outcome service is not active");
    const skill = await getSkillByServiceAndSkillId(service.id, outcome.skillId);
    if (!skill?.is_active) throw new Error("Outcome skill is not active");
    const claimed = await this.claim({
      dispatch, dispatchHash, request: args.request, outcome, supplierCostCeiling,
    });
    if (claimed.existing) {
      return this.signedResponse(claimed.taskId, dispatchHash, claimed.state);
    }

    const adapter = getAdapter(service.adapter_name);
    let state = "failed";
    try {
      const resolvedAsset = await this.resolveAsset({
        serviceId: service.id,
        serviceSlug: service.slug,
        skillId: outcome.skillId,
        payer: dispatch.payer,
        request: args.request,
        requiresOwnership: skill.requires_asset_ownership,
      });
      const asset = resolvedAsset.asset;
      if (asset && resolvedAsset.linkOwnership) {
        await setTransactionAsset(claimed.taskId, asset.id);
      }
      const decision = await consultPreExecuteAgent(
        service,
        skill,
        args.request,
        true,
        claimed.taskId,
        asset,
      );
      if (decision.action === "reject") {
        const rejected = {
          status: "failed" as const,
          failureClass: "terminal" as const,
          error: "standard_pre_execute_rejected",
        };
        const processed = await processAdapterResult(claimed.taskId, rejected, service.id);
        state = processed.status;
        await pool.query(
          `UPDATE standard_dispatch_claims SET state='failed',resolved_at=now(),response_hash=$3
           WHERE gateway_audience=$1 AND order_id=$2`,
          [dispatch.gatewayAudience, dispatch.orderId, bytes(canonicalHash(decision))],
        );
        return this.signedResponse(claimed.taskId, dispatchHash, state);
      }
      if (decision.action === "escalate") {
        const escalated = await markEscalated(claimed.taskId, decision.reviewQuestion, {
          service,
          skill,
          requestData: args.request,
          asset,
        });
        state = escalated.status;
        await pool.query(
          `UPDATE standard_dispatch_claims SET state=$2,response_hash=$3
           WHERE gateway_audience=$1 AND order_id=$4`,
          [dispatch.gatewayAudience, state, bytes(canonicalHash(decision)), dispatch.orderId],
        );
        return this.signedResponse(claimed.taskId, dispatchHash, state);
      }
      const started = await pool.query(
        `UPDATE transactions SET status='working',updated_at=now(),
            metadata=metadata || '{"supplier_mutation_started":true}'::jsonb
          WHERE id=$1 AND standard_order_id=$2 AND status='submitted'`,
        [claimed.taskId, dispatch.orderId],
      );
      if (started.rowCount !== 1) throw new Error("Standard fulfillment claim was lost");
      const result = await adapter.execute(
        outcome.skillId,
        {
          id: claimed.taskId,
          service_id: service.id,
          skill_id: outcome.skillId,
          status: "working",
          supplierMutationStarted: true,
          ...(supplierCostCeiling ? { supplierCostCeiling } : {}),
        },
        args.request,
        asset ?? undefined,
      );
      const processed = await processAdapterResult(claimed.taskId, result, service.id);
      state = processed.status;
      await pool.query(
        `UPDATE standard_dispatch_claims SET state=$2,resolved_at=now(),response_hash=$3
         WHERE gateway_audience=$1 AND order_id=$4`,
        [dispatch.gatewayAudience, state, bytes(canonicalHash(result)), dispatch.orderId],
      );
    } catch (error) {
      const failure = {
        status: "failed" as const,
        failureClass: "terminal" as const,
        error: "standard_fulfillment_failed",
      };
      const processed = await processAdapterResult(claimed.taskId, failure, service.id);
      state = processed.status;
      await pool.query(
        `UPDATE transactions SET metadata=metadata || $2::jsonb WHERE id=$1`,
        [claimed.taskId, JSON.stringify({
          standardFailureClass: error instanceof Error ? error.name : "UnknownError",
        })],
      );
      await pool.query(
        `UPDATE standard_dispatch_claims SET state='failed',resolved_at=now()
         WHERE gateway_audience=$1 AND order_id=$2`,
        [dispatch.gatewayAudience, dispatch.orderId],
      );
    }
    return this.signedResponse(claimed.taskId, dispatchHash, state);
  }

  private async verifyDispatch(
    envelope: SignedEnvelope<StandardRailDispatchV2, 2>,
    request: Record<string, unknown>,
    allowExpired = false,
  ): Promise<void> {
    assertExactKeys(envelope, SIGNED_ENVELOPE_KEYS, "dispatch envelope");
    assertExactKeys(envelope.payload, STANDARD_DISPATCH_PAYLOAD_KEYS, "dispatch payload");
    const now = Math.floor(Date.now() / 1_000);
    if (
      envelope.artifactType !== "StandardRailDispatchV2" || envelope.schemaVersion !== 2 ||
      envelope.environment !== this.config.environment || envelope.chainId !== this.chainId ||
      envelope.audience !== this.config.providerAudience || envelope.issuedAt > now + 30 ||
      (!allowExpired && (envelope.validBefore <= now || envelope.validBefore > now + 300))
    ) throw new Error("Dispatch envelope domain or lifetime is invalid");
    const recovered = await recoverMessageAddress({
      message: { raw: unsignedEnvelopeHash(envelope as unknown as Record<string, unknown>) },
      signature: envelope.signature,
    });
    if (getAddress(recovered) !== this.config.gatewayDispatchSigner) {
      throw new Error("Dispatch signature is invalid");
    }
    const dispatch = envelope.payload;
    const hashes = [
      dispatch.providerControlProfileHash, dispatch.dispatchNonce, dispatch.listingManifestHash,
      dispatch.orderKey, dispatch.serviceId, dispatch.outcomeSchemaUid,
      dispatch.providerOfferHash, dispatch.quoteHash, dispatch.canonicalRequestHash,
      dispatch.orderNonce, dispatch.buyerIdentityProofHash, dispatch.activeRailProfileHash,
      dispatch.facilitatorConfirmationHash, dispatch.settlementTxHash, dispatch.depositBlockHash,
      dispatch.depositEvidenceHash, dispatch.releaseTxHash, dispatch.releaseBlockHash,
      dispatch.releaseEvidenceHash, dispatch.canonicalProviderRequestHash,
    ];
    const unsignedDecimal = /^(0|[1-9]\d*)$/;
    const depositBlockNumber = unsignedDecimal.test(dispatch.depositBlockNumber)
      ? BigInt(dispatch.depositBlockNumber) : -1n;
    const releaseBlockNumber = unsignedDecimal.test(dispatch.releaseBlockNumber)
      ? BigInt(dispatch.releaseBlockNumber) : -1n;
    const depositPosition = [depositBlockNumber, dispatch.depositTransactionIndex, dispatch.depositLogIndex] as const;
    const releasePosition = [releaseBlockNumber, dispatch.releaseTransactionIndex, dispatch.releaseLogIndex] as const;
    const releaseAfterDeposit = releasePosition[0] > depositPosition[0] ||
      (releasePosition[0] === depositPosition[0] && releasePosition[1] > depositPosition[1]) ||
      (releasePosition[0] === depositPosition[0] && releasePosition[1] === depositPosition[1] &&
        releasePosition[2] > depositPosition[2]);
    if (
      dispatch.environment !== this.config.environment || dispatch.chainId !== this.chainId ||
      dispatch.gatewayAudience !== this.config.gatewayAudience ||
      dispatch.providerAudience !== this.config.providerAudience ||
      dispatch.reputationEligible !== true ||
      getAddress(dispatch.reputationContract) !== this.config.reputationContract ||
      dispatch.outcomeSchemaUid !== this.config.reputationOutcomeSchemaUid ||
      dispatch.issuedAt !== envelope.issuedAt || dispatch.validBefore !== envelope.validBefore ||
      dispatch.canonicalProviderRequestHash !== canonicalHash(request) ||
      !/^0x[0-9a-fA-F]{40}$/.test(dispatch.payer) ||
      !/^ord_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(dispatch.orderId) ||
      dispatch.orderKey !== keccak256(stringToHex(dispatch.orderId)) ||
      hashes.some((hash) => !/^0x[0-9a-fA-F]{64}$/.test(hash)) ||
      dispatch.facilitatorConfirmationHash.toLowerCase() === `0x${"00".repeat(32)}` ||
      depositBlockNumber < 0n || releaseBlockNumber < 0n ||
      !Number.isSafeInteger(dispatch.depositTransactionIndex) || dispatch.depositTransactionIndex < 0 ||
      !Number.isSafeInteger(dispatch.depositLogIndex) || dispatch.depositLogIndex < 0 ||
      !Number.isSafeInteger(dispatch.releaseTransactionIndex) || dispatch.releaseTransactionIndex < 0 ||
      !Number.isSafeInteger(dispatch.releaseLogIndex) || dispatch.releaseLogIndex < 0 ||
      !/^[1-9]\d*$/.test(dispatch.releaseSequence) || BigInt(dispatch.releaseSequence) >= 1n << 64n ||
      !releaseAfterDeposit ||
      (depositBlockNumber === releaseBlockNumber &&
        dispatch.depositBlockHash.toLowerCase() !== dispatch.releaseBlockHash.toLowerCase()) ||
      (depositBlockNumber === releaseBlockNumber &&
        dispatch.depositTransactionIndex === dispatch.releaseTransactionIndex &&
        dispatch.settlementTxHash.toLowerCase() !== dispatch.releaseTxHash.toLowerCase()) ||
      !/^[1-9]\d*$/.test(dispatch.grossAmount) ||
      !/^[1-9]\d*$/.test(dispatch.providerNetAmount) ||
      !/^[1-9]\d*$/.test(dispatch.daskiCommissionAmount) ||
      BigInt(dispatch.providerNetAmount) + BigInt(dispatch.daskiCommissionAmount) !== BigInt(dispatch.grossAmount) ||
      !Number.isSafeInteger(dispatch.dispatchDeadlineSeconds) || dispatch.dispatchDeadlineSeconds < 30 ||
      !Number.isSafeInteger(dispatch.issuedAt) || !Number.isSafeInteger(dispatch.validBefore)
    ) throw new Error("Dispatch payload binding is invalid");
  }

  private assertDispatchIsCurrent(
    envelope: SignedEnvelope<StandardRailDispatchV2, 2>,
    outcome: ProviderOutcomeConfig,
  ): void {
    const now = Math.floor(Date.now() / 1_000);
    if (
      envelope.validBefore <= now ||
      envelope.payload.dispatchDeadlineSeconds !== outcome.dispatchDeadlineSeconds ||
      envelope.validBefore !== envelope.issuedAt + outcome.dispatchDeadlineSeconds
    ) {
      throw new Error("Dispatch envelope lifetime is invalid for a new claim");
    }
  }

  private async verifyQuote(
    envelope: SignedEnvelope<QuoteV1>,
    dispatch: StandardRailDispatchV2,
    outcome: ProviderOutcomeConfig,
  ): Promise<void> {
    assertExactKeys(envelope, SIGNED_ENVELOPE_KEYS, "quote envelope");
    assertExactKeys(envelope.payload, [
      "listingManifestHash", "providerOfferHash", "providerQuoteHash",
      "canonicalRequestHash", "grossAmount",
      "token", "splitter", "orderNonce", "issuedAt", "validBefore",
    ], "quote payload");
    const now = Math.floor(Date.now() / 1_000);
    if (
      envelope.artifactType !== "QuoteV1" || envelope.schemaVersion !== 1 ||
      envelope.environment !== this.config.environment || envelope.chainId !== this.chainId ||
      envelope.audience !== this.config.gatewayAudience || envelope.issuedAt !== envelope.payload.issuedAt ||
      envelope.validBefore !== envelope.payload.validBefore || envelope.issuedAt > now + 30 ||
      envelope.validBefore <= envelope.issuedAt || canonicalHash(envelope) !== dispatch.quoteHash
    ) throw new Error("Quote envelope domain or lifetime is invalid");
    const recovered = await recoverMessageAddress({
      message: { raw: unsignedEnvelopeHash(envelope as unknown as Record<string, unknown>) },
      signature: envelope.signature,
    });
    if (getAddress(recovered) !== this.config.gatewayQuoteSigner) {
      throw new Error("Quote signature is invalid");
    }
    const quote = envelope.payload;
    if (
      quote.listingManifestHash !== dispatch.listingManifestHash ||
      quote.providerOfferHash !== dispatch.providerOfferHash ||
      !/^0x[0-9a-fA-F]{64}$/.test(quote.providerQuoteHash) ||
      (outcome.pricingMode === "fixed") !==
        (quote.providerQuoteHash.toLowerCase() === `0x${"00".repeat(32)}`) ||
      quote.canonicalRequestHash !== dispatch.canonicalRequestHash ||
      quote.grossAmount !== dispatch.grossAmount ||
      getAddress(quote.token) !== getAddress(outcome.token) ||
      getAddress(quote.splitter) !== getAddress(outcome.splitter) ||
      quote.orderNonce !== dispatch.orderNonce
    ) throw new Error("Quote does not bind the dispatched order");
    assertQuoteWindowPolicy(envelope, outcome);
    assertDispatchWithinQuoteSettlementWindow(dispatch, envelope, outcome);
  }

  private async findExistingClaim(
    gatewayAudience: string,
    orderId: string,
  ): Promise<ExistingClaim | null> {
    const result = await pool.query<ExistingClaim>(
      `SELECT c.dispatch_hash,c.transaction_id,COALESCE(t.status,c.state) AS state
         FROM standard_dispatch_claims c
         LEFT JOIN transactions t ON t.id=c.transaction_id AND t.standard_order_id=c.order_id
        WHERE c.gateway_audience=$1 AND c.order_id=$2`,
      [gatewayAudience, orderId],
    );
    return result.rows[0] ?? null;
  }

  private async claim(args: {
    dispatch: StandardRailDispatchV2;
    dispatchHash: Hex;
    request: Record<string, unknown>;
    outcome: ProviderOutcomeConfig;
    supplierCostCeiling: SupplierCostCeiling | null;
  }): Promise<{ taskId: string; state: string; existing: boolean }> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const existing = await client.query<ExistingClaim>(
        `SELECT dispatch_hash,transaction_id,state FROM standard_dispatch_claims
         WHERE gateway_audience=$1 AND order_id=$2 FOR UPDATE`,
        [args.dispatch.gatewayAudience, args.dispatch.orderId],
      );
      if (existing.rows[0]) {
        if (`0x${existing.rows[0].dispatch_hash.toString("hex")}` !== args.dispatchHash || !existing.rows[0].transaction_id) {
          await recordStandardSecurityIncident({
            kind: "changed_dispatch_replay",
            gatewayAudience: args.dispatch.gatewayAudience,
            orderId: args.dispatch.orderId,
            identity: {
              gatewayAudience: args.dispatch.gatewayAudience,
              orderId: args.dispatch.orderId,
            },
            details: { presentedDispatchHash: args.dispatchHash },
          });
          throw new Error("Changed dispatch replay rejected");
        }
        await client.query("COMMIT");
        return { taskId: existing.rows[0].transaction_id, state: existing.rows[0].state, existing: true };
      }
      const service = await getServiceBySlug(args.outcome.serviceSlug);
      if (!service) throw new Error("Configured service does not exist");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `standard-capacity:${args.dispatch.listingManifestHash}`,
      ]);
      const capacity = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM standard_dispatch_claims c
           JOIN transactions t ON t.id=c.transaction_id AND t.standard_order_id=c.order_id
          WHERE t.standard_listing_manifest_hash=$1
            AND COALESCE(t.status,c.state) IN ('submitted','claimed','dispatching','working','input-required')`,
        [bytes(args.dispatch.listingManifestHash)],
      );
      if (BigInt(capacity.rows[0]?.count ?? "0") >= BigInt(args.outcome.maxOpenOrders)) {
        throw new Error("Outcome capacity is exhausted");
      }
      const taskId = `task-${randomUUID()}`;
      const customer = await upsertCustomer(args.dispatch.payer, client);
      const contactEmail = typeof args.request.contactEmail === "string"
        ? args.request.contactEmail.trim().toLowerCase() : null;
      if (contactEmail) await setCustomerLastKnownEmail(customer.id, contactEmail, client);
      const encryptedRequest = encryptString(JSON.stringify(args.request), {
        purpose: "standard-order-request",
        table: "transactions",
        recordId: taskId,
        field: "metadata.standard_request_encrypted",
        recordVersion: 1,
      });
      await client.query(
        `INSERT INTO standard_dispatch_claims
          (gateway_audience,order_id,dispatch_nonce,dispatch_hash,request_hash,payer,state)
         VALUES ($1,$2,$3,$4,$5,$6,'claimed')`,
        [
          args.dispatch.gatewayAudience,
          args.dispatch.orderId,
          bytes(args.dispatch.dispatchNonce),
          bytes(args.dispatchHash),
          bytes(args.dispatch.canonicalProviderRequestHash),
          args.dispatch.payer,
        ],
      );
      await client.query(
        `INSERT INTO transactions (
          id,customer_id,service_id,skill_id,status,metadata,contact_email,canonical_request_hash,
          standard_order_id,standard_payer,standard_listing_manifest_hash,
          standard_order_key,
          standard_provider_offer_hash,standard_deposit_evidence_hash,
          standard_release_evidence_hash,standard_token,standard_gross_amount,
          standard_provider_net_amount,standard_daski_commission_amount)
         VALUES ($1,$2,$3,$4,'submitted',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          taskId, customer.id, service.id, args.outcome.skillId,
          JSON.stringify({
            standard_request_encrypted: encryptedRequest,
            ...(args.supplierCostCeiling ? { supplier_cost_ceiling: args.supplierCostCeiling } : {}),
          }),
          contactEmail ? encryptString(contactEmail, {
            purpose: "customer-contact",
            table: "transactions",
            recordId: taskId,
            field: "contact_email",
          }) : null,
          bytes(args.dispatch.canonicalRequestHash), args.dispatch.orderId,
          args.dispatch.payer, bytes(args.dispatch.listingManifestHash),
          bytes(args.dispatch.orderKey), bytes(args.dispatch.providerOfferHash), bytes(args.dispatch.depositEvidenceHash),
          bytes(args.dispatch.releaseEvidenceHash),
          args.outcome.token, args.dispatch.grossAmount, args.dispatch.providerNetAmount,
          args.dispatch.daskiCommissionAmount,
        ],
      );
      await client.query(
        `UPDATE standard_dispatch_claims SET transaction_id=$3,state='dispatching'
         WHERE gateway_audience=$1 AND order_id=$2`,
        [args.dispatch.gatewayAudience, args.dispatch.orderId, taskId],
      );
      await client.query("COMMIT");
      return { taskId, state: "dispatching", existing: false };
    } catch (error) {
      await client.query("ROLLBACK");
      const databaseError = error as { code?: string; constraint?: string };
      if (
        databaseError.code === "23505" &&
        databaseError.constraint?.includes("dispatch_nonce")
      ) {
        await recordStandardSecurityIncident({
          kind: "dispatch_nonce_reuse",
          gatewayAudience: args.dispatch.gatewayAudience,
          orderId: args.dispatch.orderId,
          identity: {
            gatewayAudience: args.dispatch.gatewayAudience,
            dispatchNonce: args.dispatch.dispatchNonce,
          },
        });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async signedResponse(taskId: string, dispatchHash: Hex, state: string) {
    const task = await pool.query<{ status: string; completed_at: Date | null }>(
      "SELECT status,completed_at FROM transactions WHERE id=$1 AND standard_order_id IS NOT NULL",
      [taskId],
    );
    const resolvedState = task.rows[0]?.status ?? state;
    const responseHash = canonicalHash({ taskId, dispatchHash, state: resolvedState });
    const signature = await privateKeyToAccount(this.config.providerAuthorityPrivateKey).signMessage({
      message: { raw: responseHash },
    });
    const terminal = resolvedState === "completed" || resolvedState === "failed" || resolvedState === "canceled";
    if (terminal && !task.rows[0]?.completed_at) throw new Error("Terminal task completion time is missing");
    const terminalResult = terminal
      ? await fetchStandardTaskResponse({ id: taskId, status: resolvedState as "completed" | "failed" | "canceled" })
      : null;
    const terminalPayload = terminal ? {
      taskId,
      dispatchHash,
      state: resolvedState,
      resultHash: canonicalHash(terminalResult),
      completedAt: Math.floor(task.rows[0]!.completed_at!.getTime() / 1_000),
    } : null;
    const terminalAttestation = terminalPayload ? {
      payload: terminalPayload,
      signature: await privateKeyToAccount(this.config.terminalAttestationPrivateKey).signMessage({
        message: { raw: canonicalHash(terminalPayload) },
      }),
    } : undefined;
    return { taskId, dispatchHash, signature, state: resolvedState, terminalAttestation };
  }

  private async loadProviderQuote(
    quote: SignedEnvelope<QuoteV1>,
    dispatch: StandardRailDispatchV2,
    outcome: ProviderOutcomeConfig,
  ): Promise<{ supplierCostCeiling: SupplierCostCeiling | null } | null> {
    if (outcome.pricingMode === "fixed") return null;
    const result = await pool.query<{ supplier_cost_ceiling: SupplierCostCeiling | null }>(
      `SELECT supplier_cost_ceiling
         FROM standard_provider_quotes
        WHERE quote_hash=$1 AND outcome_id=$2 AND listing_manifest_hash=$3
          AND request_hash=$4 AND gross_amount=$5
          AND issued_at<=to_timestamp($6) AND valid_before>=to_timestamp($7)`,
      [
        bytes(quote.payload.providerQuoteHash), outcome.outcomeId,
        bytes(dispatch.listingManifestHash),
        bytes(dispatch.canonicalProviderRequestHash), dispatch.grossAmount,
        quote.issuedAt, quote.validBefore,
      ],
    );
    return result.rows[0]
      ? { supplierCostCeiling: result.rows[0].supplier_cost_ceiling }
      : null;
  }

  private async resolveAsset(args: {
    serviceId: string;
    serviceSlug: string;
    skillId: string;
    payer: Hex;
    request: Record<string, unknown>;
    requiresOwnership: boolean;
  }): Promise<{ asset: AssetRow | null; linkOwnership: boolean }> {
    if (!args.requiresOwnership) return { asset: null, linkOwnership: false };
    const module = getService(args.serviceSlug);
    const identifier = await module?.assets?.assetIdentifierFromData?.(args.skillId, args.request)
      ?? (args.request.domain as string | undefined);
    if (!identifier) throw new Error("Standard asset identifier is missing");
    const statuses = module?.assets?.assetLookupStatuses?.(args.skillId);
    const policy = module?.assets?.assetOwnershipPolicy?.(args.skillId) ?? "owner-only";
    if (policy === "any-payer") {
      const asset = statuses?.length
        ? await getAssetByIdentifierWithStatuses(args.serviceId, identifier, statuses)
        : await getActiveAssetByIdentifier(args.serviceId, identifier);
      if (!asset) throw new Error("Standard managed asset was not found");
      return { asset, linkOwnership: shouldLinkAssetOwnership(policy) };
    }
    const owned = await verifyStandardAssetOwnership(args.payer, identifier, args.serviceId, statuses);
    if (!owned.authorized || !owned.asset) {
      throw new Error("Standard payer does not own the managed asset");
    }
    return { asset: owned.asset, linkOwnership: shouldLinkAssetOwnership(policy) };
  }

}
