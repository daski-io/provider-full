import type { Hex } from "viem";
import { config } from "../config.js";
import { publicClient } from "./client.js";

export interface CanonicalReceipt {
  status: "success" | "reverted";
  transactionHash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
}

/**
 * The observation stayed internally inconsistent after bounded re-reads:
 * the receipt's block hash never matched the chain's block at that height.
 * This is AMBIGUOUS — the transaction may still be canonical (RPC views can
 * lag or serve pre-confirmation state) — so callers must reconcile later
 * and must never treat it as reverted or re-broadcast over it.
 */
export class AmbiguousReceiptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousReceiptError";
  }
}

const OBSERVATION_ATTEMPTS = 5;
const OBSERVATION_RETRY_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Assert the transaction is final (configured confirmation depth) and
 * canonical, from coherent observations: each attempt RE-READS the receipt,
 * the head, and the block at the receipt's height together, so a stale or
 * pre-confirmation receipt from an earlier read can never be compared
 * against a newer chain view. Persistent incoherence raises
 * AmbiguousReceiptError instead of a false "non-canonical" verdict.
 */
export async function assertCanonicalFinalReceipt(
  receipt: CanonicalReceipt,
  expectedHash: Hex,
): Promise<void> {
  if (receipt.transactionHash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error("Receipt transaction hash does not match the submitted transaction");
  }
  let lastConfirmations = 0n;
  for (let attempt = 1; attempt <= OBSERVATION_ATTEMPTS; attempt += 1) {
    // One coherent observation: a FRESH receipt plus the head and the block
    // at that receipt's own height.
    const observed = attempt === 1
      ? receipt
      : await publicClient.getTransactionReceipt({
          hash: expectedHash,
        }) as CanonicalReceipt;
    const [latest, canonical] = await Promise.all([
      publicClient.getBlockNumber() as Promise<bigint>,
      publicClient.getBlock({ blockNumber: observed.blockNumber }),
    ]);
    lastConfirmations = latest >= observed.blockNumber
      ? latest - observed.blockNumber + 1n
      : 0n;
    const deepEnough =
      lastConfirmations >= BigInt(config.CHAIN_WRITE_FINALITY_CONFIRMATIONS);
    const coherent = canonical.hash !== null &&
      canonical.hash.toLowerCase() === observed.blockHash.toLowerCase();
    if (deepEnough && coherent) return;
    if (attempt < OBSERVATION_ATTEMPTS) await sleep(OBSERVATION_RETRY_MS);
  }
  if (lastConfirmations < BigInt(config.CHAIN_WRITE_FINALITY_CONFIRMATIONS)) {
    throw new Error(
      `Transaction has ${lastConfirmations} confirmation(s); `
      + `${config.CHAIN_WRITE_FINALITY_CONFIRMATIONS} required`,
    );
  }
  throw new AmbiguousReceiptError(
    "Receipt and canonical block observations stayed inconsistent; "
    + "treat the write as AMBIGUOUS and reconcile later",
  );
}

export async function waitForCanonicalFinalReceipt(hash: Hex): Promise<CanonicalReceipt> {
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: config.CHAIN_WRITE_FINALITY_CONFIRMATIONS,
  }) as CanonicalReceipt;
  await assertCanonicalFinalReceipt(receipt, hash);
  return receipt;
}

export async function finalizedReadBlockNumber(): Promise<bigint> {
  const latest = await publicClient.getBlockNumber() as bigint;
  const depth = BigInt(config.CHAIN_WRITE_FINALITY_CONFIRMATIONS);
  if (latest + 1n < depth) throw new Error("Chain has not reached the configured finality depth");
  return latest - depth + 1n;
}
