import type { Hex } from "viem";
import { encryptString } from "../chain/encryption.js";
import { pool } from "../db/pool.js";
import { getCurrentAssetOwner } from "../db/queries/assetOwnership.js";
import type { Queryable } from "../db/queryable.js";
import type { DeferredTaskEmits } from "../engine/taskTransitions.js";
import { cancelLinkedAssetActionTransaction } from "./actionLifecycle.js";
import {
  lockFenceForExecution,
  recoveryResultContext,
  type AssetActionExecutionRow,
} from "./actionStore.js";
import {
  admittedOwnerOf,
  assertAdmittedOwnerCurrent,
  AssetOwnerChangedError,
} from "./assetOwnerFence.js";
import { withholdStaleOwnerOutcome } from "./assetOwnerOutcome.js";

const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");

export async function markAssetActionAttention(executionId: Hex): Promise<void> {
  const result = await pool.query(
    `UPDATE standard_asset_action_executions SET state='attention',updated_at=now()
      WHERE execution_id=$1 AND state IN ('claimed','executing','attention')`,
    [bytes(executionId)],
  );
  if (result.rowCount !== 1) throw new Error("asset action attention transition lost its claim");
}

/**
 * Persist an execution's outcome: the result-persistence boundary. Under the
 * asset owner fence (taken before the row lock) the admitted owner must
 * still be current; when it is not, nothing of the result is persisted, the
 * execution and its task end failed with the redacted `asset_owner_changed`
 * marker in this same transaction, and AssetOwnerChangedError is thrown once
 * that has committed.
 */
export async function completeAssetAction(args: {
  executionId: Hex;
  status: "completed" | "failed";
  result: Record<string, unknown> | null;
  errorClass: string | null;
}): Promise<void> {
  const client = await pool.connect();
  const deferred: DeferredTaskEmits = [];
  let withheld = false;
  try {
    await client.query("BEGIN");
    await lockFenceForExecution(client, args.executionId);
    const row = (await client.query<AssetActionExecutionRow>(
      `SELECT * FROM standard_asset_action_executions
        WHERE execution_id=$1 AND state IN ('claimed','executing','attention') FOR UPDATE`,
      [bytes(args.executionId)],
    )).rows[0];
    if (!row) throw new Error("asset action completion lost its claim");
    const admitted = admittedOwnerOf(row);
    try {
      await assertAdmittedOwnerCurrent(client, row.provider_asset_id, admitted);
    } catch (error) {
      if (!(error instanceof AssetOwnerChangedError)) throw error;
      withheld = true;
      await withholdStaleOwnerOutcome(client, {
        assetId: row.provider_asset_id,
        taskId: `asset-action-${args.executionId.slice(2)}`,
        executionId: row.execution_id,
        admitted,
        current: await getCurrentAssetOwner(row.provider_asset_id, client),
        phase: "persistence",
        failTask: true,
        deferred,
      });
    }
    if (!withheld) await persistCompletion(client, row, args);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
  for (const emit of deferred) emit();
  if (withheld) throw new AssetOwnerChangedError();
}

async function persistCompletion(
  client: Queryable,
  row: AssetActionExecutionRow,
  args: Parameters<typeof completeAssetAction>[0],
): Promise<void> {
  if (args.status === "completed" && row.replay_policy !== "regenerate-ephemeral") {
    if (!args.result) throw new Error("recoverable action result is missing");
    await client.query(
      `INSERT INTO standard_asset_action_recovery_results(execution_id,encrypted_result,expires_at)
       VALUES ($1,$2,$3)`,
      [bytes(args.executionId), encryptString(JSON.stringify(args.result), recoveryResultContext(row)),
        row.result_valid_before],
    );
  }
  const updated = await client.query(
    `UPDATE standard_asset_action_executions
        SET state=$2,sanitized_result=NULL,error_class=$3,updated_at=now()
      WHERE execution_id=$1 AND state IN ('claimed','executing','attention')`,
    [bytes(args.executionId), args.status, args.errorClass],
  );
  if (updated.rowCount !== 1) throw new Error("asset action completion lost its claim");
  await client.query("DELETE FROM standard_destructive_action_payloads WHERE execution_id=$1", [
    bytes(args.executionId),
  ]);
  if (args.status === "completed" && row.replay_policy === "redacted-after-window") {
    await client.query("DELETE FROM artifact_secrets WHERE transaction_id=$1", [
      `asset-action-${args.executionId.slice(2)}`,
    ]);
  }
}

export async function expireDestructiveAssetActions(): Promise<{
  expired: number;
  attention: number;
}> {
  const client = await pool.connect();
  const deferred: DeferredTaskEmits = [];
  let result: { expired: number; attention: number } | undefined;
  try {
    await client.query("BEGIN");
    const expired = await client.query<{ execution_id: Buffer }>(
      `UPDATE standard_asset_action_executions SET state='expired',updated_at=now()
        WHERE state='staged' AND stage_valid_before<=now() RETURNING execution_id`,
    );
    const attention = await client.query<{ execution_id: Buffer }>(
      `UPDATE standard_asset_action_executions SET state='attention',updated_at=now(),
          error_class=NULL,sanitized_result=NULL
        WHERE state='executing' AND result_valid_before<=now() RETURNING execution_id`,
    );
    await client.query(
      `UPDATE standard_asset_action_executions
          SET sanitized_result=NULL,result_redacted_at=COALESCE(result_redacted_at,now()),updated_at=now()
        WHERE state='completed' AND result_redacted_at IS NULL AND result_valid_before<=now()`,
    );
    await client.query(
      "DELETE FROM standard_asset_action_recovery_results WHERE expires_at<=now()",
    );
    await client.query(
      "DELETE FROM standard_wallet_action_nonces WHERE consumed_at<now()-interval '10 minutes'",
    );
    await client.query(
      "DELETE FROM standard_provider_grant_nonces WHERE consumed_at<now()-interval '10 minutes'",
    );
    await client.query(
      "DELETE FROM standard_asset_rate_buckets WHERE window_started_at<now()-interval '2 minutes'",
    );
    const ids = [...expired.rows, ...attention.rows].map((row) => row.execution_id);
    for (const row of expired.rows) {
      await cancelLinkedAssetActionTransaction({
        db: client,
        taskId: `asset-action-${row.execution_id.toString("hex")}`,
        reason: "confirmation_expired",
        deferred,
      });
    }
    if (ids.length > 0) {
      await client.query(
        "DELETE FROM standard_destructive_action_payloads WHERE execution_id=ANY($1::bytea[])",
        [ids],
      );
    }
    await client.query("COMMIT");
    result = { expired: expired.rowCount ?? 0, attention: attention.rowCount ?? 0 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
  for (const emit of deferred) emit();
  return result!;
}
