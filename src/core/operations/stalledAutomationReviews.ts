import { pool } from "../db/pool.js";
import { closeEscalation } from "../db/queries/escalations.js";
import { inTransaction } from "../db/queryable.js";
import { createHumanEscalation } from "../engine/escalation.js";

export const STALLED_AUTOMATION_REVIEW_KIND = "stalled_automation";
export const DURABLE_JOB_TARGET_TYPE = "durable_job";

const OPEN_REVIEW_STATES =
  "'pending','in_agent_review','awaiting_human','resolution_attention'";
const SELF_SURFACING_QUEUES = ["operator-escalation", "escalation-resolution"];
const QUEUE_LABELS: Record<string, string> = {
  "email-ingress": "Inbound email processing",
};

function queueLabel(queue: string): string {
  return QUEUE_LABELS[queue] ?? queue.replaceAll(/[-_]/g, " ");
}

interface DeadLetterRow {
  id: string;
  queue: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface StalledAutomationReconciliation {
  opened: number;
  closed: number;
}

export async function reconcileStalledAutomationReviews(
  limit = 50,
): Promise<StalledAutomationReconciliation> {
  return inTransaction(pool, async (db) => {
    const recovered = await db.query<{ id: string; status: string }>(
      `SELECT e.id,j.status
         FROM escalations e
         JOIN durable_jobs j ON j.id::text = e.target_id
        WHERE e.review_kind = $1
          AND e.target_type = $2
          AND e.status IN (${OPEN_REVIEW_STATES})
          AND j.status <> 'dead_letter'
        ORDER BY e.created_at
        FOR UPDATE OF e SKIP LOCKED
        LIMIT $3`,
      [STALLED_AUTOMATION_REVIEW_KIND, DURABLE_JOB_TARGET_TYPE, limit],
    );
    let closed = 0;
    for (const review of recovered.rows) {
      const result = await closeEscalation({
        id: review.id,
        status: "resolved",
        resolved_by: "system",
        response: review.status === "completed"
          ? "The automation completed successfully."
          : "The automation returned to its durable worker.",
      }, db);
      if (result) closed += 1;
    }

    const stalled = await db.query<DeadLetterRow>(
      `SELECT id,queue,attempts,max_attempts,last_error,created_at,updated_at
         FROM durable_jobs
        WHERE status = 'dead_letter'
          AND dead_letter_surfaced_at IS NULL
          AND NOT (queue = ANY($1::text[]))
        ORDER BY updated_at
        FOR UPDATE SKIP LOCKED
        LIMIT $2`,
      [SELF_SURFACING_QUEUES, limit],
    );
    let opened = 0;
    for (const job of stalled.rows) {
      const claimed = await db.query(
        `UPDATE durable_jobs SET dead_letter_surfaced_at=now()
          WHERE id=$1 AND status='dead_letter' AND dead_letter_surfaced_at IS NULL`,
        [job.id],
      );
      if (claimed.rowCount !== 1) continue;
      const label = queueLabel(job.queue);
      const error = job.last_error
        ? ` Last safe error: ${job.last_error}`
        : "";
      await createHumanEscalation({
        source: "auto",
        question: `${label} stopped and needs a retry decision.`,
        title: "Automation stopped",
        summary:
          `This background task exhausted ${job.attempts} of `
          + `${job.max_attempts} attempts.${error}`,
        review: {
          kind: STALLED_AUTOMATION_REVIEW_KIND,
          severity: "critical",
          dedupeKey: `stalled-automation:${job.id}`,
          target: { type: DURABLE_JOB_TARGET_TYPE, id: job.id },
          whyHuman:
            "The durable retry budget is exhausted. Automation will not run this job again "
            + "without an explicit operator decision.",
          evidence: {
            version: 1,
            jobId: job.id,
            queue: job.queue,
            attempts: job.attempts,
            maxAttempts: job.max_attempts,
            createdAt: job.created_at.toISOString(),
            stoppedAt: job.updated_at.toISOString(),
          },
        },
        suggestedActions: [{
          label: "Retry automation",
          value: JSON.stringify({
            tool: "retry_stalled_automation",
            arguments: { job_id: job.id },
          }),
          effect: "Resets this exact job's retry budget and returns it to its durable worker.",
        }],
      }, db);
      opened += 1;
    }
    return { opened, closed };
  });
}
