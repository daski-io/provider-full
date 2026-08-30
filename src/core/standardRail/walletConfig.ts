import { createHash } from "node:crypto";
import { getAddress, recoverMessageAddress, type Address, type Hex } from "viem";
import {
  assertExactKeys,
  assertNoDuplicateJsonKeys,
  canonicalHash,
  SIGNED_ENVELOPE_KEYS,
  unsignedEnvelopeHash,
} from "./canonical.js";
import type { CursorKeyRing } from "./cursor.js";
import type { ProviderStandardRailConfig } from "./config.js";
import type { SignedEnvelope } from "./types.js";
import { compileProviderSchema, validateProviderRequest } from "./schema.js";
import type {
  ProviderWalletLaunchPolicy,
} from "./launchPolicy.js";
import type { AssetActionReplayPolicy } from "../serviceRegistry/manifestTypes.js";

export interface ProviderServicingAdmissionV1 {
  providerAgentId: string;
  providerControlProfileHash: Hex;
  servicingProfileEpoch: number;
  actionCatalogHash: Hex;
  actionCatalogSchemaHash: Hex;
  actionCatalogEpoch: number;
  servicingEnabled: boolean;
  previousAdmissionHash: Hex;
  validFrom: number;
  validBefore: number;
}

export interface AssetActionDefinitionV1 {
  providerAgentId: string;
  serviceId: Hex;
  serviceSlug: string;
  actionId: string;
  assetType: string;
  ownershipPolicy: "owner-only";
  destructive: boolean;
  requestSchema: Record<string, unknown>;
  responseSchema: Record<string, unknown>;
  confirmationSummarySchema: Record<string, unknown> | null;
  confirmationSummaryTemplate: Record<string, unknown> | null;
  endpoint: string;
  replayPolicy: AssetActionReplayPolicy;
  retentionSeconds: number;
  validFrom: number;
  validBefore: number;
  actionDefinitionHash: Hex;
}

export interface ProviderAssetActionCatalogV1 {
  providerAgentId: string;
  providerControlProfileHash: Hex;
  servicingProfileEpoch: number;
  actionCatalogSchemaHash: Hex;
  actionCatalogEpoch: number;
  actions: AssetActionDefinitionV1[];
}

export interface ProviderWalletConfig {
  providerAgentId: string;
  providerControlProfileHash: Hex;
  servicingAdmissionHash: Hex;
  admission: ProviderServicingAdmissionV1;
  actionCatalogHash: Hex;
  catalog: ProviderAssetActionCatalogV1;
  assetResponsePrivateKey: Hex;
  assetResponseKey: Address;
  assetResponseKeyId: string;
  artifactValidBefore: number;
  cursorKeyRing: CursorKeyRing;
  destructiveActionDelaySeconds: number;
  gatewayAssetQueryUrl: string;
  gatewayAssetActionUrl: string;
  abuse: {
    requestsPerGatewaySignerPerMinute: number;
    requestsPerPayerPerMinute: number;
    requestsPerActionPerMinute: number;
    requestsGlobalPerMinute: number;
    destructiveOutstandingPerPayer: number;
    destructiveOutstandingPerProvider: number;
    destructiveOutstandingGlobal: number;
  };
}

export async function assertProviderWalletAvailable(
  config: ProviderWalletConfig,
  definition?: AssetActionDefinitionV1,
): Promise<void> {
  const now = Math.floor(Date.now() / 1_000);
  if (
    !config.admission.servicingEnabled || config.admission.validFrom > now ||
    config.admission.validBefore <= now || config.artifactValidBefore <= now ||
    (definition && (definition.validFrom > now || definition.validBefore <= now))
  ) throw new Error("provider servicing unavailable");
}

const need = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for wallet servicing`);
  return value;
};

function parseJson<T>(env: NodeJS.ProcessEnv, name: string): T {
  try {
    const source = need(env, name);
    assertNoDuplicateJsonKeys(source);
    return JSON.parse(source) as T;
  } catch {
    throw new Error(`${name} is malformed`);
  }
}

async function verifyReleaseEnvelope<T>(args: {
  envelope: SignedEnvelope<T>;
  artifactType: string;
  standard: ProviderStandardRailConfig;
}): Promise<void> {
  assertExactKeys(args.envelope, SIGNED_ENVELOPE_KEYS, `${args.artifactType} envelope`);
  if (
    args.envelope.artifactType !== args.artifactType || args.envelope.schemaVersion !== 1 ||
    args.envelope.environment !== args.standard.environment ||
    args.envelope.chainId !== args.standard.chainId ||
    args.envelope.audience !== args.standard.gatewayAudience ||
    args.envelope.validBefore <= Math.floor(Date.now() / 1_000)
  ) throw new Error(`${args.artifactType} domain is invalid`);
  let recovered: Address;
  try {
    recovered = await recoverMessageAddress({
      message: { raw: unsignedEnvelopeHash(args.envelope as unknown as Record<string, unknown>) },
      signature: args.envelope.signature,
    });
  } catch {
    throw new Error(`${args.artifactType} signature is invalid`);
  }
  if (getAddress(recovered) !== args.standard.gatewayDispatchSigner) {
    throw new Error(`${args.artifactType} signature is invalid`);
  }
}

export async function loadProviderWalletConfig(
  standard: ProviderStandardRailConfig,
  launchPolicy: ProviderWalletLaunchPolicy,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderWalletConfig> {
  const reviewedActions = new Map(
    launchPolicy.assetActions.map((action) => [
      `${action.serviceSlug}:${action.actionId}`,
      action,
    ]),
  );
  if (
    reviewedActions.size !== launchPolicy.assetActions.length ||
    [...reviewedActions.keys()].some((actionKey) => actionKey.trim().length === 0)
  ) {
    throw new Error("Provider wallet launch policy is invalid");
  }
  const admissionEnvelope = parseJson<SignedEnvelope<ProviderServicingAdmissionV1>>(
    env, "STANDARD_RAIL_SERVICING_ADMISSION_JSON",
  );
  const catalogEnvelope = parseJson<SignedEnvelope<ProviderAssetActionCatalogV1>>(
    env, "STANDARD_RAIL_ASSET_ACTION_CATALOG_JSON",
  );
  await verifyReleaseEnvelope({ envelope: admissionEnvelope, artifactType: "ProviderServicingAdmissionV1", standard });
  await verifyReleaseEnvelope({ envelope: catalogEnvelope, artifactType: "ProviderAssetActionCatalogV1", standard });
  assertExactKeys(admissionEnvelope.payload, [
    "providerAgentId", "providerControlProfileHash", "servicingProfileEpoch",
    "actionCatalogHash", "actionCatalogSchemaHash", "actionCatalogEpoch", "servicingEnabled",
    "previousAdmissionHash", "validFrom", "validBefore",
  ], "servicing admission payload");
  assertExactKeys(catalogEnvelope.payload, [
    "providerAgentId", "providerControlProfileHash", "servicingProfileEpoch",
    "actionCatalogSchemaHash", "actionCatalogEpoch", "actions",
  ], "asset action catalog payload");
  const admission = admissionEnvelope.payload;
  const catalog = catalogEnvelope.payload;
  const providerControlProfileHash = need(env, "STANDARD_RAIL_PROVIDER_CONTROL_PROFILE_HASH").toLowerCase() as Hex;
  const catalogHash = canonicalHash(catalogEnvelope);
  if (
    !admission.servicingEnabled || admission.validFrom > Math.floor(Date.now() / 1_000) ||
    admission.validBefore <= Math.floor(Date.now() / 1_000) ||
    admission.providerControlProfileHash !== providerControlProfileHash ||
    admission.actionCatalogHash !== catalogHash ||
    admission.providerAgentId !== catalog.providerAgentId ||
    admission.providerControlProfileHash !== catalog.providerControlProfileHash ||
    admission.servicingProfileEpoch !== catalog.servicingProfileEpoch ||
    admission.actionCatalogSchemaHash !== catalog.actionCatalogSchemaHash ||
    admission.actionCatalogEpoch !== catalog.actionCatalogEpoch
  ) throw new Error("wallet servicing artifacts are inconsistent");
  const delay = 600;
  const actionKeys = new Set<string>();
  for (const action of catalog.actions) {
    assertExactKeys(action, [
      "providerAgentId", "serviceId", "serviceSlug", "actionId", "assetType", "ownershipPolicy",
      "destructive", "requestSchema", "responseSchema", "confirmationSummarySchema",
      "confirmationSummaryTemplate", "endpoint",
      "replayPolicy", "retentionSeconds", "validFrom", "validBefore", "actionDefinitionHash",
    ], "asset action definition");
    const { actionDefinitionHash, ...preimage } = action;
    const actionKey = `${action.serviceSlug}:${action.actionId}`;
    const reviewedAction = reviewedActions.get(actionKey);
    if (
      actionKeys.has(actionKey) || action.providerAgentId !== catalog.providerAgentId ||
      reviewedAction === undefined ||
      action.destructive !== (reviewedAction.effect === "destructive") ||
      action.replayPolicy !== reviewedAction.replayPolicy ||
      canonicalHash(action.requestSchema) !==
        canonicalHash(reviewedAction.inputSchema) ||
      canonicalHash(action.responseSchema) !==
        canonicalHash(reviewedAction.resultSchema) ||
      action.ownershipPolicy !== "owner-only" || canonicalHash(preimage) !== actionDefinitionHash ||
      (action.destructive !== (action.confirmationSummarySchema !== null && action.confirmationSummaryTemplate !== null)) ||
      action.validFrom > Math.floor(Date.now() / 1_000) || action.validBefore <= Math.floor(Date.now() / 1_000)
      || !Number.isSafeInteger(action.retentionSeconds) || action.retentionSeconds < 1
      || (action.replayPolicy === "redacted-after-window" && action.retentionSeconds > 604_800)
      || (action.destructive && action.retentionSeconds <= delay)
      || !["stable-result", "regenerate-ephemeral", "redacted-after-window"].includes(action.replayPolicy)
    ) throw new Error("asset action definition is invalid");
    compileProviderSchema(action.requestSchema);
    compileProviderSchema(action.responseSchema);
    if (action.destructive) {
      validateProviderRequest(
        compileProviderSchema(action.confirmationSummarySchema!),
        action.confirmationSummaryTemplate,
      );
      if (!summaryBindsRequest(action)) {
        throw new Error("destructive confirmation summary must bind a request field");
      }
    }
    actionKeys.add(actionKey);
  }
  if (
    actionKeys.size !== reviewedActions.size ||
    [...reviewedActions.keys()].some((actionKey) => !actionKeys.has(actionKey))
  ) throw new Error("asset action catalog differs from installed service action contracts");
  const responsePrivateKey = standard.providerAuthorityPrivateKey;
  const assetResponseKey = standard.providerAuthorityKey;
  const cursorSource = need(env, "PROVIDER_DATA_ENCRYPTION_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(cursorSource)) {
    throw new Error("PROVIDER_DATA_ENCRYPTION_KEY is invalid");
  }
  const cursorKey = createHash("sha256")
    .update("daski:provider-cursor:v1")
    .update(Buffer.from(cursorSource.slice(2), "hex"))
    .digest();
  const keyRing: CursorKeyRing = {
    activeKeyId: "derived-v1",
    keys: new Map([["derived-v1", cursorKey]]),
  };
  const abuse = {
    requestsPerGatewaySignerPerMinute: 120,
    requestsPerPayerPerMinute: 30,
    requestsPerActionPerMinute: 120,
    requestsGlobalPerMinute: 300,
    destructiveOutstandingPerPayer: 5,
    destructiveOutstandingPerProvider: 100,
    destructiveOutstandingGlobal: 1_000,
  };
  const gatewayAssetQueryUrl = new URL("/wallet/assets", standard.gatewayOrigin);
  const gatewayAssetActionUrl = new URL("/wallet/assets/action", standard.gatewayOrigin);
  for (const url of [gatewayAssetQueryUrl, gatewayAssetActionUrl]) {
    if (
      url.protocol !== "https:" || url.origin !== standard.gatewayOrigin || url.username ||
      url.password || url.search || url.hash
    ) throw new Error("gateway asset URL is outside the pinned origin");
  }
  return {
    providerAgentId: catalog.providerAgentId,
    providerControlProfileHash,
    servicingAdmissionHash: canonicalHash(admissionEnvelope),
    admission,
    actionCatalogHash: catalogHash,
    catalog,
    assetResponsePrivateKey: responsePrivateKey,
    assetResponseKey,
    assetResponseKeyId: "provider-wallet",
    artifactValidBefore: Math.min(admissionEnvelope.validBefore, catalogEnvelope.validBefore),
    cursorKeyRing: keyRing,
    destructiveActionDelaySeconds: delay,
    gatewayAssetQueryUrl: gatewayAssetQueryUrl.toString(),
    gatewayAssetActionUrl: gatewayAssetActionUrl.toString(),
    abuse,
  };
}

function summaryBindsRequest(action: AssetActionDefinitionV1): boolean {
  const requestProperties = action.requestSchema.properties as Record<string, Record<string, unknown>>;
  const summaryProperties = action.confirmationSummarySchema!.properties as Record<string, Record<string, unknown>>;
  const bindable = new Set(["actionId", "providerAssetId", ...Object.keys(requestProperties)]);
  return Object.keys(action.confirmationSummaryTemplate!).some((key) => {
    if (!bindable.has(key)) return false;
    const requestType = key === "actionId" || key === "providerAssetId"
      ? "string"
      : requestProperties[key]?.type;
    return requestType === summaryProperties[key]?.type;
  });
}
