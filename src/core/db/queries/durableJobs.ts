import { pool } from "../pool.js";
import { inTransaction, type Queryable } from "../queryable.js";
import { redactSensitiveText, redactSensitiveValue } from "../../security/redaction.js";

const MAX_QUEUE_CHARS = 128;
const MAX_IDEMPOTENCY_KEY_CHARS = 512;
const MAX_PAYLOAD_BYTES = 16_384;
const MAX_ERROR_CHARS = 1_000;

export type DurableJobStatus =
  | "queued"
  | "running"
  | "retry"
  | "dead_letter"
  | "completed";

export interface DurableJobRow {
  id: string;
  queue: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  status: DurableJobStatus;
  attempts: number;
  max_attempts: number;
  available_at: Date;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
  required_capability?: string | null;
  last_error: string | null;
  dead_letter_surfaced_at: Date | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export type DurableJobClaim = DurableJobRow & {
  lease_owner: string;
  lease_token: string;
  lease_expires_at: Date;
};

export interface DurableQueueMetrics {
  queue: string;
  /** queued + retry rows currently eligible or waiting. */
  depth: number;
  running: number;
  deadLetter: number;
  /** Age in seconds of the oldest queued/retry row (0 when empty). */
  oldestQueuedSeconds: number;
}

/// Per-queue depth/age/dead-letter metrics for readiness diagnostics and
/// operator dashboards. Backlog age is the leading indicator of a stuck
/// worker; dead-letter count is work awaiting an operator.
export async function getDurableQueueMetrics(): Promise<DurableQueueMetrics[]> {
  const result = await pool.query<{
    queue: string;
    depth: string;
    running: string;
    dead_letter: string;
    oldest_queued_seconds: string | null;
  }>(
    `SELECT queue,
            COUNT(*) FILTER (WHERE status IN ('queued','retry'))::text AS depth,
            COUNT(*) FILTER (WHERE status = 'running')::text AS running,
            COUNT(*) FILTER (WHERE status = 'dead_letter')::text AS dead_letter,
            FLOOR(EXTRACT(EPOCH FROM (now() - MIN(created_at)
              FILTER (WHERE status IN ('queued','retry')))))::text AS oldest_queued_seconds
       FROM durable_jobs
      GROUP BY queue
      ORDER BY queue`,
  );
  return result.rows.map((row) => ({
    queue: row.queue,
    depth: Number(row.depth),
    running: Number(row.running),
    deadLetter: Number(row.dead_letter),
    oldestQueuedSeconds: row.oldest_queued_seconds ? Number(row.oldest_queued_seconds) : 0,
  }));
}

function protectedJobPayload(args: { queue: string; idempotencyKey: string; payload: Record<string, unknown> }): string {
  if (!args.queue || args.queue.length > MAX_QUEUE_CHARS) {
    throw new Error("durable job queue is invalid");
  }
  if (!args.idempotencyKey || args.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_CHARS) {
    throw new Error("durable job idempotency key is invalid");
  }
  const protectedPayload = redactSensitiveValue(args.payload) as Record<string, unknown>;
  const serializedPayload = JSON.stringify(protectedPayload);
  if (Buffer.byteLength(serializedPayload, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new Error("durable job payload exceeds the protected queue limit");
  }
  return serializedPayload;
}

const CAPABILITY = /^0x[0-9a-f]{64}$/;

export async function enqueueDurableJob(args: {
  queue: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  maxAttempts?: number;
  availableAt?: Date;
  /** Only a worker whose build runs this executable definition may claim the job. */
  requiredCapability?: string | null;
  db?: Queryable;
}): Promise<DurableJobRow> {
  const serializedPayload = protectedJobPayload(args);
  if (args.requiredCapability && !CAPABILITY.test(args.requiredCapability)) {
    throw new Error("durable job capability is invalid");
  }
  const db = args.db ?? pool;
  // "Available immediately" uses the DATABASE clock (COALESCE → now()):
  // claim eligibility compares against now() too, so a skewed application
  // clock (multi-replica, VM drift) can never park an immediate job in the
  // future. Explicit delays remain caller-supplied timestamps.
  const result = await db.query<DurableJobRow>(
    `INSERT INTO durable_jobs
       (queue, idempotency_key, payload, max_attempts, available_at, required_capability)
     VALUES ($1,$2,$3,$4,COALESCE($5, now()),$6)
     ON CONFLICT (queue, idempotency_key) DO UPDATE
       SET payload = CASE
             WHEN durable_jobs.status IN ('queued','retry') THEN EXCLUDED.payload
             ELSE durable_jobs.payload
           END,
           available_at = CASE
             WHEN durable_jobs.status IN ('queued','retry')
               THEN LEAST(durable_jobs.available_at, EXCLUDED.available_at)
             ELSE durable_jobs.available_at
           END,
           updated_at = now()
     RETURNING *`,
    [
      args.queue,
      args.idempotencyKey,
      serializedPayload,
      args.maxAttempts ?? 12,
      args.availableAt ?? null,
      args.requiredCapability ?? null,
    ],
  );
  return result.rows[0];
}

/**
 * Create a job already leased to the caller, inside the caller's
 * transaction: the work it describes is being done right now by that
 * caller, and any worker resumes it only after the lease expired. Returns
 * null when the job already exists.
 */
export async function insertLeasedDurableJob(db: Queryable, args: {
  queue: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  workerId: string;
  leaseSeconds: number;
  maxAttempts?: number;
  requiredCapability?: string | null;
}): Promise<{ id: string; leaseToken: string } | null> {
  const serializedPayload = protectedJobPayload(args);
  if (args.requiredCapability && !CAPABILITY.test(args.requiredCapability)) {
    throw new Error("durable job capability is invalid");
  }
  const result = await db.query<{ id: string; lease_token: string }>(
    `INSERT INTO durable_jobs
       (queue,idempotency_key,payload,status,attempts,max_attempts,available_at,
        lease_owner,lease_token,lease_expires_at,required_capability)
     VALUES ($1,$2,$3,'running',1,$4,now(),$5,gen_random_uuid(),now() + ($6 * interval '1 second'),$7)
     ON CONFLICT (queue, idempotency_key) DO NOTHING
     RETURNING id,lease_token`,
    [
      args.queue, args.idempotencyKey, serializedPayload, args.maxAttempts ?? 12,
      args.workerId, args.leaseSeconds, args.requiredCapability ?? null,
    ],
  );
  const row = result.rows[0];
  return row ? { id: row.id, leaseToken: row.lease_token } : null;
}

export async function claimDurableJob(args: {
  queue: string;
  workerId: string;
  leaseSeconds: number;
  /**
   * The executable definitions this worker's build runs. When given, a job
   * that requires another one is left for a worker that can run it.
   */
  capabilities?: readonly string[];
}): Promise<DurableJobClaim | null> {
  return inTransaction(pool, async (db) => {
    await db.query(
      `UPDATE durable_jobs
          SET status = CASE
                WHEN attempts >= max_attempts THEN 'dead_letter'
                ELSE 'retry'
              END,
              lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
              available_at = CASE
                WHEN attempts >= max_attempts THEN available_at
                ELSE now()
              END,
              updated_at = now(),
              last_error = COALESCE(last_error, 'worker lease expired')
        WHERE queue = $1 AND status = 'running' AND lease_expires_at <= now()`,
      [args.queue],
    );
    await db.query(
      `UPDATE durable_jobs
          SET status = 'dead_letter', updated_at = now(),
              last_error = COALESCE(last_error, 'retry budget exhausted')
        WHERE queue = $1 AND status IN ('queued','retry')
          AND attempts >= max_attempts`,
      [args.queue],
    );
    const result = await db.query<DurableJobClaim>(
      `WITH candidate AS (
         SELECT id FROM durable_jobs
          WHERE queue = $1
            AND status IN ('queued','retry')
            AND attempts < max_attempts
            AND available_at <= now()
            AND ($4::text[] IS NULL OR required_capability IS NULL
              OR required_capability = ANY($4::text[]))
          ORDER BY available_at, created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE durable_jobs j
          SET status = 'running',
              attempts = attempts + 1,
              lease_owner = $2,
              lease_token = gen_random_uuid(),
              lease_expires_at = now() + ($3 * interval '1 second'),
              updated_at = now()
         FROM candidate
        WHERE j.id = candidate.id
       RETURNING j.*`,
      [args.queue, args.workerId, args.leaseSeconds, args.capabilities ? [...args.capabilities] : null],
    );
    return result.rows[0] ?? null;
  });
}

export async function completeDurableJob(
  args: {
    id: string;
    workerId: string;
    leaseToken: string;
  },
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE durable_jobs
        SET status = 'completed', completed_at = now(), updated_at = now(),
            lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
      WHERE id = $1 AND status = 'running' AND lease_owner = $2
        AND lease_token = $3 AND lease_expires_at > now()`,
    [args.id, args.workerId, args.leaseToken],
  );
  return result.rowCount === 1;
}

export async function renewDurableJobLease(args: {
  id: string;
  workerId: string;
  leaseToken: string;
  leaseSeconds: number;
}): Promise<boolean> {
  const result = await pool.query(
    `UPDATE durable_jobs
        SET lease_expires_at = now() + ($4 * interval '1 second'), updated_at = now()
      WHERE id = $1 AND status = 'running' AND lease_owner = $2
        AND lease_token = $3 AND lease_expires_at > now()`,
    [args.id, args.workerId, args.leaseToken, args.leaseSeconds],
  );
  return result.rowCount === 1;
}

/** Keep ownership alive while one durable effect waits on a slow dependency. */
export async function withDurableJobLease<T>(args: {
  id: string;
  workerId: string;
  leaseToken: string;
  leaseSeconds: number;
  work: (assertOwned: () => void) => Promise<T>;
}): Promise<T> {
  let lost = false;
  let renewal: Promise<void> = Promise.resolve();
  const renew = () => {
    renewal = renewal.then(async () => {
      if (lost) return;
      const owned = await renewDurableJobLease(args);
      if (!owned) lost = true;
    }).catch(() => {
      lost = true;
    });
  };
  const intervalMs = Math.max(1_000, Math.floor(args.leaseSeconds * 1_000 / 3));
  const timer = setInterval(renew, intervalMs);
  timer.unref();
  const assertOwned = () => {
    if (lost) throw new Error("Lost durable job lease while work was in progress");
  };
  try {
    const result = await args.work(assertOwned);
    await renewal;
    assertOwned();
    return result;
  } finally {
    clearInterval(timer);
    await renewal;
  }
}

export async function failDurableJob(args: {
  id: string;
  workerId: string;
  leaseToken: string;
  error: string;
  retryAt: Date;
}): Promise<DurableJobStatus | null> {
  const safeError = redactSensitiveText(args.error).slice(0, MAX_ERROR_CHARS);
  const result = await pool.query<{ status: DurableJobStatus }>(
    `UPDATE durable_jobs
        SET status = CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'retry' END,
            available_at = CASE WHEN attempts >= max_attempts THEN available_at ELSE $3 END,
            last_error = $5, lease_owner = NULL, lease_token = NULL,
            lease_expires_at = NULL,
            updated_at = now()
      WHERE id = $1 AND status = 'running' AND lease_owner = $2
        AND lease_token = $4 AND lease_expires_at > now()
      RETURNING status`,
    [args.id, args.workerId, args.retryAt, args.leaseToken, safeError],
  );
  return result.rows[0]?.status ?? null;
}

/**
 * Reschedule a claimed job that had nothing to do yet, without spending a
 * retry. `claimDurableJob` increments `attempts` on every claim, so a worker
 * that defers must hand the attempt back or a job that is merely waiting will
 * reach `max_attempts` and dead-letter — which surfaces as a critical
 * `stalled_automation` review for work that is behaving normally.
 *
 * Deliberately distinct from `failDurableJob`: deferral is not failure, so it
 * neither records `last_error` nor advances the job toward dead-letter. Same
 * lease guards, so a worker that lost its lease still cannot move the row.
 */
export async function deferDurableJob(args: {
  id: string;
  workerId: string;
  leaseToken: string;
  retryAt: Date;
}): Promise<boolean> {
  const result = await pool.query(
    `UPDATE durable_jobs
        SET status = 'retry',
            attempts = GREATEST(attempts - 1, 0),
            available_at = $3,
            lease_owner = NULL, lease_token = NULL,
            lease_expires_at = NULL,
            updated_at = now()
      WHERE id = $1 AND status = 'running' AND lease_owner = $2
        AND lease_token = $4 AND lease_expires_at > now()`,
    [args.id, args.workerId, args.retryAt, args.leaseToken],
  );
  return result.rowCount === 1;
}

/** Explicit redelivery can revive a dead letter; completed/running work is untouched. */
export async function requeueDeadLetter(queue: string, idempotencyKey: string): Promise<boolean> {
  const result = await pool.query(
      `UPDATE durable_jobs
        SET status = 'queued', attempts = 0, available_at = now(),
            lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
            last_error = NULL,
            dead_letter_surfaced_at = NULL,
            updated_at = now()
      WHERE queue = $1 AND idempotency_key = $2 AND status = 'dead_letter'`,
    [queue, idempotencyKey],
  );
  return result.rowCount === 1;
}

/** Review actions bind retries to the immutable dead-letter row, not caller-supplied queue keys. */
export async function requeueDeadLetterById(
  id: string,
  db: Queryable = pool,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE durable_jobs
        SET status = 'queued', attempts = 0, available_at = now(),
            lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
            last_error = NULL, dead_letter_surfaced_at = NULL, updated_at = now()
      WHERE id = $1 AND status = 'dead_letter'`,
    [id],
  );
  return result.rowCount === 1;
}
