import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ProviderOutcomeConfig } from "./types.js";
import type { ProviderOutcomeLaunchPolicy } from "./launchPolicy.js";
import {
  loadStandardRailGlobalPolicy,
  materializeCatalogOutcomes,
  type StandardRailGlobalPolicy,
} from "./catalogOutcomes.js";
import { loadRuntimeListingHeads } from "../gatewayRegistration/runtimeCatalog.js";
import { bundleListingVersion, type ListingVersion } from "./listingVersions.js";
import { validateOutcome } from "./outcomeValidation.js";
import { parseRetainedSigningKeys } from "./signingKeys.js";

export interface ProviderStandardRailConfig {
  environment: string;
  chainId: number;
  gatewayAudience: string;
  gatewayOrigin: string;
  providerAudience: string;
  gatewayDispatchSigner: Address;
  gatewayQuoteSigner: Address;
  gatewayLifecycleSigner: Address;
  providerAuthorityKey: Address;
  providerAuthorityPrivateKey: Hex;
  terminalAttestationPrivateKey: Hex;
  terminalAttestationKey: Address;
  evidenceRpcUrls: readonly [string, ...string[]];
  /** The current heads: what this provider sells now. */
  outcomes: ReadonlyMap<string, ProviderOutcomeConfig>;
  /**
   * The listing version of each head materialized from the runtime catalog,
   * by lowercase commitment hash. Orders of earlier versions resolve theirs
   * from the catalog by the hash they carry (listingVersions.ts).
   */
  headVersions?: ReadonlyMap<string, ListingVersion>;
  /** The endpoint control profile hash retained versions are re-materialized under. */
  providerControlProfileHash?: Hex;
  /** Keys of earlier agent wallets whose listing versions still have orders, by address. */
  retainedSigningKeys?: ReadonlyMap<Address, Hex>;
  /** Deployment-owned global rail policy; readiness verifies its chain
   *  facts even when the runtime catalog is still empty. */
  globalPolicy: StandardRailGlobalPolicy;
  finalityConfirmations: number;
  sanctionsOracleAddress: Address;
  reputationContract: Address;
  easAddress: Address;
  easRuntimeCodeHash: Hex;
  reputationOutcomeSchemaUid: Hex;
  reputationRetryDelaysSeconds: readonly [number, number, number, number];
}

const need = (env: NodeJS.ProcessEnv, name: string): string => {
  const found = env[name]?.trim();
  if (!found) throw new Error(`${name} is required for the standard rail`);
  return found;
};

function key(env: NodeJS.ProcessEnv, name: string): Hex {
  const found = need(env, name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(found) || /^0x0+$/.test(found)) {
    throw new Error(`${name} must be a non-zero 32-byte private key`);
  }
  return found as Hex;
}

export async function loadProviderStandardRailConfig(
  launchPolicy: ProviderOutcomeLaunchPolicy,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    warn?: (message: string) => void;
    /** Test seam: bypass the database read, never the validation. */
    headsOverride?: readonly import("../gatewayRegistration/runtimeCatalog.js").RuntimeListingHead[];
  } = {},
): Promise<ProviderStandardRailConfig> {
  const chainId = Number(need(env, "CHAIN_ID"));
  if (chainId !== 8453 && chainId !== 84532) throw new Error("CHAIN_ID must identify Base");
  const urls = [need(env, "BASE_RPC_URL"), ...(env.BASE_RPC_FALLBACK_URLS ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean)].map((raw) => {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new Error("Provider RPC URLs must be credential-free HTTPS URLs");
    }
    return parsed.toString();
  });
  const reviewedPaidSkills = new Map(launchPolicy.paidSkills.map((entry) => [
    `${entry.serviceSlug}:${entry.skillId}`,
    entry,
  ]));
  if (
    reviewedPaidSkills.size !== launchPolicy.paidSkills.length
  ) {
    throw new Error("Provider paid-skill launch policy is invalid");
  }
  const providerAuthorityPrivateKey = key(env, "PROVIDER_WALLET_PRIVATE_KEY");
  const providerAuthorityKey = privateKeyToAccount(providerAuthorityPrivateKey).address;
  const terminalAttestationPrivateKey = providerAuthorityPrivateKey;
  const terminalAttestationKey = privateKeyToAccount(terminalAttestationPrivateKey).address;
  const canonicalToken = getAddress(need(env, "USDC_ADDRESS"));
  const environment =
    env.STANDARD_RAIL_ENVIRONMENT?.trim() || (chainId === 8453 ? "mainnet" : "testnet");
  const gatewayDispatchSignerEarly = getAddress(need(env, "STANDARD_RAIL_GATEWAY_SIGNER"));
  const gatewayOriginEarly = (() => {
    const raw = env.STANDARD_RAIL_GATEWAY_ORIGIN?.trim() || need(env, "GATEWAY_BASE_URL");
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error("STANDARD_RAIL_GATEWAY_ORIGIN must be a credential-free HTTPS origin");
    }
    return parsed.origin;
  })();
  const gatewayAudienceEarly = env.STANDARD_RAIL_GATEWAY_AUDIENCE?.trim() || gatewayOriginEarly;
  // Catalog-driven outcomes: the promoted runtime listing heads for this
  // gateway, joined with the deployment-owned global rail-policy bundle,
  // replace the retired STANDARD_RAIL_OUTCOMES_JSON env source. An empty
  // catalog boots (the reset-cutover registers listings after deploy);
  // unknown or duplicate heads fail closed.
  const globalPolicy = await loadStandardRailGlobalPolicy({
    environment,
    chainId,
    gatewayAudience: gatewayAudienceEarly,
    gatewaySigner: gatewayDispatchSignerEarly,
    env,
  });
  const providerControlProfileHash =
    need(env, "STANDARD_RAIL_PROVIDER_CONTROL_PROFILE_HASH").toLowerCase() as Hex;
  if (!/^0x[0-9a-f]{64}$/.test(providerControlProfileHash)) {
    throw new Error("STANDARD_RAIL_PROVIDER_CONTROL_PROFILE_HASH must be bytes32");
  }
  const retainedSigningKeys = parseRetainedSigningKeys(env.PROVIDER_RETAINED_WALLET_PRIVATE_KEYS, providerAuthorityKey);
  const heads = options.headsOverride ?? await loadRuntimeListingHeads(gatewayOriginEarly);
  const { outcomes, headVersions } = admitCatalogHeads(heads, {
    globalPolicy,
    chainId,
    providerControlProfileHash,
    installedPaidSkills: new Set(reviewedPaidSkills.keys()),
    terminalAttestationKey,
    canonicalToken,
    warn: options.warn,
  });
  const finalityConfirmations = Number(env.STANDARD_RAIL_FINALITY_CONFIRMATIONS ?? 12);
  if (!Number.isSafeInteger(finalityConfirmations) || finalityConfirmations <= 0) {
    throw new Error("STANDARD_RAIL_FINALITY_CONFIRMATIONS must be a positive integer");
  }
  const reputationRetryDelaysSeconds = [5, 60, 3_000, 30_000] as const;
  const reputationOutcomeSchemaUid = need(env, "EAS_OUTCOME_SCHEMA_UID").toLowerCase() as Hex;
  if (!/^0x[0-9a-f]{64}$/.test(reputationOutcomeSchemaUid)) {
    throw new Error("EAS_OUTCOME_SCHEMA_UID must be bytes32");
  }
  const easRuntimeCodeHash = need(env, "EAS_RUNTIME_CODE_HASH").toLowerCase() as Hex;
  if (!/^0x[0-9a-f]{64}$/.test(easRuntimeCodeHash) || /^0x0+$/.test(easRuntimeCodeHash)) {
    throw new Error("EAS_RUNTIME_CODE_HASH must be a non-zero bytes32 code hash");
  }
  const gatewayDispatchSigner = gatewayDispatchSignerEarly;
  const gatewayQuoteSigner = gatewayDispatchSigner;
  const gatewayLifecycleSigner = gatewayDispatchSigner;
  const providerAudience = env.STANDARD_RAIL_PROVIDER_AUDIENCE?.trim() || need(env, "BASE_URL");
  return {
    environment,
    chainId,
    globalPolicy,
    gatewayAudience: gatewayAudienceEarly,
    gatewayOrigin: gatewayOriginEarly,
    providerAudience,
    gatewayDispatchSigner,
    gatewayQuoteSigner,
    gatewayLifecycleSigner,
    providerAuthorityKey,
    providerAuthorityPrivateKey,
    terminalAttestationPrivateKey,
    terminalAttestationKey,
    evidenceRpcUrls: urls as [string, ...string[]],
    outcomes,
    headVersions,
    providerControlProfileHash,
    retainedSigningKeys,
    finalityConfirmations,
    sanctionsOracleAddress: getAddress(need(env, "SANCTIONS_ORACLE_ADDRESS")),
    reputationContract: getAddress(need(env, "REPUTATION_STORAGE_ADDRESS")),
    easAddress: getAddress(need(env, "EAS_ADDRESS")),
    easRuntimeCodeHash,
    reputationOutcomeSchemaUid,
    reputationRetryDelaysSeconds,
  };
}

interface HeadAdmission {
  globalPolicy: StandardRailGlobalPolicy;
  chainId: number;
  providerControlProfileHash: Hex;
  installedPaidSkills: ReadonlySet<string>;
  terminalAttestationKey: Address;
  canonicalToken: Address;
  warn?: (message: string) => void;
}

/** Materialize and validate the promoted heads: what this provider sells. */
function admitCatalogHeads(
  heads: readonly import("../gatewayRegistration/runtimeCatalog.js").RuntimeListingHead[],
  context: HeadAdmission,
): { outcomes: Map<string, ProviderOutcomeConfig>; headVersions: Map<string, ListingVersion> } {
  const outcomes = materializeCatalogOutcomes({ ...context, heads });
  for (const outcome of outcomes.values()) {
    validateOutcome(outcome, context.chainId);
    if (!Number.isSafeInteger(outcome.maxOpenOrders) || outcome.maxOpenOrders <= 0) {
      throw new Error(`Outcome ${outcome.outcomeId} requires a positive maxOpenOrders`);
    }
    // A head is sold now, so it is signed with the current wallet's key.
    if (getAddress(outcome.providerTerminalAttestationKey) !== context.terminalAttestationKey) {
      throw new Error(`Outcome ${outcome.outcomeId} terminal attestation key mismatch`);
    }
    if (getAddress(outcome.token) !== context.canonicalToken) {
      throw new Error(`Outcome ${outcome.outcomeId} token does not match the reviewed canonical token`);
    }
  }
  const headVersions = new Map<string, ListingVersion>();
  for (const head of heads) {
    if (!head.paymentRequired) continue;
    const version = bundleListingVersion(head.runtimeCommitmentHash, head.skillId, head.bundle);
    headVersions.set(version.listingManifestHash, version);
  }
  return { outcomes, headVersions };
}

/**
 * Re-read the promoted heads after the activation revision moved, so new
 * sales use the current heads without a restart. The heads pass exactly the
 * boot validation; on any failure the previous heads stay and the error
 * propagates. Returns whether the sold heads changed.
 */
export async function refreshCatalogHeads(
  config: ProviderStandardRailConfig,
  launchPolicy: ProviderOutcomeLaunchPolicy,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!config.providerControlProfileHash) throw new Error("rail configuration has no catalog to refresh");
  const { outcomes, headVersions } = admitCatalogHeads(await loadRuntimeListingHeads(config.gatewayOrigin), {
    globalPolicy: config.globalPolicy,
    chainId: config.chainId,
    providerControlProfileHash: config.providerControlProfileHash,
    installedPaidSkills: new Set(launchPolicy.paidSkills.map((entry) => `${entry.serviceSlug}:${entry.skillId}`)),
    terminalAttestationKey: config.terminalAttestationKey,
    canonicalToken: getAddress(need(env, "USDC_ADDRESS")),
  });
  const before = [...config.outcomes.values()].map((outcome) => outcome.listingManifestHash).sort().join();
  const after = [...outcomes.values()].map((outcome) => outcome.listingManifestHash).sort().join();
  config.outcomes = outcomes;
  config.headVersions = headVersions;
  return before !== after;
}

