import { pool } from "../db/pool.js";
import { getCurrentAssetOwner, type AssetOwner } from "../db/queries/assetOwnership.js";
import { inTransaction, type Queryable } from "../db/queryable.js";

// The per-asset owner fence. Every transition that initiates or resumes
// owner-only work, every persistence or release of its result, every
// delivery admission, and any owner change a fork adds serialize on
// pg_advisory_xact_lock(hashtextextended('asset-owner:' || asset_id, 0))
// and compare the owner they were admitted under with the current one.
//
// Lock order: a request's own advisory lock and endpoint rate buckets, then
// this fence, then the execution row, then its transaction row. A fence
// holder uses only its own connection and never waits on a network call.

/** The owner a unit of owner-only work was admitted under. */
export interface AdmittedOwner {
  payer: string;
  version: number;
}

/**
 * The work, result or delivery belongs to an owner version that is no
 * longer current (or to a wallet that is not the current owner). Nothing is
 * persisted or released for it; callers answer it as a refusal.
 */
export class AssetOwnerChangedError extends Error {
  readonly code = "ASSET_OWNER_CHANGED";

  constructor(detail = "the admitted owner version is stale") {
    super(`asset owner changed: ${detail}`);
    this.name = "AssetOwnerChangedError";
  }
}

export async function lockAssetOwnerFence(db: Queryable, assetId: string): Promise<void> {
  await db.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('asset-owner:' || $1::text, 0))",
    [assetId],
  );
}

/**
 * Take the fence inside the caller's transaction and return the owner the
 * work is admitted under. `expectedPayer`, when given, must be that owner.
 */
export async function admitAssetOwner(
  db: Queryable,
  assetId: string,
  expectedPayer?: string,
): Promise<AssetOwner> {
  await lockAssetOwnerFence(db, assetId);
  const owner = await getCurrentAssetOwner(assetId, db);
  if (!owner) throw new AssetOwnerChangedError("the asset has no current owner");
  if (expectedPayer !== undefined && owner.payer !== expectedPayer.toLowerCase()) {
    throw new AssetOwnerChangedError("the wallet is not the asset's current owner");
  }
  return owner;
}

/**
 * The owner a row was admitted under. Every admission records one, so a
 * missing value is a broken row, never version 0.
 */
export function admittedOwnerOf(row: {
  admitted_owner: string | null;
  admitted_owner_version: number | string | null;
}): AdmittedOwner {
  if (!row.admitted_owner || row.admitted_owner_version === null || row.admitted_owner_version === undefined) {
    throw new Error("owner-only work lacks its admitted owner");
  }
  return { payer: row.admitted_owner.toLowerCase(), version: Number(row.admitted_owner_version) };
}

/** Under the fence, in the caller's transaction: the admitted owner must still be the current one. */
export async function assertAdmittedOwnerCurrent(
  db: Queryable,
  assetId: string,
  admitted: AdmittedOwner,
): Promise<AssetOwner> {
  await lockAssetOwnerFence(db, assetId);
  const owner = await getCurrentAssetOwner(assetId, db);
  if (!owner) throw new AssetOwnerChangedError("the asset has no current owner");
  if (owner.version !== admitted.version || owner.payer !== admitted.payer.toLowerCase()) {
    throw new AssetOwnerChangedError();
  }
  return owner;
}

/**
 * Release a deliverable at a result boundary: the fence is taken, the
 * admitted owner compared, and `release` (loading a stored result through
 * the same connection and signing the response) runs before the transaction
 * commits, so an owner change cannot commit between the check and the
 * signature. What the fence protects is the signing, which is the
 * provider's release; a stale owner gets nothing loaded or signed.
 */
export async function releaseUnderOwnerFence<T>(args: {
  assetId: string;
  admitted: AdmittedOwner;
  release: (db: Queryable) => Promise<T>;
}): Promise<T> {
  return inTransaction(pool, async (db) => {
    await assertAdmittedOwnerCurrent(db, args.assetId, args.admitted);
    return args.release(db);
  });
}
