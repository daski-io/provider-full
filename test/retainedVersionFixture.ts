import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { RuntimeListingHead } from "../src/core/gatewayRegistration/runtimeCatalog.js";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import { materializeOutcome } from "../src/core/standardRail/catalogOutcomes.js";
import { loadProviderStandardRailConfig, type ProviderStandardRailConfig } from "../src/core/standardRail/config.js";
import type { FulfillmentAdapter } from "../src/core/serviceRegistry/types.js";
import type { ProviderOutcomeConfig, QuoteV1, SignedEnvelope } from "../src/core/standardRail/types.js";
import { gatewayDispatch, gatewayQuoteV1, type DispatchArgs } from "./dispatchWire.js";
import { signGatewayEnvelope } from "./gatewayConsumer.js";
import {
  buildGlobalPolicyFixture,
  buildRuntimeHeadFixture,
  encodeGlobalPolicy,
  testGatewaySigner,
} from "./runtimeCatalogFixture.js";
import {
  CHAIN_ID, ENVIRONMENT, GATEWAY_AUDIENCE, gatewayKey, hash, payerA, provider, PROVIDER_AUDIENCE,
  providerKey, SERVICE_SLUG,
} from "./standardRailFixture.js";

/*
 * Two synthetic promoted versions of one paid skill: version 1 sold under an
 * earlier agent wallet with an earlier input contract, version 2 the current
 * head under the current wallet with a changed contract. Hash-true runtime
 * bundles (runtimeCatalogFixture) materialize exactly as the boot catalog
 * does. Nothing here is a real gateway, provider, listing or payer.
 */

export const SKILL = "fixed-skill";
export const SERVICE_ID = hash("6");
export const CONTROL_PROFILE = hash("5");
/** The earlier agent wallet version 1 was registered under. */
export const RETAINED_KEY = `0x${"57".repeat(32)}` as Hex;
export const retainedWallet = privateKeyToAccount(RETAINED_KEY).address;
export const FULFILLMENT_SECONDS = 43_200;
export const REPUTATION_CONTRACT = "0x8888888888888888888888888888888888888888" as Hex;
export const OUTCOME_SCHEMA_UID = hash("f");

export const globalPolicy = await buildGlobalPolicyFixture({ gatewayAudience: GATEWAY_AUDIENCE });

const item = { type: "string", minLength: 1, maxLength: 40 };

/** The skill contract each version's agent card published. */
export function publishedContract(version: 1 | 2): Record<string, unknown> {
  return {
    inputSchema: version === 1
      ? { type: "object", properties: { item }, required: ["item"], additionalProperties: false }
      : {
        type: "object",
        properties: { item, tier: { type: "string", enum: ["basic", "plus"] } },
        required: ["item"],
        additionalProperties: false,
      },
    resultSchema: {
      type: "object",
      properties: { note: { type: "string", minLength: 1, maxLength: 64 } },
      required: ["note"],
      additionalProperties: false,
    },
    pricing: { USDC: { type: "one-time", fixed_amount: "250000" } },
    paymentRequired: true,
    requiresAssetOwnership: false,
    assetType: null,
    fulfillmentMode: "automated",
    purchaseReadiness: null,
    capacity: { maxOpenOrders: 10 },
    deadlines: { dispatchSeconds: 300, fulfillmentSeconds: FULFILLMENT_SECONDS },
    assetAction: null,
  };
}

const heads = new Map<number, RuntimeListingHead>();

/** Each version's promoted head; built once, as its signed envelopes carry their issue time. */
export function versionHead(version: 1 | 2): RuntimeListingHead {
  const built = heads.get(version);
  if (built) return built;
  const head = buildRuntimeHeadFixture({
    globalPolicy,
    serviceSlug: SERVICE_SLUG,
    skillId: SKILL,
    gatewayOrigin: GATEWAY_AUDIENCE,
    serviceId: SERVICE_ID,
    listingEpoch: String(version),
    agentWallet: version === 1 ? retainedWallet : provider.address,
  });
  head.bundle.skillContract!.contract = publishedContract(version) as NonNullable<typeof head.bundle.skillContract>["contract"];
  heads.set(version, head);
  return head;
}

export function versionOutcome(head: RuntimeListingHead): ProviderOutcomeConfig {
  return materializeOutcome({ head, globalPolicy, chainId: CHAIN_ID, providerControlProfileHash: CONTROL_PROFILE });
}

/** A synthetic service whose skill currently publishes version 2's contract. */
export function fixtureModule(previous: Array<{ contract: Record<string, unknown>; adapter: FulfillmentAdapter }>) {
  const current = publishedContract(2);
  return {
    manifest: { slug: SERVICE_SLUG, defaultFulfillmentMode: "automated" },
    skills: [{
      id: SKILL,
      inputSchema: current.inputSchema,
      resultSchema: current.resultSchema,
      pricing: current.pricing,
      requiresAssetOwnership: false,
      fulfillmentMode: "automated",
      previousContracts: previous,
    }],
  } as never;
}

export function railEnvironment(retainedKeys: readonly Hex[] = [RETAINED_KEY]): NodeJS.ProcessEnv {
  return {
    PROVIDER_WALLET_PRIVATE_KEY: providerKey,
    ...(retainedKeys.length ? { PROVIDER_RETAINED_WALLET_PRIVATE_KEYS: retainedKeys.join(",") } : {}),
    BASE_RPC_URL: "https://rpc.example",
    CHAIN_ID: String(CHAIN_ID),
    USDC_ADDRESS: globalPolicy.chainEvidencePolicy.payload.canonicalToken,
    SANCTIONS_ORACLE_ADDRESS: "0x5555555555555555555555555555555555555555",
    REPUTATION_STORAGE_ADDRESS: REPUTATION_CONTRACT,
    EAS_ADDRESS: "0x4646464646464646464646464646464646464646",
    EAS_RUNTIME_CODE_HASH: hash("f"),
    EAS_OUTCOME_SCHEMA_UID: OUTCOME_SCHEMA_UID,
    STANDARD_RAIL_ENVIRONMENT: ENVIRONMENT,
    STANDARD_RAIL_GATEWAY_AUDIENCE: GATEWAY_AUDIENCE,
    STANDARD_RAIL_GATEWAY_ORIGIN: GATEWAY_AUDIENCE,
    STANDARD_RAIL_PROVIDER_AUDIENCE: PROVIDER_AUDIENCE,
    STANDARD_RAIL_GATEWAY_SIGNER: testGatewaySigner,
    STANDARD_RAIL_PROVIDER_CONTROL_PROFILE_HASH: CONTROL_PROFILE,
    STANDARD_RAIL_GLOBAL_POLICY_JSON: encodeGlobalPolicy(globalPolicy),
  };
}

/** The rail configuration the current deployment boots with: version 2 is the head. */
export function railConfig(retainedKeys?: readonly Hex[]): Promise<ProviderStandardRailConfig> {
  return loadProviderStandardRailConfig(
    { paidSkills: [{ serviceSlug: SERVICE_SLUG, skillId: SKILL }] },
    railEnvironment(retainedKeys),
    { headsOverride: [versionHead(2)] },
  );
}

/** Seed the service and its skill, and register it at the gateway. */
export async function seedService(pool: pg.Pool): Promise<string> {
  const serviceRowId = randomUUID();
  await pool.query(
    `INSERT INTO services (id,name,slug,category_family,service_type,jurisdictions,
       service_description,adapter_name,is_active,on_chain_id)
     VALUES ($1,'Fixture',$2,'other','other','["global"]'::jsonb,'Synthetic service',$2,true,$3)`,
    [serviceRowId, SERVICE_SLUG, Buffer.from(SERVICE_ID.slice(2), "hex")],
  );
  await pool.query(
    `INSERT INTO skills (service_id,skill_id,name,description,pricing,fulfillment_mode)
     VALUES ($1,$2,$2,'Synthetic skill','{}'::jsonb,'automated')`,
    [serviceRowId, SKILL],
  );
  await pool.query(
    `INSERT INTO provider_gateway_registrations
       (id,gateway_origin,service_row_id,service_id,card_contract_hash,state,idempotency_key,canonical_intent)
     VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6,'{}'::jsonb)`,
    [randomUUID(), GATEWAY_AUDIENCE, serviceRowId, Buffer.from(SERVICE_ID.slice(2), "hex"),
      Buffer.alloc(32, 3), `registration-${serviceRowId}`],
  );
  return serviceRowId;
}

/**
 * A timely-paid order of `outcome`: the provider quote persisted when it was
 * sold (possibly long ago), the gateway QuoteV1 bound to it, and a fresh
 * dispatch envelope issued now.
 */
export async function paidOrder(
  outcome: ProviderOutcomeConfig,
  request: Record<string, unknown>,
  quotedAt: number,
): Promise<DispatchArgs> {
  const { persistProviderQuote, providerQuoteHash } = await import("../src/core/standardRail/quoteStore.js");
  const payload = {
    outcomeId: outcome.outcomeId, listingManifestHash: outcome.listingManifestHash,
    requestHash: canonicalHash(request), grossAmount: outcome.fixedGrossAmount,
    payer: payerA.toLowerCase() as Hex, issuedAt: quotedAt, validBefore: quotedAt + 120,
  };
  await persistProviderQuote(payload, { pricingMode: "fixed", supplierCostCeiling: null });
  const quote: SignedEnvelope<QuoteV1> = await gatewayQuoteV1({
    outcome, request, validBefore: payload.validBefore - 20,
    providerQuote: { providerQuoteHash: providerQuoteHash(payload), ...payload },
  });
  return gatewayDispatch({
    outcome, quote, request, payer: payerA,
    reputationContract: REPUTATION_CONTRACT, outcomeSchemaUid: OUTCOME_SCHEMA_UID,
  });
}

/** A gateway retirement receipt for one listing version, signed as the gateway signs it. */
export function retirementReceipt(listingManifestHash: Hex, options: { privateKey?: Hex; requestId?: string } = {}) {
  const issuedAt = Math.floor(Date.now() / 1_000);
  return signGatewayEnvelope({
    artifactType: "GatewayContractRetirementV1", environment: ENVIRONMENT, chainId: CHAIN_ID,
    audience: PROVIDER_AUDIENCE, signerKeyId: "gateway-dispatch", privateKey: options.privateKey ?? gatewayKey,
    issuedAt, validBefore: issuedAt + 86_400,
    payload: {
      requestId: options.requestId ?? `retire-${listingManifestHash.slice(2, 14)}`,
      scope: { kind: "listing", providerAgentId: "1", serviceId: SERVICE_ID, listingManifestHash },
      retiredAt: new Date((issuedAt - 60) * 1_000).toISOString(),
    },
  });
}

export const RECEIPT_DOMAIN = {
  environment: ENVIRONMENT, chainId: CHAIN_ID, providerAudience: PROVIDER_AUDIENCE, gatewaySigner: testGatewaySigner,
};

/** A read-capability status call through the gateway's lifecycle grant. */
export async function statusCall(args: { orderId: string; taskId: string; now?: number }) {
  const now = args.now ?? Math.floor(Date.now() / 1_000);
  const authorization = { type: "DaskiReadCap", scope: "status" };
  const grant = await signGatewayEnvelope({
    artifactType: "ProviderLifecycleGrantV1", environment: ENVIRONMENT, chainId: CHAIN_ID,
    audience: PROVIDER_AUDIENCE, signerKeyId: "gateway-lifecycle", privateKey: gatewayKey,
    issuedAt: now, validBefore: now + 120,
    payload: {
      orderId: args.orderId, providerTaskId: args.taskId, action: "status",
      requestHash: canonicalHash({}), authorizationHash: canonicalHash(authorization), payer: payerA,
    },
  });
  return {
    orderId: args.orderId, providerTaskId: args.taskId, action: "status", request: {},
    authorization, grant, payer: payerA, gatewayAudience: GATEWAY_AUDIENCE,
  };
}
