import { pool } from "../db/pool.js";
import { upsertCustomer } from "../db/queries/customers.js";
import type { Queryable } from "../db/queryable.js";
import { decryptString, encryptString } from "../chain/encryption.js";
import type { Address, Hex } from "viem";
import type { ProviderWalletConfig } from "./walletConfig.js";
import { consumeAssetEndpointRate } from "./assetRateLimit.js";
import {
  admitAssetOwner,
  admittedOwnerOf,
  assertAdmittedOwnerCurrent,
  lockAssetOwnerFence,
} from "./assetOwnerFence.js";

const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");
const hex = (value: Buffer): Hex => `0x${value.toString("hex")}`;

export interface AssetActionExecutionRow {
  execution_id: Buffer;
  payer: string;
  provider_asset_id: string;
  action_hash: Buffer;
  request_hash: Buffer;
  wallet_authorization_hash: Buffer;
  grant_hash: Buffer;
  provider_control_profile_hash: Buffer;
  servicing_admission_hash: Buffer;
  action_catalog_hash: Buffer;
  action_catalog_schema_hash: Buffer;
  action_catalog_epoch: string;
  action_definition_hash: Buffer;
  replay_policy: "stable-result" | "regenerate-ephemeral" | "redacted-after-window";
  state: "claimed" | "staged" | "executing" | "completed" | "failed" | "canceled" | "expired" | "attention";
  effect_summary: Record<string, unknown> | null;
  confirmation_hash: Buffer | null;
  earliest_execution_at: Date | null;
  stage_valid_before: Date | null;
  result_valid_before: Date;
  result_redacted_at: Date | null;
  sanitized_result: Record<string, unknown> | null;
  error_class: string | null;
  /** The owner the execution was admitted (or last re-admitted) under. */
  admitted_owner: string;
  admitted_owner_version: number;
}

interface ClaimArgs {
  executionId: Hex;
  payer: Hex;
  providerAssetId: string;
  serviceId: string;
  skillId: string;
  actionId: string;
  actionHash: Hex;
  requestHash: Hex;
  walletAuthorizationHash: Hex;
  walletNonce: Hex;
  grantHash: Hex;
  grantNonce: Hex;
  providerControlProfileHash: Hex;
  servicingAdmissionHash: Hex;
  actionCatalogHash: Hex;
  actionCatalogSchemaHash: Hex;
  actionCatalogEpoch: number;
  actionDefinitionHash: Hex;
  replayPolicy: "stable-result" | "regenerate-ephemeral" | "redacted-after-window";
  resultValidBefore: number;
  gatewaySigner: Address;
  abuse: ProviderWalletConfig["abuse"];
  destructive?: {
    input: Record<string, unknown>;
    effectSummary: Record<string, unknown>;
    confirmationHash: Hex;
    earliestExecutionAt: number;
    stageValidBefore: number;
  };
}

export const payloadContext = (executionId: Hex) => ({
  purpose: "destructive-asset-action",
  table: "standard_destructive_action_payloads",
  recordId: executionId,
  field: "encrypted_input",
  recordVersion: 1,
} as const);

export const recoveryResultContext = (row: AssetActionExecutionRow) => ({
  purpose: "asset-action-recovery-result",
  table: "standard_asset_action_recovery_results",
  recordId: `${hex(row.execution_id)}:${row.payer}:${row.provider_asset_id}:${hex(row.action_hash)}`,
  field: "encrypted_result",
  recordVersion: 1,
} as const);

export async function claimAssetAction(args: ClaimArgs): Promise<{
  row: AssetActionExecutionRow;
  taskId: string;
  replayed: boolean;
}> {
  const client = await pool.connect();
  const taskId = `asset-action-${args.executionId.slice(2)}`;
  try {
    // Read committed: every decision below is made under a lock (the
    // execution's own, the stage cap, the asset owner fence) and must see
    // what committed before that lock was granted, whereas a serializable
    // snapshot is taken before the first wait.
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [taskId]);
    await consumeAssetEndpointRate({
      db: client, gatewaySigner: args.gatewaySigner, payer: args.payer,
      actionId: args.actionId, limits: args.abuse,
    });
    const prior = await client.query<AssetActionExecutionRow>(
      "SELECT * FROM standard_asset_action_executions WHERE execution_id=$1",
      [bytes(args.executionId)],
    );
    const existing = prior.rows[0];
    if (existing) {
      if (
        existing.payer.toLowerCase() !== args.payer.toLowerCase() ||
        existing.provider_asset_id !== args.providerAssetId ||
        hex(existing.action_hash) !== args.actionHash || hex(existing.request_hash) !== args.requestHash ||
        hex(existing.wallet_authorization_hash) !== args.walletAuthorizationHash ||
        hex(existing.provider_control_profile_hash) !== args.providerControlProfileHash ||
        hex(existing.servicing_admission_hash) !== args.servicingAdmissionHash ||
        hex(existing.action_catalog_hash) !== args.actionCatalogHash ||
        hex(existing.action_catalog_schema_hash) !== args.actionCatalogSchemaHash ||
        Number(existing.action_catalog_epoch) !== args.actionCatalogEpoch ||
        hex(existing.action_definition_hash) !== args.actionDefinitionHash ||
        existing.replay_policy !== args.replayPolicy
      ) throw new Error("asset action replay mismatch");
      // A replay is answered only while its admitted owner is current; a
      // stale one is refused here, before anything is consumed.
      await assertAdmittedOwnerCurrent(client, existing.provider_asset_id, admittedOwnerOf(existing));
      await consumeGrant(client, args.grantNonce, args.grantHash, args.payer);
      await client.query("COMMIT");
      return { row: existing, taskId, replayed: true };
    }
    if (args.destructive) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "provider:destructive-stage-cap",
      ]);
      const outstanding = await client.query<{ payer_count: string; provider_count: string }>(
        `SELECT count(*) FILTER (WHERE lower(payer)=lower($1))::text AS payer_count,
                count(*)::text AS provider_count
           FROM standard_asset_action_executions
          WHERE state='staged' AND stage_valid_before>now()`,
        [args.payer],
      );
      const counts = outstanding.rows[0]!;
      if (
        Number(counts.payer_count) >= args.abuse.destructiveOutstandingPerPayer ||
        Number(counts.provider_count) >= args.abuse.destructiveOutstandingPerProvider ||
        Number(counts.provider_count) >= args.abuse.destructiveOutstandingGlobal
      ) throw new Error("destructive action capacity exceeded");
    }
    // Admitted under the asset owner fence: the acting payer must be the
    // current owner, and the execution and its task record that owner.
    const owner = await admitAssetOwner(client, args.providerAssetId, args.payer);
    const customer = await upsertCustomer(args.payer, client);
    await client.query(
      `INSERT INTO standard_wallet_action_nonces
        (payer,nonce,action_hash,request_hash,wallet_authorization_hash)
       VALUES ($1,$2,$3,$4,$5)`,
      [args.payer, bytes(args.walletNonce), bytes(args.actionHash), bytes(args.requestHash),
        bytes(args.walletAuthorizationHash)],
    );
    await consumeGrant(client, args.grantNonce, args.grantHash, args.payer);
    await client.query(
      `INSERT INTO transactions
        (id,customer_id,asset_id,service_id,skill_id,status,metadata,canonical_request_hash,
         standard_payer,standard_action_execution_id,admitted_owner,admitted_owner_version)
       VALUES ($1,$2,$3,$4,$5,'working','{}'::jsonb,$6,$7,$8,$9,$10)`,
      [taskId, customer.id, args.providerAssetId, args.serviceId, args.skillId,
        bytes(args.requestHash), args.payer, bytes(args.executionId), owner.payer, owner.version],
    );
    const inserted = await client.query<AssetActionExecutionRow>(
      `INSERT INTO standard_asset_action_executions
        (execution_id,payer,provider_asset_id,action_hash,request_hash,wallet_authorization_hash,
         grant_hash,provider_control_profile_hash,servicing_admission_hash,action_catalog_hash,
         action_catalog_schema_hash,action_catalog_epoch,action_definition_hash,state,effect_summary,
         replay_policy,confirmation_hash,earliest_execution_at,stage_valid_before,result_valid_before,
         admitted_owner,admitted_owner_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
               to_timestamp($18::double precision),to_timestamp($19::double precision),
               to_timestamp($20::double precision),$21,$22)
       RETURNING *`,
      [bytes(args.executionId), args.payer, args.providerAssetId, bytes(args.actionHash),
        bytes(args.requestHash), bytes(args.walletAuthorizationHash), bytes(args.grantHash),
        bytes(args.providerControlProfileHash), bytes(args.servicingAdmissionHash),
        bytes(args.actionCatalogHash), bytes(args.actionCatalogSchemaHash), args.actionCatalogEpoch,
        bytes(args.actionDefinitionHash), args.destructive ? "staged" : "claimed",
        args.destructive?.effectSummary ?? null,
        args.replayPolicy,
        args.destructive ? bytes(args.destructive.confirmationHash) : null,
        args.destructive?.earliestExecutionAt ?? null, args.destructive?.stageValidBefore ?? null,
        args.resultValidBefore, owner.payer, owner.version],
    );
    if (args.destructive) {
      await client.query(
        `INSERT INTO standard_destructive_action_payloads(execution_id,encrypted_input,expires_at)
         VALUES ($1,$2,to_timestamp($3))`,
        [bytes(args.executionId), encryptString(
          JSON.stringify(args.destructive.input), payloadContext(args.executionId),
        ), args.destructive.stageValidBefore],
      );
    }
    await client.query("COMMIT");
    return { row: inserted.rows[0]!, taskId, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export async function consumeGrant(
  db: Queryable,
  nonce: Hex,
  grantHash: Hex,
  payer: Hex,
): Promise<void> {
  await db.query(
    `INSERT INTO standard_provider_grant_nonces(grant_nonce,grant_hash,payer)
     VALUES ($1,$2,$3)`,
    [bytes(nonce), bytes(grantHash), payer],
  );
}

/**
 * Take the asset owner fence of an execution before its row lock, the one
 * lock order every path shares with an owner change (which takes the fence
 * and then locks staged rows). An execution's asset never changes, so it is
 * read without a lock.
 */
export async function lockFenceForExecution(db: Queryable, executionId: Hex): Promise<void> {
  const located = await db.query<{ provider_asset_id: string }>(
    "SELECT provider_asset_id FROM standard_asset_action_executions WHERE execution_id=$1",
    [bytes(executionId)],
  );
  const assetId = located.rows[0]?.provider_asset_id;
  if (assetId) await lockAssetOwnerFence(db, assetId);
}

export async function transitionAssetAction(
  executionId: Hex,
  from: AssetActionExecutionRow["state"],
  to: AssetActionExecutionRow["state"],
  reconciliationIdentity?: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE standard_asset_action_executions SET state=$3,
        reconciliation_identity=COALESCE(reconciliation_identity,$4),updated_at=now()
      WHERE execution_id=$1 AND state=$2`,
    [bytes(executionId), from, to, reconciliationIdentity ?? null],
  );
  if (["completed", "failed", "canceled", "expired"].includes(to)) {
    await pool.query("DELETE FROM standard_destructive_action_payloads WHERE execution_id=$1", [bytes(executionId)]);
  }
  return result.rowCount === 1;
}

/**
 * Resume an execution parked in `attention` (after a human review): it is
 * re-admitted under the asset owner fence, so its payer must still own the
 * asset, and the execution and its task record the current owner version.
 * Null when the execution is no longer in attention.
 */
export async function admitAssetActionResumption(
  executionId: Hex,
  reconciliationIdentity: string,
): Promise<AssetActionExecutionRow | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockFenceForExecution(client, executionId);
    const row = (await client.query<AssetActionExecutionRow>(
      "SELECT * FROM standard_asset_action_executions WHERE execution_id=$1 AND state='attention' FOR UPDATE",
      [bytes(executionId)],
    )).rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }
    const owner = await admitAssetOwner(client, row.provider_asset_id, row.payer);
    const resumed = (await client.query<AssetActionExecutionRow>(
      `UPDATE standard_asset_action_executions
          SET state='executing',reconciliation_identity=COALESCE(reconciliation_identity,$2),
              admitted_owner=$3,admitted_owner_version=$4,updated_at=now()
        WHERE execution_id=$1 AND state='attention'
        RETURNING *`,
      [bytes(executionId), reconciliationIdentity, owner.payer, owner.version],
    )).rows[0]!;
    await client.query(
      `UPDATE transactions SET admitted_owner=$2,admitted_owner_version=$3,updated_at=now()
        WHERE standard_action_execution_id=$1`,
      [bytes(executionId), owner.payer, owner.version],
    );
    await client.query("COMMIT");
    return resumed;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function loadAssetActionExecution(executionId: Hex): Promise<AssetActionExecutionRow> {
  const result = await pool.query<AssetActionExecutionRow>(
    "SELECT * FROM standard_asset_action_executions WHERE execution_id=$1",
    [bytes(executionId)],
  );
  if (!result.rows[0]) throw new Error("asset action unavailable");
  return result.rows[0];
}

export async function loadAssetActionForTask(taskId: string): Promise<AssetActionExecutionRow | null> {
  const result = await pool.query<AssetActionExecutionRow>(
    `SELECT e.* FROM standard_asset_action_executions e
       JOIN transactions t ON t.standard_action_execution_id=e.execution_id
      WHERE t.id=$1`,
    [taskId],
  );
  return result.rows[0] ?? null;
}

export async function loadAssetActionStatesForTasks(
  taskIds: string[],
): Promise<Map<string, AssetActionExecutionRow["state"]>> {
  if (taskIds.length === 0) return new Map();
  const result = await pool.query<{ task_id: string; state: AssetActionExecutionRow["state"] }>(
    `SELECT t.id AS task_id,e.state
       FROM transactions t
       JOIN standard_asset_action_executions e
         ON e.execution_id=t.standard_action_execution_id
      WHERE t.id=ANY($1::text[])`,
    [taskIds],
  );
  return new Map(result.rows.map((row) => [row.task_id, row.state]));
}

/** The stored result of a completed execution; a fence holder passes its own connection. */
export async function loadAssetActionRecoveryResult(
  row: AssetActionExecutionRow,
  db: Queryable = pool,
): Promise<Record<string, unknown>> {
  if (row.result_valid_before <= new Date()) throw new Error("asset action recovery expired");
  const result = await db.query<{ encrypted_result: string; expires_at: Date }>(
    `SELECT encrypted_result,expires_at FROM standard_asset_action_recovery_results
      WHERE execution_id=$1`,
    [row.execution_id],
  );
  const recovery = result.rows[0];
  if (!recovery || recovery.expires_at <= new Date()) throw new Error("asset action recovery unavailable");
  const parsed: unknown = JSON.parse(decryptString(recovery.encrypted_result, recoveryResultContext(row)));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("asset action recovery result invalid");
  }
  return parsed as Record<string, unknown>;
}
