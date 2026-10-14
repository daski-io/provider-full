import type { Hex } from "viem";
import { config } from "../config.js";
import {
  listOpenProviderWrites,
  type ProviderChainWriteRow,
} from "../db/queries/providerChainWrites.js";
import { serviceRegistryAbi } from "./abis.js";
import { publicClient } from "./client.js";
import {
  BASE_BLOCK_TIME_MS,
  finalityWaitBudgetMs,
  finalizedReadBlockNumber,
} from "./finality.js";
import {
  confirmProviderWrite,
  providerWriteScope,
  revertProviderWrite,
} from "./providerWriteCoordinator.js";

// ServiceRegistry writes the registrar already journaled. A registration
// whose transaction is still pending is resumed, never signed a second time,
// and a settled one is recorded in the journal instead of staying open.

export async function openRegistrationWrites(serviceRowId: string): Promise<ProviderChainWriteRow[]> {
  return listOpenProviderWrites(providerWriteScope, "service_registration", {
    type: "service",
    id: serviceRowId,
  });
}

export async function registryHolds(expected: Hex, blockNumber: bigint): Promise<boolean> {
  return await publicClient.readContract({
    address: config.SERVICE_REGISTRY_ADDRESS as Hex,
    abi: serviceRegistryAbi,
    functionName: "exists",
    args: [expected],
    blockNumber,
  }) as boolean;
}

/**
 * Record the outcome of every open registration write whose receipt is at
 * the finalized depth. Pending writes stay open: the next cycle, or the
 * nonce-gap reconciler, settles them.
 */
export async function settleRegistrationWrites(
  serviceRowId: string,
  finalizedBlock: bigint,
): Promise<void> {
  for (const write of await openRegistrationWrites(serviceRowId)) {
    if (write.status === "attention") continue;
    let receipt: { status: string; blockNumber: bigint } | null = null;
    try {
      receipt = await publicClient.getTransactionReceipt({ hash: write.transaction_hash });
    } catch {
      receipt = null;
    }
    if (!receipt || receipt.blockNumber > finalizedBlock) continue;
    if (receipt.status === "success") await confirmProviderWrite(write.id);
    else await revertProviderWrite(write.id, "canonical_receipt_reverted");
  }
}

/**
 * Wait until a registration visible at the latest block is visible at the
 * finalized depth, so an adopted entry is verified there like one this
 * provider broadcast itself. Bounded by the finality wait budget.
 */
export async function waitForFinalizedRegistration(expected: Hex): Promise<bigint> {
  const timeoutMs = finalityWaitBudgetMs();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const finalizedBlock = await finalizedReadBlockNumber();
    if (await registryHolds(expected, finalizedBlock)) return finalizedBlock;
    if (Date.now() >= deadline) {
      throw new Error(
        `ServiceRegistry entry ${expected} visible at the latest block did not reach finality within ${timeoutMs}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, BASE_BLOCK_TIME_MS));
  }
}
