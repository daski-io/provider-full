import type { Address, Hex } from "viem";
import { pool } from "../db/pool.js";
import { consumeAssetEndpointRate } from "./assetRateLimit.js";
import { assertExactKeys, canonicalHash } from "./canonical.js";
import type { AssetActionExecutionRow } from "./actionStore.js";
import { regenerateEphemeralAssetActionResult } from "./actionExecution.js";
import { releaseFinalResponse, requireCurrentExecutionArtifacts } from "./assetActionResponse.js";
import { targetOf } from "./assetActionTarget.js";
import { compileProviderSchema, validateProviderRequest } from "./schema.js";
import type { ProviderStandardRailConfig } from "./config.js";
import type { ProviderWalletActionGrantV1, SignedEnvelope } from "./types.js";
import type { AssetActionDefinitionV1, ProviderWalletConfig } from "./walletConfig.js";
import {
  deriveActionExecutionId,
  utf8Hash,
  type WalletAuthorizationTransport,
} from "./walletAuthorization.js";

const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");
const hex = (value: Buffer): Hex => `0x${value.toString("hex")}`;

interface RecoveryBody {
  request: {
    actionId: string;
    providerAssetId: string;
    input: Record<string, unknown>;
  };
  authorization: WalletAuthorizationTransport;
  grant: SignedEnvelope<ProviderWalletActionGrantV1>;
}

export async function recoverAssetAction(args: {
  body: RecoveryBody;
  definition: AssetActionDefinitionV1;
  walletHash: Hex;
  grantHash: Hex;
  actionHash: Hex;
  requestHash: Hex;
  payer: Hex;
  serviceId: string;
  standard: ProviderStandardRailConfig;
  wallet: ProviderWalletConfig;
  chainId: number;
}): Promise<SignedEnvelope<unknown>> {
  assertExactKeys(args.body.request.input, [
    "operation", "actionExecutionId", "originalInput",
  ], "asset action recovery");
  const recovery = args.body.request.input;
  if (recovery.operation !== "recover-action" ||
    typeof recovery.actionExecutionId !== "string" ||
    !/^0x[0-9a-f]{64}$/.test(recovery.actionExecutionId) ||
    !recovery.originalInput || typeof recovery.originalInput !== "object" ||
    Array.isArray(recovery.originalInput)) throw new Error("asset action recovery denied");
  const originalInput = recovery.originalInput as Record<string, unknown>;
  validateProviderRequest(compileProviderSchema(args.definition.requestSchema), originalInput);
  const originalRequestHash = canonicalHash({
    actionId: args.body.request.actionId,
    providerAssetId: args.body.request.providerAssetId,
    input: originalInput,
  });
  const recoveryExecutionId = deriveActionExecutionId({
    walletAuthorizationHash: args.walletHash,
    providerAgentId: BigInt(args.wallet.providerAgentId),
    serviceId: args.definition.serviceId,
    providerControlProfileHash: args.wallet.providerControlProfileHash,
    servicingAdmissionHash: args.wallet.servicingAdmissionHash,
    actionCatalogHash: args.wallet.actionCatalogHash,
    actionCatalogSchemaHash: args.wallet.admission.actionCatalogSchemaHash,
    actionCatalogEpoch: BigInt(args.wallet.admission.actionCatalogEpoch),
    actionDefinitionHash: args.definition.actionDefinitionHash,
    requestHash: args.requestHash,
  });
  const row = await authorizeRecovery({
    recoveryExecutionId,
    actionExecutionId: recovery.actionExecutionId as Hex,
    payer: args.payer,
    providerAssetId: args.body.request.providerAssetId,
    originalRequestHash,
    walletAuthorizationHash: args.walletHash,
    walletNonce: args.body.authorization.message.nonce,
    actionHash: args.actionHash,
    originalActionHash: utf8Hash(
      `use-asset:${args.wallet.providerAgentId}:${args.definition.actionId}`,
    ),
    requestHash: args.requestHash,
    grantHash: args.grantHash,
    grantNonce: args.body.grant.payload.grantNonce,
    gatewaySigner: args.standard.gatewayLifecycleSigner,
    definition: args.definition,
    wallet: args.wallet,
  });
  requireCurrentExecutionArtifacts(row, args.definition, args.wallet);
  const context = {
    standard: args.standard,
    wallet: args.wallet,
    chainId: args.chainId,
    grant: args.body.grant,
    walletHash: args.walletHash,
    grantHash: args.grantHash,
    requestHash: args.requestHash,
  };
  // Released under the asset owner fence: a result admitted under an
  // earlier owner version is withheld even from a payer-exact recovery.
  if (args.definition.replayPolicy === "regenerate-ephemeral") {
    const result = await regenerateEphemeralAssetActionResult({
      definition: args.definition,
      taskId: `asset-action-${hex(row.execution_id).slice(2)}`,
      serviceId: args.serviceId,
      input: originalInput,
      target: targetOf(row),
    });
    return releaseFinalResponse({ row, definition: args.definition, context, stored: false, result });
  }
  return releaseFinalResponse({ row, definition: args.definition, context, stored: true });
}

async function authorizeRecovery(args: {
  recoveryExecutionId: Hex;
  actionExecutionId: Hex;
  payer: Hex;
  providerAssetId: string;
  originalRequestHash: Hex;
  walletAuthorizationHash: Hex;
  walletNonce: Hex;
  actionHash: Hex;
  originalActionHash: Hex;
  requestHash: Hex;
  grantHash: Hex;
  grantNonce: Hex;
  gatewaySigner: Address;
  definition: AssetActionDefinitionV1;
  wallet: ProviderWalletConfig;
}): Promise<AssetActionExecutionRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `asset-action-${args.actionExecutionId.slice(2)}`,
    ]);
    await consumeAssetEndpointRate({
      db: client,
      gatewaySigner: args.gatewaySigner,
      payer: args.payer,
      actionId: args.definition.actionId,
      limits: args.wallet.abuse,
    });
    const found = await client.query<AssetActionExecutionRow>(
      "SELECT * FROM standard_asset_action_executions WHERE execution_id=$1 FOR UPDATE",
      [bytes(args.actionExecutionId)],
    );
    const row = found.rows[0];
    if (!row || row.state !== "completed" || row.result_valid_before <= new Date() ||
      row.payer.toLowerCase() !== args.payer.toLowerCase() ||
      row.provider_asset_id !== args.providerAssetId ||
      hex(row.action_hash) !== args.originalActionHash ||
      hex(row.request_hash) !== args.originalRequestHash ||
      hex(row.provider_control_profile_hash) !== args.wallet.providerControlProfileHash ||
      hex(row.servicing_admission_hash) !== args.wallet.servicingAdmissionHash ||
      hex(row.action_catalog_hash) !== args.wallet.actionCatalogHash ||
      hex(row.action_catalog_schema_hash) !== args.wallet.admission.actionCatalogSchemaHash ||
      Number(row.action_catalog_epoch) !== args.wallet.admission.actionCatalogEpoch ||
      hex(row.action_definition_hash) !== args.definition.actionDefinitionHash ||
      row.replay_policy !== args.definition.replayPolicy) throw new Error("asset action recovery denied");
    const prior = await client.query<{
      action_execution_id: Buffer;
      payer: string;
      wallet_authorization_hash: Buffer;
      request_hash: Buffer;
    }>(
      "SELECT * FROM standard_asset_action_recovery_executions WHERE recovery_execution_id=$1 FOR UPDATE",
      [bytes(args.recoveryExecutionId)],
    );
    const existing = prior.rows[0];
    if (existing && (hex(existing.action_execution_id) !== args.actionExecutionId ||
      existing.payer.toLowerCase() !== args.payer.toLowerCase() ||
      hex(existing.wallet_authorization_hash) !== args.walletAuthorizationHash ||
      hex(existing.request_hash) !== args.requestHash)) throw new Error("asset action recovery replay mismatch");
    if (!existing) {
      await client.query(
        `INSERT INTO standard_wallet_action_nonces
          (payer,nonce,action_hash,request_hash,wallet_authorization_hash)
         VALUES ($1,$2,$3,$4,$5)`,
        [args.payer, bytes(args.walletNonce), bytes(args.actionHash),
          bytes(args.requestHash), bytes(args.walletAuthorizationHash)],
      );
      await client.query(
        `INSERT INTO standard_asset_action_recovery_executions
          (recovery_execution_id,action_execution_id,payer,wallet_authorization_hash,request_hash)
         VALUES ($1,$2,$3,$4,$5)`,
        [bytes(args.recoveryExecutionId), bytes(args.actionExecutionId), args.payer,
          bytes(args.walletAuthorizationHash), bytes(args.requestHash)],
      );
    }
    await client.query(
      `INSERT INTO standard_provider_grant_nonces(grant_nonce,grant_hash,payer)
       VALUES ($1,$2,$3)`,
      [bytes(args.grantNonce), bytes(args.grantHash), args.payer],
    );
    await client.query("COMMIT");
    return row;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
