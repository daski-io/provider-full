import { randomUUID } from "node:crypto";
import { parseTransaction, type Hex } from "viem";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import {
  advanceProviderCursor,
  getBlockingProviderNonceGap,
  getProviderWrite,
  insertProviderWrite,
  markProviderWriteResent,
  rebindReplacementProviderWrite,
  suggestedProviderNonce,
  updateProviderWriteStatus,
  type ProviderChainWriteRow,
  type ProviderWritePurpose,
  type ProviderWriteScope,
} from "../db/queries/providerChainWrites.js";
import { closeOpenReviewsForTarget } from "../db/queries/escalations.js";
import { inTransaction, type Queryable } from "../db/queryable.js";
import { createHumanEscalation } from "../engine/escalation.js";
import { logInfo, logWarn } from "../logger.js";
import { decryptString, encryptString } from "./encryption.js";
import {
  assertCanonicalFinalReceipt,
  finalizedReadBlockNumber,
} from "./finality.js";
import { providerAddress, publicClient, walletClient } from "./client.js";
import { withProviderSignerLease } from "./signerLease.js";
import {
  prepareSignedContractWrite,
  prepareSignedFeeReplacement,
} from "./signedWrite.js";

export const providerWriteScope: ProviderWriteScope = {
  chainId: config.CHAIN_ID,
  walletAddress: providerAddress.toLowerCase(),
};

function signedWriteContext(id: string) {
  return {
    purpose: "provider-signed-transaction",
    table: "provider_chain_writes",
    recordId: id,
    field: "signed_tx_encrypted",
    service: "core",
  } as const;
}

/**
 * [finalized, pending] account nonces for the provider wallet, as bigint.
 *
 * viem's getTransactionCount resolves to a NUMBER. Every call site here used
 * to cast the promise to Promise<bigint>, which only silenced the compiler:
 * the values stayed numbers and poisoned the nonce arithmetic downstream
 * ("Cannot mix BigInt and other types" — the 2026-07-28 boot crash-loop).
 * Convert once, here, and never cast at the boundary.
 */
async function providerAccountNonces(
  finalizedBlock: bigint,
): Promise<[bigint, bigint]> {
  const [finalized, pending] = await Promise.all([
    publicClient.getTransactionCount({
      address: providerAddress,
      blockNumber: finalizedBlock,
    }),
    publicClient.getTransactionCount({
      address: providerAddress,
      blockTag: "pending",
    }),
  ]);
  return [BigInt(finalized), BigInt(pending)];
}

function normalizedWriteError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/replacement transaction underpriced/i.test(message)) return "replacement_underpriced";
  if (/nonce too low/i.test(message)) return "nonce_too_low";
  if (/already known|known transaction/i.test(message)) return "already_known";
  if (/insufficient funds/i.test(message)) return "insufficient_funds";
  if (/fee|max fee|base fee/i.test(message)) return "fee_rejected";
  if (/timeout|timed out/i.test(message)) return "rpc_timeout";
  return "broadcast_rejected";
}

export interface PreparedProviderWrite {
  id: string;
  hash: Hex;
  intentHash: Hex;
  nonce: bigint;
}

class ProviderGapRecoveryInProgress extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderGapRecoveryInProgress";
  }
}

async function createProviderNonceGapReview(args: {
  gap: ProviderChainWriteRow & { queued_behind: number };
  finalizedNonce: bigint;
  pendingNonce: bigint;
  reason: string;
}): Promise<void> {
  let parsed: ReturnType<typeof parseTransaction> | null = null;
  if (args.gap.signed_tx_encrypted) {
    try {
      parsed = parseTransaction(decryptString(
        args.gap.signed_tx_encrypted,
        signedWriteContext(args.gap.id),
      ) as Hex);
    } catch {
      parsed = null;
    }
  }
  await inTransaction(pool, async (db) => {
    await updateProviderWriteStatus(args.gap.id, "attention", {
      errorCode: args.reason,
    }, db);
    await createHumanEscalation({
      source: "auto",
      question:
        `Provider wallet write ${args.gap.id} at nonce ${args.gap.nonce} is blocking `
        + `${args.gap.queued_behind} queued write(s). Choose a bounded recovery action.`,
      title: `Provider wallet nonce ${args.gap.nonce} is blocked`,
      summary:
        `Automatic recovery stopped for the ${args.gap.purpose.replace(/_/g, " ")} `
        + `write at nonce ${args.gap.nonce}. Review the bounded action below; no wallet `
        + "nonce diagnosis is required.",
      review: {
        kind: "provider_nonce_gap",
        severity: "critical",
        dedupeKey:
          `provider-nonce-gap:${providerWriteScope.chainId}:`
          + `${providerWriteScope.walletAddress}:${args.gap.nonce}`,
        target: { type: "provider_chain_write", id: args.gap.id },
        whyHuman:
          "Automatic same-nonce fee replacement reached its configured attempt or fee ceiling.",
        evidence: {
          version: 1,
          chainId: providerWriteScope.chainId,
          walletAddress: providerWriteScope.walletAddress,
          nonce: args.gap.nonce,
          purpose: args.gap.purpose,
          targetType: args.gap.target_type,
          targetId: args.gap.target_id,
          transactionHash: args.gap.transaction_hash,
          createdAt: args.gap.created_at.toISOString(),
          finalizedAccountNonce: args.finalizedNonce.toString(),
          pendingAccountNonce: args.pendingNonce.toString(),
          queuedBehind: args.gap.queued_behind,
          feeBumpCount: args.gap.fee_bump_count,
          maxFeePerGas: parsed?.maxFeePerGas?.toString() ?? null,
          maxPriorityFeePerGas: parsed?.maxPriorityFeePerGas?.toString() ?? null,
          gasPrice: parsed?.gasPrice?.toString() ?? null,
          configuredFeeCeilingGwei: config.PROVIDER_WRITE_MAX_FEE_GWEI ?? 500,
          reason: args.reason,
        },
        dueAt: new Date(Date.now() + 4 * 3_600_000),
      },
    suggestedActions: args.gap.signed_tx_encrypted
      ? [{
            label: "Bounded fee replacement",
            value: JSON.stringify({
              tool: "retry_provider_nonce_gap",
              arguments: { provider_write_id: args.gap.id },
            }),
            effect:
              "Re-signs identical calldata at the blocked nonce under the configured fee ceiling.",
          }]
        : [],
    }, db);
  });
}

async function recoverGapUnderLease(
  gap: ProviderChainWriteRow & { queued_behind: number },
  finalizedNonce: bigint,
  pendingNonce: bigint,
  force: boolean,
): Promise<PreparedProviderWrite | null> {
  let receipt: Awaited<ReturnType<typeof publicClient.getTransactionReceipt>> | null = null;
  try {
    receipt = await publicClient.getTransactionReceipt({
      hash: gap.transaction_hash,
    });
  } catch {
    receipt = null;
  }
  if (receipt) {
    try {
      await assertCanonicalFinalReceipt(receipt, gap.transaction_hash);
    } catch {
      return null;
    }
    await updateProviderWriteStatus(
      gap.id,
      receipt.status === "success" ? "confirmed" : "reverted",
      receipt.status === "success" ? {} : { errorCode: "canonical_receipt_reverted" },
    );
    return null;
  }
  const minimumAgeMs = (config.PROVIDER_WRITE_GAP_SECONDS ?? 180) * 1_000;
  if (!force && Date.now() - gap.updated_at.getTime() < minimumAgeMs) return null;
  const maxBumps = config.PROVIDER_WRITE_MAX_FEE_BUMPS ?? 3;
  if (!force && gap.fee_bump_count >= maxBumps) {
    await createProviderNonceGapReview({
      gap,
      finalizedNonce,
      pendingNonce,
      reason: "fee_replacement_exhausted",
    });
    return null;
  }
  if (!gap.signed_tx_encrypted) {
    await createProviderNonceGapReview({
      gap,
      finalizedNonce,
      pendingNonce,
      reason: "signed_transaction_unavailable",
    });
    return null;
  }
  const serialized = decryptString(
    gap.signed_tx_encrypted,
    signedWriteContext(gap.id),
  ) as Hex;
  let signed;
  try {
    signed = await prepareSignedFeeReplacement({
      serialized,
      nonce: BigInt(gap.nonce),
      expectedIntentHash: gap.intent_hash,
      feeBumpPercent: config.PROVIDER_WRITE_FEE_BUMP_PERCENT ?? 15,
      maxFeePerGas: BigInt(config.PROVIDER_WRITE_MAX_FEE_GWEI ?? 500)
        * 1_000_000_000n,
    });
  } catch (error) {
    await createProviderNonceGapReview({
      gap,
      finalizedNonce,
      pendingNonce,
      reason: normalizedWriteError(error),
    });
    return null;
  }
  const id = randomUUID();
  const replacement: PreparedProviderWrite = {
    id,
    hash: signed.hash,
    intentHash: signed.intentHash,
    nonce: signed.nonce,
  };
  const encrypted = encryptString(signed.serialized, signedWriteContext(id));
  await inTransaction(pool, async (db) => {
    await updateProviderWriteStatus(gap.id, "replaced", {
      errorCode: "same_nonce_fee_replacement",
    }, db);
    await insertProviderWrite({
      id,
      chainId: providerWriteScope.chainId,
      wallet_address: providerWriteScope.walletAddress,
      nonce: signed.nonce,
      purpose: gap.purpose,
      target_type: gap.target_type,
      target_id: gap.target_id,
      intent_hash: signed.intentHash,
      transaction_hash: signed.hash,
      signed_tx_encrypted: encrypted,
      supersedesWriteId: gap.id,
      feeBumpCount: gap.fee_bump_count + 1,
    }, db);
    await updateProviderWriteStatus(gap.id, "replaced", {
      errorCode: "same_nonce_fee_replacement",
      replacementWriteId: id,
    }, db);
    if (!await rebindReplacementProviderWrite({
      old: gap,
      replacementId: id,
      replacementHash: signed.hash,
      db,
    })) {
      throw new Error("Provider write replacement lost its domain binding");
    }
  });
  try {
    const submitted = await walletClient.sendRawTransaction({
      serializedTransaction: signed.serialized,
    }) as Hex;
    if (submitted.toLowerCase() !== signed.hash.toLowerCase()) {
      throw new Error("Provider replacement hash did not match persisted signed bytes");
    }
    await updateProviderWriteStatus(id, "broadcast");
  } catch (error) {
    await updateProviderWriteStatus(id, "prepared", {
      errorCode: normalizedWriteError(error),
    });
  }
  logWarn("Provider wallet nonce gap received a same-nonce fee replacement", {
    providerWriteId: id,
    supersedesWriteId: gap.id,
    nonce: gap.nonce,
    purpose: gap.purpose,
    txHash: signed.hash,
    feeBumpCount: gap.fee_bump_count + 1,
  });
  return replacement;
}

export async function prepareAndBroadcastProviderWrite(args: {
  purpose: ProviderWritePurpose;
  target: { type: string; id: string };
  address: Hex;
  abi: readonly unknown[];
  functionName: string;
  callArgs: readonly unknown[];
  gas?: bigint;
  value?: bigint;
  /** Revalidate mutable chain/domain preconditions while holding the signer
   * lease, before allocating a nonce or persisting a signed transaction. */
  preflight?: () => Promise<void>;
  persist: (
    prepared: PreparedProviderWrite,
    db: Queryable,
  ) => Promise<boolean | void>;
}): Promise<PreparedProviderWrite> {
  return withProviderSignerLease(providerWriteScope, async () => {
    await args.preflight?.();
    const finalizedBlock = await finalizedReadBlockNumber();
    const [finalizedNonce, pendingNonce] = await providerAccountNonces(
      finalizedBlock,
    );
    const gap = await getBlockingProviderNonceGap(
      providerWriteScope,
      finalizedNonce,
      config.PROVIDER_WRITE_GAP_SECONDS ?? 180,
    );
    if (gap) {
      const replacement = await recoverGapUnderLease(
        gap,
        finalizedNonce,
        pendingNonce,
        false,
      );
      throw new ProviderGapRecoveryInProgress(
        replacement
          ? `Provider nonce gap at ${gap.nonce} was fee-replaced; confirmation is pending`
          : `Provider nonce gap at ${gap.nonce} blocks new provider-wallet writes`,
      );
    }
    const nonce = await suggestedProviderNonce(
      providerWriteScope,
      pendingNonce,
      finalizedNonce,
    );
    const signed = await prepareSignedContractWrite({
      address: args.address,
      abi: args.abi,
      functionName: args.functionName,
      callArgs: args.callArgs,
      gas: args.gas,
      nonce,
      value: args.value,
    });
    const id = randomUUID();
    const prepared: PreparedProviderWrite = {
      id,
      hash: signed.hash,
      intentHash: signed.intentHash,
      nonce,
    };
    const encrypted = encryptString(signed.serialized, signedWriteContext(id));
    await inTransaction(pool, async (db) => {
      await insertProviderWrite({
        id,
        chainId: providerWriteScope.chainId,
        wallet_address: providerWriteScope.walletAddress,
        nonce,
        purpose: args.purpose,
        target_type: args.target.type,
        target_id: args.target.id,
        intent_hash: signed.intentHash,
        transaction_hash: signed.hash,
        signed_tx_encrypted: encrypted,
      }, db);
      const persisted = await args.persist(prepared, db);
      if (persisted === false) {
        throw new Error("Provider write lost its domain-state persistence claim");
      }
      await advanceProviderCursor(providerWriteScope, nonce, db);
    });
    try {
      const submitted = await walletClient.sendRawTransaction({
        serializedTransaction: signed.serialized,
      }) as Hex;
      if (submitted.toLowerCase() !== signed.hash.toLowerCase()) {
        throw new Error("Provider broadcast hash did not match persisted signed bytes");
      }
      await updateProviderWriteStatus(id, "broadcast");
      logInfo("Provider wallet write broadcast", {
        providerWriteId: id,
        purpose: args.purpose,
        targetType: args.target.type,
        targetId: args.target.id,
        txHash: signed.hash,
        nonce: nonce.toString(),
      });
      return prepared;
    } catch (error) {
      const errorCode = normalizedWriteError(error);
      await updateProviderWriteStatus(id, "prepared", { errorCode });
      logWarn("Provider wallet write persisted for reconciliation after broadcast error", {
        providerWriteId: id,
        purpose: args.purpose,
        txHash: signed.hash,
        nonce: nonce.toString(),
        errorCode,
      });
      throw error;
    }
  });
}

export async function rebroadcastProviderWrite(id: string): Promise<Hex> {
  const row = await getProviderWrite(id);
  if (!row?.signed_tx_encrypted) {
    throw new Error(`Provider write ${id} has no retained signed transaction`);
  }
  const serialized = decryptString(
    row.signed_tx_encrypted,
    signedWriteContext(row.id),
  ) as Hex;
  return broadcastStoredTransaction(serialized, row.transaction_hash, id);
}

async function broadcastStoredTransaction(
  serialized: Hex,
  expectedHash: Hex,
  providerWriteId?: string,
): Promise<Hex> {
  const submitted = await walletClient.sendRawTransaction({
    serializedTransaction: serialized,
  }) as Hex;
  if (submitted.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error("Rebroadcast hash did not match persisted signed transaction");
  }
  // Resends run outside the signer lease: a write the nonce-gap recovery
  // replaced, or a settlement closed, meanwhile is never reopened.
  if (providerWriteId) await markProviderWriteResent(providerWriteId);
  return submitted;
}

export async function confirmProviderWrite(
  id: string | null | undefined,
  db?: Queryable,
): Promise<void> {
  if (!id) return;
  const row = await getProviderWrite(id, db);
  await updateProviderWriteStatus(id, "confirmed", {}, db);
  if (row?.supersedes_write_id) {
    await closeOpenReviewsForTarget({
      targetType: "provider_chain_write",
      targetId: row.supersedes_write_id,
      resolvedBy: "system",
      response: `Same-nonce replacement ${row.transaction_hash} confirmed canonically.`,
    }, db);
  }
}

export async function revertProviderWrite(
  id: string | null | undefined,
  errorCode: string,
): Promise<void> {
  if (id) await updateProviderWriteStatus(id, "reverted", { errorCode });
}

export async function replaceProviderWrite(
  id: string | null | undefined,
  replacementWriteId: string | null,
  errorCode: string,
  db?: Queryable,
): Promise<void> {
  if (id) {
    await updateProviderWriteStatus(id, "replaced", {
      errorCode,
      replacementWriteId,
    }, db);
  }
}

export async function loadProviderWrite(
  id: string | null | undefined,
): Promise<ProviderChainWriteRow | null> {
  return id ? getProviderWrite(id) : null;
}

/** Human-approved additional fee replacement after automatic recovery stops. */
export async function replaceProviderWriteWithBoundedFee(
  id: string,
): Promise<PreparedProviderWrite> {
  return withProviderSignerLease(providerWriteScope, async () => {
      const gap = await getProviderWrite(id);
      if (!gap || !["prepared", "broadcast", "attention"].includes(gap.status)) {
        throw new Error("Provider write is no longer eligible for fee replacement");
      }
      const finalizedBlock = await finalizedReadBlockNumber();
      const [finalizedNonce, pendingNonce] = await providerAccountNonces(
        finalizedBlock,
      );
      const replacement = await recoverGapUnderLease(
        { ...gap, queued_behind: 0 },
        finalizedNonce,
        pendingNonce,
        true,
      );
      if (!replacement) {
        throw new Error("Provider write no longer requires a fee replacement");
      }
    return replacement;
  });
}

export async function reconcileProviderNonceGap(): Promise<
  "clear" | "replacement_broadcast" | "attention"
> {
  return withProviderSignerLease(providerWriteScope, async () => {
      const finalizedBlock = await finalizedReadBlockNumber();
      const [finalizedNonce, pendingNonce] = await providerAccountNonces(
        finalizedBlock,
      );
      const gap = await getBlockingProviderNonceGap(
        providerWriteScope,
        finalizedNonce,
        config.PROVIDER_WRITE_GAP_SECONDS ?? 180,
      );
      if (!gap) return "clear";
      const replacement = await recoverGapUnderLease(
        gap,
        finalizedNonce,
        pendingNonce,
        false,
      );
    return replacement ? "replacement_broadcast" : "attention";
  });
}
