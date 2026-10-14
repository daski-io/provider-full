import { vi } from "vitest";
import type { Hex } from "viem";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import type { ProviderStandardRailConfig } from "../src/core/standardRail/config.js";
import type { ProviderOutcomeConfig } from "../src/core/standardRail/types.js";
import { gatewayDispatch, gatewayQuoteV1, type DispatchArgs } from "./dispatchWire.js";
import { acceptProviderQuote, signGatewayEnvelope } from "./gatewayConsumer.js";
import {
  CHAIN_ID, ENVIRONMENT, fixedOutcome, gatewayKey, payerA, provider, PROVIDER_AUDIENCE,
} from "./standardRailFixture.js";

interface QuoteHandler {
  handle(envelope: unknown): Promise<Record<string, unknown>>;
}

/**
 * Drives one synthetic purchase the way the gateway does: a provider
 * readiness quote (optionally issued in the past), the gateway QuoteV1
 * bound to its hash, and a fresh dispatch envelope for the paid order.
 */
export function paidOrderHarness(args: {
  config: ProviderStandardRailConfig;
  quoteService: () => QuoteHandler;
  request: Record<string, unknown>;
}) {
  const { config, request } = args;

  async function readinessQuote(outcome: ProviderOutcomeConfig, payer: Hex | null, at?: number) {
    if (at !== undefined) {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(at * 1_000);
    }
    try {
      const issuedAt = Math.floor(Date.now() / 1_000);
      const envelope = await signGatewayEnvelope({
        artifactType: "ProviderQuoteRequestV1", environment: ENVIRONMENT, chainId: CHAIN_ID,
        audience: PROVIDER_AUDIENCE, signerKeyId: "gateway-dispatch", privateKey: gatewayKey,
        issuedAt, validBefore: issuedAt + 60,
        payload: {
          outcomeId: outcome.outcomeId, listingManifestHash: outcome.listingManifestHash,
          requestHash: canonicalHash(request), request, payer,
        },
      });
      const response = await args.quoteService().handle(envelope);
      return acceptProviderQuote(response, {
        outcomeId: outcome.outcomeId, listingManifestHash: outcome.listingManifestHash,
        requestHash: canonicalHash(request), payer, fixed: outcome.pricingMode === "fixed",
        fixedGrossAmount: outcome.fixedGrossAmount, providerAuthorityKey: provider.address,
        minimumPaymentWindowSeconds: 30,
        maximumLifetimeSeconds: outcome.pricingMode === "dynamic" ? 180 : null,
        commissionBps: outcome.commissionBps, receivedAt: issuedAt,
      });
    } finally {
      if (at !== undefined) vi.useRealTimers();
    }
  }

  async function paidOrder(options: {
    outcome?: ProviderOutcomeConfig;
    quotePayer?: Hex | null;
    dispatchPayer?: Hex;
    quotedAt?: number;
    gatewayValidBefore?: (validBefore: number) => number;
    orderId?: string;
  } = {}): Promise<DispatchArgs> {
    const outcome = options.outcome ?? fixedOutcome;
    const providerQuote = await readinessQuote(
      outcome, options.quotePayer === undefined ? payerA.toLowerCase() as Hex : options.quotePayer,
      options.quotedAt,
    );
    const quote = await gatewayQuoteV1({
      outcome, request, providerQuote,
      validBefore: options.gatewayValidBefore?.(providerQuote.validBefore) ?? providerQuote.validBefore - 20,
    });
    return gatewayDispatch({
      outcome, quote, request, payer: options.dispatchPayer ?? payerA, orderId: options.orderId,
      reputationContract: config.reputationContract, outcomeSchemaUid: config.reputationOutcomeSchemaUid,
    });
  }

  /** Another fresh envelope for the same paid order, as after a refusal. */
  function redispatch(order: DispatchArgs, outcome: ProviderOutcomeConfig = fixedOutcome) {
    return gatewayDispatch({
      outcome, quote: order.quote, request: order.request, payer: order.dispatch.payload.payer,
      orderId: order.dispatch.payload.orderId, evidence: order.evidenceBundle,
      reputationContract: config.reputationContract, outcomeSchemaUid: config.reputationOutcomeSchemaUid,
    });
  }

  return { readinessQuote, paidOrder, redispatch };
}
