import { decryptString } from "../chain/encryption.js";
import { pool } from "../db/pool.js";
import { getTransactionById, type TransactionStatus } from "../db/queries/transactions.js";
import { processAdapterResult } from "../engine/taskFinalization.js";
import type { AdapterResult } from "../serviceRegistry/types.js";
import { readmitPaidTaskOwner } from "./assetOwnerAdmission.js";
import { AssetOwnerChangedError } from "./assetOwnerFence.js";
import { canonicalHash } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { claimLifecycleAction, commitLifecycleAction } from "./lifecycleActions.js";
import type { LifecycleCall } from "./lifecycleAuthorization.js";
import { lifecycleUnavailable, unsupportedAction } from "./lifecycleErrors.js";
import {
  adapterFor,
  attempt,
  claimLifecycleMutation,
  nothingChanged,
  persistLifecycleState,
  serviceTask,
} from "./lifecycleMutations.js";
import type { StandardTaskRow } from "./lifecycleStore.js";

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
 * Persist the service's answer to an input. When the owner the order was
 * admitted under went stale during the call, finalization withholds the
 * deliverable and ends the order failed with `asset_owner_changed` in its
 * own transaction, exactly as at dispatch: that settled failure is the
 * action's outcome, answered at once rather than as an unknown one.
 */
async function persistInputResult(task: StandardTaskRow, result: AdapterResult): Promise<{
  status: TransactionStatus;
  version: string;
  completedAt: Date | null;
}> {
  try {
    const processed = await processAdapterResult(task.id, result, task.service_id);
    return { status: processed.status, version: processed.version, completedAt: processed.completed_at };
  } catch (error) {
    if (!(error instanceof AssetOwnerChangedError)) throw error;
    const settled = await getTransactionById(task.id);
    if (!settled) throw error;
    return { status: settled.status, version: settled.version, completedAt: settled.completed_at };
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
    // Owner-only work resumes only for the asset's current owner.
    await readmitPaidTaskOwner(task.id).catch((error: unknown) => {
      if (error instanceof AssetOwnerChangedError) {
        throw nothingChanged(unsupportedAction("The order's asset has a different owner now"));
      }
      throw error;
    });
    const fenced = await claimLifecycleMutation(task);
    const result = await service.run(() => adapter.handleInput(
      serviceTask(fenced, claim),
      call.request.inputText as string,
      data,
      { requestHash: canonicalHash(call.request), payer: fenced.standard_payer, standardOrderId: fenced.standard_order_id },
    ));
    const processed = await persistInputResult(fenced, result);
    await persistLifecycleState(
      { ...fenced, status: processed.status, version: processed.version },
      processed.status,
      processed.completedAt,
      claim,
    );
  });
}
