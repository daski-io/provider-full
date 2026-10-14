import { TransactionReceiptNotFoundError, type Address, type Hex } from "viem";
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
  rebroadcastProviderWrite,
  reconcileProviderNonceGap,
  replaceProviderWrite,
  revertProviderWrite,
} from "./providerWriteCoordinator.js";
import type { ReconcileCycle } from "./reconcileCycle.js";

// ServiceRegistry writes the registrar already journaled. An open write is
// resumed until the state it was signed for is final, never signed a second
// time, and every write whose outcome is final is recorded in the journal
// instead of staying open.

export type ServiceWritePurpose = "service_registration" | "service_uri_update";

const SERVICE_WRITE_PURPOSES: readonly ServiceWritePurpose[] = [
  "service_registration",
  "service_uri_update",
];

export async function openServiceWrites(
  serviceRowId: string,
  purpose: ServiceWritePurpose,
): Promise<ProviderChainWriteRow[]> {
  return listOpenProviderWrites(providerWriteScope, purpose, {
    type: "service",
    id: serviceRowId,
  });
}

export function openRegistrationWrites(serviceRowId: string): Promise<ProviderChainWriteRow[]> {
  return openServiceWrites(serviceRowId, "service_registration");
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

/** A write's receipt, null when the chain has none, "unknown" when the read failed. */
async function receiptOf(
  hash: Hex,
): Promise<{ status: string; blockNumber: bigint } | null | "unknown"> {
  try {
    return await publicClient.getTransactionReceipt({ hash });
  } catch (error) {
    return error instanceof TransactionReceiptNotFoundError ? null : "unknown";
  }
}

/**
 * Record the outcome of every open ServiceRegistry write of a service that
 * is final at `finalizedBlock`: confirmed or reverted by its receipt at that
 * depth, or replaced when another transaction used its nonce there, so it can
 * never be mined. Pending writes, and writes under nonce-gap review, stay
 * open for the next cycle or the nonce-gap reconciler.
 */
export async function settleServiceWrites(
  serviceRowId: string,
  finalizedBlock: bigint,
): Promise<void> {
  let finalizedNonce: bigint | null = null;
  for (const purpose of SERVICE_WRITE_PURPOSES) {
    for (const write of await openServiceWrites(serviceRowId, purpose)) {
      if (write.status === "attention") continue;
      const receipt = await receiptOf(write.transaction_hash);
      if (receipt === "unknown") continue;
      if (receipt) {
        if (receipt.blockNumber > finalizedBlock) continue;
        if (receipt.status === "success") await confirmProviderWrite(write.id);
        else await revertProviderWrite(write.id, "canonical_receipt_reverted");
        continue;
      }
      finalizedNonce ??= BigInt(await publicClient.getTransactionCount({
        address: providerWriteScope.walletAddress as Address,
        blockNumber: finalizedBlock,
      }));
      if (BigInt(write.nonce) < finalizedNonce) {
        await replaceProviderWrite(write.id, null, "nonce_consumed");
      }
    }
  }
}

/**
 * Resume an open ServiceRegistry write until `reached` holds at the
 * finalized depth, without signing it again. A write the network never
 * accepted is resent with its original signed bytes, and one pass of the
 * nonce-gap recovery fee-replaces a write stuck at its nonce: boot resumes
 * writes before the provider-write reconciler starts. Resolves with the
 * finalized block, or with the write's final revert; bounded by the finality
 * wait budget, during which the cycle's deadline pauses.
 */
export async function resumeServiceWrite(args: {
  write: ProviderChainWriteRow;
  label: string;
  cycle: ReconcileCycle;
  reached: (finalizedBlock: bigint) => Promise<boolean>;
}): Promise<{ finalizedBlock: bigint } | { reverted: ProviderChainWriteRow }> {
  const { write, cycle } = args;
  if (write.status === "attention") {
    throw new Error(`${args.label} write ${write.id} awaits review of its blocked nonce`);
  }
  if (write.status === "prepared") {
    try {
      await rebroadcastProviderWrite(write.id);
    } catch {
      // Refused when the network already has it; the wait below decides.
    }
  }
  if (cycle.isCurrent()) {
    try {
      await reconcileProviderNonceGap();
    } catch {
      // A later cycle, or the reconciler once started, retries.
    }
  }
  return cycle.awaitBroadcast(async () => {
    const timeoutMs = finalityWaitBudgetMs();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const finalizedBlock = await finalizedReadBlockNumber();
      if (await args.reached(finalizedBlock)) return { finalizedBlock };
      const receipt = await receiptOf(write.transaction_hash);
      if (
        receipt && receipt !== "unknown" &&
        receipt.status !== "success" && receipt.blockNumber <= finalizedBlock
      ) return { reverted: write };
      if (Date.now() >= deadline) {
        throw new Error(
          `${args.label} write ${write.id} did not reach finality within ${timeoutMs}ms; a later cycle resumes it`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, BASE_BLOCK_TIME_MS));
    }
  });
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
