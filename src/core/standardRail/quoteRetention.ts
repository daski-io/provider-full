import type { Queryable } from "../db/queryable.js";
import { logInfo, logWarn } from "../logger.js";
import { workerCycleFailed, workerCycleSucceeded } from "../observability/workerConditions.js";

/*
 * How long a provider quote is owed. The gateway never makes a first
 * dispatch for an order more than MAX_FIRST_DISPATCH_QUOTE_AGE_SECONDS after
 * its gateway quote's validBefore, which is never later than the provider
 * quote's own, and admission refuses a new claim the gateway signed later
 * (dispatchQuoteBinding.ts). A dispatch envelope lives at most a day, so no
 * claim can name a provider quote once PROVIDER_QUOTE_OBLIGATION_SECONDS have
 * passed since its own validBefore: it has lapsed. Until then the quote is an
 * obligation of its listing version; after it nothing is owed for it, and a
 * lapsed quote no claim names may be pruned. Core migration 016 enforces the
 * same rule on every deletion, whoever deletes.
 */

/** Protocol constant: no first dispatch more than 30 days after its quote's validBefore. */
export const MAX_FIRST_DISPATCH_QUOTE_AGE_SECONDS = 2_592_000;
/** The first-dispatch bound plus a day for the dispatch envelope's lifetime and clock skew. */
export const PROVIDER_QUOTE_OBLIGATION_SECONDS = MAX_FIRST_DISPATCH_QUOTE_AGE_SECONDS + 86_400;
/** At most this many lapsed quotes are pruned per retention sweep. */
export const PROVIDER_QUOTE_PRUNE_BATCH = 1_000;

const PRUNE_CONDITION = "retention:provider-quotes";

/**
 * Remove up to `limit` lapsed provider quotes that no dispatch claim names,
 * oldest first, and return how many went. Best effort: a failure (such as a
 * claim committed meanwhile, which the deletion guard refuses) is logged
 * once per change and retried by the next sweep, never failing it.
 */
export async function pruneLapsedProviderQuotes(
  db: Queryable,
  limit = PROVIDER_QUOTE_PRUNE_BATCH,
): Promise<number> {
  try {
    const result = await db.query(
      `DELETE FROM standard_provider_quotes
        WHERE quote_hash IN (
          SELECT q.quote_hash FROM standard_provider_quotes q
           WHERE q.valid_before < now() - make_interval(secs => $1)
             AND NOT EXISTS (
               SELECT 1 FROM standard_dispatch_claims c WHERE c.provider_quote_hash = q.quote_hash)
           ORDER BY q.valid_before
           LIMIT $2)`,
      [PROVIDER_QUOTE_OBLIGATION_SECONDS, limit],
    );
    if (workerCycleSucceeded(PRUNE_CONDITION)) logInfo("Provider quote pruning recovered", {});
    return result.rowCount ?? 0;
  } catch (error) {
    if (workerCycleFailed(PRUNE_CONDITION, error)) {
      const code = (error as { code?: unknown }).code;
      logWarn("Provider quote pruning failed; the next retention sweep retries it", {
        errorClass: error instanceof Error ? error.name : "UnknownError",
        ...(typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? { code } : {}),
      });
    }
    return 0;
  }
}
