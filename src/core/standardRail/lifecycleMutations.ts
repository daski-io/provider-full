import { decryptString } from "../chain/encryption.js";
import { pool } from "../db/pool.js";
import { getServiceById } from "../db/queries/services.js";
import { getTransactionById, type TransactionStatus } from "../db/queries/transactions.js";
import { validateTransition } from "../engine/stateMachine.js";
import { processAdapterResult } from "../engine/taskFinalization.js";
import { recordMandatoryAudit } from "../events/emitter.js";
import { getAdapter } from "../serviceRegistry/registry.js";
import { contractHandler } from "../serviceRegistry/retainedHandlers.js";
import { admittedSupplierCostCeiling } from "../serviceRegistry/supplierCostCeiling.js";
import { CancellationRefusedError, type FulfillmentAdapter } from "../serviceRegistry/types.js";
import { canonicalHash } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import {
  abandonLifecycleAction,
  claimLifecycleAction,
  commitLifecycleAction,
  releaseLifecycleAction,
  renewLifecycleAction,
  type LifecycleActionClaim,
} from "./lifecycleActions.js";
import type { LifecycleCall } from "./lifecycleAuthorization.js";
import { lifecycleUnavailable, unsupportedAction, type LifecycleRefusal } from "./lifecycleErrors.js";
import { STANDARD_TASK_COLUMNS, type StandardTaskRow } from "./lifecycleStore.js";
import { listingVersion } from "./listingVersions.js";
import { enqueueReputationOutcome } from "./reputationOutcomeStore.js";
import { freezeTerminalResult } from "./terminalResult.js";

const CANCELABLE: ReadonlySet<string> = new Set(["submitted", "dispatching", "working", "input-required"]);
const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "canceled"]);
export const CANCELED_MESSAGE = "Canceled at the buyer's request.";
/** How often an attempt renews its lease while the service call runs. */
const LEASE_RENEWAL_MS = 60_000;

/// The handler of the contract the order was admitted under, never merely
/// the service's current one: a later listing version may execute another
/// contract.
async function adapterFor(config: ProviderStandardRailConfig, task: StandardTaskRow): Promise<FulfillmentAdapter> {
  const service = await getServiceById(task.service_id);
  if (!service) throw lifecycleUnavailable("Task service is unavailable");
  const version = task.standard_listing_manifest_hash
    ? await listingVersion(config, `0x${task.standard_listing_manifest_hash.toString("hex")}`)
    : null;
  if (!version) throw lifecycleUnavailable("Task listing version is unavailable");
  const handler = contractHandler(version.serviceSlug, version.skillId, version.contract);
  if (!handler) throw lifecycleUnavailable("This build has no handler for the order's admitted contract");
  return handler.kind === "retained" ? handler.adapter : getAdapter(service.adapter_name);
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
  action: LifecycleActionClaim,
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
    // The action's outcome commits with the state it produced.
    await commitLifecycleAction(client, action, state);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Refusals the service gave definitely: nothing changed, so the identity is freed. */
const NOTHING_CHANGED = new WeakSet<object>();
const nothingChanged = (refusal: LifecycleRefusal): LifecycleRefusal => {
  NOTHING_CHANGED.add(refusal);
  return refusal;
};

/** The service's view of the action: its stable key, and whether an earlier attempt may have acted. */
function serviceTask(task: StandardTaskRow, claim: LifecycleActionClaim) {
  return {
    ...task,
    supplierMutationStarted: task.metadata.supplier_mutation_started === true,
    supplierCostCeiling: admittedSupplierCostCeiling(task.metadata),
    lifecycleAction: {
      idempotencyKey: `standard-lifecycle:${task.id}:${claim.action}:0x${claim.identity.toString("hex")}`,
      resumed: claim.resumed,
    },
  };
}

interface ServiceCall {
  /** Call the service while this attempt still owns the claim, keeping its lease alive meanwhile. */
  run<T>(effect: () => Promise<T>): Promise<T>;
}

/**
 * Run one claimed action attempt. A definite refusal from the service frees
 * the identity, and so does a failure before the service was called when no
 * earlier attempt could have acted. Anything else (a failure after the
 * service was called, or any failure of a resumed attempt) keeps the identity
 * bound for the next attempt to reconcile, and the caller answers temporarily
 * unavailable, never as if the action had not happened.
 */
async function attempt(claim: LifecycleActionClaim, work: (service: ServiceCall) => Promise<void>): Promise<void> {
  let started = false;
  const service: ServiceCall = {
    async run(effect) {
      if (!await renewLifecycleAction(claim)) throw lifecycleUnavailable("Another attempt took the action over");
      started = true;
      const renewal = setInterval(() => {
        void renewLifecycleAction(claim).catch(() => undefined);
      }, LEASE_RENEWAL_MS);
      try {
        return await effect();
      } finally {
        clearInterval(renewal);
      }
    },
  };
  try {
    await work(service);
  } catch (error) {
    const definite = typeof error === "object" && error !== null && NOTHING_CHANGED.has(error);
    if (definite || (!started && !claim.resumed)) {
      await releaseLifecycleAction(claim).catch(() => undefined);
      throw error;
    }
    await abandonLifecycleAction(claim).catch(() => undefined);
    throw lifecycleUnavailable(started ? "Lifecycle action outcome is unknown" : "An earlier attempt is unresolved");
  }
}

/**
 * Cancel a nonterminal order once: the claim is durable before the service is
 * called and commits with the canceled state, so a retry under a fresh
 * authorization answers the committed cancellation instead of repeating it.
 */
export async function applyLifecycleCancel(
  config: ProviderStandardRailConfig,
  task: StandardTaskRow,
  call: LifecycleCall,
  readPublicState: () => Promise<string>,
): Promise<void> {
  const claimed = await claimLifecycleAction(task, call);
  if (claimed.kind === "replay") return;
  const claim = claimed.claim;
  await attempt(claim, async (service) => {
    // Read under the claim, so no other attempt of this action interleaves.
    const publicState = await readPublicState();
    if (claim.resumed && TERMINAL.has(publicState)) {
      // The order settled after an attempt whose effect is unknown: its
      // terminal state, canceled or not, is the action's outcome. Record it.
      await commitLifecycleAction(pool, claim, publicState);
      return;
    }
    if (!CANCELABLE.has(publicState) || !CANCELABLE.has(task.status)) {
      throw unsupportedAction("Task cannot be canceled from its current state");
    }
    const adapter = await adapterFor(config, task);
    const fenced = await claimLifecycleMutation(task);
    await service.run(async () => {
      try {
        await adapter.cancel(serviceTask(fenced, claim));
      } catch (error) {
        if (error instanceof CancellationRefusedError) {
          throw nothingChanged(unsupportedAction("The service refused the cancellation"));
        }
        throw error;
      }
    });
    await persistLifecycleState(fenced, "canceled", new Date(), claim);
  });
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

/**
 * Hand one buyer input to the service of an order awaiting it, identified by
 * its request: the claim is durable before the service is called and commits
 * with the state the service produced, so a retry of the same input under a
 * fresh authorization answers that state instead of repeating it.
 */
export async function applyLifecycleInput(
  config: ProviderStandardRailConfig,
  task: StandardTaskRow,
  call: LifecycleCall,
  readPublicState: () => Promise<string>,
): Promise<void> {
  const claimed = await claimLifecycleAction(task, call);
  if (claimed.kind === "replay") return;
  const claim = claimed.claim;
  await attempt(claim, async (service) => {
    const publicState = await readPublicState();
    if (claim.resumed && publicState !== "input-required") {
      // An earlier attempt of this input moved the order on; record it.
      await commitLifecycleAction(pool, claim, publicState);
      return;
    }
    if (publicState !== "input-required" || task.status !== "input-required") {
      throw unsupportedAction("Task is not awaiting buyer input");
    }
    const data = call.request.data as Record<string, unknown>;
    assertInputMatchesCommittedRequest(task, data);
    const adapter = await adapterFor(config, task);
    const fenced = await claimLifecycleMutation(task);
    const result = await service.run(() => adapter.handleInput(
      serviceTask(fenced, claim),
      call.request.inputText as string,
      data,
      { requestHash: canonicalHash(call.request), payer: fenced.standard_payer, standardOrderId: fenced.standard_order_id },
    ));
    const processed = await processAdapterResult(fenced.id, result, fenced.service_id);
    await persistLifecycleState(
      { ...fenced, status: processed.status, version: processed.version },
      processed.status,
      processed.completed_at,
      claim,
    );
  });
}
