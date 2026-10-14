import type { Hex } from "viem";
import { materializeOutcome, type StandardRailGlobalPolicy } from "./catalogOutcomes.js";
import { DispatchRejectedError } from "./dispatchErrors.js";
import {
  bundleListingVersion,
  headListingVersion,
  loadListingVersionHead,
  type ListingVersion,
  type ListingVersionSource,
} from "./listingVersions.js";
import { validateOutcome } from "./outcomeValidation.js";
import type { ProviderOutcomeConfig } from "./types.js";

/** What resolving a dispatched version needs from the rail configuration. */
export interface DispatchOutcomeSource extends ListingVersionSource {
  chainId: number;
  globalPolicy: StandardRailGlobalPolicy;
  /** The endpoint control profile retained versions are re-materialized under. */
  providerControlProfileHash?: Hex;
}

export interface DispatchedOutcome {
  outcome: ProviderOutcomeConfig;
  version: ListingVersion;
  /** False for an earlier version still owed a funded first dispatch. */
  head: boolean;
}

const materialized = new Map<string, ProviderOutcomeConfig>();

/**
 * The outcome a funded dispatch names. The current head with that commitment
 * comes from the boot catalog; otherwise an earlier promoted version of the
 * same gateway, not retired, is re-materialized and re-validated exactly as a
 * head is at boot. A timely-paid order of a superseded listing therefore
 * keeps its original definition, price, splitter and keys. An unknown or
 * retired version, or one this deployment's rail policy no longer
 * reproduces, is refused before admission; a failed read is not a refusal.
 */
export async function dispatchOutcome(
  source: DispatchOutcomeSource,
  listingManifestHash: Hex,
  providerOfferHash: Hex,
): Promise<DispatchedOutcome> {
  const head = [...source.outcomes.values()].find((outcome) =>
    outcome.listingManifestHash === listingManifestHash && outcome.providerOfferHash === providerOfferHash);
  if (head) return { outcome: head, version: headListingVersion(source, head), head: true };
  if (!source.providerControlProfileHash || !/^0x[0-9a-fA-F]{64}$/.test(listingManifestHash)) {
    throw new DispatchRejectedError("outcome_policy", "Dispatch references an unknown outcome");
  }
  const loaded = await loadListingVersionHead(source.gatewayOrigin, listingManifestHash);
  if (!loaded || loaded.retired) {
    throw new DispatchRejectedError("outcome_policy", "Dispatch references an unknown or retired outcome");
  }
  const key = `${source.gatewayOrigin}\n${listingManifestHash.toLowerCase()}`;
  let outcome = materialized.get(key);
  if (!outcome) {
    try {
      outcome = materializeOutcome({
        head: loaded.head,
        globalPolicy: source.globalPolicy,
        chainId: source.chainId,
        providerControlProfileHash: source.providerControlProfileHash,
      });
      validateOutcome(outcome, source.chainId);
      if (!Number.isSafeInteger(outcome.maxOpenOrders) || outcome.maxOpenOrders <= 0) {
        throw new Error("retained outcome capacity is invalid");
      }
    } catch {
      throw new DispatchRejectedError(
        "outcome_policy", "The retained outcome does not materialize under this deployment's rail policy",
      );
    }
    materialized.set(key, outcome);
  }
  if (outcome.providerOfferHash !== providerOfferHash || outcome.listingManifestHash !== listingManifestHash) {
    throw new DispatchRejectedError("outcome_policy", "Dispatch references an unknown outcome");
  }
  return {
    outcome,
    version: bundleListingVersion(listingManifestHash, loaded.head.skillId, loaded.head.bundle),
    head: false,
  };
}
