import {
  createEscalation,
  type ReviewAction,
  type ReviewSeverity,
  setEscalationThread,
  type EscalationRow,
  type EscalationSource,
} from "../db/queries/escalations.js";
import {
  getOrCreateEscalationThread,
  getThreadByEscalation,
} from "../db/queries/chatThreads.js";
import { appendOperatorChatMessage } from "../db/queries/operatorChats.js";
import {
  getTransactionById,
  type TransactionRow,
} from "../db/queries/transactions.js";
import type { ServiceRow } from "../db/queries/services.js";
import type { SkillRow } from "../db/queries/skills.js";
import type { AssetRow } from "../db/queries/assets.js";
import { taskEvents } from "./events.js";
import { recordMandatoryAudit } from "../events/emitter.js";
import { createPreExecuteEscalation } from "./escalationResolutionStore.js";
import { pool } from "../db/pool.js";
import { inTransaction, type Queryable } from "../db/queryable.js";

// Escalation lifecycle. v4: escalations live in their own table, one row
// per escalation event. Multiple escalations can accrue on a single
// transaction over its lifetime.

/// Pre-execute LLM hook flagged the request for human review. Inserts an
/// `escalations` row (status='pending') and bridges the transaction to
/// 'working' so the buyer's poll sees activity.
export async function markEscalated(
  transactionId: string,
  reviewQuestion: string,
  context: {
    service: ServiceRow;
    skill: SkillRow;
    requestData: Record<string, unknown>;
    asset: AssetRow | null;
  },
): Promise<TransactionRow> {
  const current = await getTransactionById(transactionId);
  if (!current) {
    throw new Error(`markEscalated: transaction ${transactionId} not found`);
  }
  await createPreExecuteEscalation({
    transaction: current,
    service: context.service,
    skill: context.skill,
    requestData: context.requestData,
    asset: context.asset,
    question: reviewQuestion,
  });
  const after = await getTransactionById(transactionId);
  if (!after) throw new Error(`markEscalated: transaction vanished mid-flow`);
  taskEvents.emitTaskEvent({ type: "escalation-pending", task: after });
  return after;
}

export interface CreateHumanEscalationArgs {
  source: EscalationSource;
  question: string;
  transactionId?: string | null;
  /** Chat-thread title (defaults to a truncation of the question). */
  title?: string;
  /** Initial agent message posted into the bound thread (defaults to the
   *  question). Shown to the operator when they open the escalation. */
  summary?: string;
  /** Quick-action buttons rendered under the initial message, e.g.
   *  [{label:"Clear", value:"clear"},{label:"Confirm match", value:"confirm"}]. */
  suggestedActions?: ReviewAction[];
  review?: {
    kind: string;
    severity?: ReviewSeverity;
    dedupeKey: string;
    target: { type: string; id: string };
    whyHuman: string;
    evidence?: Record<string, unknown>;
    dueAt?: Date | null;
  };
}

/// Human-only escalation (core change 8). Inserts the row directly in
/// 'awaiting_human' (assignee 'human') and creates the bound chat thread
/// immediately with a summary message + optional suggested actions — so
/// the operator lands in a ready conversation, not an empty shell. These
/// escalations never pass through
/// the autonomous Operator-Agent stage (the agent has no authority over
/// compliance or committed-spend decisions) and are never auto-resolved by
/// the escalation-timeout worker (scoped to source='pre_execute').
export async function createHumanEscalation(
  args: CreateHumanEscalationArgs,
  db?: Queryable,
): Promise<EscalationRow> {
  const work = async (tx: Queryable): Promise<EscalationRow> => {
    const escalation = await createEscalation({
      transaction_id: args.transactionId ?? null,
      question: args.question,
      source: args.source,
      status: "awaiting_human",
      assignee: "human",
      review_kind: args.review?.kind,
      severity: args.review?.severity,
      dedupe_key: args.review?.dedupeKey,
      target_type: args.review?.target.type,
      target_id: args.review?.target.id,
      why_human: args.review?.whyHuman,
      evidence: args.review?.evidence,
      available_actions: args.suggestedActions,
      review_due_at: args.review?.dueAt,
    }, tx);
    const title =
      args.title ??
      (args.question.length > 80 ? `${args.question.slice(0, 77)}…` : args.question);
    const existingThread = await getThreadByEscalation(escalation.id, tx);
    const thread = existingThread ?? await getOrCreateEscalationThread({
      escalationId: escalation.id,
      title,
    }, tx);
    await setEscalationThread(escalation.id, thread.id, tx);
    if (!existingThread) {
      await appendOperatorChatMessage({
        threadId: thread.id,
        walletAddress: "system",
        role: "agent",
        content: args.summary ?? args.question,
        suggestedActions: args.suggestedActions,
      }, tx);
    }
    await recordMandatoryAudit(tx, {
      transactionId: args.transactionId ?? undefined,
      source: "system",
      severity: "warn",
      type: existingThread ? "escalation.deduplicated" : "escalation.awaiting_human",
      message: `Escalation (${args.source}): ${title}`,
      payload: {
        escalationId: escalation.id,
        source: args.source,
        threadId: thread.id,
        reviewKind: args.review?.kind,
        occurrenceCount: escalation.occurrence_count,
      },
    });
    return escalation;
  };
  return db ? work(db) : inTransaction(pool, work);
}
