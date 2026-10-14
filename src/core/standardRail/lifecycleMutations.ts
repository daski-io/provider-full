import { decryptString } from "../chain/encryption.js";
import { pool } from "../db/pool.js";
import { getServiceById } from "../db/queries/services.js";
import { getTransactionById, type TransactionStatus } from "../db/queries/transactions.js";
import { validateTransition } from "../engine/stateMachine.js";
import { processAdapterResult } from "../engine/taskFinalization.js";
import { recordMandatoryAudit } from "../events/emitter.js";
import { getAdapter } from "../serviceRegistry/registry.js";
import { admittedSupplierCostCeiling } from "../serviceRegistry/supplierCostCeiling.js";
import { CancellationRefusedError, type FulfillmentAdapter } from "../serviceRegistry/types.js";
import { canonicalHash } from "./canonical.js";
import type { LifecycleCall } from "./lifecycleAuthorization.js";
import { lifecycleUnavailable, unsupportedAction } from "./lifecycleErrors.js";
import { STANDARD_TASK_COLUMNS, type StandardTaskRow } from "./lifecycleStore.js";
import { enqueueReputationOutcome } from "./reputationOutcomeStore.js";
import { freezeTerminalResult } from "./terminalResult.js";

const CANCELABLE: ReadonlySet<string> = new Set(["submitted", "dispatching", "working", "input-required"]);
export const CANCELED_MESSAGE = "Canceled at the buyer's request.";

async function adapterFor(task: StandardTaskRow): Promise<FulfillmentAdapter> {
  const service = await getServiceById(task.service_id);
  if (!service) throw lifecycleUnavailable("Task service is unavailable");
  return getAdapter(service.adapter_name);
}

/// Fence a supplier-facing lifecycle mutation before the adapter runs:
/// the version bump invalidates every claim other actors hold from the
/// pre-claim snapshot, and RETURNING yields the row the adapter must
/// act on (fresh supplier_mutation_started, not the load-time copy).
async function claimLifecycleMutation(task: StandardTaskRow): Promise<StandardTaskRow> {
  const result = await pool.query<StandardTaskRow>(
    `UPDATE transactions
        SET version=version+1,updated_at=now()
      WHERE id=$1 AND standard_order_id=$2 AND status=$3 AND version=$4
      RETURNING ${STANDARD_TASK_COLUMNS}`,
    [task.id, task.standard_order_id, task.status, task.version],
  );
  if (!result.rows[0]) throw lifecycleUnavailable("Task state changed while authorizing the lifecycle action");
  return result.rows[0];
}

/// task must be the claimed snapshot the mutation ran against: the update
/// is conditional on that exact status and version, so a worker or
/// competing lifecycle call that finalized in between loses nothing — this
/// write fails instead of overwriting a terminal state. The first terminal
/// transition freezes the order's terminal identity in the same transaction.
export async function persistLifecycleState(
  task: StandardTaskRow,
  state: TransactionStatus,
  completedAt: Date | null,
): Promise<void> {
  if (state !== task.status) validateTransition(task.status, state);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE transactions
          SET status=$2,updated_at=now(),version=version+1,
              completed_at=COALESCE(completed_at,$3)
        WHERE id=$1 AND standard_order_id=$4 AND status=$5 AND version=$6`,
      [task.id, state, completedAt, task.standard_order_id, task.status, task.version],
    );
    if (updated.rowCount !== 1) throw new Error("Standard task state update lost its fence");
    const persisted = await getTransactionById(task.id, client);
    if (!persisted) throw new Error("Standard task disappeared after state update");
    if (state === "canceled" && task.status !== "canceled") {
      await recordMandatoryAudit(client, {
        transactionId: task.id, serviceId: task.service_id, source: "system",
        type: "transaction.message.agent", message: CANCELED_MESSAGE,
        payload: { role: "agent", content: CANCELED_MESSAGE },
      });
    }
    if (state !== task.status) await freezeTerminalResult(client, persisted);
    await enqueueReputationOutcome(persisted, client);
    await client.query(
      `UPDATE standard_dispatch_claims SET state=$2,
          resolved_at=CASE WHEN $2 IN ('completed','failed','canceled') THEN now() ELSE resolved_at END
        WHERE order_id=$1 AND transaction_id=$3`,
      [task.standard_order_id, state, task.id],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Cancel a nonterminal order through its service, then persist and freeze it. */
export async function applyLifecycleCancel(task: StandardTaskRow, publicState: string): Promise<void> {
  if (!CANCELABLE.has(publicState) || !CANCELABLE.has(task.status)) {
    throw unsupportedAction("Task cannot be canceled from its current state");
  }
  const adapter = await adapterFor(task);
  const claimed = await claimLifecycleMutation(task);
  try {
    await adapter.cancel({
      ...claimed,
      supplierMutationStarted: claimed.metadata.supplier_mutation_started === true,
      supplierCostCeiling: admittedSupplierCostCeiling(claimed.metadata),
    });
  } catch (error) {
    // A definite refusal changed nothing; any other failure may have acted.
    if (error instanceof CancellationRefusedError) throw unsupportedAction("The service refused the cancellation");
    throw lifecycleUnavailable("Cancellation outcome is unknown");
  }
  await persistLifecycleState(claimed, "canceled", new Date());
}

/// Input may re-supply the committed request; every field must equal what
/// the payer committed to, so the product, plan and price bound by the quote
/// never change after payment.
function assertInputMatchesCommittedRequest(task: StandardTaskRow, revealed: Record<string, unknown>): void {
  const encrypted = task.metadata.standard_request_encrypted;
  if (typeof encrypted !== "string") throw lifecycleUnavailable("Committed standard request is unavailable");
  let committed: unknown;
  try {
    committed = JSON.parse(decryptString(encrypted, {
      purpose: "standard-order-request", table: "transactions", recordId: task.id,
      field: "metadata.standard_request_encrypted", recordVersion: 1,
    }));
  } catch {
    throw lifecycleUnavailable("Committed standard request cannot be authenticated");
  }
  if (!committed || typeof committed !== "object" || Array.isArray(committed)) {
    throw lifecycleUnavailable("Committed standard request is invalid");
  }
  const original = committed as Record<string, unknown>;
  for (const [field, value] of Object.entries(revealed)) {
    if (
      field === "__proto__" || field === "constructor" || field === "prototype" ||
      !Object.prototype.hasOwnProperty.call(original, field) ||
      canonicalHash(original[field]) !== canonicalHash(value)
    ) throw unsupportedAction("Lifecycle input changes the payer-committed request");
  }
}

/** Hand buyer input to the service of an order awaiting it, then persist its answer. */
export async function applyLifecycleInput(task: StandardTaskRow, call: LifecycleCall, publicState: string): Promise<void> {
  if (publicState !== "input-required" || task.status !== "input-required") {
    throw unsupportedAction("Task is not awaiting buyer input");
  }
  const data = call.request.data as Record<string, unknown>;
  assertInputMatchesCommittedRequest(task, data);
  const adapter = await adapterFor(task);
  const claimed = await claimLifecycleMutation(task);
  let processed: Awaited<ReturnType<typeof processAdapterResult>>;
  try {
    const result = await adapter.handleInput(
      {
        ...claimed,
        supplierMutationStarted: claimed.metadata.supplier_mutation_started === true,
        supplierCostCeiling: admittedSupplierCostCeiling(claimed.metadata),
      },
      call.request.inputText as string,
      data,
      { requestHash: canonicalHash(call.request), payer: claimed.standard_payer, standardOrderId: claimed.standard_order_id },
    );
    processed = await processAdapterResult(claimed.id, result, claimed.service_id);
  } catch {
    throw lifecycleUnavailable("Input outcome is unknown");
  }
  await persistLifecycleState(
    { ...claimed, status: processed.status, version: processed.version },
    processed.status,
    processed.completed_at,
  );
}
