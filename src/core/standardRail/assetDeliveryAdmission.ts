import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { getCurrentAssetOwner, type AssetOwner } from "../db/queries/assetOwnership.js";
import { inTransaction, type Queryable } from "../db/queryable.js";
import { OutboundEmailError, OutboundSendRefusedError } from "../email/postmarkOutcome.js";
import { logWarn } from "../logger.js";
import { admitAssetOwner, lockAssetOwnerFence } from "./assetOwnerFence.js";

// Delivering information about an asset to its owner (an email, a protected
// document, a notice) is owner-only work. Core delivers none itself; a
// service that does must use this sequence (core migration 013):
//
//   1. admit the delivery in a short transaction under the asset owner fence
//      for the owner it addresses, recording that owner's version, with any
//      recipient resolution done through the same connection;
//   2. send outside every lock, with only bounded outbound work after
//      `beforeSend`;
//   3. `beforeSend` renews the admission under the fence immediately before
//      the outbound call and refuses, explicitly and terminally, when the
//      admission was revoked or finished or the owner or its version
//      changed; an infrastructure failure there is not a refusal, and the
//      send stays retryable and validates again on its next attempt;
//   4. close the admission with the attempt's outcome.
//
// An owner change a fork adds must count a live admission as active work
// and revoke every open admission of the asset in its own fenced
// transaction (countLiveAssetDeliveryAdmissions, revokeAssetDeliveryAdmissions).

/**
 * An open admission is live work for an owner change for this long after its
 * last renewal. Only the bounded outbound call follows a renewal, and an
 * outbound call is bounded far below it (OUTBOUND_TOTAL_TIMEOUT_MS <= 120 s).
 */
export const ASSET_DELIVERY_ADMISSION_BOUND_SECONDS = 600;

const PURPOSE = /^[a-z][a-z0-9_.:-]{0,95}$/;

/** The sender's explicit, terminal refusal: this delivery must not leave. */
export class AssetDeliveryRefusedError extends OutboundSendRefusedError {
  constructor(detail: string) {
    super(`asset delivery refused: ${detail}`);
    this.name = "AssetDeliveryRefusedError";
  }
}

export interface AssetDeliveryAdmission {
  id: string;
  assetId: string;
  owner: AssetOwner;
}

export type AssetDeliveryOutcome = "delivered" | "refused" | "failed";

/**
 * Admit one delivery under the asset owner fence. The asset must have a
 * current owner and `owner`, when given, must be that owner. `prepare` runs
 * before the fence is released and may only do database work through the
 * fenced connection it receives, such as resolving the owner's recipient.
 */
export async function admitAssetDelivery<T = undefined>(args: {
  assetId: string;
  purpose: string;
  owner?: string;
  prepare?: (db: Queryable, owner: AssetOwner) => Promise<T>;
}): Promise<{ admission: AssetDeliveryAdmission; prepared: T | undefined }> {
  if (!PURPOSE.test(args.purpose)) throw new Error("asset delivery purpose is invalid");
  return inTransaction(pool, async (db) => {
    const owner = await admitAssetOwner(db, args.assetId, args.owner);
    const prepared = await args.prepare?.(db, owner);
    const id = randomUUID();
    // Statement times taken once the fence is held: the bound counts from
    // here, not from a transaction start that may have waited on the fence.
    await db.query(
      `INSERT INTO asset_delivery_admissions
         (id,asset_id,purpose,admitted_owner,admitted_owner_version,admitted_at,renewed_at)
       VALUES ($1,$2,$3,$4,$5,clock_timestamp(),clock_timestamp())`,
      [id, args.assetId, args.purpose, owner.payer, owner.version],
    );
    return { admission: { id, assetId: args.assetId, owner }, prepared };
  });
}

/**
 * The last check before the outbound call, as a `beforeSend` hook. Under the
 * fence the admission is renewed only while it is open and unrevoked and the
 * asset's owner and version are still the admitted ones; otherwise it throws
 * AssetDeliveryRefusedError. An owner change that already committed is seen
 * here; one that has not waits on the fence and then finds a fresh, live
 * admission, so it refuses.
 */
export async function renewAssetDeliveryAdmission(admission: AssetDeliveryAdmission): Promise<void> {
  await inTransaction(pool, async (db) => {
    await lockAssetOwnerFence(db, admission.assetId);
    const renewed = (await db.query<{ admitted_owner: string; admitted_owner_version: number }>(
      `UPDATE asset_delivery_admissions SET renewed_at=clock_timestamp()
        WHERE id=$1 AND asset_id=$2 AND finished_at IS NULL AND revoked_at IS NULL
        RETURNING admitted_owner,admitted_owner_version`,
      [admission.id, admission.assetId],
    )).rows[0];
    if (!renewed) throw new AssetDeliveryRefusedError("the admission was revoked or has finished");
    const owner = await getCurrentAssetOwner(admission.assetId, db);
    if (!owner || owner.payer !== renewed.admitted_owner || owner.version !== Number(renewed.admitted_owner_version)) {
      throw new AssetDeliveryRefusedError("the asset's owner changed after the delivery was admitted");
    }
  });
}

/** Close an admission once its attempt is over; a revoked admission keeps its revocation. */
export async function finishAssetDeliveryAdmission(
  admission: AssetDeliveryAdmission,
  outcome: AssetDeliveryOutcome,
): Promise<void> {
  await pool.query(
    "UPDATE asset_delivery_admissions SET finished_at=now(),outcome=$2 WHERE id=$1 AND finished_at IS NULL",
    [admission.id, outcome],
  );
}

function isRefusal(error: unknown): boolean {
  return error instanceof OutboundSendRefusedError ||
    (error instanceof OutboundEmailError && error.outcome === "skipped");
}

/**
 * Deliver asset information to its owner: admit, run `send` outside every
 * lock with the renewal as its `beforeSend`, and close the admission with
 * the attempt's outcome. A stale owner is refused before anything is sent.
 */
export async function deliverAssetInformation<T, R>(args: {
  assetId: string;
  purpose: string;
  owner?: string;
  prepare?: (db: Queryable, owner: AssetOwner) => Promise<T>;
  send: (delivery: {
    owner: AssetOwner;
    prepared: T | undefined;
    beforeSend: () => Promise<void>;
  }) => Promise<R>;
}): Promise<R> {
  const { admission, prepared } = await admitAssetDelivery(args);
  let outcome: AssetDeliveryOutcome = "failed";
  try {
    const sent = await args.send({
      owner: admission.owner,
      prepared,
      beforeSend: () => renewAssetDeliveryAdmission(admission),
    });
    outcome = "delivered";
    return sent;
  } catch (error) {
    if (isRefusal(error)) outcome = "refused";
    throw error;
  } finally {
    // An admission left open ages out of the live window after the bound.
    await finishAssetDeliveryAdmission(admission, outcome).catch((error: unknown) => {
      logWarn("Asset delivery admission could not be closed", {
        errorClass: error instanceof Error ? error.name : "UnknownError",
      });
    });
  }
}

/**
 * Open, unrevoked admissions renewed within the bound: active work an owner
 * change must refuse. Takes the fence in the caller's transaction.
 */
export async function countLiveAssetDeliveryAdmissions(db: Queryable, assetId: string): Promise<number> {
  await lockAssetOwnerFence(db, assetId);
  const result = await db.query<{ live: number }>(
    `SELECT count(*)::int AS live FROM asset_delivery_admissions
      WHERE asset_id=$1 AND finished_at IS NULL AND revoked_at IS NULL
        AND renewed_at > clock_timestamp() - make_interval(secs => $2)`,
    [assetId, ASSET_DELIVERY_ADMISSION_BOUND_SECONDS],
  );
  return result.rows[0]?.live ?? 0;
}

/**
 * Revoke every open admission of an asset, from an owner change's own
 * transaction. Takes the fence in that transaction.
 */
export async function revokeAssetDeliveryAdmissions(db: Queryable, assetId: string): Promise<number> {
  await lockAssetOwnerFence(db, assetId);
  const result = await db.query(
    `UPDATE asset_delivery_admissions SET revoked_at=clock_timestamp()
      WHERE asset_id=$1 AND finished_at IS NULL AND revoked_at IS NULL`,
    [assetId],
  );
  return result.rowCount ?? 0;
}
