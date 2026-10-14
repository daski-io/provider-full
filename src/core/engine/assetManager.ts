import {
  createAsset,
  getActiveAssetByIdentifier,
  getAssetByIdentifierWithStatuses,
  type AssetRow,
  type AssetStatus,
} from "../db/queries/assets.js";
import { setTransactionAsset } from "../db/queries/transactions.js";
import { assetOwnedBy } from "../db/queries/assetOwnership.js";
import { pool } from "../db/pool.js";
import type { Queryable } from "../db/queryable.js";

// Asset lifecycle helpers. The `assets` table is per service; ownership is
// resolved only through src/core/db/queries/assetOwnership.ts (an owner
// override when one committed, else the most recent standard order linked
// to the asset).
//
// Gateway-managed actions pass the verified standard payer wallet. A
// point-in-time ownership answer authorizes nothing by itself: owner-only
// work is admitted under the asset owner fence (standardRail/assetOwnerFence.ts).

export async function verifyStandardAssetOwnership(
  payer: string,
  assetIdentifier: string,
  serviceId: string,
  statuses?: AssetStatus[],
): Promise<{ authorized: boolean; asset?: AssetRow }> {
  const asset = statuses && statuses.length > 0
    ? await getAssetByIdentifierWithStatuses(serviceId, assetIdentifier, statuses)
    : await getActiveAssetByIdentifier(serviceId, assetIdentifier);
  if (!asset) return { authorized: false };
  return await assetOwnedBy(asset.id, payer)
    ? { authorized: true, asset }
    : { authorized: false };
}

/// Persist a FIRST-TIME asset from an AdapterResult.asset block. This is
/// INSERT-only by design: assets_live_unique guarantees one live row per
/// (service_id, identifier), and creation is the only flow that may mint
/// one. Skills that operate on an existing asset must update it in place
/// (updateAssetExpiryDate / setAssetStatus) and omit the asset block —
/// see the AdapterResult.asset doc comment.
///
/// Pass `db` to make the asset row and its transaction link commit inside
/// the caller's transaction (task finalization does this so a completed
/// task can never be observed without its deliverable asset).
export async function storeAsset(data: {
  transactionId: string;
  serviceId: string;
  type: string;
  identifier: string;
  metadata: Record<string, unknown>;
  expiresAt?: Date;
}, db: Queryable = pool): Promise<AssetRow> {
  const asset = await createAsset({
    service_id: data.serviceId,
    type: data.type,
    identifier: data.identifier,
    metadata: data.metadata,
    expires_at: data.expiresAt ?? null,
  }, db);
  // Wire the asset back to the transaction that created it.
  await setTransactionAsset(data.transactionId, asset.id, db);
  return asset;
}

export async function updateAssetExpiryDate(
  assetId: string,
  expiresAt: Date,
): Promise<AssetRow | null> {
  const result = await pool.query(
    `UPDATE assets SET expires_at = $2 WHERE id = $1 RETURNING *`,
    [assetId, expiresAt],
  );
  return (result.rows[0] as AssetRow | undefined) ?? null;
}

/// Atomically extend an asset term and perform an optional lifecycle
/// transition. The expected-status predicate prevents a renewal from
/// overwriting a concurrent suspension or terminal transition.
export async function extendAssetExpiry(
  assetId: string,
  interval: string,
  transition: { expectedStatus: AssetStatus; nextStatus: AssetStatus },
): Promise<AssetRow | null> {
  if (!/^\d+ (month|months|year|years|day|days)$/.test(interval)) {
    throw new Error(`extendAssetExpiry: unsupported interval '${interval}'`);
  }
  const result = await pool.query(
    `UPDATE assets
        SET expires_at = GREATEST(COALESCE(expires_at, now()), now()) + $2::interval,
            status = $3
      WHERE id = $1 AND status = $4
      RETURNING *`,
    [assetId, interval, transition.nextStatus, transition.expectedStatus],
  );
  return (result.rows[0] as AssetRow | undefined) ?? null;
}
