import { pool } from "../pool.js";
import { randomUUID } from "node:crypto";
import { enqueueDurableJob } from "./durableJobs.js";
import { inTransaction } from "../queryable.js";
import type { Queryable } from "../queryable.js";
import {
  protectEscalationText,
  revealEscalationFields,
} from "../../security/escalationProtection.js";
import { recordMandatoryAudit } from "../../events/emitter.js";

export const OPERATOR_ESCALATION_QUEUE = "operator-escalation";

// Admin review queue. Escalations live in their own table, one row per event.
// Email triage may enter the bounded Operator Agent queue first. All other
// consequential provider reviews route directly to an authenticated human.
//
// Legacy pre-execute escalations still use status='pending' →
// 'approved'/'edited'/'rejected' (engine/escalation.ts), unchanged.

export type EscalationStatus =
  | "pending"
  | "in_agent_review"
  | "awaiting_human"
  | "resolved"
  | "rejected"
  | "approved"
  | "edited"
  | "resolution_queued"
  | "rejection_queued"
  | "resolution_executing"
  | "resolution_result_ready"
  | "resolution_attention";
export type EscalationSource =
  | "pre_execute"
  | "email_agent"
  | "operator"
  | "auto"
  | "fulfillment_hold"
  | "screening";
export type EscalationAssignee = "operator_agent" | "human";
export type ReviewSeverity = "info" | "warning" | "critical";

export interface ReviewAction {
  label: string;
  value: string;
  effect?: string;
}

export interface EscalationRow {
  id: string;
  transaction_id: string | null;
  question: string;
  status: EscalationStatus;
  response: string | null;
  edited_data: Record<string, unknown> | null;
  source: EscalationSource;
  assignee: EscalationAssignee | null;
  agent_recommendation: string | null;
  inbound_id: string | null;
  thread_id: string | null;
  fulfillment_hold_kind?: "outage" | "provider_config" | "ambiguous" | null;
  fulfillment_supplier?: string | null;
  review_kind: string | null;
  severity: ReviewSeverity;
  dedupe_key: string | null;
  target_type: string | null;
  target_id: string | null;
  why_human: string | null;
  evidence: Record<string, unknown>;
  available_actions: ReviewAction[];
  review_due_at: Date | null;
  occurrence_count: number;
  last_seen_at: Date;
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
  resolution_error?: string | null;
}

export async function createEscalation(args: {
  transaction_id: string | null;
  question: string;
  source: EscalationSource;
  status?: EscalationStatus;
  assignee?: EscalationAssignee | null;
  inbound_id?: string | null;
  agent_recommendation?: string | null;
  review_kind?: string | null;
  severity?: ReviewSeverity;
  dedupe_key?: string | null;
  target_type?: string | null;
  target_id?: string | null;
  why_human?: string | null;
  evidence?: Record<string, unknown>;
  available_actions?: ReviewAction[];
  review_due_at?: Date | null;
}, existingDb?: Queryable): Promise<EscalationRow> {
  const id = randomUUID();
  const severity = args.severity ?? "warning";
  const reviewKind = args.review_kind
    ?? (args.source === "pre_execute" ? "pre_execute_resolution" : "unclassified_review");
  const targetType = args.target_type
    ?? (args.source === "pre_execute" ? "pre_execute_escalation" : "escalation");
  const targetId = args.target_id ?? id;
  const dueHours = severity === "critical" ? 4 : severity === "info" ? 72 : 24;
  const evidence = {
    version: 1,
    ...(args.review_kind ? {} : { classificationRequired: true }),
    ...(args.evidence ?? {}),
  };
  const work = async (db: Queryable) => {
    const result = await db.query<EscalationRow>(
      `INSERT INTO escalations
         (id, transaction_id, question, source, status, assignee, inbound_id,
          agent_recommendation, review_kind, severity, dedupe_key, target_type,
          target_id, why_human, evidence, available_actions, review_due_at)
       VALUES ($1,$2,$3,$4,COALESCE($5,'pending'),$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (dedupe_key)
         WHERE dedupe_key IS NOT NULL
           AND status IN (
             'pending','in_agent_review','awaiting_human',
             'resolution_queued','rejection_queued','resolution_executing',
             'resolution_result_ready','resolution_attention'
           )
       DO UPDATE SET
         occurrence_count = escalations.occurrence_count + 1,
         last_seen_at = now(),
         evidence = EXCLUDED.evidence,
         available_actions = EXCLUDED.available_actions,
         review_due_at = EXCLUDED.review_due_at
       RETURNING *`,
      [
        id,
        args.transaction_id,
        protectEscalationText(id, "question", args.question),
        args.source,
        args.status ?? null,
        args.assignee ?? null,
        args.inbound_id ?? null,
        protectEscalationText(id, "agent_recommendation", args.agent_recommendation),
        reviewKind,
        severity,
        args.dedupe_key ?? `unclassified-review:${id}`,
        targetType,
        targetId,
        args.why_human
          ?? "Automation stopped at a human-authority boundary and needs an operator decision.",
        // JSONB columns are bound as JSON text, matching every other JSONB
        // write in this repo (services.jurisdictions, skills.tags, …). Handing
        // node-pg a JS array instead serializes it as a POSTGRES ARRAY literal:
        // a non-empty array becomes {"{\"label\":…}"} and the insert dies with
        // `invalid input syntax for type json`, while an empty one lands as the
        // object `{}` rather than `[]`.
        JSON.stringify(evidence),
        JSON.stringify(args.available_actions ?? []),
        args.review_due_at ?? new Date(Date.now() + dueHours * 3_600_000),
      ],
    );
    const row = result.rows[0];
    if (row.status === "in_agent_review" && row.assignee === "operator_agent") {
      const job = await enqueueDurableJob({
        queue: OPERATOR_ESCALATION_QUEUE,
        idempotencyKey: row.id,
        payload: { escalationId: row.id },
        maxAttempts: 8,
        db,
      });
      await db.query(
        `UPDATE escalations SET operator_dispatch_job_id=$2 WHERE id=$1`,
        [row.id, job.id],
      );
      await recordMandatoryAudit(db, {
        transactionId: row.transaction_id ?? undefined,
        source: "system",
        type: "review.operator_triage.queued",
        message: "Queued an email-triage review for bounded operator-agent processing.",
        payload: { escalationId: row.id, jobId: job.id },
      });
    }
    return revealEscalationFields(row);
  };
  return existingDb ? work(existingDb) : inTransaction(pool, work);
}

/// Protected fund-holding escalations still 'pending' past a cutoff. Each one parks a
/// PAID transaction in 'working' with the buyer's funds captured, so the
/// timeout worker (engine/escalationTimeout.ts) auto-refunds + rejects them
/// rather than holding funds indefinitely. Provider-configuration holds use
/// the same backstop; ambiguous supplier outcomes remain excluded.
///
/// SCOPE GUARD: this positive source filter is load-bearing. Human-only,
/// post-supplier-spend, ambiguous-outcome, and compliance reviews must never
/// be auto-resolved with a refund. Widen this WHERE clause only after proving
/// that invariant remains intact.
export async function getStalePendingEscalations(
  olderThan: Date,
  limit = 50,
): Promise<EscalationRow[]> {
  const result = await pool.query(
    `SELECT * FROM escalations
      WHERE status = 'pending'
        AND (
          source = 'pre_execute'
          OR (source = 'fulfillment_hold' AND fulfillment_hold_kind = 'provider_config')
        )
        AND transaction_id IS NOT NULL
        AND created_at < $1
      ORDER BY created_at
      LIMIT $2`,
    [olderThan, limit],
  );
  return (result.rows as EscalationRow[]).map(revealEscalationFields);
}

/** Agent turns that ended without a disposition must be surfaced, not parked forever. */
export async function getStaleAgentReviewEscalations(
  olderThan: Date,
  limit = 50,
): Promise<EscalationRow[]> {
  const result = await pool.query(
    `SELECT * FROM escalations
      WHERE status = 'in_agent_review' AND created_at < $1
      ORDER BY created_at LIMIT $2`,
    [olderThan, limit],
  );
  return (result.rows as EscalationRow[]).map(revealEscalationFields);
}

export async function getEscalationById(id: string): Promise<EscalationRow | null> {
  const result = await pool.query(`SELECT * FROM escalations WHERE id = $1`, [id]);
  const row = result.rows[0] as EscalationRow | undefined;
  return row ? revealEscalationFields(row) : null;
}

export async function listEscalationsForTransaction(
  transactionId: string,
): Promise<EscalationRow[]> {
  const result = await pool.query(
    `SELECT * FROM escalations WHERE transaction_id = $1 ORDER BY created_at`,
    [transactionId],
  );
  return (result.rows as EscalationRow[]).map(revealEscalationFields);
}

/// True when a pre-execute review decision for this transaction is being
/// (or is about to be) executed by the resolution worker. Cancellation must
/// not proceed underneath it — the decision may dispatch supplier work.
export async function hasActiveResolutionForTransaction(
  transactionId: string,
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM escalations
      WHERE transaction_id = $1
        AND status IN ('resolution_queued','rejection_queued',
                       'resolution_executing','resolution_result_ready')
      LIMIT 1`,
    [transactionId],
  );
  return result.rows.length > 0;
}

/// Cancellation support: conditionally close every still-PENDING pre-execute
/// review on the transaction so a later approval can never execute a task
/// the buyer already canceled. CAS on status='pending' — a review that a
/// concurrent operator decision already claimed is left alone (the caller
/// re-checks hasActiveResolutionForTransaction and aborts the cancel).
/// Deliberately bypasses the resolution worker: there is no decision to
/// execute and the cancellation path owns the refund.
export async function invalidatePendingPreExecuteReviews(
  transactionId: string,
  resolvedBy: string,
): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    `UPDATE escalations
        SET status      = 'rejected',
            resolved_at = now(),
            resolved_by = $2
      WHERE transaction_id = $1
        AND source = 'pre_execute'
        AND status = 'pending'
      RETURNING id`,
    [transactionId, resolvedBy],
  );
  return result.rows.map((row) => row.id);
}

/// Bind an escalation to its chat thread (created when the Operator Agent
/// surfaces it to a human, or eagerly by the runner).
export async function setEscalationThread(
  id: string,
  threadId: string,
  db: Queryable = pool,
): Promise<void> {
  await db.query(`UPDATE escalations SET thread_id = $2 WHERE id = $1`, [id, threadId]);
}

/// Operator Agent surfaced the escalation: park it for a human and record
/// its recommended action. Only valid from in_agent_review.
export async function markEscalationAwaitingHuman(args: {
  id: string;
  agent_recommendation: string;
}): Promise<EscalationRow | null> {
  const result = await pool.query(
    `UPDATE escalations
        SET status = 'awaiting_human',
            agent_recommendation = $2
      WHERE id = $1 AND status = 'in_agent_review'
      RETURNING *`,
    [args.id, protectEscalationText(args.id, "agent_recommendation", args.agent_recommendation)],
  );
  const row = result.rows[0] as EscalationRow | undefined;
  return row ? revealEscalationFields(row) : null;
}

/// Close an escalation and its bound chat thread from any open agent/human
/// status.
export async function closeEscalation(args: {
  id: string;
  status: "resolved" | "rejected";
  resolved_by: string;
  response?: string | null;
  requireOutboundReply?: boolean;
}, existingDb?: Queryable): Promise<EscalationRow | null> {
  const work = async (db: Queryable) => {
    const result = await db.query<EscalationRow>(
      `UPDATE escalations e
          SET status      = $2,
              response    = COALESCE($3, response),
              resolved_at = now(),
              resolved_by = $4
        WHERE id = $1
          AND status IN (
            'in_agent_review','awaiting_human','pending','resolution_attention'
          )
          AND source NOT IN ('pre_execute','fulfillment_hold')
          AND (
            $5::boolean = false
            OR (
              e.inbound_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM emails_outbound eo
                 WHERE eo.inbound_id=e.inbound_id AND eo.sent_at>=e.created_at
              )
            )
          )
        RETURNING *`,
      [
        args.id,
        args.status,
        protectEscalationText(args.id, "response", args.response),
        args.resolved_by,
        args.requireOutboundReply ?? false,
      ],
    );
    const closed = result.rows[0];
    if (!closed) return null;
    await db.query(
      `UPDATE chat_threads
          SET status = $2, updated_at = now()
        WHERE escalation_id = $1 AND status <> $2`,
      [closed.id, args.status],
    );
    return closed;
  };
  const row = existingDb ? await work(existingDb) : await inTransaction(pool, work);
  return row ? revealEscalationFields(row) : null;
}

export async function closeOpenReviewsForTarget(args: {
  targetType: string;
  targetId: string;
  resolvedBy: string;
  response: string;
  reviewKind?: string;
}, existingDb?: Queryable): Promise<string[]> {
  const work = async (db: Queryable) => {
    const result = await db.query<{ id: string }>(
      `SELECT id FROM escalations
        WHERE target_type = $1 AND target_id = $2
          AND ($3::text IS NULL OR review_kind = $3)
          AND status IN ('pending','in_agent_review','awaiting_human','resolution_attention')
        ORDER BY created_at`,
      [
        args.targetType,
        args.targetId,
        args.reviewKind ?? null,
      ],
    );
    const closed: string[] = [];
    for (const row of result.rows) {
      const updated = await closeEscalation({
        id: row.id,
        status: "resolved",
        resolved_by: args.resolvedBy,
        response: args.response,
      }, db);
      if (updated) closed.push(updated.id);
    }
    return closed;
  };
  return existingDb ? work(existingDb) : inTransaction(pool, work);
}

/// All escalations still needing attention (pending + in_agent_review +
/// awaiting_human). Used by the Operator Agent's list tool and the Home
/// list so two-tier escalations show up alongside legacy pre-execute ones.
export async function listOpenEscalations(args: {
  limit?: number;
} = {}): Promise<EscalationRow[]> {
  const result = await pool.query(
    `SELECT * FROM escalations
      WHERE status IN (
        'pending','in_agent_review','awaiting_human',
        'resolution_queued','rejection_queued','resolution_executing',
        'resolution_result_ready','resolution_attention'
      )
      ORDER BY created_at
      LIMIT $1`,
    [args.limit ?? 100],
  );
  return (result.rows as EscalationRow[]).map(revealEscalationFields);
}

export async function countOpenEscalations(): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS n FROM escalations
      WHERE status IN (
        'pending','in_agent_review','awaiting_human',
        'resolution_queued','rejection_queued','resolution_executing',
        'resolution_result_ready','resolution_attention'
      )`,
  );
  return (result.rows[0] as { n: number }).n;
}

export interface ReviewQueueMetrics {
  open: number;
  overdue: number;
  critical: number;
  deduplicatedOccurrences: number;
}

export async function getReviewQueueMetrics(): Promise<ReviewQueueMetrics> {
  const result = await pool.query<ReviewQueueMetrics>(
    `SELECT
       COUNT(*)::int AS open,
       COUNT(*) FILTER (WHERE review_due_at < now())::int AS overdue,
       COUNT(*) FILTER (WHERE severity = 'critical')::int AS critical,
       COALESCE(SUM(occurrence_count - 1), 0)::int AS "deduplicatedOccurrences"
     FROM escalations
     WHERE status IN (
       'pending','in_agent_review','awaiting_human',
       'resolution_queued','rejection_queued','resolution_executing',
       'resolution_result_ready','resolution_attention'
     )`,
  );
  return result.rows[0]!;
}

export interface EscalationListItem extends EscalationRow {
  service_slug: string | null;
}

/// Open escalations for the Home list, resolved to a service slug via the
/// linked transaction or inbound email. Awaiting-human sorts first, then
/// pending, then in-agent-review; newest first within each band. Closed
/// escalations (resolved/rejected/approved/edited) are excluded.
export async function listEscalationsForHome(
  limit = 15,
): Promise<EscalationListItem[]> {
  const result = await pool.query(
    `SELECT e.*, s.slug AS service_slug
       FROM escalations e
       LEFT JOIN transactions t  ON t.id  = e.transaction_id
       LEFT JOIN emails_inbound ie ON ie.id = e.inbound_id
       LEFT JOIN services s ON s.id = COALESCE(t.service_id, ie.service_id)
      WHERE e.status IN (
        'pending','in_agent_review','awaiting_human',
        'resolution_queued','rejection_queued','resolution_executing',
        'resolution_result_ready','resolution_attention'
      )
      ORDER BY
        CASE e.status
          WHEN 'resolution_attention' THEN 0
          WHEN 'awaiting_human'  THEN 1
          WHEN 'pending'         THEN 2
          WHEN 'in_agent_review' THEN 3
          ELSE 3
        END,
        e.created_at DESC
      LIMIT $1`,
    [limit],
  );
  return (result.rows as EscalationListItem[]).map(revealEscalationFields);
}
