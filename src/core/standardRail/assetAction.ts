import { getAddress, type Hex } from "viem";
import { getStandardPayerAsset } from "../db/queries/assetOwnership.js";
import { getAssetById } from "../db/queries/assets.js";
import { getServiceBySlug } from "../db/queries/services.js";
import { getSkillByServiceAndSkillId } from "../db/queries/skills.js";
import { assertExactKeys } from "./canonical.js";
import { compileProviderSchema, validateProviderRequest } from "./schema.js";
import type { ProviderStandardRailConfig } from "./config.js";
import type {
  ProviderWalletActionGrantV1,
  SignedEnvelope,
} from "./types.js";
import type { AssetActionDefinitionV1, ProviderWalletConfig } from "./walletConfig.js";
import {
  deriveActionExecutionId,
  requestHash,
  utf8Hash,
  verifyProviderGrant,
  verifyWalletAuthorization,
  type WalletAuthorizationTransport,
} from "./walletAuthorization.js";
import {
  claimAssetAction,
  loadAssetActionExecution,
  loadAssetActionRecoveryResult,
  transitionAssetAction,
} from "./actionStore.js";
import { executeAssetAction, regenerateEphemeralAssetActionResult } from "./actionExecution.js";
import { signFinalResponse, signStageResponse } from "./assetActionResponse.js";
import { destructiveClaim, performDestructiveFollowUp } from "./destructiveAction.js";
import { recoverAssetAction } from "./actionRecovery.js";
import { assertProviderWalletAvailable } from "./walletConfig.js";

interface AssetActionRequestV1 {
  actionId: string;
  providerAssetId: string;
  input: Record<string, unknown>;
}

interface ActionBody {
  request: AssetActionRequestV1;
  authorization: WalletAuthorizationTransport;
  grant: SignedEnvelope<ProviderWalletActionGrantV1>;
}

export class ProviderAssetActionService {
  constructor(
    private readonly standard: ProviderStandardRailConfig,
    private readonly wallet: ProviderWalletConfig,
    private readonly chainId: number,
  ) {}

  async perform(input: unknown): Promise<SignedEnvelope<unknown>> {
    const body = this.parseBody(input);
    const definition = this.wallet.catalog.actions.find((item) => item.actionId === body.request.actionId);
    if (!definition) throw new Error("asset action denied");
    await assertProviderWalletAvailable(this.wallet, definition);
    const operation = this.operation(body.request.input);
    const actionHash = utf8Hash(operation === "confirm"
      ? `confirm-destructive:${this.wallet.providerAgentId}:${definition.actionId}`
      : operation === "recover"
        ? `recover-action:${this.wallet.providerAgentId}:${definition.actionId}`
        : `use-asset:${this.wallet.providerAgentId}:${definition.actionId}`);
    const canonicalRequestHash = requestHash(body.request);
    // The gateway's grant first: an offline recovery that costs nothing, so a
    // request without one never reaches the payer-signature verification,
    // whose contract-account path is a bounded chain call.
    const grantHash = await verifyProviderGrant({
      envelope: body.grant,
      environment: this.standard.environment,
      chainId: this.chainId,
      providerAudience: this.standard.providerAudience,
      gatewayLifecycleSigner: this.standard.gatewayLifecycleSigner,
    });
    const walletHash = await verifyWalletAuthorization({
      authorization: body.authorization,
      chainId: this.chainId,
      expectedPayer: getAddress(body.grant.payload.payer),
      expectedRequestHash: canonicalRequestHash,
      expectedActionHash: actionHash,
      expectedAudienceHash: utf8Hash(this.standard.gatewayAudience),
    });
    this.validateBindings(body, definition, walletHash, canonicalRequestHash, actionHash);
    const payer = getAddress(body.grant.payload.payer).toLowerCase() as Hex;
    const asset = await getStandardPayerAsset({ payer, providerAssetId: body.request.providerAssetId });
    if (!asset || asset.service_slug !== definition.serviceSlug || asset.type !== definition.assetType) {
      throw new Error("asset action denied");
    }
    const service = await getServiceBySlug(definition.serviceSlug);
    const skill = service && await getSkillByServiceAndSkillId(service.id, definition.actionId);
    if (!service || !skill) throw new Error("asset action unavailable");
    if (operation === "recover") {
      return recoverAssetAction({
        body, definition, walletHash, grantHash, actionHash,
        requestHash: canonicalRequestHash, payer, serviceId: service.id,
        standard: this.standard, wallet: this.wallet, chainId: this.chainId,
      });
    }
    if (operation) {
      return performDestructiveFollowUp({
        body, definition, walletHash, grantHash, actionHash,
        requestHash: canonicalRequestHash, service, skill,
        standard: this.standard, wallet: this.wallet, chainId: this.chainId,
      });
    }
    validateProviderRequest(compileProviderSchema(definition.requestSchema), body.request.input);
    const executionId = deriveActionExecutionId({
      walletAuthorizationHash: walletHash,
      providerAgentId: BigInt(this.wallet.providerAgentId),
      serviceId: definition.serviceId,
      providerControlProfileHash: this.wallet.providerControlProfileHash,
      servicingAdmissionHash: this.wallet.servicingAdmissionHash,
      actionCatalogHash: this.wallet.actionCatalogHash,
      actionCatalogSchemaHash: this.wallet.admission.actionCatalogSchemaHash,
      actionCatalogEpoch: BigInt(this.wallet.admission.actionCatalogEpoch),
      actionDefinitionHash: definition.actionDefinitionHash,
      requestHash: canonicalRequestHash,
    });
    const destructive = definition.destructive
      ? destructiveClaim({ definition, request: body.request, executionId, wallet: this.wallet })
      : undefined;
    const claim = await claimAssetAction({
      executionId, payer, providerAssetId: asset.id, serviceId: service.id,
      skillId: definition.actionId, actionId: definition.actionId,
      actionHash, requestHash: canonicalRequestHash,
      walletAuthorizationHash: walletHash, walletNonce: body.authorization.message.nonce,
      grantHash, grantNonce: body.grant.payload.grantNonce,
      providerControlProfileHash: this.wallet.providerControlProfileHash,
      servicingAdmissionHash: this.wallet.servicingAdmissionHash,
      actionCatalogHash: this.wallet.actionCatalogHash,
      actionCatalogSchemaHash: this.wallet.admission.actionCatalogSchemaHash,
      actionCatalogEpoch: this.wallet.admission.actionCatalogEpoch,
      actionDefinitionHash: definition.actionDefinitionHash,
      replayPolicy: definition.replayPolicy,
      resultValidBefore: Math.min(
        Math.floor(Date.now() / 1_000) + definition.retentionSeconds,
        definition.validBefore,
        this.wallet.admission.validBefore,
      ),
      gatewaySigner: this.standard.gatewayLifecycleSigner,
      abuse: this.wallet.abuse,
      destructive,
    });
    if (definition.destructive) {
      return signStageResponse(claim.row, this.responseContext(body, walletHash, grantHash, canonicalRequestHash));
    }
    let current = claim.row;
    let transientResult: Record<string, unknown> | null | undefined;
    const ownsExecution = current.state === "claimed" &&
      await transitionAssetAction(executionId, "claimed", "executing", claim.taskId);
    if (ownsExecution) {
      current.state = "executing";
      const fullAsset = await getAssetById(asset.id);
      if (!fullAsset) throw new Error("asset action denied");
      const completed = await executeAssetAction({
        definition, executionId, taskId: claim.taskId, service, skill,
        input: body.request.input, asset: fullAsset,
        persistResult: definition.replayPolicy !== "regenerate-ephemeral",
      });
      current.state = completed.status;
      transientResult = completed.result;
      current.error_class = completed.errorClass;
    } else {
      current = await loadAssetActionExecution(executionId);
      if (["claimed", "executing", "attention"].includes(current.state)) {
        throw new Error("asset action unavailable");
      }
    }
    if (!ownsExecution && definition.replayPolicy === "regenerate-ephemeral" && current.state === "completed") {
      if (current.result_valid_before <= new Date()) throw new Error("asset action recovery expired");
      const fullAsset = await getAssetById(asset.id);
      if (!fullAsset) throw new Error("asset action denied");
      transientResult = await regenerateEphemeralAssetActionResult({
        definition,
        taskId: claim.taskId,
        serviceId: service.id,
        input: body.request.input,
        asset: fullAsset,
      });
    } else if (!ownsExecution && ["stable-result", "redacted-after-window"].includes(definition.replayPolicy) &&
      current.state === "completed") {
      transientResult = await loadAssetActionRecoveryResult(current);
    }
    if (current.state === "attention") throw new Error("asset action unavailable");
    return signFinalResponse(
      current,
      definition,
      this.responseContext(body, walletHash, grantHash, canonicalRequestHash),
      transientResult,
    );
  }

  private parseBody(input: unknown): ActionBody {
    assertExactKeys(input, ["request", "authorization", "grant"], "asset action");
    const body = input as ActionBody;
    assertExactKeys(body.request, ["actionId", "providerAssetId", "input"], "asset action request");
    if (
      !/^[a-z0-9][a-z0-9-]{0,95}$/.test(body.request.actionId) ||
      !/^[0-9a-f-]{36}$/.test(body.request.providerAssetId) ||
      !body.request.input || typeof body.request.input !== "object" || Array.isArray(body.request.input)
    ) throw new Error("asset action denied");
    return body;
  }

  private operation(input: Record<string, unknown>): "confirm" | "cancel" | "recover" | null {
    return input.operation === "confirm-destructive" ? "confirm"
      : input.operation === "cancel-staged-action" ? "cancel"
        : input.operation === "recover-action" ? "recover" : null;
  }

  private validateBindings(
    body: ActionBody,
    definition: AssetActionDefinitionV1,
    walletHash: Hex,
    canonicalRequestHash: Hex,
    actionHash: Hex,
  ): void {
    const message = body.authorization.message;
    const grant = body.grant.payload;
    if (
      message.providerAgentId !== this.wallet.providerAgentId || message.serviceId !== definition.serviceId ||
      message.providerControlProfileHash !== this.wallet.providerControlProfileHash ||
      message.servicingAdmissionHash !== this.wallet.servicingAdmissionHash ||
      message.actionCatalogHash !== this.wallet.actionCatalogHash ||
      message.actionCatalogSchemaHash !== this.wallet.admission.actionCatalogSchemaHash ||
      message.actionCatalogEpoch !== this.wallet.admission.actionCatalogEpoch ||
      message.actionDefinitionHash !== definition.actionDefinitionHash ||
      message.methodHash !== utf8Hash("POST") ||
      message.absoluteResourceUriHash !== utf8Hash(this.wallet.gatewayAssetActionUrl) ||
      grant.providerAgentId !== message.providerAgentId || grant.payer !== message.payer ||
      grant.serviceId !== message.serviceId || grant.actionHash !== actionHash ||
      grant.methodHash !== message.methodHash || grant.absoluteResourceUriHash !== message.absoluteResourceUriHash ||
      grant.requestHash !== canonicalRequestHash || grant.walletAuthorizationHash !== walletHash ||
      grant.providerControlProfileHash !== message.providerControlProfileHash ||
      grant.servicingAdmissionHash !== message.servicingAdmissionHash ||
      grant.servicingProfileEpoch !== this.wallet.admission.servicingProfileEpoch ||
      grant.actionCatalogHash !== message.actionCatalogHash ||
      grant.actionCatalogSchemaHash !== message.actionCatalogSchemaHash ||
      grant.actionCatalogEpoch !== message.actionCatalogEpoch ||
      grant.actionDefinitionHash !== message.actionDefinitionHash ||
      grant.gatewayAudienceHash !== utf8Hash(this.standard.gatewayAudience) ||
      grant.providerAudienceHash !== utf8Hash(this.standard.providerAudience)
    ) throw new Error("asset action denied");
  }

  private responseContext(
    body: ActionBody,
    walletHash: Hex,
    grantHash: Hex,
    canonicalRequestHash: Hex,
  ) {
    return {
      standard: this.standard,
      wallet: this.wallet,
      chainId: this.chainId,
      grant: body.grant,
      walletHash,
      grantHash,
      requestHash: canonicalRequestHash,
    };
  }
}
