import type { Hex } from "viem";
import type { RuntimeListingHead } from "./runtimeCatalog.js";
import {
  buildRuntimeListingCommitment,
  runtimeCommitmentHash,
  type RuntimeCommitmentInputs,
  type RuntimeListingCommitmentV1,
} from "./runtimeCommitment.js";

export interface ResolvedActivationCommitment {
  commitment: RuntimeListingCommitmentV1;
  hash: Hex;
  /** The listing already heads this provider's runtime catalog. */
  reused: boolean;
}

/**
 * A reused listing that no longer reproduces its admitted commitment, or a
 * listing the gateway calls reused that this catalog never admitted. Either
 * is identity drift: refused, never adopted. The message names listing ids,
 * skill ids and commitment field names only.
 */
export class ReusedListingDriftError extends Error {
  constructor(
    readonly skillId: string,
    readonly listingId: string,
    /** Differing commitment fields; null when no admitted head exists. */
    readonly fields: readonly string[] | null,
  ) {
    super(fields
      ? `${skillId} was reused under listing ${listingId} but no longer reproduces its promoted commitment (differs in: ${fields.join(", ")})`
      : `${skillId} is reported as reused under listing ${listingId}, but no promoted commitment for that listing heads the local runtime catalog`);
    this.name = "ReusedListingDriftError";
  }
}

function differingFields(
  left: RuntimeListingCommitmentV1,
  right: RuntimeListingCommitmentV1,
): string[] {
  const a = left as unknown as Record<string, unknown>;
  const b = right as unknown as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
    .filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
}

/**
 * The commitment this provider expects the gateway to report for one listing
 * of an activation view.
 *
 * A listing whose id already heads this catalog keeps the commitment promoted
 * at its original admission: the gateway returns that record verbatim, and
 * both sides' identity rules forbid rotating an unchanged skill. The rebuild
 * therefore binds the head's provider intent hash, never the current
 * registration's. Only a free skill without an asset action depends on this:
 * paid listings pin the intent through their preparation and asset-action
 * skills through their control profile. Every other field must still
 * reproduce the head exactly. The same rule covers a crash-recovery replay of
 * an activation that was already promoted.
 *
 * A listing the gateway marks reused without a matching head is reproduced
 * from its own gateway-signed preparation or control profile, which carry
 * the admission's intent hash. A free listing with neither cannot be
 * reproduced without the head, so it is refused rather than rebuilt from the
 * current registration. Any other listing is a new admission and rebuilds
 * from the current registration.
 *
 * Pure: the catalog head is the only local authority consulted, and the
 * gateway's report is compared by the caller, never trusted here.
 */
export function resolveActivationCommitment(args: {
  inputs: RuntimeCommitmentInputs;
  priorHead: RuntimeListingHead | undefined;
  gatewayReused: boolean;
}): ResolvedActivationCommitment {
  const { inputs, priorHead } = args;
  const reused = priorHead !== undefined &&
    priorHead.listingId === inputs.listing.listingId;
  const pinnedByEnvelope = inputs.listing.preparation !== null ||
    inputs.listing.controlProfile !== null;
  if (!reused && args.gatewayReused && !pinnedByEnvelope) {
    throw new ReusedListingDriftError(inputs.listing.skillId, inputs.listing.listingId, null);
  }
  const commitment = buildRuntimeListingCommitment(reused
    ? {
      ...inputs,
      currentProviderIntentHash: priorHead.runtimeCommitment.providerIntentHash,
    }
    : inputs);
  const hash = runtimeCommitmentHash(commitment);
  if (reused && hash.toLowerCase() !== priorHead.runtimeCommitmentHash.toLowerCase()) {
    throw new ReusedListingDriftError(
      inputs.listing.skillId,
      inputs.listing.listingId,
      differingFields(commitment, priorHead.runtimeCommitment),
    );
  }
  return { commitment, hash, reused };
}

/** One listing of an activation view judged against the gateway's report. */
export interface ActivationCommitmentVerdict {
  listingId: string;
  skillId: string;
  reused: boolean;
  commitment: RuntimeListingCommitmentV1;
  expected: Hex;
  /** What the gateway reported for this listing id; null when it reported nothing. */
  reported: string | null;
  match: boolean;
}

export interface ActivationCrossCheck {
  verdicts: ActivationCommitmentVerdict[];
  /** Listing ids the gateway reported that the view does not list. */
  extra: string[];
  /** The gateway reported one listing id more than once. */
  duplicates: boolean;
  ok: boolean;
}

/**
 * The exact-set cross-check of an activation: one expected commitment per
 * listing in the view, every reported hash equal to it, nothing missing,
 * nothing extra, nothing duplicated. Pure; `priorHeads` is keyed by skill id.
 * Throws ReusedListingDriftError when a reused listing cannot reproduce its
 * admitted commitment: that is a refusal, not a mismatch to report.
 */
export function crossCheckActivationCommitments(args: {
  inputs: ReadonlyArray<RuntimeCommitmentInputs & { gatewayReused: boolean }>;
  reported: ReadonlyArray<{ listingId: string; runtimeCommitmentHash: string }>;
  priorHeads: ReadonlyMap<string, RuntimeListingHead>;
}): ActivationCrossCheck {
  const reported = new Map<string, string>();
  for (const item of args.reported) {
    reported.set(item.listingId, item.runtimeCommitmentHash.toLowerCase());
  }
  const duplicates = reported.size !== args.reported.length;
  const verdicts = args.inputs.map(({ gatewayReused, ...inputs }) => {
    const resolved = resolveActivationCommitment({
      inputs,
      priorHead: args.priorHeads.get(inputs.listing.skillId),
      gatewayReused,
    });
    const got = reported.get(inputs.listing.listingId) ?? null;
    return {
      listingId: inputs.listing.listingId,
      skillId: inputs.listing.skillId,
      reused: resolved.reused,
      commitment: resolved.commitment,
      expected: resolved.hash,
      reported: got,
      match: got === resolved.hash.toLowerCase(),
    };
  });
  const listed = new Set(verdicts.map((verdict) => verdict.listingId));
  const extra = [...reported.keys()].filter((listingId) => !listed.has(listingId));
  return {
    verdicts,
    extra,
    duplicates,
    ok: !duplicates && extra.length === 0 && verdicts.every((verdict) => verdict.match),
  };
}

/**
 * Names every disagreement of a cross-check: listing, skill, reuse and the
 * expected and reported commitment hashes. Commitment hashes are public
 * identifiers; no signed artifact or secret is ever included.
 */
export function describeCrossCheck(check: ActivationCrossCheck): string {
  const parts = check.verdicts
    .filter((verdict) => !verdict.match)
    .map((verdict) =>
      `${verdict.skillId} (${verdict.listingId}${verdict.reused ? ", reused" : ""}): expected ${verdict.expected}, reported ${verdict.reported ?? "nothing"}`);
  if (check.extra.length > 0) parts.push(`reported but not in the view: ${check.extra.join(", ")}`);
  if (check.duplicates) parts.push("duplicate listing ids in the report");
  return parts.join("; ");
}
