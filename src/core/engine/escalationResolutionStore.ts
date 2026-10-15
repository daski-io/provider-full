import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { enqueueDurableJob } from "../db/queries/durableJobs.js";
import type { EscalationRow } from "../db/queries/escalations.js";
import type { AssetRow } from "../db/queries/assets.js";
import type { ServiceRow } from "../db/queries/services.js";
import type { SkillRow } from "../db/queries/skills.js";
import type { TransactionRow } from "../db/queries/transactions.js";
import { inTransaction, type Queryable } from "../db/queryable.js";
import { recordMandatoryAudit } from "../events/emitter.js";
import { redactSensitiveText } from "../security/redaction.js";
import {
  protectEscalationText,
  revealEscalationFields,
} from "../security/escalationProtection.js";
import {
  buildExecutionSnapshot,
  hashCanonical,
  openExecutionSnapshot,
  openReviewEvidence,
  sealExecutionSnapshot,
  sealReviewEvidence,
  validateAndMergeReviewerEdits,
  type SnapshotEvidenceRow,
} from "./escalationSnapshot.js";
import { assertReviewedRequestAdmitted } from "./escalationRequest.js";

export const ESCALATION_RESOLUTION_QUEUE = "escalation-resolution";

export type PreExecuteDecision = "approved" | "edited" | "rejected";

export interface PreExecuteEscalationRow extends EscalationRow, SnapshotEvidenceRow {
  snapshot_skill_id: string;
  snapshot_asset_id: string | null;
  fulfillment_supplier: string | null;
  fulfillment_hold_kind: "outage" | "provider_config" | "ambiguous" | null;
  fulfillment_resume_at: Date | null;
  fulfillment_attempts: number | null;
  fulfillment_attempt_seq: string;
  reviewer_decision: PreExecuteDecision | null;
  reviewer_actor: string | null;
  resolution_job_id: string | null;
  resolution_claimed_at: Date | null;
  resolution_started_at: Date | null;
  resolution_error: string | null;
}

/** The caller's start step refused the task's escalation; nothing was written. */
export class EscalationStartRefusedError extends Error {
  constructor() {
    super("The task's escalation was refused its start");
    this.name = "EscalationStartRefusedError";
  }
}

export async function createPreExecuteEscalation(args: {
  transaction: TransactionRow;
  service: ServiceRow;
  skill: SkillRow;
  asset: AssetRow | null;
  requestData: Record<string, unknown>;
  question: string;
  /**
   * Moves the task from submitted to working inside the escalation's own
   * transaction, under the caller's conditions (a funded standard order's
   * start fence); false refuses the escalation with
   * EscalationStartRefusedError. Without it a submitted task starts here
   * and a working one escalates as it is.
   */
  claimStart?: (db: Queryable) => Promise<boolean>;
}): Promise<PreExecuteEscalationRow> {
  if (args.transaction.service_id !== args.service.id ||
      args.transaction.skill_id !== args.skill.skill_id ||
      args.skill.service_id !== args.service.id ||
      (args.asset && args.asset.service_id !== args.service.id)) {
    throw new Error("pre-execute escalation context does not match transaction");
  }
  const id = randomUUID();
  const snapshot = buildExecutionSnapshot({
    transactionId: args.transaction.id,
    customerId: args.transaction.customer_id,
    requestData: args.requestData,
    service: args.service,
    skill: args.skill,
    asset: args.asset,
  });
  const sealed = sealExecutionSnapshot(id, snapshot);
  return inTransaction(pool, async (db) => {
    const locked = await db.query<{
      service_id: string;
      skill_id: string;
      customer_id: string | null;
      status: string;
      canonical_request_hash: Buffer | null;
      standard_order_id: string | null;
      asset_id: string | null;
      standard_action_execution_id: Buffer | null;
    }>(
      `SELECT service_id, skill_id, customer_id, status, canonical_request_hash, standard_order_id,
              asset_id, standard_action_execution_id
         FROM transactions WHERE id = $1 FOR UPDATE`,
      [args.transaction.id],
    );
    const task = locked.rows[0];
    if (!task || task.service_id !== args.service.id ||
        task.skill_id !== args.skill.skill_id || task.customer_id !== args.transaction.customer_id) {
      throw new Error("transaction changed before escalation snapshot was persisted");
    }
    await assertReviewedRequestAdmitted(db, { ...task, id: args.transaction.id }, args.requestData);
    if (args.claimStart) {
      if (!await args.claimStart(db)) throw new EscalationStartRefusedError();
    } else if (task.status === "submitted") {
      const transitioned = await db.query(
        `UPDATE transactions
            SET status = 'working', updated_at = now(), version = version + 1
          WHERE id = $1 AND status = 'submitted'
          RETURNING id`,
        [args.transaction.id],
      );
      if (transitioned.rowCount !== 1) {
        throw new Error("transaction lost its escalation transition claim");
      }
    } else if (task.status !== "working") {
      throw new Error(`cannot escalate transaction in ${task.status}`);
    }
    // The review's target id is the escalation id as text: one parameter
    // bound to both the uuid and the text column would be refused.
    const result = await db.query<PreExecuteEscalationRow>(
      `INSERT INTO escalations (
         id, transaction_id, question, source, status,
         execution_snapshot_encrypted, execution_snapshot_hash, request_hash,
         snapshot_version, snapshot_service_id, snapshot_skill_id, snapshot_asset_id,
         review_kind, severity, dedupe_key, target_type, target_id, why_human,
         evidence, available_actions, review_due_at
       ) VALUES (
         $1,$2,$3,'pre_execute','pending',$4,$5,$6,1,$7,$8,$9,
         'pre_execute_resolution','warning',$10,'pre_execute_escalation',$13,
         'A pre-execution policy rule requires a human decision before supplier dispatch.',
         $11::jsonb,$12::jsonb,now() + interval '24 hours'
       )
       RETURNING *`,
      [
        id,
        args.transaction.id,
        protectEscalationText(id, "question", args.question),
        sealed.encrypted,
        sealed.snapshotHash,
        snapshot.requestHash,
        args.service.id,
        args.skill.skill_id,
        args.asset?.id ?? null,
        `pre-execute:${args.transaction.id}`,
        JSON.stringify({
          version: 1,
          transactionId: args.transaction.id,
          serviceSlug: args.service.slug,
          skillId: args.skill.skill_id,
          snapshotHash: sealed.snapshotHash,
        }),
        JSON.stringify([
          {
            label: "Prepare approval",
            value: `Prepare approval for pre-execute review ${id}.`,
            effect: "Queues durable execution after exact browser approval.",
          },
          {
            label: "Prepare approval with edits",
            value:
              `Prepare approval with edits for pre-execute review ${id}. `
              + "Ask me for the exact field changes if I have not supplied them.",
            effect:
              "Validates the edits against the protected snapshot, then queues the "
              + "approved immutable edit set.",
          },
          {
            label: "Prepare rejection",
            value: `Prepare rejection for pre-execute review ${id}.`,
            effect: "Rejects through the durable resolution pipeline.",
          },
        ]),
        id,
      ],
    );
    await recordMandatoryAudit(db, {
      transactionId: args.transaction.id,
      assetId: args.asset?.id,
      serviceId: args.service.id,
      source: "system",
      type: "escalation.snapshot.created",
      message: "Created protected pre-execute review snapshot",
      payload: { escalationId: id, snapshotHash: sealed.snapshotHash, requestHash: snapshot.requestHash },
    });
    await recordMandatoryAudit(db, {
      transactionId: args.transaction.id,
      serviceId: args.service.id,
      source: "adapter",
      type: "transaction.message.agent",
      message: "Pending human review",
      payload: { role: "agent", content: "Pending human review" },
    });
    await recordMandatoryAudit(db, {
      transactionId: args.transaction.id,
      assetId: args.asset?.id,
      serviceId: args.service.id,
      source: "llm",
      type: "llm.preexecute.escalate",
      message: "Pre-execute review requested protected human evaluation.",
      payload: { outcome: "escalated", escalationId: id },
    });
    return revealEscalationFields(result.rows[0]);
  });
}

export interface ResolutionClaimResult {
  claimed: boolean;
  escalationId: string;
  transactionId: string | null;
  status: string;
}

export async function retryResolutionAttention(args: {
  escalationId: string;
  actor: string;
}): Promise<boolean> {
  if (!args.actor.trim()) throw new Error("review actor is required");
  return inTransaction(pool, async (db) => {
    const selected = await db.query<PreExecuteEscalationRow>(
      "SELECT * FROM escalations WHERE id=$1 FOR UPDATE",
      [args.escalationId],
    );
    const row = selected.rows[0];
    if (!row || row.status !== "resolution_attention" ||
        !["pre_execute", "fulfillment_hold"].includes(row.source) ||
        !row.reviewer_decision) return false;
    openExecutionSnapshot(row);
    openReviewEvidence(row);
    const queuedState = row.reviewer_decision === "rejected"
      ? "rejection_queued"
      : "resolution_queued";
    const job = await enqueueDurableJob({
      queue: ESCALATION_RESOLUTION_QUEUE,
      idempotencyKey: `${row.id}:operator-retry:${randomUUID()}`,
      payload: { escalationId: row.id },
      maxAttempts: 100,
      db,
    });
    const updated = await db.query(
      `UPDATE escalations SET status=$2,resolution_job_id=$3,resolution_error=NULL,
          resolution_claimed_at=now(),resolution_started_at=NULL,updated_at=now()
        WHERE id=$1 AND status='resolution_attention'`,
      [row.id, queuedState, job.id],
    );
    if (updated.rowCount !== 1) throw new Error("review retry claim was lost");
    await recordMandatoryAudit(db, {
      transactionId: row.transaction_id ?? undefined,
      serviceId: row.snapshot_service_id,
      assetId: row.snapshot_asset_id ?? undefined,
      source: "admin",
      actor: args.actor,
      type: "review.resolution.retried",
      message: "An operator requeued a protected review resolution.",
      payload: { escalationId: row.id, jobId: job.id, decision: row.reviewer_decision },
    });
    return true;
  });
}

/** Atomically requeue every provider-config hold when credentials are saved. */
export async function queueProviderConfigHoldRetries(args: {
  supplier: string;
  actor: string;
  db: Queryable;
}): Promise<number> {
  const selected = await args.db.query<PreExecuteEscalationRow>(
    `SELECT * FROM escalations
      WHERE source = 'fulfillment_hold'
        AND fulfillment_hold_kind = 'provider_config'
        AND fulfillment_supplier = $1
        AND status = 'pending'
      ORDER BY created_at
      FOR UPDATE`,
    [args.supplier],
  );
  let queued = 0;
  for (const row of selected.rows) {
    openExecutionSnapshot(row);
    const binding = {
      decision: "approved" as const,
      actor: "system:credential-repair",
      response: `Supplier credentials were updated by ${args.actor}; retry dispatch.`,
      editsHash: null,
      snapshotHash: row.execution_snapshot_hash,
    };
    const evidence = sealReviewEvidence({ row, binding });
    const updated = await args.db.query<PreExecuteEscalationRow>(
      `UPDATE escalations SET
         status = 'resolution_queued', response = $2,
         reviewer_decision = 'approved', reviewer_actor = $3,
         reviewer_edits_encrypted = NULL, reviewer_edits_hash = NULL,
         review_binding_encrypted = $4, review_binding_hash = $5,
         resolution_claimed_at = now(), resolution_error = NULL,
         fulfillment_resume_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'pending'
         AND source = 'fulfillment_hold'
         AND fulfillment_hold_kind = 'provider_config'
       RETURNING *`,
      [
        row.id,
        protectEscalationText(
          row.id,
          "response",
          "Supplier credentials were updated; fulfillment retry was queued.",
        ),
        binding.actor,
        evidence.bindingEncrypted,
        evidence.bindingHash,
      ],
    );
    if (!updated.rows[0]) continue;
    const job = await enqueueDurableJob({
      queue: ESCALATION_RESOLUTION_QUEUE,
      idempotencyKey: `${row.id}:${randomUUID()}`,
      payload: { escalationId: row.id },
      maxAttempts: 100,
      db: args.db,
    });
    await args.db.query(
      "UPDATE escalations SET resolution_job_id = $2 WHERE id = $1",
      [row.id, job.id],
    );
    await recordMandatoryAudit(args.db, {
      transactionId: row.transaction_id ?? undefined,
      serviceId: row.snapshot_service_id,
      assetId: row.snapshot_asset_id ?? undefined,
      source: "admin",
      actor: args.actor,
      type: "fulfillment.hold.credentials_repaired",
      message: "Provider configuration was updated and held fulfillment was requeued.",
      payload: {
        escalationId: row.id,
        supplier: args.supplier,
        reviewBindingHash: evidence.bindingHash,
      },
    });
    queued += 1;
  }
  return queued;
}

export async function claimPreExecuteResolution(args: {
  escalationId: string;
  decision: PreExecuteDecision;
  actor: string;
  response?: string;
  editedData?: Record<string, unknown>;
}): Promise<ResolutionClaimResult> {
  if (!args.actor.trim()) throw new Error("review actor is required");
  return inTransaction(pool, async (db) => {
    const selected = await db.query<PreExecuteEscalationRow>(
      `SELECT * FROM escalations WHERE id = $1 FOR UPDATE`,
      [args.escalationId],
    );
    const row = selected.rows[0];
    if (!row) throw new Error(`escalation ${args.escalationId} not found`);
    if (row.source !== "pre_execute" && row.source !== "fulfillment_hold") {
      throw new Error("resolution service only accepts protected execution escalations");
    }
    if (row.status !== "pending") {
      return { claimed: false, escalationId: row.id, transactionId: row.transaction_id, status: row.status };
    }
    if (!row.transaction_id) throw new Error("protected execution escalation has no transaction");
    if (
      row.source === "fulfillment_hold"
      && row.fulfillment_hold_kind === "ambiguous"
    ) {
      throw new Error("ambiguous supplier outcomes require reconciliation before resolution");
    }
    const snapshot = openExecutionSnapshot(row);
    if (args.decision === "edited" && !args.editedData) throw new Error("edited decision requires reviewer edits");
    if (args.decision !== "edited" && args.editedData) throw new Error("reviewer edits require an edited decision");
    validateAndMergeReviewerEdits(snapshot, args.editedData);
    const editsHash = args.editedData ? hashCanonical(args.editedData) : null;
    const binding = {
      decision: args.decision,
      actor: args.actor,
      response: args.response ?? "",
      editsHash,
      snapshotHash: row.execution_snapshot_hash,
    } as const;
    const evidence = sealReviewEvidence({ row, binding, edits: args.editedData });
    const nextStatus = args.decision === "rejected" ? "rejection_queued" : "resolution_queued";
    const updated = await db.query<PreExecuteEscalationRow>(
      `UPDATE escalations SET
         status = $2, response = $3, reviewer_decision = $4, reviewer_actor = $5,
         reviewer_edits_encrypted = $6, reviewer_edits_hash = $7,
         review_binding_encrypted = $8, review_binding_hash = $9,
         resolution_claimed_at = now(), resolution_error = NULL
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [
        row.id,
        nextStatus,
        protectEscalationText(
          row.id,
          "response",
          args.response ? "Reviewer note retained in protected review evidence." : null,
        ),
        args.decision,
        args.actor,
        evidence.editsEncrypted,
        evidence.editsHash,
        evidence.bindingEncrypted,
        evidence.bindingHash,
      ],
    );
    if (!updated.rows[0]) {
      return { claimed: false, escalationId: row.id, transactionId: row.transaction_id, status: "lost_claim" };
    }
    const job = await enqueueDurableJob({
      queue: ESCALATION_RESOLUTION_QUEUE,
      idempotencyKey: row.source === "fulfillment_hold"
        ? `${row.id}:${randomUUID()}`
        : row.id,
      payload: { escalationId: row.id },
      ...(row.source === "fulfillment_hold" ? { maxAttempts: 100 } : {}),
      db,
    });
    await db.query(`UPDATE escalations SET resolution_job_id = $2 WHERE id = $1`, [row.id, job.id]);
    await recordMandatoryAudit(db, {
      transactionId: row.transaction_id,
      assetId: row.snapshot_asset_id ?? undefined,
      serviceId: row.snapshot_service_id,
      source: "admin",
      actor: args.actor,
      type: "escalation.resolution.claimed",
      message: `Claimed pre-execute review as ${args.decision}`,
      payload: {
        escalationId: row.id,
        decision: args.decision,
        snapshotHash: row.execution_snapshot_hash,
        editsHash,
      },
    });
    return { claimed: true, escalationId: row.id, transactionId: row.transaction_id, status: nextStatus };
  });
}

export async function getPreExecuteResolution(id: string): Promise<PreExecuteEscalationRow | null> {
  const result = await pool.query<PreExecuteEscalationRow>(`SELECT * FROM escalations WHERE id = $1`, [id]);
  return result.rows[0] ? revealEscalationFields(result.rows[0]) : null;
}

export async function startResolutionExecution(id: string): Promise<PreExecuteEscalationRow | null> {
  const result = await pool.query<PreExecuteEscalationRow>(
    `UPDATE escalations SET status = 'resolution_executing', resolution_started_at = now(), resolution_error = NULL
      WHERE id = $1 AND status IN ('resolution_queued','rejection_queued') RETURNING *`,
    [id],
  );
  return result.rows[0] ? revealEscalationFields(result.rows[0]) : null;
}

export async function saveResolutionAdapterResult(
  id: string,
  encrypted: string,
  hash: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE escalations SET status = 'resolution_result_ready',
       adapter_result_encrypted = $2, adapter_result_hash = $3
     WHERE id = $1 AND status = 'resolution_executing' AND reviewer_decision IN ('approved','edited')`,
    [id, encrypted, hash],
  );
  return result.rowCount === 1;
}

export async function finalizeResolution(
  id: string,
  finalStatus: PreExecuteDecision,
): Promise<boolean> {
  const allowed = finalStatus === "rejected"
    ? ["resolution_executing"]
    : ["resolution_result_ready"];
  const result = await pool.query(
    `UPDATE escalations SET status = $2, resolved_at = now(), resolved_by = reviewer_actor,
       resolution_error = NULL
     WHERE id = $1 AND status = ANY($3::text[]) AND reviewer_decision = $2`,
    [id, finalStatus, allowed],
  );
  return result.rowCount === 1;
}

export async function finalizeStandardActionResolution(
  id: string,
  finalStatus: PreExecuteDecision,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE escalations e SET status=$2,resolved_at=now(),resolved_by=reviewer_actor,
            resolution_error=NULL,updated_at=now()
      WHERE e.id=$1 AND e.status='resolution_executing' AND e.reviewer_decision=$2
        AND EXISTS (
          SELECT 1 FROM transactions t
          JOIN standard_asset_action_executions a
            ON a.execution_id=t.standard_action_execution_id
          WHERE t.id=e.transaction_id
            AND a.state IN ('completed','failed')
            AND ($2::text<>'rejected' OR a.state='failed')
        )`,
    [id, finalStatus],
  );
  return result.rowCount === 1;
}

export async function markResolutionAttention(id: string, error: string): Promise<void> {
  await pool.query(
    `UPDATE escalations SET status = 'resolution_attention', resolution_error = $2
      WHERE id = $1 AND status NOT IN ('approved','edited','rejected')`,
    [
      id,
      protectEscalationText(
        id,
        "resolution_error",
        redactSensitiveText(error).slice(0, 2_000),
      ),
    ],
  );
}
