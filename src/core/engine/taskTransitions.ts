import { pool } from "../db/pool.js";
import {
  getTransactionById,
  mergeTransactionMetadata,
  setTransactionStatus,
  type TransactionRow,
  type TransactionStatus,
} from "../db/queries/transactions.js";
import { inTransaction, type Queryable } from "../db/queryable.js";
import { recordMandatoryAudit } from "../events/emitter.js";
import { freezeTerminalResult } from "../standardRail/terminalResult.js";
import { taskEvents } from "./events.js";
import { isTerminalState, validateTransition } from "./stateMachine.js";

export type FailureClass = "retryable" | "terminal";
export type DeferredTaskEmits = Array<() => void>;

export class TaskTransitionConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskTransitionConflict";
  }
}

export async function applyTaskTransition(
  db: Queryable,
  task: TransactionRow,
  newStatus: TransactionStatus,
  opts: { message?: string; failureClass?: FailureClass | null },
  deferred: DeferredTaskEmits,
): Promise<TransactionRow> {
  validateTransition(task.status, newStatus);
  const updated = await setTransactionStatus(task.id, newStatus, {
    expectedStatus: task.status,
    expectedVersion: task.version,
    db,
  });
  if (!updated) {
    const winner = await getTransactionById(task.id, db);
    if (winner?.status === newStatus) return winner;
    throw new TaskTransitionConflict(
      `Lost transaction transition ${task.id}: expected ${task.status}@${task.version}, ` +
        `found ${winner?.status ?? "missing"}@${winner?.version ?? "?"}`,
    );
  }
  if (opts.failureClass) {
    await mergeTransactionMetadata(
      task.id,
      { failure_class: opts.failureClass },
      db,
    );
  }
  if (opts.message) {
    await recordMandatoryAudit(db, {
      transactionId: task.id,
      source: "adapter",
      type: "transaction.message.agent",
      message: opts.message,
      payload: { role: "agent", content: opts.message },
    });
  }
  // A standard order's first terminal transition freezes its terminal
  // identity in this same transaction, after every deliverable and message.
  if (isTerminalState(newStatus)) await freezeTerminalResult(db, updated);
  deferred.push(() =>
    taskEvents.emitTaskEvent({ type: "transition", task: updated })
  );
  return updated;
}

export async function transitionTask(
  taskId: string,
  newStatus: TransactionStatus,
  message?: string,
  failureClass?: FailureClass | null,
): Promise<TransactionRow> {
  const deferred: DeferredTaskEmits = [];
  const updated = await inTransaction(pool, async (db) => {
    const task = await getTransactionById(taskId, db);
    if (!task) throw new Error(`Transaction not found: ${taskId}`);
    if (task.status === newStatus) return task;
    return applyTaskTransition(
      db,
      task,
      newStatus,
      { message, failureClass },
      deferred,
    );
  });
  for (const emit of deferred) emit();
  return updated;
}

export async function transitionTaskIfCurrent(args: {
  taskId: string;
  expectedStatus: TransactionStatus;
  expectedVersion: string;
  newStatus: TransactionStatus;
  message?: string;
  failureClass?: FailureClass | null;
  metadata?: Record<string, unknown>;
}): Promise<TransactionRow | null> {
  const deferred: DeferredTaskEmits = [];
  const updated = await inTransaction(pool, async (db) => {
    const task = await getTransactionById(args.taskId, db);
    if (
      !task
      || task.status !== args.expectedStatus
      || task.version !== args.expectedVersion
    ) {
      return null;
    }
    try {
      const transitioned = await applyTaskTransition(
        db,
        task,
        args.newStatus,
        { message: args.message, failureClass: args.failureClass },
        deferred,
      );
      if (args.metadata) {
        await mergeTransactionMetadata(task.id, args.metadata, db);
      }
      return transitioned;
    } catch (error) {
      if (error instanceof TaskTransitionConflict) return null;
      throw error;
    }
  });
  for (const emit of deferred) emit();
  return updated;
}

export async function claimSupplierMutation(args: {
  taskId: string;
  expectedStatus: TransactionStatus;
  expectedVersion: string;
}): Promise<TransactionRow | null> {
  return inTransaction(pool, async (db) => {
    const claimed = await db.query<{ id: string }>(
      `UPDATE transactions
          SET metadata = metadata || '{"supplier_mutation_started":true}'::jsonb,
              updated_at = now(),
              version = version + 1
        WHERE id = $1 AND status = $2 AND version = $3
          AND NOT (metadata @> '{"supplier_mutation_started":true}'::jsonb)
        RETURNING id`,
      [args.taskId, args.expectedStatus, args.expectedVersion],
    );
    if (!claimed.rows[0]) return null;
    await recordMandatoryAudit(db, {
      transactionId: args.taskId,
      source: "system",
      type: "transaction.fulfillment.claimed",
      actor: "system:fulfillment-dispatch",
      message: "Supplier mutation dispatch was durably claimed.",
      payload: { expectedStatus: args.expectedStatus },
    });
    return getTransactionById(args.taskId, db);
  });
}
