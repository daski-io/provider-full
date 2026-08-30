import { randomBytes } from "node:crypto";
import { getAddress, type Hex } from "viem";
import { compileProviderSchema, validateProviderRequest } from "./schema.js";
import type { ProviderStandardRailConfig } from "./config.js";
import type {
  ProviderAssetActionResponseV1,
  ProviderAssetActionStageResponseV1,
  ProviderWalletActionGrantV1,
  SignedEnvelope,
} from "./types.js";
import type { AssetActionDefinitionV1, ProviderWalletConfig } from "./walletConfig.js";
import type { AssetActionExecutionRow } from "./actionStore.js";
import { signProviderResponse } from "./providerResponse.js";

interface ResponseContext {
  standard: ProviderStandardRailConfig;
  wallet: ProviderWalletConfig;
  chainId: number;
  grant: SignedEnvelope<ProviderWalletActionGrantV1>;
  walletHash: Hex;
  grantHash: Hex;
  requestHash: Hex;
}

function bindings(context: ResponseContext) {
  return {
    responseNonce: `0x${randomBytes(32).toString("hex")}` as Hex,
    requestHash: context.requestHash,
    walletAuthorizationHash: context.walletHash,
    grantHash: context.grantHash,
    providerControlProfileHash: context.wallet.providerControlProfileHash,
    servicingAdmissionHash: context.wallet.servicingAdmissionHash,
    servicingProfileEpoch: context.wallet.admission.servicingProfileEpoch,
    actionCatalogHash: context.wallet.actionCatalogHash,
    actionCatalogSchemaHash: context.wallet.admission.actionCatalogSchemaHash,
    actionCatalogEpoch: context.wallet.admission.actionCatalogEpoch,
    actionDefinitionHash: context.grant.payload.actionDefinitionHash,
  };
}

export function requireCurrentExecutionArtifacts(
  row: AssetActionExecutionRow,
  definition: AssetActionDefinitionV1,
  wallet: ProviderWalletConfig,
): void {
  const asHex = (value: Buffer) => `0x${value.toString("hex")}`;
  if (
    asHex(row.provider_control_profile_hash) !== wallet.providerControlProfileHash ||
    asHex(row.servicing_admission_hash) !== wallet.servicingAdmissionHash ||
    asHex(row.action_catalog_hash) !== wallet.actionCatalogHash ||
    asHex(row.action_catalog_schema_hash) !== wallet.admission.actionCatalogSchemaHash ||
    Number(row.action_catalog_epoch) !== wallet.admission.actionCatalogEpoch ||
    asHex(row.action_definition_hash) !== definition.actionDefinitionHash
  ) throw new Error("staged action artifact superseded");
}

export function signStageResponse(
  row: AssetActionExecutionRow,
  context: ResponseContext,
): Promise<SignedEnvelope<ProviderAssetActionStageResponseV1>> {
  if (!row.effect_summary || !row.confirmation_hash || !row.earliest_execution_at || !row.stage_valid_before) {
    throw new Error("staged action state invalid");
  }
  const payload: ProviderAssetActionStageResponseV1 = {
    providerAgentId: context.wallet.providerAgentId,
    payer: getAddress(context.grant.payload.payer).toLowerCase() as Hex,
    actionExecutionId: `0x${row.execution_id.toString("hex")}`,
    status: row.state === "canceled" ? "canceled" : "staged",
    effectSummary: row.effect_summary,
    confirmationHash: `0x${row.confirmation_hash.toString("hex")}`,
    earliestExecutionAt: Math.floor(row.earliest_execution_at.getTime() / 1_000),
    stageValidBefore: Math.floor(row.stage_valid_before.getTime() / 1_000),
    ...bindings(context),
  };
  return signProviderResponse({
    artifactType: "ProviderAssetActionStageResponseV1", payload,
    standard: context.standard, wallet: context.wallet, chainId: context.chainId,
    grantDeadline: context.grant.validBefore,
  });
}

export function signFinalResponse(
  row: AssetActionExecutionRow,
  definition: AssetActionDefinitionV1,
  context: ResponseContext,
  transientResult?: Record<string, unknown> | null,
): Promise<SignedEnvelope<ProviderAssetActionResponseV1>> {
  const status = row.state === "completed" ? "completed" : "failed";
  const result = transientResult === undefined ? row.sanitized_result : transientResult;
  if (status === "completed" && row.result_valid_before <= new Date()) {
    throw new Error("completed action recovery expired");
  }
  if (status === "completed" && (!result || typeof result !== "object" || Array.isArray(result))) {
    throw new Error("completed action result is unavailable");
  }
  if (status === "completed") {
    validateProviderRequest(compileProviderSchema(definition.responseSchema), result, "Response");
  }
  const payload: ProviderAssetActionResponseV1 = {
    providerAgentId: context.wallet.providerAgentId,
    payer: getAddress(context.grant.payload.payer).toLowerCase() as Hex,
    actionExecutionId: `0x${row.execution_id.toString("hex")}`,
    status,
    ...bindings(context),
    result: status === "completed" ? result : null,
    errorClass: status === "failed"
      ? row.state === "attention" ? "provider_retryable" : row.error_class ?? "provider_failed"
      : null,
  };
  return signProviderResponse({
    artifactType: "ProviderAssetActionResponseV1", payload,
    standard: context.standard, wallet: context.wallet, chainId: context.chainId,
    grantDeadline: context.grant.validBefore,
  });
}
