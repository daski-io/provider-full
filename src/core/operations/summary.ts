import { getRegistrationObservations } from "../chain/registrationObservability.js";
import { config } from "../config.js";
import { providerAddress, publicClient } from "../chain/client.js";
import { pool } from "../db/pool.js";
import { getDurableQueueMetrics } from "../db/queries/durableJobs.js";
import { getProviderWriteOperationalSummary } from "../db/queries/providerChainWrites.js";
import { getReputationOutcomeOperationalSummary } from "../standardRail/reputationOutcome.js";

export async function getProviderWalletOperationalSummary(): Promise<Record<string, unknown>> {
  const [finalizedNonce, pendingNonce, balance, cursor] = await Promise.all([
    publicClient.getTransactionCount({ address: providerAddress, blockTag: "finalized" })
      .then(String).catch(() => null),
    publicClient.getTransactionCount({ address: providerAddress, blockTag: "pending" })
      .then(String).catch(() => null),
    publicClient.getBalance({ address: providerAddress }).then(String).catch(() => null),
    pool.query<{ next_nonce: string; updated_at: Date }>(
      `SELECT next_nonce::text,updated_at FROM provider_signer_cursors
        WHERE chain_id=$1 AND wallet_address=$2`,
      [config.CHAIN_ID, providerAddress.toLowerCase()],
    ).then((result) => result.rows[0] ?? null),
  ]);
  return {
    chainId: config.CHAIN_ID,
    address: providerAddress,
    finalizedNonce,
    pendingNonce,
    balanceWei: balance,
    durableNextNonce: cursor?.next_nonce ?? null,
    cursorUpdatedAt: cursor?.updated_at.toISOString() ?? null,
    maxFeeGwei: config.PROVIDER_WRITE_MAX_FEE_GWEI,
    maxFeeBumps: config.PROVIDER_WRITE_MAX_FEE_BUMPS,
  };
}

export async function getOperationsSummary(): Promise<Record<string, unknown>> {
  const [reputationOutcomes, providerWrites, providerWallet, queues] = await Promise.all([
    getReputationOutcomeOperationalSummary(),
    getProviderWriteOperationalSummary(),
    getProviderWalletOperationalSummary(),
    getDurableQueueMetrics(),
  ]);
  return {
    reputationOutcomes, providerWrites, providerWallet, queues,
    serviceRegistration: getRegistrationObservations(),
  };
}
