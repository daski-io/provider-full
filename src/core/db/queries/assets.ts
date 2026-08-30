import { pool } from "../pool.js";
import type { Queryable } from "../queryable.js";
import { randomUUID } from "node:crypto";
import {
  decryptString,
  encryptString,
  protectedLookupHash,
  protectedLookupHashes,
  type EncryptionContext,
} from "../../chain/encryption.js";

// Provider-managed assets. Status reflects supplier state only; financial
// actions such as refunds do not mutate asset lifecycle state.

export type AssetStatus =
  | "active"
  | "suspended"
  | "expired"
  | "transferred_out"
  | "deleted";

/// The statuses under which an asset still "holds" its identifier (matches
/// the assets_live_unique partial-index predicate). A deleted, transferred-
/// out asset frees the identifier.
export const LIVE_ASSET_STATUSES: AssetStatus[] = [
  "active",
  "suspended",
  "expired",
];

export interface AssetRow {
  id: string;
  service_id: string;
  type: string;
  identifier: string;
  status: AssetStatus;
  metadata: Record<string, unknown>;
  created_at: Date;
  expires_at: Date | null;
}

interface StoredAssetRow extends AssetRow {
  identifier_hash: string;
}

// ── Protected asset identifiers ───────────────────────────────────────
// Some asset types carry PII in the identifier itself. The owning service
// registers a scheme and core
// encrypts on write / decrypts on read — core never names asset types
// itself. The context a scheme builds is the AAD binding for existing
// rows and must stay byte-stable forever.

export interface ProtectedAssetIdentifierScheme {
  /** Canonicalize before storage and lookup hashing (e.g. lowercase). */
  normalize?(identifier: string): string;
  /** Encryption context for one asset's identifier cell. */
  buildContext(assetId: string): EncryptionContext;
}

const protectedIdentifierSchemes = new Map<string, ProtectedAssetIdentifierScheme>();

export function registerProtectedAssetIdentifier(
  assetType: string,
  scheme: ProtectedAssetIdentifierScheme,
): void {
  const existing = protectedIdentifierSchemes.get(assetType);
  if (existing && existing !== scheme) {
    throw new Error(`Protected asset identifier already registered for type: ${assetType}`);
  }
  protectedIdentifierSchemes.set(assetType, scheme);
}

function normalizeIdentifier(type: string, identifier: string): string {
  const normalize = protectedIdentifierSchemes.get(type)?.normalize;
  return normalize ? normalize(identifier) : identifier;
}

function storedIdentifierColumns(
  type: string,
  assetId: string,
  normalizedIdentifier: string,
): { stored: string; hash: string } {
  const scheme = protectedIdentifierSchemes.get(type);
  if (!scheme) return { stored: normalizedIdentifier, hash: normalizedIdentifier };
  return {
    stored: encryptString(normalizedIdentifier, scheme.buildContext(assetId)),
    hash: protectedLookupHash(normalizedIdentifier, "asset-identifier"),
  };
}

/// Reveal a stored identifier fetched OUTSIDE the assets queries (e.g. a
/// batched admin join): protected identifiers are encrypted at rest.
export function revealAssetIdentifierValue(
  assetId: string,
  type: string,
  storedIdentifier: string,
): string {
  const scheme = protectedIdentifierSchemes.get(type);
  return scheme
    ? decryptString(storedIdentifier, scheme.buildContext(assetId))
    : storedIdentifier;
}

function revealAsset(row: StoredAssetRow): AssetRow {
  return {
    ...row,
    identifier: revealAssetIdentifierValue(row.id, row.type, row.identifier),
  };
}

function identifierCandidates(identifier: string): string[] {
  return [identifier, ...protectedLookupHashes(identifier.toLowerCase(), "asset-identifier")];
}

export async function getAssetById(
  id: string,
  db: Queryable = pool,
): Promise<AssetRow | null> {
  const result = await db.query(`SELECT * FROM assets WHERE id = $1`, [id]);
  const row = result.rows[0] as StoredAssetRow | undefined;
  return row ? revealAsset(row) : null;
}

export async function getAssetByIdForUpdate(
  id: string,
  db: Queryable,
): Promise<AssetRow | null> {
  const result = await db.query(
    `SELECT * FROM assets WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const row = result.rows[0] as StoredAssetRow | undefined;
  return row ? revealAsset(row) : null;
}

export async function getActiveAssetByIdentifier(
  serviceId: string,
  identifier: string,
): Promise<AssetRow | null> {
  const result = await pool.query(
    `SELECT * FROM assets
      WHERE service_id = $1 AND identifier_hash = ANY($2::text[]) AND status = 'active'`,
    [serviceId, identifierCandidates(identifier)],
  );
  const row = result.rows[0] as StoredAssetRow | undefined;
  return row ? revealAsset(row) : null;
}

/// Look up an asset holding this identifier in one of the given statuses.
/// Services whose skills operate on non-active assets (for example, renewing
/// an expired subscription during its grace window)
/// declare the statuses per skill via ServiceModule.assets.assetLookupStatuses;
/// the handlers default to ['active'].
///
/// Resolution is deterministic when history contains terminal duplicates:
/// live-statuses-first, then newest created_at. A historical terminal row
/// must never shadow a live asset with the same identifier.
export async function getAssetByIdentifierWithStatuses(
  serviceId: string,
  identifier: string,
  statuses: AssetStatus[],
  db: Queryable = pool,
): Promise<AssetRow | null> {
  const result = await db.query(
    `SELECT * FROM assets
      WHERE service_id = $1 AND identifier_hash = ANY($2::text[]) AND status = ANY($3::text[])
      ORDER BY CASE WHEN status = ANY($4::text[]) THEN 0 ELSE 1 END,
               created_at DESC
      LIMIT 1`,
    [serviceId, identifierCandidates(identifier), statuses, LIVE_ASSET_STATUSES],
  );
  const row = result.rows[0] as StoredAssetRow | undefined;
  return row ? revealAsset(row) : null;
}

export async function createAsset(args: {
  id?: string;
  service_id: string;
  type: string;
  identifier: string;
  status?: AssetStatus;
  metadata?: Record<string, unknown>;
  expires_at?: Date | null;
}, db: Queryable = pool): Promise<AssetRow> {
  const id = args.id ?? randomUUID();
  const normalizedIdentifier = normalizeIdentifier(args.type, args.identifier);
  const { stored: storedIdentifier, hash: identifierHash } =
    storedIdentifierColumns(args.type, id, normalizedIdentifier);
  const result = await db.query(
    `INSERT INTO assets (id, service_id, type, identifier, identifier_hash, status, metadata, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      id,
      args.service_id,
      args.type,
      storedIdentifier,
      identifierHash,
      args.status ?? "active",
      JSON.stringify(args.metadata ?? {}),
      args.expires_at ?? null,
    ],
  );
  return revealAsset(result.rows[0] as StoredAssetRow);
}

/// Update an asset's lifecycle status. Pass `expected` to make it a
/// compare-and-set (audit 3.8): lifecycle sweeps claim transitions
/// conditionally — e.g. active→expired only while STILL active AND still
/// past expiry — so a concurrent renewal wins instead of being expired
/// out from under the buyer. Returns null when the claim was lost.
export async function setAssetStatus(
  id: string,
  status: AssetStatus,
  expected?: {
    status?: AssetStatus;
    /** Require expires_at <= now() at claim time (expiry sweeps). */
    expiredNow?: boolean;
  },
): Promise<AssetRow | null> {
  const result = await pool.query(
    `UPDATE assets
        SET status = $2
      WHERE id = $1
        AND ($3::text IS NULL OR status = $3)
        AND ($4::boolean IS NOT TRUE OR (expires_at IS NOT NULL AND expires_at <= now()))
      RETURNING *`,
    [id, status, expected?.status ?? null, expected?.expiredNow === true],
  );
  const row = result.rows[0] as StoredAssetRow | undefined;
  return row ? revealAsset(row) : null;
}

/// Merge an object into assets.metadata using JSONB || (shallow, per top-
/// level key — mirrors mergeTransactionMetadata). Used for reminder marks,
/// renewal entitlements, suspension bookkeeping (suspendedReason /
/// priorStatus), contact-repair flags, etc. A key set to JSON null is
/// stored as null (callers treat null as "cleared").
export async function mergeAssetMetadata(
  id: string,
  patch: Record<string, unknown>,
  db: Queryable = pool,
): Promise<AssetRow | null> {
  const result = await db.query(
    `UPDATE assets SET metadata = metadata || $2::jsonb WHERE id = $1 RETURNING *`,
    [id, JSON.stringify(patch)],
  );
  const row = result.rows[0] as StoredAssetRow | undefined;
  return row ? revealAsset(row) : null;
}

/// Update an existing asset identifier. The caller has already pre-checked collisions;
/// assets_live_unique is the backstop.
export async function updateAssetIdentifier(
  id: string,
  identifier: string,
  db: Queryable = pool,
): Promise<AssetRow | null> {
  const current = await getAssetById(id, db);
  if (!current) return null;
  const normalized = normalizeIdentifier(current.type, identifier);
  const { stored, hash: identifierHash } =
    storedIdentifierColumns(current.type, id, normalized);
  const result = await db.query(
    `UPDATE assets SET identifier = $2, identifier_hash = $3 WHERE id = $1 RETURNING *`,
    [id, stored, identifierHash],
  );
  const row = result.rows[0] as StoredAssetRow | undefined;
  return row ? revealAsset(row) : null;
}

/// All assets for a service in the given statuses (sweep target). Unlike
/// listAssets this has no pagination — sweeps walk the full set.
export async function listAssetsByStatuses(
  serviceId: string,
  statuses: AssetStatus[],
  type?: string,
): Promise<AssetRow[]> {
  const params: unknown[] = [serviceId, statuses];
  let sql = `SELECT * FROM assets WHERE service_id = $1 AND status = ANY($2::text[])`;
  if (type !== undefined) {
    params.push(type);
    sql += ` AND type = $${params.length}`;
  }
  const result = await pool.query(sql + ` ORDER BY created_at`, params);
  return (result.rows as StoredAssetRow[]).map(revealAsset);
}

export async function listAssets(args: {
  serviceId?: string;
  status?: AssetStatus;
  limit?: number;
  offset?: number;
} = {}): Promise<AssetRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (args.serviceId !== undefined) {
    params.push(args.serviceId);
    where.push(`service_id = $${params.length}`);
  }
  if (args.status !== undefined) {
    params.push(args.status);
    where.push(`status = $${params.length}`);
  }
  params.push(args.limit ?? 100, args.offset ?? 0);
  const sql =
    `SELECT * FROM assets` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
  const result = await pool.query(sql, params);
  return (result.rows as StoredAssetRow[]).map(revealAsset);
}

export async function countActiveAssetsByService(serviceId: string): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS n FROM assets WHERE service_id = $1 AND status = 'active'`,
    [serviceId],
  );
  return (result.rows[0] as { n: number }).n;
}

/// Total assets for a service, any status — accurate header counts for
/// the admin service detail page (audit 4.7: the header used to count a
/// list capped at 100).
export async function countAssetsByService(serviceId: string): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS n FROM assets WHERE service_id = $1`,
    [serviceId],
  );
  return (result.rows[0] as { n: number }).n;
}
