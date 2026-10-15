import type { Chain } from "viem";
import { failWorker, heartbeatWorker, setWorkerStatus } from "../health.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { ProviderEvidenceVerifier } from "./evidence.js";

const WORKER = "standard-rail-evidence";
// The background proof runs every five minutes; protected operations prove
// the contracts freshly themselves (contractIntegrity.ts). The heartbeat
// allows 90 seconds for the next scheduled proof to finish, and a failure
// still revokes it at once.
const INTERVAL_MS = 300_000;
const MAX_AGE_SECONDS = INTERVAL_MS / 1_000 + 90;

export async function startStandardRailReadiness(
  config: ProviderStandardRailConfig,
  chain: Chain,
): Promise<() => void> {
  const verifier = new ProviderEvidenceVerifier(config, chain);
  let verificationInFlight = false;
  const verifyEvidence = async () => {
    if (verificationInFlight) return;
    verificationInFlight = true;
    try {
      await verifier.verifyLiveReadiness();
      heartbeatWorker(WORKER, MAX_AGE_SECONDS);
    } catch {
      failWorker(WORKER);
    } finally {
      verificationInFlight = false;
    }
  };
  setWorkerStatus(WORKER, false, MAX_AGE_SECONDS);
  await verifier.verifyReadiness();
  heartbeatWorker(WORKER, MAX_AGE_SECONDS);
  const timer = setInterval(() => void verifyEvidence(), INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
