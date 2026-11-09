import type { Hex } from "viem";
import { pool } from "../db/pool.js";
import { inTransaction, type Queryable } from "../db/queryable.js";
import { getTransactionById, mergeTransactionMetadata } from "../db/queries/transactions.js";
import { recordMandatoryAudit } from "../events/emitter.js";
import { applyTaskTransition, type DeferredTaskEmits } from "../engine/taskTransitions.js";
import { errorClassExtra, logError, logInfo } from "../logger.js";
import { lockAssetOwnerFence } from "./assetOwnerFence.js";
import type { ProviderWalletLaunchPolicy } from "./launchPolicy.js";
import type { ProviderWalletConfig } from "./walletConfig.js";

/**
 * Closes read-only asset actions parked in `attention` that nothing can ever
 * resume.
 *
 * A non-destructive action reaches `attention` when its execution threw after
 * the claim (for example a result the task finalization refused), returned a
 * retryable failure, or outlived its window while executing. The buyer cannot
 * resume it: replaying the same signed request is refused, and the wallet
 * authorization and the gateway grant are each valid for at most 300 seconds
 * after an issuedAt no more than 30 seconds ahead of verification. Only a
 * human Review resumes an attention execution. Without this sweep the task
 * stays `working` and the execution counts as active work on the asset
 * forever, which also blocks an owner change.
 *
 * Scope is deliberately narrow:
 * - only actions of the current signed catalog that are non-destructive and
 *   whose installed effect is `read` (never `mutate` or `destructive`: their
 *   supplier outcome may be unknown, and guessing failure is forbidden).
 *   Definitions retained from earlier catalogs are never swept, because the
 *   effect they ran with is not recorded;
 * - no confirmation, staged payload or effect summary on the row;
 * - the task is still `working` and carries no standard order or paid
 *   listing;
 * - no Review, queued/running durable job or unresolved supplier operation
 *   refers to the task;
 * - the execution was created and last changed more than an hour ago, far
 *   past the 330-second authorization bound.
 *
 * Each row is closed in its own transaction under the task advisory lock, the
 * asset owner fence and a row lock, with every predicate re-checked, so a
 * concurrent Review resumption or owner change wins cleanly. The update is
 * conditional on `attention`, so reruns are no-ops. A refused row is logged
 * and left for an operator. No supplier is called and no payment, owner or
 * result is touched.
 */

export const STUCK_READ_ACTION_REASON = "attention_unrecoverable";
const STUCK_READ_ACTION_ERROR_CLASS = "provider_failed";
const DEFAULT_GRACE_SECONDS = 3_600;
const BATCH_LIMIT = 50;
const FAILURE_MESSAGE =
  "This read-only asset action could not finish and its authorization has expired, " +
  "so it cannot be resumed. Nothing was changed. Send a new request to try again.";

let configuredHashes: readonly Hex[] = [];

/**
 * The current catalog's action definition hashes whose action is
 * non-destructive and installed with the `read` effect.
 */
export function readOnlyActionDefinitionHashes(
  wallet: Pick<ProviderWalletConfig, "catalog">,
  launchPolicy: ProviderWalletLaunchPolicy,
): Hex[] {
  const readOnly = new Set(launchPolicy.assetActions
    .filter((action) => action.effect === "read")
    .map((action) => `${action.serviceSlug}\u0000${action.actionId}`));
  const hashes = new Set<Hex>();
  for (const action of wallet.catalog.actions) {
    if (!action.destructive && readOnly.has(`${action.serviceSlug}\u0000${action.actionId}`)) {
      hashes.add(action.actionDefinitionHash.toLowerCase() as Hex);
    }
  }
  return [...hashes].sort();
}

/** Composition seam: boot installs the read-only set once the catalog is verified. */
export function configureStuckReadActionSweep(hashes: readonly Hex[]): void {
  configuredHashes = [...hashes];
}

const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");

const ELIGIBLE = `
  e.state = 'attention'
  AND e.confirmation_hash IS NULL AND e.effect_summary IS NULL
  AND e.stage_valid_before IS NULL AND e.earliest_execution_at IS NULL
  AND e.action_definition_hash = ANY($1::bytea[])
  AND e.created_at < now() - make_interval(secs => $2::double precision)
  AND e.updated_at < now() - make_interval(secs => $2::double precision)
  AND t.status = 'working'
  AND t.standard_order_id IS NULL AND t.standard_listing_manifest_hash IS NULL
  AND NOT EXISTS (SELECT 1 FROM standard_destructive_action_payloads p
                   WHERE p.execution_id = e.execution_id)
  AND NOT EXISTS (SELECT 1 FROM escalations es WHERE es.transaction_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM supplier_operations so
                   WHERE so.transaction_id = t.id AND so.state IN ('intent','ambiguous'))
  AND NOT EXISTS (SELECT 1 FROM durable_jobs j
                   WHERE j.status IN ('queued','running','retry')
                     AND COALESCE(j.payload->>'taskId', j.payload->>'transactionId',
                                  j.payload->>'transaction_id') = t.id)`;

interface Candidate {
  execution_id: Buffer;
  provider_asset_id: string;
  task_id: string;
}

export async function failStuckReadAssetActions(options: {
  definitionHashes?: readonly Hex[];
  graceSeconds?: number;
} = {}): Promise<number> {
  const hashes = options.definitionHashes ?? configuredHashes;
  if (hashes.length === 0) return 0;
  const grace = Math.max(DEFAULT_GRACE_SECONDS, options.graceSeconds ?? DEFAULT_GRACE_SECONDS);
  const definitionBytes = hashes.map(bytes);
  const candidates = await pool.query<Candidate>(
    `SELECT e.execution_id, e.provider_asset_id, t.id AS task_id
       FROM standard_asset_action_executions e
       JOIN transactions t ON t.standard_action_execution_id = e.execution_id
      WHERE ${ELIGIBLE}
      ORDER BY e.updated_at
      LIMIT ${BATCH_LIMIT}`,
    [definitionBytes, grace],
  );
  let failed = 0;
  for (const candidate of candidates.rows) {
    try {
      if (await failOne(candidate, definitionBytes, grace)) failed += 1;
    } catch (error) {
      // A lost race or a refused transition affects this row only.
      logError("Stuck read-only asset action could not be closed", {
        ...errorClassExtra(error),
        taskId: candidate.task_id,
      });
    }
  }
  if (failed > 0) logInfo("Closed stuck read-only asset actions", { failed });
  return failed;
}

async function failOne(candidate: Candidate, definitionBytes: Buffer[], grace: number): Promise<boolean> {
  const deferred: DeferredTaskEmits = [];
  const closed = await inTransaction(pool, async (db) => {
    // The claim's lock, then the fence, then the rows: the order every
    // execution path uses (actionStore.ts).
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [candidate.task_id]);
    await lockAssetOwnerFence(db, candidate.provider_asset_id);
    const locked = await db.query<{ execution_id: Buffer }>(
      `SELECT e.execution_id
         FROM standard_asset_action_executions e
         JOIN transactions t ON t.standard_action_execution_id = e.execution_id
        WHERE e.execution_id = $3 AND ${ELIGIBLE}
        FOR UPDATE OF e, t`,
      [definitionBytes, grace, candidate.execution_id],
    );
    if (!locked.rows[0]) return false;
    return closeExecution(db, candidate, deferred);
  });
  for (const emit of deferred) emit();
  return closed;
}

async function closeExecution(db: Queryable, candidate: Candidate, deferred: DeferredTaskEmits): Promise<boolean> {
  const updated = await db.query(
    `UPDATE standard_asset_action_executions
        SET state='failed', error_class=$2, sanitized_result=NULL, updated_at=now()
      WHERE execution_id=$1 AND state='attention'`,
    [candidate.execution_id, STUCK_READ_ACTION_ERROR_CLASS],
  );
  if (updated.rowCount !== 1) return false;
  const task = await getTransactionById(candidate.task_id, db);
  if (!task || task.status !== "working") throw new Error("stuck read-only action task changed");
  await mergeTransactionMetadata(task.id, {
    asset_action_state: "failed",
    asset_action_terminal_reason: STUCK_READ_ACTION_REASON,
  }, db);
  await applyTaskTransition(db, task, "failed", { message: FAILURE_MESSAGE, failureClass: "terminal" }, deferred);
  await recordMandatoryAudit(db, {
    transactionId: task.id,
    assetId: task.asset_id ?? undefined,
    serviceId: task.service_id,
    source: "system",
    type: "asset_action.failed",
    message: "Read-only asset action closed after its authorization expired in attention.",
    payload: {
      actionState: "failed",
      reason: STUCK_READ_ACTION_REASON,
      errorClass: STUCK_READ_ACTION_ERROR_CLASS,
      transactionStatus: "failed",
    },
    actor: "system:standard-rail",
  });
  return true;
}
