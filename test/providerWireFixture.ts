import { readFileSync } from "node:fs";
import { getAddress, type Address, type Hex } from "viem";
import { expect } from "vitest";
import { canonicalJson } from "../src/core/standardRail/canonical.js";
import type { ProviderStandardRailConfig } from "../src/core/standardRail/config.js";
import type { ProviderOutcomeConfig } from "../src/core/standardRail/types.js";
import { fixtureOutcome } from "./standardRailFixture.js";

/**
 * The vendored daski-io/gateway provider-wire fixtures (see
 * test/fixtures/provider-wire.source.json) and a full provider configured
 * from their keys and context, as their README prescribes.
 */
export const FIXTURE_DIR = new URL("./fixtures/provider-wire/", import.meta.url);
/** Fixture documents are generated JSON; tests read them structurally. */
type Doc = any;
export const fixture = (name: string): Doc => JSON.parse(readFileSync(new URL(name, FIXTURE_DIR), "utf8"));

export const keys = fixture("keys.json").keys as Record<string, { privateKey: Hex; address: Address }>;
export const context = fixture("context.json");
export const FULL = "daski-io/provider-full";
export const order = context.order;
export const fixedListing = context.listings.fixed;
export const dynamicListing = context.listings.dynamic;

/** A fixture listing as a full runtime outcome of the synthetic notes service. */
export function wireOutcome(
  listing: Doc,
  overrides: Partial<ProviderOutcomeConfig> = {},
): ProviderOutcomeConfig {
  const dynamic = listing.pricingMode === "dynamic";
  return fixtureOutcome({
    outcomeId: listing.outcomeId,
    pricingMode: listing.pricingMode,
    serviceSlug: "notes",
    skillId: listing.skillId,
    serviceId: listing.serviceId,
    listingManifestHash: listing.listingManifestHash,
    providerOfferHash: listing.providerOfferHash,
    fixedGrossAmount: listing.fixedGrossAmount,
    quoteMaximumLifetimeSeconds: dynamic ? listing.quotePolicy.maximumLifetimeSeconds : 0,
    quoteMinimumPaymentWindowSeconds: dynamic ? listing.quotePolicy.minimumPaymentWindowSeconds : 0,
    commissionBps: listing.commissionBps,
    token: getAddress(listing.token),
    splitter: getAddress(listing.splitter),
    providerPayee: getAddress(listing.providerPayee),
    daskiCommissionReceiver: getAddress(listing.daskiCommissionReceiver),
    providerControlProfileHash: context.provider.controlProfileHash,
    activeRailProfileHash: context.gateway.activeRailProfileHash,
    providerTerminalAttestationKey: keys.providerTerminalAttestation!.address,
    dispatchDeadlineSeconds: listing.deadlinePolicy.dispatchSeconds,
    bindingProfile: listing.bindingProfile,
    requestSchema: listing.requestSchema,
    ...overrides,
  });
}

export function wireConfig(outcomes: ProviderOutcomeConfig[] = [
  wireOutcome(fixedListing), wireOutcome(dynamicListing),
]): ProviderStandardRailConfig {
  return {
    environment: context.environment,
    chainId: context.chainId,
    gatewayAudience: context.gateway.audience,
    gatewayOrigin: context.gateway.publicUrl,
    providerAudience: context.provider.audience,
    gatewayDispatchSigner: context.gateway.signers["gateway-dispatch"],
    gatewayQuoteSigner: context.gateway.signers["gateway-quote"],
    gatewayLifecycleSigner: context.gateway.signers["gateway-lifecycle"],
    providerAuthorityKey: keys.providerAuthority!.address,
    providerAuthorityPrivateKey: keys.providerAuthority!.privateKey,
    terminalAttestationPrivateKey: keys.providerTerminalAttestation!.privateKey,
    terminalAttestationKey: keys.providerTerminalAttestation!.address,
    evidenceRpcUrls: ["https://rpc.example"],
    outcomes: new Map(outcomes.map((outcome) => [outcome.outcomeId, outcome])),
    globalPolicy: {} as ProviderStandardRailConfig["globalPolicy"],
    finalityConfirmations: 12,
    sanctionsOracleAddress: "0x5555555555555555555555555555555555555555",
    reputationContract: getAddress(context.gateway.reputationContract),
    easAddress: "0x4646464646464646464646464646464646464646",
    easRuntimeCodeHash: `0x${"f".repeat(64)}` as Hex,
    reputationOutcomeSchemaUid: context.gateway.reputationOutcomeSchemaUid,
    reputationRetryDelaysSeconds: [5, 60, 3_000, 30_000],
  };
}

export interface WireAnswer {
  status: number;
  contentType: string | null;
  contentEncoding: string | null;
  text: string;
}

/**
 * The README's matching rule: the status, `application/json` without a
 * content encoding, and canonical JSON equality of the body.
 */
export function expectWireAnswer(answer: WireAnswer, vector: Doc): void {
  expect(answer.status, vector.id).toBe(vector.response.status);
  if (vector.response.bodyText === "") {
    expect(answer.text, vector.id).toBe("");
    return;
  }
  expect(answer.contentType?.split(";", 1)[0], vector.id).toBe("application/json");
  expect(answer.contentEncoding, vector.id).toBeNull();
  expect(canonicalJson(JSON.parse(answer.text)), vector.id).toBe(canonicalJson(vector.response.body));
}

export const appliesToFull = (vector: Doc): boolean => (vector.appliesTo as string[]).includes(FULL);

export function vector(doc: { responses: Array<{ id: string }>; refusals?: Array<{ id: string }> }, id: string): Doc {
  const found = [...doc.responses, ...(doc.refusals ?? [])].find((entry) => entry.id === id);
  if (!found) throw new Error(`fixture vector ${id} is missing`);
  return found;
}
