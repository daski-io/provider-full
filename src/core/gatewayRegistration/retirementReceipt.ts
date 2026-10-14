import { getAddress, type Address, type Hex } from "viem";
import { assertExactKeys } from "../standardRail/canonical.js";
import { verifyGatewayEnvelope } from "../standardRail/gatewayEnvelope.js";

/*
 * The gateway's proof that one listing version's dispatch obligations ended:
 * its operator retired the version only after every order of it was
 * fulfilled or never settled and no dispatch, capacity reservation or
 * authorization was outstanding. The gateway signs the receipt with its
 * dispatch key for this provider's audience and re-signs the same permanent
 * payload on every read, so only the payload identifies a retirement.
 */

export interface ListingRetirementScope {
  kind: "listing";
  providerAgentId: string;
  serviceId: Hex;
  listingManifestHash: Hex;
}

export interface GatewayRetirementPayload {
  requestId: string;
  scope: ListingRetirementScope;
  retiredAt: string;
}

export interface RetirementReceiptDomain {
  environment: string;
  chainId: number;
  providerAudience: string;
  gatewaySigner: Address;
}

/** The gateway re-signs a receipt for one day on each read. */
const RECEIPT_MAX_REMAINING_SECONDS = 86_400 + 30;
const HASH = /^0x[0-9a-f]{64}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/** Read the retirement domain from the same variables the rail configuration uses. */
export function retirementReceiptDomain(env: NodeJS.ProcessEnv = process.env): RetirementReceiptDomain {
  const chainId = Number(env.CHAIN_ID);
  if (chainId !== 8453 && chainId !== 84532) throw new Error("CHAIN_ID must identify Base");
  const signer = env.STANDARD_RAIL_GATEWAY_SIGNER?.trim();
  const audience = env.STANDARD_RAIL_PROVIDER_AUDIENCE?.trim() || env.BASE_URL?.trim();
  if (!signer || !audience) {
    throw new Error("STANDARD_RAIL_GATEWAY_SIGNER and the provider audience are required to verify a retirement");
  }
  return {
    environment: env.STANDARD_RAIL_ENVIRONMENT?.trim() || (chainId === 8453 ? "mainnet" : "testnet"),
    chainId,
    providerAudience: audience,
    gatewaySigner: getAddress(signer),
  };
}

/** Verify a GatewayContractRetirementV1 receipt for exactly `scope`; returns its permanent payload. */
export async function verifyRetirementReceipt(
  receipt: unknown,
  scope: ListingRetirementScope,
  domain: RetirementReceiptDomain,
  now = Math.floor(Date.now() / 1_000),
): Promise<GatewayRetirementPayload> {
  const envelope = await verifyGatewayEnvelope<GatewayRetirementPayload>(receipt, {
    artifactType: "GatewayContractRetirementV1",
    schemaVersion: 1,
    payloadKeys: ["requestId", "scope", "retiredAt"],
    environment: domain.environment,
    chainId: domain.chainId,
    audience: domain.providerAudience,
    signer: domain.gatewaySigner,
    lifetime: { maxRemainingSeconds: RECEIPT_MAX_REMAINING_SECONDS },
  }, now);
  const payload = envelope.payload;
  try {
    assertExactKeys(payload.scope, ["kind", "providerAgentId", "serviceId", "listingManifestHash"], "retirement scope");
  } catch {
    throw new Error("gateway retirement receipt names another kind of contract");
  }
  const retiredAt = Date.parse(payload.retiredAt);
  if (
    typeof payload.requestId !== "string" || !REQUEST_ID.test(payload.requestId) ||
    typeof payload.retiredAt !== "string" || !Number.isFinite(retiredAt) || retiredAt > (now + 30) * 1_000 ||
    payload.scope.kind !== "listing" ||
    payload.scope.providerAgentId !== scope.providerAgentId ||
    !HASH.test(payload.scope.serviceId) || payload.scope.serviceId !== scope.serviceId.toLowerCase() ||
    !HASH.test(payload.scope.listingManifestHash) ||
    payload.scope.listingManifestHash !== scope.listingManifestHash.toLowerCase()
  ) throw new Error("gateway retirement receipt does not retire this listing version");
  return payload;
}
