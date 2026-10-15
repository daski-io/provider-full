import { base, baseSepolia } from "viem/chains";
import type { ProviderStandardRailConfig } from "./config.js";
import { ProviderEvidenceVerifier } from "./evidence.js";

/*
 * The rail's chain facts (sanctions oracle, EAS, canonical token code,
 * implementation and domain) are re-proved in the background only every
 * five minutes (readiness.ts). A protected operation therefore obtains a
 * fresh proof of its own before it acts: a quote before it is signed, a
 * buyer's input or cancellation before it mutates, a wallet action before
 * it consumes anything, a reputation write before it is signed, and a
 * dispatch inside its evidence verification. A successful background
 * verification is deliberately never reused for them.
 */

/** A fresh live proof of the rail contracts; throws when it cannot be made. */
export type ContractIntegrityCheck = () => Promise<void>;

export function liveContractIntegrity(config: ProviderStandardRailConfig): ContractIntegrityCheck {
  return () => new ProviderEvidenceVerifier(config, config.chainId === 8453 ? base : baseSepolia)
    .verifyLiveReadiness();
}
