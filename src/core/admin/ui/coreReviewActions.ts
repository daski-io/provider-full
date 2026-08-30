import {
  closeEscalation,
  getEscalationById,
} from "../../db/queries/escalations.js";
import { pool } from "../../db/pool.js";
import { inTransaction } from "../../db/queryable.js";
import { recordMandatoryAudit } from "../../events/emitter.js";
import { replaceProviderWriteWithBoundedFee } from "../../chain/providerWriteCoordinator.js";
import type { ReviewActionTool } from "./reviewActionTools.js";
import type { OperatorTool } from "../../agents/operatorAgent/tools/shared.js";
import {
  abortReputationOutcomeTool,
  reconcileReputationOutcomeTool,
  retryReputationOutcomeOnceTool,
} from "../../agents/operatorAgent/tools/reputation.js";
import {
  retryStalledAutomationTool,
} from "../../agents/operatorAgent/tools/stalledAutomation.js";

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function asReviewAction(tool: OperatorTool): ReviewActionTool {
  return {
    name: tool.definition.function.name,
    description: tool.definition.function.description,
    execute: tool.execute,
  };
}

async function reviewForContext(escalationId: string | null | undefined) {
  if (!escalationId) throw new Error("review context is required");
  const row = await getEscalationById(escalationId);
  if (!row) throw new Error("review not found");
  if (!["pending", "awaiting_human", "resolution_attention"].includes(row.status)) {
    throw new Error("review is no longer open");
  }
  return row;
}

const closeEmailTriage: ReviewActionTool = {
  name: "close_email_triage",
  description: "Close an email-triage review after a verified reply or an explicit no-action disposition.",
  async execute(args, ctx) {
    if (ctx.directAdminApproval !== true || ctx.mode !== "human") {
      throw new Error("direct review approval is required");
    }
    const row = await reviewForContext(ctx.escalationId);
    if (row.source !== "email_agent" || row.review_kind !== "email_triage" || !row.inbound_id) {
      throw new Error("review is not an email-triage case");
    }
    const disposition = text(args.disposition, "disposition");
    if (disposition !== "replied" && disposition !== "no-action") {
      throw new Error("disposition must be replied or no-action");
    }
    const note = text(args.note, "operator note").slice(0, 2_000);
    if (disposition === "replied") {
      const reply = await pool.query(
        "SELECT 1 FROM emails_outbound WHERE inbound_id=$1 AND sent_at>=$2 LIMIT 1",
        [row.inbound_id, row.created_at],
      );
      if (reply.rowCount !== 1) throw new Error("no outbound reply is recorded for this review");
    }
    await inTransaction(pool, async (db) => {
      const closed = await closeEscalation({
        id: row.id,
        status: "resolved",
        resolved_by: ctx.actor,
        response: note,
      }, db);
      if (!closed) throw new Error("email-triage review changed before closure");
      await recordMandatoryAudit(db, {
        transactionId: row.transaction_id ?? undefined,
        source: "admin",
        actor: ctx.actor,
        type: "review.email_triage.resolved",
        message: "An operator resolved an email-triage review.",
        payload: { escalationId: row.id, inboundId: row.inbound_id, disposition },
      });
    });
    ctx.escalationClosed = true;
    return JSON.stringify({ ok: true, disposition });
  },
};

const resolveOperationalReview: ReviewActionTool = {
  name: "resolve_operational_review",
  description: "Record an explicit disposition for a manual provider-operations review.",
  async execute(args, ctx) {
    if (ctx.directAdminApproval !== true || ctx.mode !== "human") {
      throw new Error("direct review approval is required");
    }
    const row = await reviewForContext(ctx.escalationId);
    if (row.review_kind !== "unclassified_review" || row.source !== "operator") {
      throw new Error("review requires its service-specific resolution action");
    }
    const outcome = text(args.outcome, "outcome");
    if (!["external-action-confirmed", "no-action-required", "supplier-escalated"].includes(outcome)) {
      throw new Error("invalid operational review outcome");
    }
    const note = text(args.note, "operator note").slice(0, 2_000);
    const externalReference = typeof args.externalReference === "string"
      ? args.externalReference.trim().slice(0, 256)
      : "";
    if (outcome !== "no-action-required" && !externalReference) {
      throw new Error("external reference is required for this outcome");
    }
    await inTransaction(pool, async (db) => {
      const closed = await closeEscalation({
        id: row.id,
        status: "resolved",
        resolved_by: ctx.actor,
        response: note,
      }, db);
      if (!closed) throw new Error("operational review changed before closure");
      await recordMandatoryAudit(db, {
        transactionId: row.transaction_id ?? undefined,
        source: "admin",
        actor: ctx.actor,
        type: "review.operations.resolved",
        message: "An operator recorded a manual provider-operations disposition.",
        payload: { escalationId: row.id, source: row.source, outcome, externalReference },
      });
    });
    ctx.escalationClosed = true;
    return JSON.stringify({ ok: true, outcome });
  },
};

const retryProviderNonceGap: ReviewActionTool = {
  name: "retry_provider_nonce_gap",
  description: "Broadcast one bounded same-nonce replacement for the exact reviewed provider write.",
  async execute(args, ctx) {
    if (ctx.directAdminApproval !== true || ctx.mode !== "human") {
      throw new Error("direct review approval is required");
    }
    const row = await reviewForContext(ctx.escalationId);
    if (row.review_kind !== "provider_nonce_gap" ||
        row.target_type !== "provider_chain_write" || !row.target_id) {
      throw new Error("review is not a provider nonce-gap case");
    }
    if (text(args.provider_write_id, "provider write id") !== row.target_id) {
      throw new Error("provider write id does not match the reviewed evidence");
    }
    await replaceProviderWriteWithBoundedFee(row.target_id);
    await recordMandatoryAudit(pool, {
      transactionId: row.transaction_id ?? undefined,
      source: "admin",
      actor: ctx.actor,
      type: "review.provider_nonce_gap.retried",
      message: "An operator authorized one bounded same-nonce provider-write replacement.",
      payload: { escalationId: row.id, providerWriteId: row.target_id },
    });
    return JSON.stringify({ ok: true, replacement_broadcast: true, review_open: true });
  },
};

export function coreReviewActionTools(): ReviewActionTool[] {
  return [
    closeEmailTriage,
    resolveOperationalReview,
    retryProviderNonceGap,
    asReviewAction(reconcileReputationOutcomeTool),
    asReviewAction(retryReputationOutcomeOnceTool),
    asReviewAction(abortReputationOutcomeTool),
    asReviewAction(retryStalledAutomationTool),
  ];
}
