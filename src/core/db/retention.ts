import { config } from "../config.js";
import { logError, logInfo } from "../logger.js";
import { pool } from "./pool.js";
import { inTransaction } from "./queryable.js";
import { failWorker, heartbeatWorker, setWorkerStatus } from "../health.js";
import { purgeExpiredEphemeralTransactions } from "./ephemeralRetention.js";

// Frequent no-op sweeps keep both retention lag and readiness evidence
// bounded; indexed predicates make this safe across replicas.
const INTERVAL_MS = 5 * 60 * 1_000;
let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<Record<string, number>> | null = null;

export function startRetentionWorker(): void {
  if (timer) return;
  setWorkerStatus("retention", false);
  const start = () => {
    if (inFlight) return;
    inFlight = runRetention().finally(() => {
      inFlight = null;
    });
    void inFlight.catch(reportFailure);
  };
  timer = setInterval(start, INTERVAL_MS);
  timer.unref();
  start();
}

export async function stopRetentionWorker(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  if (inFlight) await inFlight.catch(() => undefined);
}

export async function runRetention(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const remove = async (name: string, text: string, values: unknown[]) => {
    const result = await pool.query(text, values);
    counts[name] = result.rowCount ?? 0;
  };
  await remove(
    "outboundEmails",
    `DELETE FROM emails_outbound e
      WHERE sent_at < now() - ($1 * interval '1 day') AND NOT legal_hold
        AND NOT EXISTS (
          SELECT 1 FROM active_legal_hold_targets h
           WHERE h.transaction_id = e.transaction_id
        )`,
    [config.EMAIL_RETENTION_DAYS],
  );
  await remove(
    "inboundEmails",
    `DELETE FROM emails_inbound e
      WHERE e.received_at < now() - ($1 * interval '1 day')
        AND NOT e.legal_hold
        AND NOT EXISTS (
          SELECT 1 FROM active_legal_hold_targets h
           WHERE h.transaction_id = e.transaction_id
              OR EXISTS (
                SELECT 1 FROM escalations x
                 WHERE x.inbound_id = e.id AND x.transaction_id = h.transaction_id
              )
        )
        AND NOT EXISTS (
          SELECT 1 FROM escalations x
           WHERE x.inbound_id = e.id
             AND (
               x.legal_hold
               OR x.resolved_at IS NULL
               OR x.resolved_at >= now() - ($1 * interval '1 day')
             )
        )`,
    [config.EMAIL_RETENTION_DAYS],
  );
  // A standard order's events are its deliverable bytes until its terminal
  // identity is frozen: keep them for nonterminal and unreconciled legacy
  // orders. Frozen results and protected artifact references live in their
  // own tables and are never removed by retention; paid-order reads have no
  // expiry.
  await remove(
    "events",
    `DELETE FROM events e
      WHERE created_at < now() - ($1 * interval '1 day') AND NOT legal_hold
        AND NOT EXISTS (
          SELECT 1 FROM active_legal_hold_targets h
           WHERE h.transaction_id = e.transaction_id OR h.asset_id = e.asset_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM transactions t
           WHERE t.id = e.transaction_id AND t.standard_order_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM standard_terminal_results r WHERE r.transaction_id = t.id
             )
        )`,
    [config.EVENT_RETENTION_DAYS],
  );
  await remove(
    "operatorChats",
    `DELETE FROM operator_chats c
      WHERE c.created_at < now() - ($1 * interval '1 day')
        AND NOT c.legal_hold
        AND NOT EXISTS (
          SELECT 1 FROM chat_threads t
          JOIN escalations e ON e.id = t.escalation_id
          JOIN active_legal_hold_targets h ON h.transaction_id = e.transaction_id
           WHERE t.id = c.thread_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM chat_threads t
          JOIN escalations e ON e.thread_id = t.id
           WHERE t.id = c.thread_id AND e.legal_hold
        )
        AND NOT EXISTS (
          SELECT 1 FROM operator_confirmation_intents i
           WHERE i.origin_turn_id = c.id AND i.consumed_at IS NULL AND i.expires_at > now()
        )`,
    [config.OPERATOR_CHAT_RETENTION_DAYS],
  );
  await remove(
    "durableJobs",
    `DELETE FROM durable_jobs
      WHERE status IN ('completed','dead_letter')
        AND updated_at < now() - ($1 * interval '1 day')`,
    [config.DURABLE_JOB_RETENTION_DAYS],
  );
  await inTransaction(pool, async (db) => {
    await db.query(
      `UPDATE operator_confirmation_intents
          SET voided_at = now()
        WHERE consumed_at IS NULL
          AND voided_at IS NULL
          AND expires_at <= now()`,
    );
    const confirmationPayloads = await db.query(
      `UPDATE operator_confirmation_intents i
          SET pending_payload_encrypted = NULL,
              payload_purged_at = now()
        WHERE i.pending_payload_encrypted IS NOT NULL
          AND i.execution_status NOT IN ('executing','outcome_unknown')
          AND (
            i.voided_at < now() - interval '1 day'
            OR (
              i.execution_status IN ('succeeded','failed')
              AND i.execution_finished_at
                    < now() - ($1 * interval '1 day')
            )
          )
          AND NOT EXISTS (
            SELECT 1
              FROM chat_threads t
              JOIN escalations e ON e.id = t.escalation_id
             WHERE t.id = i.thread_id
               AND (
                 e.resolved_at IS NULL
                 OR e.legal_hold
                 OR EXISTS (
                   SELECT 1 FROM active_legal_hold_targets h
                    WHERE h.transaction_id = e.transaction_id
                 )
               )
          )
          AND NOT EXISTS (
            SELECT 1
              FROM escalations e
             WHERE e.thread_id = i.thread_id
               AND (
                 e.resolved_at IS NULL
                 OR e.legal_hold
                 OR EXISTS (
                   SELECT 1 FROM active_legal_hold_targets h
                    WHERE h.transaction_id = e.transaction_id
                 )
               )
          )`,
      [config.OPERATOR_CHAT_RETENTION_DAYS],
    );
    counts.confirmationPayloads = confirmationPayloads.rowCount ?? 0;

    const escalations = await db.query(
      `UPDATE escalations e SET
         execution_snapshot_encrypted = NULL,
         reviewer_edits_encrypted = NULL,
         review_binding_encrypted = NULL,
         adapter_result_encrypted = NULL,
         resolution_error = NULL,
         evidence_purged_at = now()
       WHERE e.source IN ('pre_execute','fulfillment_hold')
         AND e.status IN ('approved','edited','rejected')
         AND e.resolved_at < now() - ($1 * interval '1 day')
         AND e.evidence_purged_at IS NULL
         AND NOT e.legal_hold
         AND NOT EXISTS (
           SELECT 1 FROM active_legal_hold_targets h
            WHERE h.transaction_id = e.transaction_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM events v
            WHERE v.transaction_id = e.transaction_id AND v.legal_hold
         )`,
      [config.EVENT_RETENTION_DAYS],
    );
    counts.escalationEvidence = escalations.rowCount ?? 0;

    const attempts = await db.query(
      `UPDATE fulfillment_hold_attempts a SET
         reviewer_edits_encrypted = NULL,
         review_binding_encrypted = NULL,
         adapter_result_encrypted = NULL,
         resolution_error = NULL,
         evidence_purged_at = now()
        FROM escalations e
        WHERE e.id = a.escalation_id
          AND e.evidence_purged_at IS NOT NULL
          AND a.evidence_purged_at IS NULL
          AND NOT e.legal_hold
          AND NOT EXISTS (
            SELECT 1 FROM active_legal_hold_targets h
             WHERE h.transaction_id = e.transaction_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM events v
             WHERE v.transaction_id = e.transaction_id AND v.legal_hold
          )`,
      [],
    );
    counts.fulfillmentHoldAttemptEvidence = attempts.rowCount ?? 0;

    const providerWrites = await db.query(
      `UPDATE provider_chain_writes w
          SET signed_tx_encrypted = NULL,
              signed_tx_purged_at = now(),
              updated_at = now()
        WHERE w.status IN ('confirmed','reverted','replaced')
          AND w.signed_tx_encrypted IS NOT NULL
          AND w.updated_at < now() - ($1 * interval '1 day')
          AND NOT EXISTS (
            SELECT 1
              FROM active_legal_hold_targets h
             WHERE (
               w.target_type = 'standard_reputation_outcome'
               AND EXISTS (
                 SELECT 1 FROM standard_reputation_outcomes r
                  WHERE encode(r.order_key, 'hex') = replace(lower(w.target_id), '0x', '')
                    AND r.transaction_id = h.transaction_id
               )
             )
          )`,
      [config.EVENT_RETENTION_DAYS],
    );
    counts.providerSignedTransactions = providerWrites.rowCount ?? 0;
  });
  await remove("rateBuckets", `DELETE FROM rate_limit_buckets WHERE expires_at < now()`, []);
  counts.ephemeralTransactions = await purgeExpiredEphemeralTransactions();
  logInfo("Retention sweep completed", counts);
  heartbeatWorker("retention");
  return counts;
}

function reportFailure(error: unknown): void {
  failWorker("retention");
  logError("Retention sweep failed", { error: (error as Error).message });
}
