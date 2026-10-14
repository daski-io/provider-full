import type { Hex } from "viem";
import { pool } from "../db/pool.js";
import type { Queryable } from "../db/queryable.js";
import { recordMandatoryAudit } from "../events/emitter.js";
import {
  verifyRetirementReceipt,
  type GatewayRetirementPayload,
  type RetirementReceiptDomain,
} from "./retirementReceipt.js";
import { loadVersionObligations, openExecutionObligations, type VersionObligations } from "./versionObligations.js";

/*
 * Retirement ends a paid listing version's dispatch and execution support
 * for good; reads of its orders, its frozen results and its signing key are
 * never retired. It needs two independent proofs: the gateway's signed
 * receipt that the version's dispatch obligations ended, and no open local
 * execution obligation. Local state is counted only after the version rows
 * are locked FOR UPDATE, the same rows every admission locks FOR SHARE
 * (core migration 009), so an admission either committed first and blocks
 * the retirement, or waits and is refused once it commits.
 */

const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");

export class ListingRetirementBlockedError extends Error {
  constructor(readonly blockers: Record<string, Record<string, number>>) {
    super(`listing retirement blocked: ${JSON.stringify(blockers)}`);
    this.name = "ListingRetirementBlockedError";
  }
}

export interface RetiredListing {
  listingManifestHash: Hex;
  skillId: string;
  requestId: string;
  alreadyRetired: boolean;
}

/** Verify each receipt against the version it names; the map is keyed by lowercase commitment hash. */
export async function verifyRetirementReceipts(args: {
  receipts: readonly unknown[];
  providerAgentId: string;
  serviceId: Hex;
  domain: RetirementReceiptDomain;
}): Promise<Map<string, GatewayRetirementPayload>> {
  const verified = new Map<string, GatewayRetirementPayload>();
  for (const receipt of args.receipts) {
    const named = (receipt as { payload?: { scope?: { listingManifestHash?: unknown } } } | null)
      ?.payload?.scope?.listingManifestHash;
    if (typeof named !== "string" || !/^0x[0-9a-f]{64}$/.test(named)) {
      throw new Error("gateway retirement receipt does not name a listing version");
    }
    const payload = await verifyRetirementReceipt(receipt, {
      kind: "listing", providerAgentId: args.providerAgentId,
      serviceId: args.serviceId, listingManifestHash: named as Hex,
    }, args.domain);
    if (verified.has(named)) throw new Error("two gateway retirement receipts name the same listing version");
    verified.set(named, payload);
  }
  return verified;
}

/**
 * Inside the caller's transaction, after it took the service's promotion
 * lock: lock the versions, count their obligations, and retire every one
 * that is not retired yet. Throws ListingRetirementBlockedError, writing
 * nothing, when any version lacks a receipt, is still the head (unless the
 * caller supersedes the heads itself) or owes execution.
 */
export async function retireLockedListingVersions(db: Queryable, args: {
  gatewayOrigin: string;
  serviceId: Hex;
  /** Lowercase commitment hashes; all paid versions of the service when omitted. */
  listingManifestHashes?: readonly Hex[];
  receipts: ReadonlyMap<string, GatewayRetirementPayload>;
  headsSuperseded: boolean;
  actor: string;
}): Promise<{ retired: RetiredListing[]; obligations: VersionObligations[] }> {
  const locked = await db.query<{ runtime_commitment_hash: Buffer }>(
    `SELECT runtime_commitment_hash FROM provider_runtime_listing_versions
      WHERE gateway_origin=$1 AND service_id=$2 AND payment_required
        AND ($3::bytea[] IS NULL OR runtime_commitment_hash=ANY($3::bytea[]))
      ORDER BY id FOR UPDATE`,
    [args.gatewayOrigin, bytes(args.serviceId), args.listingManifestHashes?.map(bytes) ?? null],
  );
  const found = new Set(locked.rows.map((row) => `0x${row.runtime_commitment_hash.toString("hex")}`));
  for (const hash of args.listingManifestHashes ?? []) {
    if (!found.has(hash.toLowerCase())) throw new Error("listing version is not a paid version of this service");
  }
  const obligations = await loadVersionObligations(db, {
    gatewayOrigin: args.gatewayOrigin, serviceId: args.serviceId,
    listingManifestHashes: args.listingManifestHashes,
  });
  const blockers: Record<string, Record<string, number>> = {};
  for (const version of obligations.filter((item) => !item.retired)) {
    const open: Record<string, number> = openExecutionObligations(version);
    if (version.head && !args.headsSuperseded) open.currentHead = 1;
    if (!args.receipts.has(version.listingManifestHash)) open.gatewayEvidence = 1;
    if (Object.keys(open).length > 0) blockers[version.listingManifestHash] = open;
  }
  if (Object.keys(blockers).length > 0) throw new ListingRetirementBlockedError(blockers);
  const retired: RetiredListing[] = [];
  for (const version of obligations) {
    const receipt = args.receipts.get(version.listingManifestHash);
    if (version.retired) {
      retired.push({
        listingManifestHash: version.listingManifestHash, skillId: version.skillId,
        requestId: receipt?.requestId ?? "", alreadyRetired: true,
      });
      continue;
    }
    const updated = await db.query(
      `UPDATE provider_runtime_listing_versions
          SET superseded_at=COALESCE(superseded_at,now()),retired_at=now(),retirement=$2
        WHERE id=$1 AND retired_at IS NULL`,
      [version.versionId, JSON.stringify({ gatewayReceipt: receipt, retiredBy: args.actor })],
    );
    if (updated.rowCount !== 1) throw new Error("listing retirement lost its row lock");
    retired.push({
      listingManifestHash: version.listingManifestHash, skillId: version.skillId,
      requestId: receipt!.requestId, alreadyRetired: false,
    });
  }
  return { retired, obligations };
}

/**
 * Retire one superseded paid version: new dispatches of it are refused from
 * then on, while its orders stay readable and signed with its key.
 */
export async function retireListingVersion(args: {
  gatewayOrigin: string;
  listingManifestHash: Hex;
  receipt: unknown;
  providerAgentId: string;
  domain: RetirementReceiptDomain;
}): Promise<RetiredListing> {
  const hash = args.listingManifestHash.toLowerCase() as Hex;
  const version = (await pool.query<{ service_id: Buffer }>(
    `SELECT service_id FROM provider_runtime_listing_versions
      WHERE gateway_origin=$1 AND runtime_commitment_hash=$2 AND payment_required LIMIT 1`,
    [args.gatewayOrigin, bytes(hash)],
  )).rows[0];
  if (!version) throw new Error("exact paid listing version was not found");
  const serviceId = `0x${version.service_id.toString("hex")}` as Hex;
  // The one receipt must retire exactly this version.
  const payload = await verifyRetirementReceipt(args.receipt, {
    kind: "listing", providerAgentId: args.providerAgentId, serviceId, listingManifestHash: hash,
  }, args.domain);
  const receipts = new Map([[hash, payload]]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // The promotion lock first, then the version rows: the same order as
    // promotion and service retirement.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${args.gatewayOrigin}\n${serviceId}`]);
    const { retired } = await retireLockedListingVersions(client, {
      gatewayOrigin: args.gatewayOrigin, serviceId, listingManifestHashes: [hash],
      receipts, headsSuperseded: false, actor: "listing-retirement",
    });
    const result = retired[0]!;
    if (!result.alreadyRetired) {
      await recordMandatoryAudit(client, {
        source: "admin",
        type: "admin.listing.retired",
        actor: "listing-retirement",
        message: `Retired listing version ${hash} of ${result.skillId} from dispatch servicing.`,
        payload: { gatewayOrigin: args.gatewayOrigin, onChainServiceId: serviceId, listingManifestHash: hash },
      });
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
