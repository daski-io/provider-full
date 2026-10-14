import { TransactionReceiptNotFoundError, type Address, type Hex } from "viem";
import { publicClient } from "./client.js";
import { providerWriteScope } from "./providerWriteCoordinator.js";

// What the chain says about a journaled provider-wallet write, read without
// waiting: its receipt, and whether another transaction took its nonce.

/** A write's receipt; null when the chain has none, "unknown" when the read failed. */
export async function receiptOf(
  hash: Hex,
): Promise<{ status: string; blockNumber: bigint } | null | "unknown"> {
  try {
    return await publicClient.getTransactionReceipt({ hash });
  } catch (error) {
    return error instanceof TransactionReceiptNotFoundError ? null : "unknown";
  }
}

/** The provider wallet's nonce at a block: every lower nonce is used. */
export async function walletNonceAt(blockNumber: bigint): Promise<bigint> {
  return BigInt(await publicClient.getTransactionCount({
    address: providerWriteScope.walletAddress as Address,
    blockNumber,
  }));
}
