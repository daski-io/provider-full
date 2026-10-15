import { getAddress, recoverMessageAddress, type Hex } from "viem";
import { parseOptionalSupplierCostCeiling } from "../serviceRegistry/supplierCostCeiling.js";
import type { SupplierCostCeiling } from "../serviceRegistry/types.js";
import { assertExactKeys, canonicalHash, SIGNED_ENVELOPE_KEYS, unsignedEnvelopeHash } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { DispatchRejectedError, withDispatchRejection } from "./dispatchErrors.js";
import { GATEWAY_CLOCK_SKEW_SECONDS } from "./gatewayEnvelope.js";
import { assertQuoteWindowPolicy } from "./paymentBinding.js";
import { MAX_FIRST_DISPATCH_QUOTE_AGE_SECONDS } from "./quoteRetention.js";
import { loadProviderQuote, providerQuoteHash, type StoredProviderQuote } from "./quoteStore.js";
import type { ProviderOutcomeConfig, QuoteV1, SignedEnvelope, StandardRailDispatchV2 } from "./types.js";

const ZERO_HASH = `0x${"00".repeat(32)}`;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const QUOTE_PAYLOAD_KEYS = [
  "listingManifestHash", "providerOfferHash", "providerQuoteHash", "canonicalRequestHash",
  "grossAmount", "token", "splitter", "orderNonce", "issuedAt", "validBefore",
] as const;

export interface AdmittedProviderQuote {
  quoteHash: Hex;
  pricingMode: "fixed" | "dynamic";
  payer: Hex | null;
  supplierCostCeiling: SupplierCostCeiling | null;
}

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

/**
 * The signed dispatch binds the forwarded QuoteV1 by hash, so its shape, that
 * hash and its gateway-quote signature are checked offline before any claim
 * is looked up: an exact replay always carries the identical quote, and a
 * request with any other quote is refused without reading state.
 */
export async function assertForwardedQuoteIntegrity(args: {
  config: ProviderStandardRailConfig;
  envelope: unknown;
  dispatch: StandardRailDispatchV2;
}): Promise<void> {
  try {
    assertExactKeys(args.envelope, SIGNED_ENVELOPE_KEYS, "quote envelope");
    assertExactKeys((args.envelope as { payload?: unknown }).payload, QUOTE_PAYLOAD_KEYS, "quote payload");
  } catch {
    throw new DispatchRejectedError("quote_window", "Quote envelope shape is invalid");
  }
  const envelope = args.envelope as SignedEnvelope<QuoteV1>;
  const bound = await withDispatchRejection("quote_window", () => canonicalHash(envelope) === args.dispatch.quoteHash);
  if (!bound) throw new DispatchRejectedError("quote_window", "Quote envelope is not the one the dispatch binds");
  const recovered = await withDispatchRejection("signature", () => recoverMessageAddress({
    message: { raw: unsignedEnvelopeHash(envelope as unknown as Record<string, unknown>) },
    signature: envelope.signature,
  }));
  if (getAddress(recovered) !== args.config.gatewayQuoteSigner) {
    throw new DispatchRejectedError("signature", "Quote signature is invalid");
  }
}

/**
 * Verify the gateway QuoteV1 forwarded with a dispatch that would admit a new
 * claim. Fixed and dynamic listings alike carry a nonzero provider quote
 * hash. The quote's age is not compared with the current time: a timely
 * payment can be dispatched with a fresh envelope long after the quote
 * window closed, and settlement time is proven separately from the
 * authenticated deposit block. The gateway never signs a first dispatch more
 * than MAX_FIRST_DISPATCH_QUOTE_AGE_SECONDS after the quote's validBefore, so
 * an envelope signed later is refused; equality is still admitted.
 */
export async function verifyGatewayQuote(args: {
  config: ProviderStandardRailConfig;
  chainId: number;
  envelope: SignedEnvelope<QuoteV1>;
  dispatch: StandardRailDispatchV2;
  outcome: ProviderOutcomeConfig;
}): Promise<void> {
  const { config, envelope, dispatch, outcome } = args;
  try {
    assertExactKeys(envelope, SIGNED_ENVELOPE_KEYS, "quote envelope");
    assertExactKeys(envelope.payload, QUOTE_PAYLOAD_KEYS, "quote payload");
  } catch {
    throw new DispatchRejectedError("quote_window", "Quote envelope shape is invalid");
  }
  const now = Math.floor(Date.now() / 1_000);
  if (
    envelope.artifactType !== "QuoteV1" || envelope.schemaVersion !== 1 ||
    envelope.environment !== config.environment || envelope.chainId !== args.chainId ||
    envelope.audience !== config.gatewayAudience || envelope.issuedAt !== envelope.payload.issuedAt ||
    envelope.validBefore !== envelope.payload.validBefore ||
    !Number.isSafeInteger(envelope.issuedAt) || !Number.isSafeInteger(envelope.validBefore) ||
    envelope.issuedAt > now + GATEWAY_CLOCK_SKEW_SECONDS || envelope.validBefore <= envelope.issuedAt ||
    canonicalHash(envelope) !== dispatch.quoteHash
  ) throw new DispatchRejectedError("quote_window", "Quote envelope domain or window is invalid");
  if (dispatch.issuedAt > envelope.payload.validBefore + MAX_FIRST_DISPATCH_QUOTE_AGE_SECONDS) {
    throw new DispatchRejectedError("quote_window", "Dispatch was signed past its quote's first-dispatch bound");
  }
  const recovered = await withDispatchRejection("signature", () => recoverMessageAddress({
    message: { raw: unsignedEnvelopeHash(envelope as unknown as Record<string, unknown>) },
    signature: envelope.signature,
  }));
  if (getAddress(recovered) !== config.gatewayQuoteSigner) {
    throw new DispatchRejectedError("signature", "Quote signature is invalid");
  }
  const quote = envelope.payload;
  if (
    quote.listingManifestHash !== dispatch.listingManifestHash ||
    quote.providerOfferHash !== dispatch.providerOfferHash ||
    !HASH.test(quote.providerQuoteHash) || same(quote.providerQuoteHash, ZERO_HASH) ||
    quote.canonicalRequestHash !== dispatch.canonicalRequestHash ||
    quote.grossAmount !== dispatch.grossAmount ||
    getAddress(quote.token) !== getAddress(outcome.token) ||
    getAddress(quote.splitter) !== getAddress(outcome.splitter) ||
    quote.orderNonce !== dispatch.orderNonce
  ) throw new DispatchRejectedError("price", "Quote does not bind the dispatched order");
  try {
    assertQuoteWindowPolicy(envelope, outcome);
  } catch {
    throw new DispatchRejectedError("quote_window", "Quote window violates the outcome quote policy");
  }
}

/** The stored row must reproduce the hash the gateway committed to. */
function reproducesQuoteHash(stored: StoredProviderQuote): boolean {
  const signed = {
    outcomeId: stored.outcomeId,
    listingManifestHash: stored.listingManifestHash,
    requestHash: stored.requestHash,
    grossAmount: stored.grossAmount,
    payer: stored.payer,
    issuedAt: stored.issuedAt,
    validBefore: stored.validBefore,
  };
  if (same(providerQuoteHash(signed), stored.quoteHash)) return true;
  // Earlier releases signed dynamic quotes without a payer field at all; such
  // a row is still the admitted, payer-unbound quote of a timely-paid order.
  if (stored.payer !== null || stored.pricingMode !== "dynamic") return false;
  const { payer: _payer, ...legacy } = signed;
  return same(canonicalHash(legacy), stored.quoteHash);
}

/**
 * Load the provider quote the gateway bound this order to and verify it
 * against the dispatch for fixed and dynamic listings: outcome, listing,
 * request, price and pricing mode, the payer as an address (a payer-unbound
 * readiness quote admits any payer), and a provider window that covers the
 * gateway's quote window. Only signed timestamps are compared; the current
 * time is deliberately not part of this binding.
 */
export async function loadAdmittedProviderQuote(args: {
  quote: SignedEnvelope<QuoteV1>;
  dispatch: StandardRailDispatchV2;
  outcome: ProviderOutcomeConfig;
}): Promise<AdmittedProviderQuote> {
  const { quote, dispatch, outcome } = args;
  const stored = await loadProviderQuote(quote.payload.providerQuoteHash);
  // A quote this provider never issued cannot bind the order's window.
  if (!stored) throw new DispatchRejectedError("quote_window", "Dispatch is not bound to a persisted provider quote");
  if (!reproducesQuoteHash(stored)) {
    throw new DispatchRejectedError("price", "Persisted provider quote does not reproduce its hash");
  }
  if (
    stored.outcomeId !== outcome.outcomeId ||
    !same(stored.listingManifestHash, dispatch.listingManifestHash) ||
    !same(stored.requestHash, dispatch.canonicalProviderRequestHash) ||
    stored.grossAmount !== dispatch.grossAmount ||
    stored.pricingMode !== outcome.pricingMode ||
    (outcome.pricingMode === "fixed" && stored.grossAmount !== outcome.fixedGrossAmount) ||
    (stored.payer !== null && getAddress(stored.payer) !== getAddress(dispatch.payer))
  ) throw new DispatchRejectedError("price", "Persisted provider quote does not bind this dispatch");
  if (stored.issuedAt > quote.issuedAt || stored.validBefore < quote.validBefore) {
    throw new DispatchRejectedError("quote_window", "Provider quote window does not cover the gateway quote");
  }
  let supplierCostCeiling: SupplierCostCeiling | null;
  try {
    supplierCostCeiling = parseOptionalSupplierCostCeiling(stored.supplierCostCeiling);
  } catch {
    throw new DispatchRejectedError("price", "Persisted supplier cost ceiling is invalid");
  }
  return {
    quoteHash: stored.quoteHash,
    pricingMode: stored.pricingMode,
    payer: stored.payer,
    supplierCostCeiling,
  };
}
