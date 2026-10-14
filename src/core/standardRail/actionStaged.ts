import type { Address, Hex } from "viem";
import { decryptString } from "../chain/encryption.js";
import { pool } from "../db/pool.js";
import type { DeferredTaskEmits } from "../engine/taskTransitions.js";
import { cancelLinkedAssetActionTransaction } from "./actionLifecycle.js";
import {
  consumeGrant,
  lockFenceForExecution,
  payloadContext,
  type AssetActionExecutionRow,
} from "./actionStore.js";
import { consumeAssetEndpointRate } from "./assetRateLimit.js";
import { admitAssetOwner } from "./assetOwnerFence.js";
import type { ProviderWalletConfig } from "./walletConfig.js";

const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");
const hex = (value: Buffer): Hex => `0x${value.toString("hex")}`;

export async function loadDestructiveInput(executionId: Hex): Promise<Record<string, unknown>> {
  const result = await pool.query<{ encrypted_input: string; expires_at: Date }>(
    "SELECT encrypted_input,expires_at FROM standard_destructive_action_payloads WHERE execution_id=$1",
    [bytes(executionId)],
  );
  const row = result.rows[0];
  if (!row || row.expires_at <= new Date()) throw new Error("staged action expired");
  const parsed: unknown = JSON.parse(decryptString(row.encrypted_input, payloadContext(executionId)));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("staged input invalid");
  return parsed as Record<string, unknown>;
}

interface FollowupRow {
  action_execution_id: Buffer;
  payer: string;
  operation: "confirm" | "cancel";
  confirmation_hash: Buffer;
  wallet_authorization_hash: Buffer;
  request_hash: Buffer;
}

/**
 * Authorize the delayed second step of a staged destructive action. The
 * follow-up acts only on the staged row its request names: the same asset,
 * payer, admitted definition and artifacts, and the exact confirmation
 * hash. A confirmation re-admits the work under the asset owner fence (the
 * payer must still own the asset) before the row moves to executing; the
 * fence is taken before the row lock, the order an owner change uses too.
 */
export async function authorizeStagedAction(args: {
  followupExecutionId: Hex;
  executionId: Hex;
  payer: Hex;
  providerAssetId: string;
  confirmationHash: Hex;
  operation: "confirm" | "cancel";
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
  gatewaySigner: Address;
  abuse: ProviderWalletConfig["abuse"];
}): Promise<{ row: AssetActionExecutionRow; taskId: string; replayed: boolean }> {
  const client = await pool.connect();
  const taskId = `asset-action-${args.executionId.slice(2)}`;
  const deferred: DeferredTaskEmits = [];
  let result: { row: AssetActionExecutionRow; taskId: string; replayed: boolean } | undefined;
  try {
    // Read committed for the same reason as the claim: the owner read after
    // the fence must see what committed before the fence was granted.
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [taskId]);
    await consumeAssetEndpointRate({
      db: client, gatewaySigner: args.gatewaySigner, payer: args.payer,
      actionId: args.actionId, limits: args.abuse,
    });
    await lockFenceForExecution(client, args.executionId);
    const row = (await client.query<AssetActionExecutionRow>(
      "SELECT * FROM standard_asset_action_executions WHERE execution_id=$1 FOR UPDATE",
      [bytes(args.executionId)],
    )).rows[0];
    const existing = (await client.query<FollowupRow>(
      `SELECT * FROM standard_destructive_followup_executions
        WHERE followup_execution_id=$1 FOR UPDATE`,
      [bytes(args.followupExecutionId)],
    )).rows[0];
    if (existing && (
      hex(existing.action_execution_id) !== args.executionId ||
      existing.payer.toLowerCase() !== args.payer.toLowerCase() ||
      existing.operation !== args.operation ||
      hex(existing.confirmation_hash) !== args.confirmationHash ||
      hex(existing.wallet_authorization_hash) !== args.walletAuthorizationHash ||
      hex(existing.request_hash) !== args.requestHash
    )) throw new Error("staged action replay mismatch");
    if (!row || row.payer.toLowerCase() !== args.payer.toLowerCase()) throw new Error("staged action unavailable");
    // A definite refusal: the follow-up names another asset than its stage.
    if (row.provider_asset_id !== args.providerAssetId) throw new Error("staged action target mismatch");
    if (
      hex(row.provider_control_profile_hash) !== args.providerControlProfileHash ||
      hex(row.servicing_admission_hash) !== args.servicingAdmissionHash ||
      hex(row.action_catalog_hash) !== args.actionCatalogHash ||
      hex(row.action_catalog_schema_hash) !== args.actionCatalogSchemaHash ||
      Number(row.action_catalog_epoch) !== args.actionCatalogEpoch ||
      hex(row.action_definition_hash) !== args.actionDefinitionHash ||
      !row.confirmation_hash || hex(row.confirmation_hash) !== args.confirmationHash ||
      (!existing && (!row.stage_valid_before || row.stage_valid_before <= new Date())) ||
      (!existing && args.operation === "confirm" &&
        (!row.earliest_execution_at || row.earliest_execution_at > new Date())) ||
      (!existing && row.state !== "staged") ||
      (existing && args.operation === "confirm" &&
        !["executing", "completed", "failed", "attention"].includes(row.state)) ||
      (existing && args.operation === "cancel" && row.state !== "canceled")
    ) throw new Error("staged action unavailable");
    if (!existing) {
      await client.query(
        `INSERT INTO standard_wallet_action_nonces
          (payer,nonce,action_hash,request_hash,wallet_authorization_hash)
         VALUES ($1,$2,$3,$4,$5)`,
        [args.payer, bytes(args.walletNonce), bytes(args.actionHash), bytes(args.requestHash),
          bytes(args.walletAuthorizationHash)],
      );
      await client.query(
        `INSERT INTO standard_destructive_followup_executions
          (followup_execution_id,action_execution_id,payer,operation,confirmation_hash,
           wallet_authorization_hash,request_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [bytes(args.followupExecutionId), bytes(args.executionId), args.payer, args.operation,
          bytes(args.confirmationHash), bytes(args.walletAuthorizationHash), bytes(args.requestHash)],
      );
    }
    await consumeGrant(client, args.grantNonce, args.grantHash, args.payer);
    if (!existing) {
      row.state = args.operation === "confirm" ? "executing" : "canceled";
      if (row.state === "executing") {
        // The staged-to-executing transition starts owner-only work.
        const owner = await admitAssetOwner(client, row.provider_asset_id, args.payer);
        row.admitted_owner = owner.payer;
        row.admitted_owner_version = owner.version;
        await client.query(
          `UPDATE transactions SET admitted_owner=$2,admitted_owner_version=$3,updated_at=now()
            WHERE id=$1`,
          [taskId, owner.payer, owner.version],
        );
      }
      await client.query(
        `UPDATE standard_asset_action_executions SET state=$2,
            reconciliation_identity=CASE WHEN $2='executing' THEN COALESCE(reconciliation_identity,$3)
              ELSE reconciliation_identity END,
            admitted_owner=$4,admitted_owner_version=$5,updated_at=now()
          WHERE execution_id=$1`,
        [bytes(args.executionId), row.state, taskId, row.admitted_owner, row.admitted_owner_version],
      );
      if (row.state === "canceled") {
        await client.query("DELETE FROM standard_destructive_action_payloads WHERE execution_id=$1", [
          bytes(args.executionId),
        ]);
      }
      if (row.state === "executing") {
        await client.query(
          "UPDATE standard_destructive_action_payloads SET expires_at=$2 WHERE execution_id=$1",
          [bytes(args.executionId), row.result_valid_before],
        );
      }
    }
    if (row.state === "canceled") {
      await cancelLinkedAssetActionTransaction({
        db: client,
        taskId,
        reason: "wallet_canceled",
        deferred,
      });
    }
    await client.query("COMMIT");
    result = { row, taskId, replayed: existing !== undefined };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
  for (const emit of deferred) emit();
  return result!;
}
