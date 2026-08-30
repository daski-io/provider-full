import type { Hex } from "viem";
import { pool } from "../pool.js";
import type { Queryable } from "../queryable.js";

export type ProviderWritePurpose =
  | "service_registration"
  | "service_uri_update"
  | "standard_reputation_outcome"
  | "splitter_deployment";

export type ProviderWriteStatus =
  | "prepared"
  | "broadcast"
  | "confirmed"
  | "reverted"
  | "replaced"
  | "attention";

export interface ProviderChainWriteRow {
  id: string;
  chain_id: string;
  wallet_address: string;
  nonce: string;
  purpose: ProviderWritePurpose;
  target_type: string;
  target_id: string;
  intent_hash: Hex;
  transaction_hash: Hex;
  signed_tx_encrypted: string | null;
  status: ProviderWriteStatus;
  supersedes_write_id: string | null;
  replacement_write_id: string | null;
  fee_bump_count: number;
  broadcast_at: Date | null;
  confirmed_at: Date | null;
  signed_tx_purged_at: Date | null;
  last_error_code: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ProviderWriteScope {
  chainId: number;
  walletAddress: string;
}

export async function suggestedProviderNonce(
  scope: ProviderWriteScope,
  networkPending: bigint,
  networkFinalized: bigint,
): Promise<bigint> {
  const wallet = scope.walletAddress.toLowerCase();
  const result = await pool.query<{ cursor: string | null; local_max: string | null }>(
    `SELECT
       (SELECT next_nonce::text
          FROM provider_signer_cursors
         WHERE chain_id = $1 AND wallet_address = $2) AS cursor,
       (SELECT MAX(nonce)::text
          FROM provider_chain_writes
         WHERE chain_id = $1 AND wallet_address = $2) AS local_max`,
    [scope.chainId, wallet],
  );
  const row = result.rows[0];
  const cursor = row?.cursor ? BigInt(row.cursor) : 0n;
  const afterLocal = row?.local_max ? BigInt(row.local_max) + 1n : 0n;
  // Coerce before comparing: `>` happily compares a bigint with a number, but
  // reduce returns the winning value with its ORIGINAL type, so one number in
  // the list silently yields a number nonce that explodes on the next `+ 1n`.
  return [cursor, afterLocal, networkPending, networkFinalized]
    .reduce<bigint>((highest, value) => {
      const candidate = BigInt(value);
      return candidate > highest ? candidate : highest;
    }, 0n);
}

export async function insertProviderWrite(
  row: Omit<
    ProviderChainWriteRow,
    "chain_id" | "nonce" | "status" | "supersedes_write_id"
    | "replacement_write_id" | "fee_bump_count" | "broadcast_at"
    | "confirmed_at" | "signed_tx_purged_at" | "last_error_code"
    | "created_at" | "updated_at"
  > & {
    chainId: number;
    nonce: bigint;
    status?: ProviderWriteStatus;
    supersedesWriteId?: string | null;
    feeBumpCount?: number;
  },
  db: Queryable,
): Promise<ProviderChainWriteRow> {
  const result = await db.query<ProviderChainWriteRow>(
    `INSERT INTO provider_chain_writes
       (id, chain_id, wallet_address, nonce, purpose, target_type, target_id,
        intent_hash, transaction_hash, signed_tx_encrypted, status,
        supersedes_write_id, fee_bump_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [
      row.id,
      row.chainId,
      row.wallet_address.toLowerCase(),
      row.nonce.toString(),
      row.purpose,
      row.target_type,
      row.target_id,
      row.intent_hash.toLowerCase(),
      row.transaction_hash.toLowerCase(),
      row.signed_tx_encrypted,
      row.status ?? "prepared",
      row.supersedesWriteId ?? null,
      row.feeBumpCount ?? 0,
    ],
  );
  return result.rows[0]!;
}

export async function advanceProviderCursor(
  scope: ProviderWriteScope,
  usedNonce: bigint,
  db: Queryable,
): Promise<void> {
  await db.query(
    `INSERT INTO provider_signer_cursors
       (chain_id, wallet_address, next_nonce)
     VALUES ($1,$2,$3)
     ON CONFLICT (chain_id, wallet_address) DO UPDATE
       SET next_nonce = GREATEST(provider_signer_cursors.next_nonce, EXCLUDED.next_nonce),
           updated_at = now()`,
    [scope.chainId, scope.walletAddress.toLowerCase(), (usedNonce + 1n).toString()],
  );
}

export async function getProviderWrite(
  id: string,
  db: Queryable = pool,
): Promise<ProviderChainWriteRow | null> {
  const result = await db.query<ProviderChainWriteRow>(
    "SELECT * FROM provider_chain_writes WHERE id = $1",
    [id],
  );
  return result.rows[0] ?? null;
}

export async function getCurrentWriteAtNonce(
  scope: ProviderWriteScope,
  nonce: bigint,
  excludeId?: string,
): Promise<ProviderChainWriteRow | null> {
  const result = await pool.query<ProviderChainWriteRow>(
    `SELECT * FROM provider_chain_writes
      WHERE chain_id = $1 AND wallet_address = $2 AND nonce = $3
        AND status <> 'replaced'
        AND ($4::uuid IS NULL OR id <> $4)
      ORDER BY created_at DESC LIMIT 1`,
    [scope.chainId, scope.walletAddress.toLowerCase(), nonce.toString(), excludeId ?? null],
  );
  return result.rows[0] ?? null;
}

export async function updateProviderWriteStatus(
  id: string,
  status: ProviderWriteStatus,
  options: {
    errorCode?: string | null;
    replacementWriteId?: string | null;
  } = {},
  db: Queryable = pool,
): Promise<void> {
  await db.query(
    `UPDATE provider_chain_writes
        SET status = $2,
            broadcast_at = CASE
              WHEN $2 = 'broadcast' THEN COALESCE(broadcast_at, now())
              ELSE broadcast_at
            END,
            confirmed_at = CASE
              WHEN $2 = 'confirmed' THEN COALESCE(confirmed_at, now())
              ELSE confirmed_at
            END,
            last_error_code = $3,
            replacement_write_id = COALESCE($4, replacement_write_id),
            updated_at = now()
      WHERE id = $1`,
    [id, status, options.errorCode ?? null, options.replacementWriteId ?? null],
  );
}

export async function getBlockingProviderNonceGap(
  scope: ProviderWriteScope,
  finalizedNonce: bigint,
  minimumAgeSeconds: number,
): Promise<(ProviderChainWriteRow & { queued_behind: number }) | null> {
  const result = await pool.query<ProviderChainWriteRow & { queued_behind: number }>(
    `WITH oldest AS (
       SELECT *
         FROM provider_chain_writes
        WHERE chain_id = $1 AND wallet_address = $2
          AND status IN ('prepared','broadcast','attention')
          AND nonce >= $3
          AND (
            SELECT MIN(history.created_at)
              FROM provider_chain_writes history
             WHERE history.chain_id = provider_chain_writes.chain_id
               AND history.wallet_address = provider_chain_writes.wallet_address
               AND history.nonce = provider_chain_writes.nonce
          ) < now() - make_interval(secs => $4)
          AND (
            EXISTS (
              SELECT 1 FROM provider_chain_writes later
               WHERE later.chain_id = provider_chain_writes.chain_id
                 AND later.wallet_address = provider_chain_writes.wallet_address
                 AND later.nonce > provider_chain_writes.nonce
                 AND later.status IN ('prepared','broadcast','attention')
            )
            OR EXISTS (
              SELECT 1 FROM provider_signer_cursors cursor
               WHERE cursor.chain_id = provider_chain_writes.chain_id
                 AND cursor.wallet_address = provider_chain_writes.wallet_address
                 AND cursor.next_nonce > provider_chain_writes.nonce
            )
          )
        ORDER BY nonce, created_at
        LIMIT 1
     )
     SELECT oldest.*,
            (
              SELECT COUNT(*)::int FROM provider_chain_writes later
               WHERE later.chain_id = oldest.chain_id
                 AND later.wallet_address = oldest.wallet_address
                 AND later.nonce > oldest.nonce
                 AND later.status IN ('prepared','broadcast','attention')
            ) AS queued_behind
       FROM oldest`,
    [
      scope.chainId,
      scope.walletAddress.toLowerCase(),
      finalizedNonce.toString(),
      minimumAgeSeconds,
    ],
  );
  return result.rows[0] ?? null;
}

export async function rebindReplacementProviderWrite(args: {
  old: ProviderChainWriteRow;
  replacementId: string;
  replacementHash: Hex;
  db: Queryable;
}): Promise<boolean> {
  if (args.old.purpose === "standard_reputation_outcome") {
    const result = await args.db.query(
      `UPDATE standard_reputation_outcomes
          SET provider_write_id=$2,transaction_hash=$3,updated_at=now()
        WHERE provider_write_id=$1 AND state='broadcast'`,
      [args.old.id, args.replacementId, args.replacementHash.toLowerCase()],
    );
    return result.rowCount === 1;
  }
  return args.old.purpose === "service_registration" || args.old.purpose === "service_uri_update";
}

export interface ProviderWriteOperationalSummary {
  unresolved: number;
  attention: number;
  oldest_unresolved_at: Date | null;
}

export async function getProviderWriteOperationalSummary(): Promise<ProviderWriteOperationalSummary> {
  const result = await pool.query<ProviderWriteOperationalSummary>(
    `SELECT
       COUNT(*) FILTER (
         WHERE status IN ('prepared','broadcast','attention')
       )::int AS unresolved,
       COUNT(*) FILTER (WHERE status = 'attention')::int AS attention,
       MIN(created_at) FILTER (
         WHERE status IN ('prepared','broadcast','attention')
       ) AS oldest_unresolved_at
     FROM provider_chain_writes`,
  );
  return result.rows[0] ?? {
    unresolved: 0,
    attention: 0,
    oldest_unresolved_at: null,
  };
}
