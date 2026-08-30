import { getAddress, type Hex } from "viem";
import { getStandardPayerAsset } from "../db/queries/assetOwnership.js";
import { getAssetById } from "../db/queries/assets.js";
import { assertExactKeys, canonicalHash } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import type { ProviderWalletActionGrantV1, SignedEnvelope } from "./types.js";
import type { AssetActionDefinitionV1, ProviderWalletConfig } from "./walletConfig.js";
import { deriveActionExecutionId, type WalletAuthorizationTransport } from "./walletAuthorization.js";
import {
  authorizeStagedAction,
  loadAssetActionRecoveryResult,
  loadDestructiveInput,
} from "./actionStore.js";
import { executeAssetAction } from "./actionExecution.js";
import {
  requireCurrentExecutionArtifacts,
  signFinalResponse,
  signStageResponse,
} from "./assetActionResponse.js";
import type { ServiceRow } from "../db/queries/services.js";
import type { SkillRow } from "../db/queries/skills.js";
import { compileProviderSchema, validateProviderRequest } from "./schema.js";

interface ActionBody {
  request: {
    actionId: string;
    providerAssetId: string;
    input: Record<string, unknown>;
  };
  authorization: WalletAuthorizationTransport;
  grant: SignedEnvelope<ProviderWalletActionGrantV1>;
}

export function destructiveClaim(args: {
  definition: AssetActionDefinitionV1;
  request: ActionBody["request"];
  executionId: Hex;
  wallet: ProviderWalletConfig;
}) {
  const issuedAt = Math.floor(Date.now() / 1_000);
  const earliestExecutionAt = issuedAt + args.wallet.destructiveActionDelaySeconds;
  const stageValidBefore = Math.min(
    issuedAt + 86_400,
    issuedAt + args.definition.retentionSeconds,
    args.definition.validBefore,
    args.wallet.admission.validBefore,
  );
  const effectSummary = renderConfirmationSummary(
    args.definition.confirmationSummaryTemplate!,
    args.request,
  );
  validateProviderRequest(
    compileProviderSchema(args.definition.confirmationSummarySchema!),
    effectSummary,
    "Response",
  );
  const confirmationHash = canonicalHash({
    request: args.request,
    effectSummary,
    providerControlProfileHash: args.wallet.providerControlProfileHash,
    servicingAdmissionHash: args.wallet.servicingAdmissionHash,
    actionCatalogHash: args.wallet.actionCatalogHash,
    actionCatalogSchemaHash: args.wallet.admission.actionCatalogSchemaHash,
    actionCatalogEpoch: args.wallet.admission.actionCatalogEpoch,
    servicingProfileEpoch: args.wallet.admission.servicingProfileEpoch,
    actionDefinitionHash: args.definition.actionDefinitionHash,
    actionExecutionId: args.executionId,
    earliestExecutionAt,
    stageValidBefore,
  });
  return {
    input: args.request.input, effectSummary, confirmationHash,
    earliestExecutionAt, stageValidBefore,
  };
}

export function renderConfirmationSummary(
  template: Record<string, unknown>,
  request: ActionBody["request"],
): Record<string, unknown> {
  const requestFields: Record<string, unknown> = {
    ...request.input,
    actionId: request.actionId,
    providerAssetId: request.providerAssetId,
  };
  return Object.fromEntries(Object.entries(template).map(([key, fallback]) => [
    key,
    Object.prototype.hasOwnProperty.call(requestFields, key) ? requestFields[key] : fallback,
  ]));
}

export async function performDestructiveFollowUp(args: {
  body: ActionBody;
  definition: AssetActionDefinitionV1;
  walletHash: Hex;
  grantHash: Hex;
  actionHash: Hex;
  requestHash: Hex;
  service: ServiceRow;
  skill: SkillRow;
  standard: ProviderStandardRailConfig;
  wallet: ProviderWalletConfig;
  chainId: number;
}): Promise<SignedEnvelope<unknown>> {
  if (!args.definition.destructive) throw new Error("asset action denied");
  assertExactKeys(args.body.request.input, [
    "operation", "actionExecutionId", "confirmationHash",
  ], "destructive follow-up");
  const operation = args.body.request.input.operation;
  const executionId = args.body.request.input.actionExecutionId;
  const confirmationHash = args.body.request.input.confirmationHash;
  if (
    (operation !== "confirm-destructive" && operation !== "cancel-staged-action") ||
    typeof executionId !== "string" || !/^0x[0-9a-f]{64}$/.test(executionId) ||
    typeof confirmationHash !== "string" || !/^0x[0-9a-f]{64}$/.test(confirmationHash)
  ) throw new Error("asset action denied");
  const payer = getAddress(args.body.grant.payload.payer).toLowerCase() as Hex;
  const followupExecutionId = operation === "confirm-destructive"
    ? canonicalHash({
        operation: "confirm-destructive",
        actionExecutionId: executionId,
        confirmationHash,
        walletAuthorizationHash: args.walletHash,
      })
    : deriveActionExecutionId({
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
  const authorized = await authorizeStagedAction({
    followupExecutionId,
    executionId: executionId as Hex,
    payer,
    confirmationHash: confirmationHash as Hex,
    operation: operation === "confirm-destructive" ? "confirm" : "cancel",
    actionId: args.definition.actionId,
    actionHash: args.actionHash,
    requestHash: args.requestHash,
    walletAuthorizationHash: args.walletHash,
    walletNonce: args.body.authorization.message.nonce,
    grantHash: args.grantHash,
    grantNonce: args.body.grant.payload.grantNonce,
    providerControlProfileHash: args.wallet.providerControlProfileHash,
    servicingAdmissionHash: args.wallet.servicingAdmissionHash,
    actionCatalogHash: args.wallet.actionCatalogHash,
    actionCatalogSchemaHash: args.wallet.admission.actionCatalogSchemaHash,
    actionCatalogEpoch: args.wallet.admission.actionCatalogEpoch,
    actionDefinitionHash: args.definition.actionDefinitionHash,
    gatewaySigner: args.standard.gatewayLifecycleSigner,
    abuse: args.wallet.abuse,
  });
  requireCurrentExecutionArtifacts(authorized.row, args.definition, args.wallet);
  const context = {
    standard: args.standard, wallet: args.wallet, chainId: args.chainId,
    grant: args.body.grant, walletHash: args.walletHash,
    grantHash: args.grantHash, requestHash: args.requestHash,
  };
  if (operation === "cancel-staged-action") return signStageResponse(authorized.row, context);
  if (authorized.replayed && ["completed", "failed"].includes(authorized.row.state)) {
    const recovered = authorized.row.state === "completed" &&
      ["stable-result", "redacted-after-window"].includes(args.definition.replayPolicy)
      ? await loadAssetActionRecoveryResult(authorized.row)
      : undefined;
    return signFinalResponse(authorized.row, args.definition, context, recovered);
  }
  if (authorized.replayed) throw new Error("asset action unavailable");
  const stagedInput = await loadDestructiveInput(executionId as Hex);
  const asset = await getStandardPayerAsset({ payer, providerAssetId: authorized.row.provider_asset_id });
  const fullAsset = asset && await getAssetById(asset.id);
  if (!fullAsset) throw new Error("asset action denied");
  const completed = await executeAssetAction({
    definition: args.definition,
    executionId: executionId as Hex,
    taskId: authorized.taskId,
    service: args.service,
    skill: args.skill,
    input: stagedInput,
    asset: fullAsset,
    persistResult: true,
  });
  authorized.row.state = completed.status;
  if (args.definition.replayPolicy === "stable-result") {
    authorized.row.sanitized_result = completed.result;
  }
  authorized.row.error_class = completed.errorClass;
  if (completed.status === "attention") throw new Error("asset action unavailable");
  return signFinalResponse(authorized.row, args.definition, context, completed.result);
}
