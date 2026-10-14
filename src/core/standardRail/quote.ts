import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getServiceBySlug } from "../db/queries/services.js";
import { getAdapter } from "../serviceRegistry/registry.js";
import { contractHandler } from "../serviceRegistry/retainedHandlers.js";
import { parseOptionalSupplierCostCeiling } from "../serviceRegistry/supplierCostCeiling.js";
import type { FulfillmentAdapter, QuoteResult, SupplierCostCeiling } from "../serviceRegistry/types.js";
import { canonicalHash } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { verifyGatewayEnvelope } from "./gatewayEnvelope.js";
import { describeIntake, requestMatchesHash } from "./intake.js";
import { assertBoundedJsonValue, REQUEST_JSON_BUDGET } from "./jsonBounds.js";
import { QuoteRefusedError, quoteEnvelopeRefusal, requestInvalid } from "./quoteErrors.js";
import { providerSchemaFieldErrors, serviceFieldErrors } from "./quoteFieldErrors.js";
import { assertQuoteCapacity, readinessQuoteLifetimeSeconds } from "./quotePolicy.js";
import { persistProviderQuote, type ProviderQuotePayload } from "./quoteStore.js";
import { headListingVersion } from "./listingVersions.js";
import { assertRequestReadiness } from "./requestReadiness.js";
import { outcomeRequestValidator } from "./schema.js";
import type { ProviderOutcomeConfig } from "./types.js";

interface ProviderQuoteRequest {
  outcomeId: string;
  listingManifestHash: Hex;
  requestHash: Hex;
  request: Record<string, unknown>;
  payer: Hex | null;
}

const LOWERCASE_ADDRESS = /^0x[0-9a-f]{40}$/;
const OUT_OF_BOUNDS = {
  path: "$",
  rule: "bounds",
  message: "Request exceeds the accepted document bounds.",
};
const SERVICE_DECLINED = {
  path: "$",
  rule: "invalid",
  message: "The request does not satisfy the service contract.",
};

/**
 * The provider quote endpoint. It answers signed readiness quotes for fixed
 * and dynamic listings and, on the same URL, signed intake discovery. A quote
 * validates the request and service prerequisites, never starts work, and is
 * persisted with its exact payer before it is signed.
 */
export class StandardQuoteService {
  constructor(
    private readonly config: ProviderStandardRailConfig,
    private readonly chainId: number,
  ) {}

  /** The request validator of a current head; undefined for any other outcome id. */
  private validatorFor(outcomeId: string) {
    const outcome = this.config.outcomes.get(outcomeId);
    return outcome ? outcomeRequestValidator(outcome) : undefined;
  }

  /** Each artifact type has its own handler; neither trusts the other's shape. */
  async handle(envelope: unknown): Promise<Record<string, unknown>> {
    const artifactType = envelope && typeof envelope === "object" && !Array.isArray(envelope)
      ? (envelope as { artifactType?: unknown }).artifactType
      : undefined;
    if (artifactType === "ProviderQuoteRequestV1") return this.quote(envelope);
    if (artifactType === "ProviderIntakeRequestV1") {
      return describeIntake({
        config: this.config,
        chainId: this.chainId,
        envelope,
        validatorFor: (outcomeId) => this.validatorFor(outcomeId),
      });
    }
    throw new QuoteRefusedError(400, "envelope");
  }

  async quote(value: unknown): Promise<Record<string, unknown>> {
    const envelope = await verifyGatewayEnvelope<ProviderQuoteRequest>(value, {
      artifactType: "ProviderQuoteRequestV1",
      schemaVersion: 1,
      payloadKeys: ["outcomeId", "listingManifestHash", "requestHash", "request", "payer"],
      environment: this.config.environment,
      chainId: this.chainId,
      audience: this.config.providerAudience,
      signer: this.config.gatewayDispatchSigner,
      lifetime: { maxRemainingSeconds: 120, maxAgeSeconds: 120 },
    }).catch((error: unknown) => { throw quoteEnvelopeRefusal(error); });
    const args = envelope.payload;
    // The gateway sends a lowercase payer (or null) and compares our echo
    // literally; a differently cased address is a different signed value.
    if (args.payer !== null && (typeof args.payer !== "string" || !LOWERCASE_ADDRESS.test(args.payer))) {
      throw new QuoteRefusedError(400, "envelope");
    }
    if (!args.request || typeof args.request !== "object" || Array.isArray(args.request) ||
        !requestMatchesHash(args.request, args.requestHash)) {
      throw new QuoteRefusedError(400, "envelope");
    }
    const outcome = this.config.outcomes.get(args.outcomeId);
    const validate = this.validatorFor(args.outcomeId);
    if (!outcome || !validate || outcome.listingManifestHash !== args.listingManifestHash) {
      throw new QuoteRefusedError(409, "outcome_policy");
    }
    try {
      assertBoundedJsonValue(args.request, REQUEST_JSON_BUDGET, "Request");
    } catch {
      throw requestInvalid([OUT_OF_BOUNDS]);
    }
    if (!validate(args.request)) throw requestInvalid(providerSchemaFieldErrors(validate.errors));
    const service = await getServiceBySlug(outcome.serviceSlug);
    if (!service?.is_active) throw new QuoteRefusedError(503, "service_unavailable");
    await assertQuoteCapacity(outcome);
    // A head is sold only while this build can execute its contract.
    const version = headListingVersion(this.config, outcome);
    const handler = contractHandler(version.serviceSlug, version.skillId, version.contract);
    if (!handler) throw new QuoteRefusedError(503, "service_unavailable");
    const adapter = handler.kind === "retained" ? handler.adapter : getAdapter(service.adapter_name);
    const priced = await this.price(adapter, outcome, args.request);
    await assertRequestReadiness({
      adapter, skillId: outcome.skillId, request: args.request, payer: args.payer,
    });
    const issuedAt = Math.floor(Date.now() / 1_000);
    const payload: ProviderQuotePayload = {
      outcomeId: outcome.outcomeId,
      listingManifestHash: outcome.listingManifestHash,
      requestHash: args.requestHash,
      grossAmount: priced.grossAmount,
      payer: args.payer,
      issuedAt,
      validBefore: issuedAt + readinessQuoteLifetimeSeconds(outcome),
    };
    await persistProviderQuote(payload, {
      pricingMode: outcome.pricingMode,
      supplierCostCeiling: priced.supplierCostCeiling,
    });
    const signature = await privateKeyToAccount(this.config.providerAuthorityPrivateKey).signMessage({
      message: { raw: canonicalHash(payload) },
    });
    return { ...payload, signature };
  }

  /**
   * The service validates the request and, for dynamic listings, prices it.
   * A fixed listing's amount is the admitted listing price: the service may
   * decline the request but can never change what the buyer pays.
   */
  private async price(
    adapter: FulfillmentAdapter,
    outcome: ProviderOutcomeConfig,
    request: Record<string, unknown>,
  ): Promise<{ grossAmount: string; supplierCostCeiling: SupplierCostCeiling | null }> {
    let result: QuoteResult;
    try {
      result = await adapter.quote(outcome.skillId, structuredClone(request));
    } catch {
      throw new QuoteRefusedError(503, "service_unavailable");
    }
    if (!result.ok) {
      const fieldErrors = serviceFieldErrors(Array.isArray(result.errors) ? result.errors : []);
      throw requestInvalid(fieldErrors.length > 0 ? fieldErrors : [SERVICE_DECLINED]);
    }
    if (result.currency !== "USDC" || typeof result.amount !== "bigint" || result.amount <= 0n) {
      throw new QuoteRefusedError(503, "price");
    }
    const amount = outcome.pricingMode === "fixed" ? BigInt(outcome.fixedGrossAmount) : result.amount;
    if (outcome.pricingMode === "fixed" && result.amount !== amount) {
      // The service's price no longer matches the admitted listing; selling
      // at either amount would misprice the order until it is re-registered.
      throw new QuoteRefusedError(503, "price");
    }
    const commissionBps = BigInt(outcome.commissionBps);
    if (amount < (10_000n + commissionBps - 1n) / commissionBps) {
      throw new QuoteRefusedError(422, "price");
    }
    let supplierCostCeiling: SupplierCostCeiling | null;
    try {
      supplierCostCeiling = parseOptionalSupplierCostCeiling(result.supplierCostCeiling);
    } catch {
      throw new QuoteRefusedError(503, "service_unavailable");
    }
    return { grossAmount: amount.toString(), supplierCostCeiling };
  }
}
