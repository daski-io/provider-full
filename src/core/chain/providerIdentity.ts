import type { Hex } from "viem";
import { config } from "../config.js";
import { identityRegistryAbi } from "./abis.js";
import {
  CHAIN_MODE_MOCK,
  providerAddress,
  publicClient,
} from "./client.js";
import { errorExtra, logWarn } from "../logger.js";

export interface ProviderIdentityAuthorization {
  ok: boolean;
  checkedAt: Date | null;
  reason: string | null;
}

const PROVIDER_IDENTITY_MAX_AGE_MS =
  config.REGISTRATION_RECONCILE_MAX_AGE_SECONDS * 1_000;
let identityVerification: {
  verified: boolean;
  checkedAt: Date | null;
} = {
  verified: false,
  checkedAt: null,
};
let monitorTimer: ReturnType<typeof setInterval> | null = null;
let refreshInFlight: Promise<boolean> | null = null;

export async function verifyProviderIdentity(): Promise<boolean> {
  if (CHAIN_MODE_MOCK) return true;
  const onChainWalletAddress = await publicClient.readContract({
    address: config.IDENTITY_REGISTRY_ADDRESS as Hex,
    abi: identityRegistryAbi,
    functionName: "getAgentWallet",
    args: [config.PROVIDER_AGENT_ID],
  });
  return String(onChainWalletAddress).toLowerCase() === providerAddress.toLowerCase();
}

export function recordProviderIdentityVerification(
  verified: boolean,
  checkedAt = new Date(),
): void {
  identityVerification = { verified, checkedAt };
}

export function getProviderIdentityAuthorization(
  now = Date.now(),
): ProviderIdentityAuthorization {
  if (!identityVerification.verified || !identityVerification.checkedAt) {
    return {
      ok: false,
      checkedAt: identityVerification.checkedAt,
      reason: "provider identity is not verified",
    };
  }
  if (
    identityVerification.checkedAt.getTime()
      < now - PROVIDER_IDENTITY_MAX_AGE_MS
  ) {
    return {
      ok: false,
      checkedAt: identityVerification.checkedAt,
      reason: "provider identity verification is stale",
    };
  }
  return {
    ok: true,
    checkedAt: identityVerification.checkedAt,
    reason: null,
  };
}

export function refreshProviderIdentityAuthorization(
  verify: () => Promise<boolean> = verifyProviderIdentity,
): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const wasAuthorized = getProviderIdentityAuthorization().ok;
    try {
      const verified = await verify();
      recordProviderIdentityVerification(verified);
      if (!verified && wasAuthorized) {
        logWarn("Provider identity no longer matches its registered agent wallet", {
          agentId: config.PROVIDER_AGENT_ID.toString(),
        });
      }
      return verified;
    } catch (error) {
      recordProviderIdentityVerification(false);
      if (wasAuthorized) {
        logWarn("Provider identity revalidation failed", errorExtra(error, {
          agentId: config.PROVIDER_AGENT_ID.toString(),
        }));
      }
      return false;
    }
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/**
 * Re-verify the identity every three minutes, within the five-minute
 * authorization freshness limit; a failed or mismatching read revokes it at
 * once.
 */
export function startProviderIdentityMonitor(
  intervalMs = Math.max(1_000, Math.min(180_000, Math.floor(PROVIDER_IDENTITY_MAX_AGE_MS * 0.6))),
): void {
  if (monitorTimer) return;
  void refreshProviderIdentityAuthorization();
  monitorTimer = setInterval(() => {
    void refreshProviderIdentityAuthorization();
  }, intervalMs);
  monitorTimer.unref();
}

export function stopProviderIdentityMonitor(): void {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = null;
}
