import { randomUUID } from "node:crypto";
import type pg from "pg";
import { keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ProviderStandardRailConfig } from "../src/core/standardRail/config.js";
import type { ProviderOutcomeConfig } from "../src/core/standardRail/types.js";
import { standardSplitterFixture } from "./standardRailOutcomeFixture.js";

// Synthetic standard-rail identities for protocol tests. Nothing here is a
// real gateway, provider, listing or payer.
export const hash = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex;
export const gatewayKey = hash("7");
export const gateway = privateKeyToAccount(gatewayKey);
export const providerKey = `0x${"44".repeat(32)}` as Hex;
export const provider = privateKeyToAccount(providerKey);
export const otherKey = `0x${"55".repeat(32)}` as Hex;
export const ENVIRONMENT = "testnet";
export const CHAIN_ID = 84_532;
export const GATEWAY_AUDIENCE = "https://gateway.example";
export const PROVIDER_AUDIENCE = "https://provider.example";
export const SERVICE_SLUG = "fixture";
export const payerA = privateKeyToAccount(`0x${"66".repeat(32)}` as Hex).address;
export const payerB = privateKeyToAccount(`0x${"67".repeat(32)}` as Hex).address;

const requestSchema: ProviderOutcomeConfig["requestSchema"] = {
  type: "object",
  properties: {
    item: { type: "string", minLength: 1, maxLength: 40 } as { type: string },
    tier: { type: "string", enum: ["basic", "plus"] } as { type: string },
  },
  required: ["item"],
  additionalProperties: false,
};

export function fixtureOutcome(
  overrides: Partial<ProviderOutcomeConfig> & Pick<ProviderOutcomeConfig, "outcomeId" | "pricingMode">,
): ProviderOutcomeConfig {
  const dynamic = overrides.pricingMode === "dynamic";
  const runtime = keccak256("0x6000");
  return {
    ...standardSplitterFixture(),
    skillId: overrides.outcomeId,
    serviceSlug: SERVICE_SLUG,
    serviceId: hash("6"),
    listingManifestHash: dynamic ? hash("d") : hash("3"),
    providerOfferHash: dynamic ? hash("e") : hash("4"),
    fixedGrossAmount: dynamic ? "0" : "250000",
    quoteMaximumLifetimeSeconds: dynamic ? 180 : 0,
    quoteMinimumPaymentWindowSeconds: dynamic ? 30 : 0,
    providerControlProfileHash: hash("5"),
    activeRailProfileHash: hash("9"),
    customerIdentityPolicyId: "none",
    tokenRuntimeCodeHash: runtime,
    tokenImplementationAddress: "0x7777777777777777777777777777777777777777",
    tokenImplementationRuntimeCodeHash: runtime,
    tokenImplementationSlot: hash("a"),
    tokenDomainSeparator: hash("b"),
    sanctionsOracleRuntimeCodeHash: runtime,
    providerControlledWallets: [],
    maximumSourceLagBlocks: 3,
    maximumLogPageEvents: 1_000,
    listingCommitmentHash: hash("6"),
    outcomeIdHash: hash("7"),
    policyVersionHash: hash("8"),
    listingEpoch: "1",
    providerTerminalAttestationKey: provider.address,
    commissionBps: 500,
    maxOpenOrders: 10,
    dispatchDeadlineSeconds: 300,
    bindingProfile: "recipe-bound-v2",
    requestSchema,
    ...overrides,
  };
}

export const fixedOutcome = fixtureOutcome({ outcomeId: "fixed-skill", pricingMode: "fixed" });
export const dynamicOutcome = fixtureOutcome({ outcomeId: "dynamic-skill", pricingMode: "dynamic" });

export function fixtureConfig(
  outcomes: ProviderOutcomeConfig[] = [fixedOutcome, dynamicOutcome],
): ProviderStandardRailConfig {
  return {
    environment: ENVIRONMENT,
    chainId: CHAIN_ID,
    gatewayAudience: GATEWAY_AUDIENCE,
    gatewayOrigin: GATEWAY_AUDIENCE,
    providerAudience: PROVIDER_AUDIENCE,
    gatewayDispatchSigner: gateway.address,
    gatewayQuoteSigner: gateway.address,
    gatewayLifecycleSigner: gateway.address,
    providerAuthorityKey: provider.address,
    providerAuthorityPrivateKey: providerKey,
    terminalAttestationPrivateKey: providerKey,
    terminalAttestationKey: provider.address,
    evidenceRpcUrls: ["https://rpc.example"],
    outcomes: new Map(outcomes.map((outcome) => [outcome.outcomeId, outcome])),
    globalPolicy: {} as ProviderStandardRailConfig["globalPolicy"],
    finalityConfirmations: 1,
    sanctionsOracleAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    reputationContract: "0x8888888888888888888888888888888888888888",
    easAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    easRuntimeCodeHash: keccak256("0x6000"),
    reputationOutcomeSchemaUid: hash("f"),
    reputationRetryDelaysSeconds: [5, 60, 3_000, 30_000],
  };
}

/** Insert the synthetic service and its skills; returns the service id. */
export async function seedFixtureService(
  pool: pg.Pool,
  args: { skillIds: string[]; isActive?: boolean },
): Promise<string> {
  const serviceId = randomUUID();
  await pool.query(
    `INSERT INTO services (id,name,slug,category_family,service_type,jurisdictions,
       service_description,adapter_name,is_active)
     VALUES ($1,'Fixture',$2,'other','other','["global"]'::jsonb,'Synthetic service',$2,$3)`,
    [serviceId, SERVICE_SLUG, args.isActive ?? true],
  );
  for (const skillId of args.skillIds) {
    await pool.query(
      `INSERT INTO skills (service_id,skill_id,name,description,pricing,fulfillment_mode)
       VALUES ($1,$2,$2,'Synthetic skill','{}'::jsonb,'automated')`,
      [serviceId, skillId],
    );
  }
  return serviceId;
}
