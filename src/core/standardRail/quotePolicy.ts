import { pool } from "../db/pool.js";
import { QuoteRefusedError } from "./quoteErrors.js";
import type { ProviderOutcomeConfig } from "./types.js";

/**
 * Fixed readiness quotes last 120 s: far above the gateway's strict minimum
 * remaining payment window at receipt and well below its 300 s fixed cap.
 */
export const FIXED_READINESS_QUOTE_LIFETIME_SECONDS = 120;
/** The gateway's catalog quote policy caps dynamic provider quotes at 180 s. */
export const DYNAMIC_QUOTE_MAXIMUM_LIFETIME_SECONDS = 180;
/** The gateway's default minimum payment window for any challenge. */
export const GATEWAY_MINIMUM_PAYMENT_WINDOW_SECONDS = 30;
/**
 * At receipt the gateway needs validBefore - receipt to exceed the minimum
 * payment window strictly, and it tolerates 30 s of issuance skew. Keep at
 * least this much lifetime above the window for skew and network transit.
 */
export const QUOTE_RECEIPT_MARGIN_SECONDS = 60;

export function readinessQuoteLifetimeSeconds(outcome: ProviderOutcomeConfig): number {
  const lifetime = outcome.pricingMode === "fixed"
    ? FIXED_READINESS_QUOTE_LIFETIME_SECONDS
    : Math.min(outcome.quoteMaximumLifetimeSeconds, DYNAMIC_QUOTE_MAXIMUM_LIFETIME_SECONDS);
  const minimumWindow = Math.max(
    GATEWAY_MINIMUM_PAYMENT_WINDOW_SECONDS,
    outcome.pricingMode === "dynamic" ? outcome.quoteMinimumPaymentWindowSeconds : 0,
  );
  // A policy that cannot leave a strictly larger window at receipt would
  // only produce quotes the gateway discards; refuse instead of signing.
  if (!Number.isSafeInteger(lifetime) || lifetime - minimumWindow < QUOTE_RECEIPT_MARGIN_SECONDS) {
    throw new QuoteRefusedError(503, "unavailable");
  }
  return lifetime;
}

/**
 * Stop new quotes while open paid work for this listing version already
 * fills its admitted capacity. This is a pre-payment readiness signal only:
 * a funded dispatch is admitted regardless, because the gateway reserves
 * capacity per listing version from payment until the order is terminal.
 */
export async function assertQuoteCapacity(outcome: ProviderOutcomeConfig): Promise<void> {
  const result = await pool.query<{ open: number }>(
    `SELECT count(*)::int AS open
       FROM transactions
      WHERE standard_order_id IS NOT NULL
        AND standard_listing_manifest_hash=$1
        AND status IN ('submitted','working','input-required')`,
    [Buffer.from(outcome.listingManifestHash.slice(2), "hex")],
  );
  if ((result.rows[0]?.open ?? 0) >= outcome.maxOpenOrders) {
    throw new QuoteRefusedError(503, "capacity");
  }
}
