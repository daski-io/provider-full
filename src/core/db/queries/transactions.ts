import { pool } from "../pool.js";
import type { Queryable } from "../queryable.js";
import { decryptString } from "../../chain/encryption.js";
import { redactSensitiveValue } from "../../security/redaction.js";

// Provider-facing unit of work. One row per skill execution. Renamed
// from `tasks` in v4 to match the operator-facing vocabulary; the PK is
// still TEXT to remain compatible with A2A wire format (task ids).
//
// A2A protocol artifacts (messages, output artifacts) used to live in
// `task_messages` / `task_artifacts`; they now live in `events`. Payment
// Standard settlement facts are copied from the gateway-signed dispatch.
// Escalation state lives in `escalations`.

// A2A v1 task lifecycle, plus the "input-required" pause state. Use the
// const array (not the type) as a data value — admin UI filter <select>
// options iterate this list, validator narrows query-string input, etc.
export const TRANSACTION_STATUSES = [
  "submitted",
  "working",
  "input-required",
  "completed",
  "failed",
  "canceled",
] as const;

export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];
export type TransactionRetentionClass = "persistent" | "ephemeral";

export function isTransactionStatus(s: string): s is TransactionStatus {
  return (TRANSACTION_STATUSES as readonly string[]).includes(s);
}

export interface TransactionRow {
  id: string;
  customer_id: string | null;
  standard_payer?: string | null;
  asset_id: string | null;
  service_id: string;
  skill_id: string;
  service_ref: Buffer | null;
  status: TransactionStatus;
  contact_email: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  version: string;
  canonical_request_hash: Buffer | null;
  retention_class: TransactionRetentionClass;
  expires_at: Date | null;
  request_id_hash: Buffer | null;
  accepted_envelope_message_id_hash: Buffer | null;
  standard_order_id?: string | null;
  standard_order_key?: Buffer | null;
  /** The commitment hash of the listing version a standard order was sold under. */
  standard_listing_manifest_hash?: Buffer | null;
  standard_token?: string | null;
  standard_gross_amount?: string | null;
  standard_provider_net_amount?: string | null;
  standard_daski_commission_amount?: string | null;
}

function transactionContactContext(transactionId: string) {
  return {
    purpose: "customer-contact",
    table: "transactions",
    recordId: transactionId,
    field: "contact_email",
  } as const;
}

export function decryptTransactionRow(row: TransactionRow): TransactionRow {
  return {
    ...row,
    contact_email: row.contact_email
      ? decryptString(row.contact_email, transactionContactContext(row.id))
      : null,
  };
}

export async function getTransactionById(
  id: string,
  db: Queryable = pool,
): Promise<TransactionRow | null> {
  const result = await db.query(`SELECT * FROM transactions WHERE id = $1`, [id]);
  const row = result.rows[0] as TransactionRow | undefined;
  return row ? decryptTransactionRow(row) : null;
}

export interface CreateTransactionArgs {
  id: string;
  customer_id?: string | null;
  service_id: string;
  skill_id: string;
  asset_id?: string | null;
  status?: TransactionStatus;
  metadata?: Record<string, unknown>;
  retention_class?: TransactionRetentionClass;
  expires_at?: Date | null;
  request_id_hash?: Buffer | null;
}

export class EphemeralRequestConflictError extends Error {
  constructor() {
    super("anonymous messageId was already used for different request data");
    this.name = "EphemeralRequestConflictError";
  }
}

export async function createTransaction(
  args: CreateTransactionArgs,
  db: Queryable = pool,
): Promise<TransactionRow> {
  const result = await db.query<TransactionRow>(
    `INSERT INTO transactions
       (id,customer_id,asset_id,service_id,skill_id,status,metadata,retention_class,expires_at,request_id_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      args.id,
      args.customer_id ?? null,
      args.asset_id ?? null,
      args.service_id,
      args.skill_id,
      args.status ?? "submitted",
      JSON.stringify(redactSensitiveValue(args.metadata ?? {})),
      args.retention_class ?? "persistent",
      args.expires_at ?? null,
      args.request_id_hash ?? null,
    ],
  );
  return decryptTransactionRow(result.rows[0]!);
}

export async function createOrGetEphemeralTransaction(
  args: CreateTransactionArgs & {
    expires_at: Date;
    request_id_hash: Buffer;
    canonical_request_hash: Buffer;
  },
  db: Queryable = pool,
): Promise<{ transaction: TransactionRow; created: boolean }> {
  const inserted = await db.query<TransactionRow>(
    `INSERT INTO transactions
       (id,customer_id,service_id,skill_id,status,metadata,retention_class,expires_at,
        request_id_hash,canonical_request_hash)
     VALUES ($1,$2,$3,$4,$5,$6,'ephemeral',$7,$8,$9)
     ON CONFLICT (service_id,skill_id,request_id_hash)
       WHERE retention_class='ephemeral'
     DO NOTHING RETURNING *`,
    [
      args.id,
      args.customer_id ?? null,
      args.service_id,
      args.skill_id,
      args.status ?? "submitted",
      JSON.stringify(redactSensitiveValue(args.metadata ?? {})),
      args.expires_at,
      args.request_id_hash,
      args.canonical_request_hash,
    ],
  );
  if (inserted.rows[0]) {
    return { transaction: decryptTransactionRow(inserted.rows[0]), created: true };
  }
  const existing = await db.query<TransactionRow>(
    `SELECT * FROM transactions
      WHERE service_id=$1 AND skill_id=$2
        AND request_id_hash=$3 AND retention_class='ephemeral'`,
    [args.service_id, args.skill_id, args.request_id_hash],
  );
  const row = existing.rows[0];
  if (!row) throw new Error("ephemeral request conflict could not be resolved");
  if (!row.canonical_request_hash?.equals(args.canonical_request_hash)) {
    throw new EphemeralRequestConflictError();
  }
  return { transaction: decryptTransactionRow(row), created: false };
}

/// Update the transaction status. Returns the updated row, or null when
/// the id is unknown. completed_at is set automatically on terminal
/// statuses (completed | failed | canceled); for non-terminal transitions
/// it remains untouched.
export async function setTransactionStatus(
  id: string,
  status: TransactionStatus,
  options: {
    expectedStatus?: TransactionStatus;
    expectedVersion?: string | number;
    db?: Queryable;
  } = {},
): Promise<TransactionRow | null> {
  const db = options.db ?? pool;
  const isTerminal = status === "completed" || status === "failed" || status === "canceled";
  const result = await db.query<TransactionRow>(
    `UPDATE transactions
        SET status       = $2,
            updated_at   = now(),
            version      = version + 1,
            completed_at = CASE WHEN $3::boolean THEN COALESCE(completed_at, now()) ELSE completed_at END
      WHERE id = $1
        AND ($4::text IS NULL OR status = $4)
        AND ($5::bigint IS NULL OR version = $5)
      RETURNING *`,
    [
      id,
      status,
      isTerminal,
      options.expectedStatus ?? null,
      options.expectedVersion?.toString() ?? null,
    ],
  );
  const row = result.rows[0] as TransactionRow | undefined;
  return row ? decryptTransactionRow(row) : null;
}

/// Merge an object into transactions.metadata using JSONB ||. Useful for
/// progressively recording fulfilment_time_seconds, request_data, etc.
/// without overwriting earlier keys.
export async function mergeTransactionMetadata(
  id: string,
  patch: Record<string, unknown>,
  db: Queryable = pool,
): Promise<TransactionRow | null> {
  const result = await db.query(
    `UPDATE transactions
        SET metadata   = metadata || $2::jsonb,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, JSON.stringify(redactSensitiveValue(patch))],
  );
  const row = result.rows[0] as TransactionRow | undefined;
  return row ? decryptTransactionRow(row) : null;
}

export async function setTransactionAsset(
  id: string,
  assetId: string | null,
  db: Queryable = pool,
): Promise<void> {
  const result = await db.query(
    `UPDATE transactions SET asset_id = $2, updated_at = now()
      WHERE id = $1 AND (asset_id IS NULL OR asset_id IS NOT DISTINCT FROM $2)
      RETURNING id`,
    [id, assetId],
  );
  if (result.rowCount !== 1) {
    throw new Error(`Transaction ${id} is already bound to another asset`);
  }
}

export interface ListTransactionsFilter {
  serviceId?: string;
  customerId?: string;
  status?: TransactionStatus;
  /// Filter to transactions with at least one pending escalation.
  pendingEscalation?: boolean;
  /// Restrict to standard paid transactions. Free-skill calls do not carry
  /// a standard order ID and are excluded.
  hasSettlement?: boolean;
  since?: Date;
  until?: Date;
  limit?: number;
  offset?: number;
}

/// ONE WHERE builder for the list/count/enriched variants (audit 4.1):
/// duplicated filter clauses drift; a shared builder cannot.
function buildTransactionsWhere(
  filter: Omit<ListTransactionsFilter, "limit" | "offset">,
): { where: string[]; args: unknown[] } {
  const where: string[] = [];
  const args: unknown[] = [];
  const push = (clause: string, value: unknown) => {
    args.push(value);
    where.push(clause.replace("?", `$${args.length}`));
  };
  if (filter.serviceId !== undefined) push("t.service_id = ?", filter.serviceId);
  if (filter.customerId !== undefined) push("t.customer_id = ?", filter.customerId);
  if (filter.status !== undefined) push("t.status = ?", filter.status);
  if (filter.since !== undefined) push("t.created_at >= ?", filter.since);
  if (filter.until !== undefined) push("t.created_at < ?", filter.until);
  if (filter.pendingEscalation === true) {
    where.push(
      "EXISTS (SELECT 1 FROM escalations e WHERE e.transaction_id = t.id AND e.status = 'pending')",
    );
  }
  if (filter.hasSettlement === true) {
    where.push(
      "t.standard_order_id IS NOT NULL",
    );
  }
  return { where, args };
}

export async function listTransactions(
  filter: ListTransactionsFilter = {},
): Promise<TransactionRow[]> {
  const { where, args } = buildTransactionsWhere(filter);
  const limit = filter.limit ?? 100;
  const offset = filter.offset ?? 0;
  args.push(limit, offset);
  const limitIdx = args.length - 1;
  const offsetIdx = args.length;

  const sql =
    `SELECT t.* FROM transactions t` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY t.created_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`;

  const result = await pool.query(sql, args);
  return (result.rows as TransactionRow[]).map(decryptTransactionRow);
}

export interface AdminTransactionRow extends TransactionRow {
  service_slug: string;
  customer_wallet: string | null;
  asset_type: string | null;
  asset_identifier_stored: string | null;
  settlement_amount: string | null;
}

/// Admin list with everything the transactions table renders, in ONE query
/// (audit 4.7): the old per-row enrichment issued ~4 queries per row —
/// about 4,000 at the page's limit=1000.
export async function listTransactionsForAdmin(
  filter: ListTransactionsFilter = {},
): Promise<AdminTransactionRow[]> {
  const { where, args } = buildTransactionsWhere(filter);
  const limit = filter.limit ?? 100;
  const offset = filter.offset ?? 0;
  args.push(limit, offset);
  const limitIdx = args.length - 1;
  const offsetIdx = args.length;

  const sql =
    `SELECT t.*,
            s.slug AS service_slug,
            c.wallet_address AS customer_wallet,
            a.type AS asset_type,
            a.identifier AS asset_identifier_stored,
            t.standard_gross_amount::text AS settlement_amount
       FROM transactions t
       JOIN services s ON s.id = t.service_id
       LEFT JOIN customers c ON c.id = t.customer_id
       LEFT JOIN assets a ON a.id = t.asset_id` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY t.created_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`;

  const result = await pool.query(sql, args);
  return (result.rows as AdminTransactionRow[]).map(
    (row) => decryptTransactionRow(row) as AdminTransactionRow,
  );
}

/// Same filter shape as listTransactions, sans limit/offset. Used by the
/// admin Transactions page to render "showing N of TOTAL" beside the
/// load-more button.
export async function countTransactions(
  filter: Omit<ListTransactionsFilter, "limit" | "offset"> = {},
): Promise<number> {
  const { where, args } = buildTransactionsWhere(filter);
  const sql =
    `SELECT COUNT(*)::int AS n FROM transactions t` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "");
  const result = await pool.query(sql, args);
  return (result.rows[0] as { n: number }).n;
}

export async function countTransactionsByService(
  serviceId: string,
  since: Date,
): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS n FROM transactions
      WHERE service_id = $1 AND created_at >= $2`,
    [serviceId, since],
  );
  return (result.rows[0] as { n: number }).n;
}
