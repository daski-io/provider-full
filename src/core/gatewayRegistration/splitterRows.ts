import type { Hex } from "viem";
import { pool } from "../db/pool.js";
import { inTransaction, type Queryable } from "../db/queryable.js";
import type { PreparedProviderWrite } from "../chain/providerWriteCoordinator.js";
import type { RegistrationRef } from "./store.js";
import type { GatewayRegistrationView } from "./types.js";

// The durable splitter rows of a gateway registration: one per deployment
// its preparation requires, each claimed by exactly one journaled write.

export interface GatewaySplitterWriteRow {
  listing_id: string;
  gateway_registration_local_id: string;
  expected_splitter_address: string;
  canonical_transaction: Record<string, unknown>;
  provider_write_id: string | null;
  transaction_hash: Hex | null;
  state: "PREPARED" | "BROADCAST" | "CONFIRMED" | "REVERTED" | "ATTENTION";
  last_error_code: string | null;
  created_at: Date;
  updated_at: Date;
}

// One durable row per splitter the preparation requires, claimed later by
// exactly one journaled deployment. Rows another registration owns, or that
// a deployment already claimed, are left alone.
export async function recordSplitterPreparations(
  db: Queryable,
  localId: string,
  view: GatewayRegistrationView,
): Promise<void> {
  for (const listing of view.prepared.listings) {
    if (!listing.deploymentRequired || !listing.transaction || !listing.splitterAddress) {
      continue;
    }
    await db.query(
      `INSERT INTO provider_gateway_splitter_writes
        (listing_id,gateway_registration_local_id,expected_splitter_address,
         canonical_transaction,state)
       VALUES ($1,$2,$3,$4,'PREPARED')
       ON CONFLICT (listing_id) DO UPDATE SET
         expected_splitter_address=EXCLUDED.expected_splitter_address,
         canonical_transaction=EXCLUDED.canonical_transaction,
         updated_at=now()
       WHERE provider_gateway_splitter_writes.gateway_registration_local_id=$2
         AND provider_gateway_splitter_writes.provider_write_id IS NULL`,
      [
        listing.listingId,
        localId,
        listing.splitterAddress.toLowerCase(),
        listing.transaction,
      ],
    );
  }
}

/**
 * Restore missing splitter rows of a persisted preparation before its
 * splitters are deployed or confirmed. Records saved before the preparation
 * and its rows were one transaction can lack some.
 */
export async function ensureSplitterPreparations(
  ref: RegistrationRef,
  view: GatewayRegistrationView,
): Promise<void> {
  await inTransaction(pool, async (db) => {
    const fenced = await db.query(
      `SELECT 1 FROM provider_gateway_registrations
        WHERE id=$1 AND idempotency_key=$2 AND gateway_registration_id=$3
        FOR SHARE`,
      [ref.id, ref.idempotency_key, view.registrationId],
    );
    if (fenced.rowCount !== 1) {
      throw new Error("the gateway registration record changed during recovery");
    }
    await recordSplitterPreparations(db, ref.id, view);
  });
}

export async function listGatewaySplitterWrites(
  localId: string,
): Promise<GatewaySplitterWriteRow[]> {
  const result = await pool.query<GatewaySplitterWriteRow>(
    `SELECT * FROM provider_gateway_splitter_writes
      WHERE gateway_registration_local_id=$1 ORDER BY listing_id`,
    [localId],
  );
  return result.rows;
}

/**
 * Bind a journaled splitter deployment to its listing inside the journal's
 * transaction. The registration row is share-locked under its intent, so a
 * run whose intent was replaced never persists or broadcasts a deployment.
 */
export async function claimSplitterProviderWrite(
  ref: RegistrationRef,
  listingId: string,
  prepared: PreparedProviderWrite,
  db: Queryable,
): Promise<boolean> {
  const fenced = await db.query(
    `SELECT 1 FROM provider_gateway_registrations
      WHERE id=$1 AND idempotency_key=$2 FOR SHARE`,
    [ref.id, ref.idempotency_key],
  );
  if (fenced.rowCount !== 1) return false;
  const result = await db.query(
    `UPDATE provider_gateway_splitter_writes
        SET provider_write_id=$2,transaction_hash=$3,state='BROADCAST',
            last_error_code=NULL,updated_at=now()
      WHERE listing_id=$1 AND gateway_registration_local_id=$4
        AND provider_write_id IS NULL`,
    [listingId, prepared.id, prepared.hash.toLowerCase(), ref.id],
  );
  return result.rowCount === 1;
}

/**
 * Free a listing's claim on a journaled deployment that can never be mined
 * because another transaction took its nonce, so a fresh deployment can be
 * journaled. A compare-and-set on the claimed write.
 */
export async function releaseSplitterClaim(
  ref: RegistrationRef,
  listingId: string,
  providerWriteId: string,
): Promise<void> {
  const result = await pool.query(
    `UPDATE provider_gateway_splitter_writes
        SET provider_write_id=NULL,transaction_hash=NULL,state='PREPARED',
            last_error_code='nonce_consumed',updated_at=now()
      WHERE listing_id=$1 AND provider_write_id=$2 AND gateway_registration_local_id=$3`,
    [listingId, providerWriteId, ref.id],
  );
  if (result.rowCount !== 1) throw new Error("splitter write persistence claim was lost");
}

export async function confirmSplitterWrite(
  listingId: string,
  providerWriteId: string,
): Promise<void> {
  const result = await pool.query(
    `UPDATE provider_gateway_splitter_writes
        SET state='CONFIRMED',last_error_code=NULL,updated_at=now()
      WHERE listing_id=$1 AND provider_write_id=$2`,
    [listingId, providerWriteId],
  );
  if (result.rowCount !== 1) throw new Error("splitter write persistence claim was lost");
}
