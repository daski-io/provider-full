import { getAddress, type Address, type Hex } from "viem";
import { pool } from "../db/pool.js";
import type {
  ProviderRuntimeListingBundleV1,
  RuntimeListingHead,
} from "../gatewayRegistration/runtimeCatalog.js";
import type { RuntimeListingCommitmentV1 } from "../gatewayRegistration/runtimeCommitment.js";
import { DEFAULT_DISPATCH_SECONDS, DEFAULT_FULFILLMENT_SECONDS } from "../serviceRegistry/deadlines.js";
import { executableContractOf } from "../serviceRegistry/executableContracts.js";
import type { ProviderOutcomeConfig } from "./types.js";

/*
 * The listing version an order was sold under, resolved by the commitment
 * hash the order carries: the current head for new sales, any earlier
 * promoted version for the orders, jobs and reads it still owes. Content is
 * immutable once promoted (core migration 009), so resolved versions are
 * cached by hash; only retirement changes what a version may still admit,
 * and the database fences that at admission.
 */

export interface ListingVersion {
  listingManifestHash: Hex;
  serviceSlug: string;
  skillId: string;
  /** The version's published skill contract; null for a head configured without the runtime catalog. */
  contract: Record<string, unknown> | null;
  /** The agent wallet the checkout snapshot names as provider authority and terminal attestation key. */
  signingKey: Address;
  dispatchSeconds: number;
  /** The admitted fulfillment duration; null when the contract states none this release can read. */
  fulfillmentSeconds: number | null;
}

/** What resolving a version needs from the rail configuration. */
export interface ListingVersionSource {
  gatewayOrigin: string;
  outcomes: ReadonlyMap<string, ProviderOutcomeConfig>;
  /** Heads materialized from the runtime catalog, keyed by lowercase commitment hash. */
  headVersions?: ReadonlyMap<string, ListingVersion>;
}

const MAX_CACHED_VERSIONS = 4_096;
const MIN_DEADLINE_SECONDS = 30;
const MAX_FULFILLMENT_SECONDS = 31_536_000;
const cache = new Map<string, ListingVersion>();
const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");
const hex = (value: Buffer): Hex => `0x${value.toString("hex")}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function seconds(value: unknown, fallback: number, maximum: number): number | null {
  if (value === undefined) return fallback;
  return Number.isSafeInteger(value) && (value as number) >= MIN_DEADLINE_SECONDS && (value as number) <= maximum
    ? value as number
    : null;
}

/**
 * The deadlines a published contract states, with the gateway's sealed
 * defaults where it states none (contracts published before deadlines were
 * always carried). A malformed value is unknown, never guessed.
 */
export function contractDeadlines(contract: unknown): { dispatchSeconds: number | null; fulfillmentSeconds: number | null } {
  const deadlines = isRecord(contract) && isRecord(contract.deadlines) ? contract.deadlines : {};
  return {
    dispatchSeconds: seconds(deadlines.dispatchSeconds, DEFAULT_DISPATCH_SECONDS, 86_400),
    fulfillmentSeconds: seconds(deadlines.fulfillmentSeconds, DEFAULT_FULFILLMENT_SECONDS, MAX_FULFILLMENT_SECONDS),
  };
}

/**
 * Whether an order of this version must prove asset ownership: its admitted
 * contract decides, since a retained contract may differ from the current
 * one; a head configured without the runtime catalog follows its installed
 * skill.
 */
export function admittedOwnership(version: ListingVersion, skill: { requires_asset_ownership: boolean }): boolean {
  return version.contract === null
    ? skill.requires_asset_ownership
    : executableContractOf(version.contract).requiresAssetOwnership === true;
}

/** The version a promoted runtime bundle describes. */
export function bundleListingVersion(
  listingManifestHash: Hex,
  skillId: string,
  bundle: ProviderRuntimeListingBundleV1,
): ListingVersion {
  const contract = bundle.skillContract?.contract ?? null;
  if (!contract) throw new Error(`runtime listing ${skillId} has no published skill contract`);
  const deadlines = contractDeadlines(contract);
  if (deadlines.dispatchSeconds === null) throw new Error(`runtime listing ${skillId} has an invalid dispatch deadline`);
  return {
    listingManifestHash: listingManifestHash.toLowerCase() as Hex,
    serviceSlug: bundle.intent.payload.serviceSlug,
    skillId,
    contract,
    signingKey: getAddress(bundle.providerIdentity.agentWallet),
    dispatchSeconds: deadlines.dispatchSeconds,
    fulfillmentSeconds: deadlines.fulfillmentSeconds,
  };
}

/** A head configured directly: its own key and deadline, the gateway's default duration. */
function configuredVersion(outcome: ProviderOutcomeConfig): ListingVersion {
  return {
    listingManifestHash: outcome.listingManifestHash.toLowerCase() as Hex,
    serviceSlug: outcome.serviceSlug,
    skillId: outcome.skillId,
    contract: null,
    signingKey: getAddress(outcome.providerTerminalAttestationKey),
    dispatchSeconds: outcome.dispatchDeadlineSeconds,
    fulfillmentSeconds: DEFAULT_FULFILLMENT_SECONDS,
  };
}

/** The version for a current head of `source`. */
export function headListingVersion(source: ListingVersionSource, outcome: ProviderOutcomeConfig): ListingVersion {
  return source.headVersions?.get(outcome.listingManifestHash.toLowerCase()) ?? configuredVersion(outcome);
}

/** Resolve any promoted paid version of this gateway by commitment hash; null when none exists. */
export async function listingVersion(source: ListingVersionSource, listingManifestHash: Hex): Promise<ListingVersion | null> {
  const hash = listingManifestHash.toLowerCase() as Hex;
  const head = source.headVersions?.get(hash);
  if (head) return head;
  const configured = [...source.outcomes.values()].find((outcome) => outcome.listingManifestHash.toLowerCase() === hash);
  if (configured) return configuredVersion(configured);
  const cacheKey = `${source.gatewayOrigin}\n${hash}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const row = (await pool.query<{ skill_id: string; bundle: ProviderRuntimeListingBundleV1 }>(
    `SELECT skill_id,bundle FROM provider_runtime_listing_versions
      WHERE gateway_origin=$1 AND runtime_commitment_hash=$2 AND payment_required
      ORDER BY promoted_at,id LIMIT 1`,
    [source.gatewayOrigin, bytes(hash)],
  )).rows[0];
  if (!row) return null;
  const version = bundleListingVersion(hash, row.skill_id, row.bundle);
  if (cache.size >= MAX_CACHED_VERSIONS) cache.clear();
  cache.set(cacheKey, version);
  return version;
}

/** A promoted version as the head shape materialization reads, with its retirement state. */
export async function loadListingVersionHead(
  gatewayOrigin: string,
  listingManifestHash: Hex,
): Promise<{ head: RuntimeListingHead; retired: boolean } | null> {
  const row = (await pool.query<{
    service_id: Buffer; skill_id: string; listing_id: string; listing_key: Buffer;
    runtime_commitment_hash: Buffer; runtime_commitment: RuntimeListingCommitmentV1;
    bundle: ProviderRuntimeListingBundleV1; promoted_at: Date; retired_at: Date | null;
  }>(
    `SELECT service_id,skill_id,listing_id,listing_key,runtime_commitment_hash,runtime_commitment,
            bundle,promoted_at,retired_at
       FROM provider_runtime_listing_versions
      WHERE gateway_origin=$1 AND runtime_commitment_hash=$2 AND payment_required
      ORDER BY promoted_at,id LIMIT 1`,
    [gatewayOrigin, bytes(listingManifestHash)],
  )).rows[0];
  if (!row) return null;
  return {
    retired: row.retired_at !== null,
    head: {
      gatewayOrigin,
      serviceId: hex(row.service_id),
      skillId: row.skill_id,
      listingId: row.listing_id,
      listingKey: hex(row.listing_key),
      paymentRequired: true,
      runtimeCommitmentHash: hex(row.runtime_commitment_hash),
      runtimeCommitment: row.runtime_commitment,
      bundle: row.bundle,
      promotedAt: row.promoted_at,
    },
  };
}
