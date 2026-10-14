import { pool } from "../pool.js";
import type { Queryable } from "../queryable.js";
import { revealAssetIdentifierValue } from "./assets.js";

// The single asset-ownership authority. An asset_owner_overrides row (core
// migration 012) is authoritative when present; otherwise the owner is the
// payer of the most recent standard order linked to the asset, at version 0.
// Every ownership read in core and in installed services goes through these
// exports, and the architecture gate refuses any other derivation of an
// owner from transactions.standard_payer. A request body, an order id or a
// cached owner field is never a second source of ownership.

export interface AssetOwner {
  /** Lowercase payer wallet. */
  payer: string;
  /** 0 while derived; the override's version once an owner change committed. */
  version: number;
}

const SQL_COLUMN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/;

function column(value: string): string {
  if (!SQL_COLUMN.test(value)) throw new Error("asset owner SQL must reference a column");
  return value;
}

/** SQL scalar yielding the current lowercase owner of the asset `assetIdColumn` names. */
export function currentAssetOwnerSql(assetIdColumn: string): string {
  const id = column(assetIdColumn);
  return `COALESCE(
    (SELECT aoo.payer FROM asset_owner_overrides aoo WHERE aoo.asset_id = ${id}),
    (SELECT lower(owner_tx.standard_payer)
       FROM transactions owner_tx
      WHERE owner_tx.asset_id = ${id}
        AND owner_tx.standard_order_id IS NOT NULL
        AND owner_tx.standard_payer IS NOT NULL
      ORDER BY owner_tx.created_at DESC, owner_tx.id DESC
      LIMIT 1))`;
}

/** SQL scalar yielding the current owner version (0 while derived). */
export function currentAssetOwnerVersionSql(assetIdColumn: string): string {
  const id = column(assetIdColumn);
  return `COALESCE((SELECT aoo.version FROM asset_owner_overrides aoo WHERE aoo.asset_id = ${id}), 0)`;
}

/** The current owner and version of an asset, or null when no standard payer ever owned it. */
export async function getCurrentAssetOwner(
  assetId: string,
  db: Queryable = pool,
): Promise<AssetOwner | null> {
  const result = await db.query<{ payer: string | null; version: number | string }>(
    `SELECT ${currentAssetOwnerSql("a.id")} AS payer,
            ${currentAssetOwnerVersionSql("a.id")} AS version
       FROM assets a
      WHERE a.id = $1::uuid`,
    [assetId],
  );
  const row = result.rows[0];
  if (!row?.payer) return null;
  return { payer: row.payer.toLowerCase(), version: Number(row.version) };
}

export async function assetOwnedBy(
  assetId: string,
  payer: string,
  db: Queryable = pool,
): Promise<boolean> {
  const owner = await getCurrentAssetOwner(assetId, db);
  return owner !== null && owner.payer === payer.toLowerCase();
}

export interface StandardPayerAssetRow {
  id: string;
  service_id: string;
  service_slug: string;
  type: string;
  identifier: string;
  status: string;
  created_at: Date;
  created_at_cursor: string;
  expires_at: Date | null;
}

interface StoredStandardPayerAssetRow extends StandardPayerAssetRow {
  has_more: boolean;
}

const PAYER_ASSET_COLUMNS = `a.id, a.service_id, s.slug AS service_slug, a.type, a.identifier, a.status,
            a.created_at, a.created_at::text AS created_at_cursor, a.expires_at`;

function revealed(row: StoredStandardPayerAssetRow): StandardPayerAssetRow {
  return {
    id: row.id,
    service_id: row.service_id,
    service_slug: row.service_slug,
    type: row.type,
    identifier: revealAssetIdentifierValue(row.id, row.type, row.identifier),
    status: row.status,
    created_at: row.created_at,
    created_at_cursor: row.created_at_cursor,
    expires_at: row.expires_at,
  };
}

export async function listAssetsForStandardPayer(args: {
  payer: string;
  limit: number;
  after?: { createdAt: string; id: string };
}): Promise<{ assets: StandardPayerAssetRow[]; hasMore: boolean }> {
  const result = await pool.query<StoredStandardPayerAssetRow>(
    `SELECT ${PAYER_ASSET_COLUMNS}, count(*) OVER () > $2 AS has_more
       FROM assets a
       JOIN services s ON s.id = a.service_id
      WHERE ${currentAssetOwnerSql("a.id")} = lower($1)
        AND ($3::timestamptz IS NULL OR (a.created_at, a.id) < ($3, $4::uuid))
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $2`,
    [args.payer, args.limit + 1, args.after?.createdAt ?? null, args.after?.id ?? null],
  );
  return {
    assets: result.rows.slice(0, args.limit).map(revealed),
    hasMore: result.rows.length > args.limit,
  };
}

export async function getStandardPayerAsset(args: {
  payer: string;
  providerAssetId: string;
}): Promise<StandardPayerAssetRow | null> {
  const result = await pool.query<StoredStandardPayerAssetRow>(
    `SELECT ${PAYER_ASSET_COLUMNS}, false AS has_more
       FROM assets a
       JOIN services s ON s.id = a.service_id
      WHERE a.id = $1::uuid AND ${currentAssetOwnerSql("a.id")} = lower($2)`,
    [args.providerAssetId, args.payer],
  );
  const row = result.rows[0];
  return row ? revealed(row) : null;
}
