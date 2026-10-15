import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import type { ProviderChainWriteRow } from "../src/core/db/queries/providerChainWrites.js";

const HASH = `0x${"11".repeat(32)}` as Hex;
const INTENT = `0x${"22".repeat(32)}` as Hex;
const REPLACEMENT_HASH = `0x${"33".repeat(32)}` as Hex;

const state = vi.hoisted(() => ({
  rows: new Map<string, ProviderChainWriteRow>(),
  gap: null as (ProviderChainWriteRow & { queued_behind: number }) | null,
  unresolved: true,
  nonceReads: 0,
  finalizedNonce: 4,
  pendingNonce: 6,
  suggestedNonce: 7n,
  receipt: null as Record<string, unknown> | null,
  receiptLookupFails: false,
  canonicalFails: false,
  replacementFails: null as Error | null,
  rebinds: true,
  broadcastResult: null as Hex | null,
  broadcastError: null as Error | null,
  updates: [] as Array<{ id: string; status: string; details?: unknown }>,
  inserted: [] as Array<Record<string, unknown>>,
  reviews: [] as Array<Record<string, unknown>>,
  closedReviews: [] as Array<Record<string, unknown>>,
  sequence: [] as string[],
}));

vi.mock("../src/core/config.js", () => ({
  config: {
    CHAIN_ID: 84532,
    PROVIDER_WRITE_GAP_SECONDS: 180,
    PROVIDER_WRITE_MAX_FEE_BUMPS: 3,
    PROVIDER_WRITE_FEE_BUMP_PERCENT: 15,
    PROVIDER_WRITE_MAX_FEE_GWEI: 500,
  },
}));
vi.mock("../src/core/chain/client.js", () => ({
  providerAddress: "0x1111111111111111111111111111111111111111",
  publicClient: {
    getTransactionCount: vi.fn(async (args: { blockTag?: string }) => {
      state.nonceReads += 1;
      return args.blockTag === "pending" ? state.pendingNonce : state.finalizedNonce;
    }),
    getTransactionReceipt: vi.fn(async () => {
      if (state.receiptLookupFails) throw new Error("receipt unavailable");
      if (!state.receipt) throw new Error("not found");
      return state.receipt;
    }),
  },
  walletClient: {
    sendRawTransaction: vi.fn(async (args: { serializedTransaction: Hex }) => {
      state.sequence.push("broadcast");
      if (state.broadcastError) throw state.broadcastError;
      return state.broadcastResult
        ?? (args.serializedTransaction === "0x5678" ? REPLACEMENT_HASH : HASH);
    }),
  },
}));
vi.mock("../src/core/chain/finality.js", () => ({
  finalizedReadBlockNumber: vi.fn(async () => 100n),
  assertCanonicalFinalReceipt: vi.fn(async () => {
    if (state.canonicalFails) throw new Error("not canonical");
  }),
}));
vi.mock("../src/core/chain/signedWrite.js", () => ({
  prepareSignedContractWrite: vi.fn(async (args: { nonce: bigint }) => ({
    hash: HASH,
    intentHash: INTENT,
    serialized: "0x1234",
    nonce: args.nonce,
  })),
  prepareSignedFeeReplacement: vi.fn(async (args: { nonce: bigint }) => {
    if (state.replacementFails) throw state.replacementFails;
    return {
      hash: REPLACEMENT_HASH,
      intentHash: INTENT,
      serialized: "0x5678",
      nonce: args.nonce,
    };
  }),
}));
vi.mock("../src/core/chain/encryption.js", () => ({
  encryptString: vi.fn((value: string) => value),
  decryptString: vi.fn((value: string) => value),
}));
vi.mock("../src/core/chain/signerLease.js", () => ({
  withProviderSignerLease: vi.fn(async (_scope, work: () => Promise<unknown>) =>
    work()),
}));
vi.mock("../src/core/db/queryable.js", () => ({
  inTransaction: vi.fn(async (_pool, work: (db: object) => Promise<unknown>) =>
    work({})),
}));
vi.mock("../src/core/db/pool.js", () => ({ pool: {} }));

const queryApi = vi.hoisted(() => ({
  suggested: vi.fn(async () => state.suggestedNonce),
  advance: vi.fn(async () => {
    state.sequence.push("cursor");
  }),
  insert: vi.fn(async (args: Record<string, unknown>) => {
    state.sequence.push("persist");
    state.inserted.push(args);
    const id = String(args.id);
    state.rows.set(id, writeRow({
      id,
      nonce: String(args.nonce),
      purpose: args.purpose as ProviderChainWriteRow["purpose"],
      target_type: String(args.target_type),
      target_id: String(args.target_id),
      intent_hash: args.intent_hash as Hex,
      transaction_hash: args.transaction_hash as Hex,
      signed_tx_encrypted: String(args.signed_tx_encrypted),
      supersedes_write_id: (args.supersedesWriteId as string | undefined) ?? null,
      fee_bump_count: Number(args.feeBumpCount ?? 0),
    }));
  }),
  update: vi.fn(async (
    id: string,
    status: ProviderChainWriteRow["status"],
    details?: Record<string, unknown>,
  ) => {
    state.updates.push({ id, status, details });
    const row = state.rows.get(id);
    if (row) {
      row.status = status;
      row.last_error_code = (details?.errorCode as string | undefined) ?? null;
      row.replacement_write_id =
        (details?.replacementWriteId as string | undefined) ?? row.replacement_write_id;
    }
  }),
  rebind: vi.fn(async () => state.rebinds),
  resent: vi.fn(async (id: string) => {
    state.updates.push({ id, status: "resent" });
    const row = state.rows.get(id);
    if (!row || !["prepared", "broadcast"].includes(row.status)) return false;
    row.status = "broadcast";
    row.last_error_code = null;
    return true;
  }),
}));
vi.mock("../src/core/db/queries/providerChainWrites.js", () => ({
  suggestedProviderNonce: queryApi.suggested,
  advanceProviderCursor: queryApi.advance,
  insertProviderWrite: queryApi.insert,
  updateProviderWriteStatus: queryApi.update,
  markProviderWriteResent: queryApi.resent,
  rebindReplacementProviderWrite: queryApi.rebind,
  getBlockingProviderNonceGap: vi.fn(async () => state.gap),
  getProviderWrite: vi.fn(async (id: string) => state.rows.get(id) ?? null),
  hasUnresolvedProviderWrites: vi.fn(async () => state.unresolved),
}));
vi.mock("../src/core/engine/escalation.js", () => ({
  createHumanEscalation: vi.fn(async (args: Record<string, unknown>) => {
    state.reviews.push(args);
    return {};
  }),
}));
vi.mock("../src/core/db/queries/escalations.js", () => ({
  closeOpenReviewsForTarget: vi.fn(async (args: Record<string, unknown>) => {
    state.closedReviews.push(args);
  }),
}));
vi.mock("../src/core/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import {
  confirmProviderWrite,
  loadProviderWrite,
  prepareAndBroadcastProviderWrite,
  rebroadcastProviderWrite,
  reconcileProviderNonceGap,
  replaceProviderWrite,
  replaceProviderWriteWithBoundedFee,
  revertProviderWrite,
} from "../src/core/chain/providerWriteCoordinator.js";

function writeRow(
  patch: Partial<ProviderChainWriteRow> = {},
): ProviderChainWriteRow {
  return {
    id: "write-1",
    chain_id: "84532",
    wallet_address: "0x1111111111111111111111111111111111111111",
    nonce: "7",
    purpose: "standard_reputation_outcome",
    target_type: "test",
    target_id: "target-1",
    intent_hash: INTENT,
    transaction_hash: HASH,
    signed_tx_encrypted: "0x1234",
    status: "broadcast",
    supersedes_write_id: null,
    replacement_write_id: null,
    fee_bump_count: 0,
    broadcast_at: new Date(),
    confirmed_at: null,
    signed_tx_purged_at: null,
    last_error_code: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date(0),
    ...patch,
  };
}

function gap(
  patch: Partial<ProviderChainWriteRow & { queued_behind: number }> = {},
): ProviderChainWriteRow & { queued_behind: number } {
  return { ...writeRow(), queued_behind: 2, ...patch };
}

function prepare(persist = vi.fn(async () => true)) {
  return prepareAndBroadcastProviderWrite({
    purpose: "standard_reputation_outcome",
    target: { type: "test", id: "target-1" },
    address: "0x2222222222222222222222222222222222222222",
    abi: [],
    functionName: "write",
    callArgs: [],
    preflight: vi.fn(async () => undefined),
    persist,
  });
}

beforeEach(() => {
  state.rows.clear();
  state.gap = null;
  state.finalizedNonce = 4;
  state.pendingNonce = 6;
  state.suggestedNonce = 7n;
  state.receipt = null;
  state.receiptLookupFails = false;
  state.canonicalFails = false;
  state.replacementFails = null;
  state.rebinds = true;
  state.broadcastResult = null;
  state.broadcastError = null;
  state.updates.length = 0;
  state.inserted.length = 0;
  state.reviews.length = 0;
  state.closedReviews.length = 0;
  state.sequence.length = 0;
  vi.clearAllMocks();
});

describe("provider write preparation and broadcast", () => {
  it("persists signed bytes and domain state before broadcasting", async () => {
    await expect(prepare()).resolves.toMatchObject({
      hash: HASH,
      intentHash: INTENT,
      nonce: 7n,
    });
    expect(state.sequence).toEqual(["persist", "cursor", "broadcast"]);
    expect(queryApi.suggested).toHaveBeenCalledWith(
      expect.anything(),
      6n,
      4n,
    );
    expect(state.updates.at(-1)?.status).toBe("broadcast");
  });

  it("fails before broadcast when domain persistence loses its claim", async () => {
    await expect(prepare(vi.fn(async () => false)))
      .rejects.toThrow("domain-state persistence claim");
    expect(state.sequence).not.toContain("broadcast");
  });

  it.each([
    ["replacement transaction underpriced", "replacement_underpriced"],
    ["nonce too low", "nonce_too_low"],
    ["already known transaction", "already_known"],
    ["insufficient funds", "insufficient_funds"],
    ["max fee below base fee", "fee_rejected"],
    ["rpc timed out", "rpc_timeout"],
    ["connection refused", "broadcast_rejected"],
  ])("parks durable bytes after broadcast error: %s", async (message, code) => {
    state.broadcastError = new Error(message);
    await expect(prepare()).rejects.toThrow(message);
    expect(state.sequence.slice(0, 2)).toEqual(["persist", "cursor"]);
    expect(state.updates.at(-1)).toMatchObject({
      status: "prepared",
      details: { errorCode: code },
    });
  });

  it("rejects a hash that differs from persisted signed bytes", async () => {
    state.broadcastResult = REPLACEMENT_HASH;
    await expect(prepare()).rejects.toThrow("hash did not match");
    expect(state.updates.at(-1)?.status).toBe("prepared");
  });

  it("blocks new writes while a nonce gap is being recovered", async () => {
    state.gap = gap({ purpose: "service_registration" });
    await expect(prepare()).rejects.toThrow("fee-replaced; confirmation is pending");

    state.gap = gap({ purpose: "standard_reputation_outcome", updated_at: new Date() });
    await expect(prepare()).rejects.toThrow("blocks new provider-wallet writes");
  });
});

describe("provider write recovery and terminal helpers", () => {
  it("spends no chain read on an idle wallet whose durable writes are all resolved", async () => {
    state.unresolved = false;
    state.gap = gap();
    state.nonceReads = 0;
    try {
      await expect(reconcileProviderNonceGap()).resolves.toBe("clear");
      expect(state.updates).toEqual([]);
      expect(state.nonceReads).toBe(0);
    } finally {
      state.unresolved = true;
    }
  });

  it("reports clear state and reconciles canonical success or revert", async () => {
    await expect(reconcileProviderNonceGap()).resolves.toBe("clear");

    state.gap = gap();
    state.receipt = { status: "success" };
    await expect(reconcileProviderNonceGap()).resolves.toBe("attention");
    expect(state.updates.at(-1)?.status).toBe("confirmed");

    state.receipt = { status: "reverted" };
    await reconcileProviderNonceGap();
    expect(state.updates.at(-1)).toMatchObject({
      status: "reverted",
      details: { errorCode: "canonical_receipt_reverted" },
    });
  });

  it("waits when a receipt cannot yet be proven canonical", async () => {
    state.gap = gap();
    state.receipt = { status: "success" };
    state.canonicalFails = true;
    await expect(reconcileProviderNonceGap()).resolves.toBe("attention");
    expect(state.updates).toHaveLength(0);
  });

  it("creates human reviews when automatic replacement cannot proceed", async () => {
    state.gap = gap({ purpose: "service_registration", fee_bump_count: 3 });
    await reconcileProviderNonceGap();
    expect(state.reviews).toHaveLength(1);

    state.reviews.length = 0;
    state.gap = gap({ purpose: "service_registration", signed_tx_encrypted: null });
    await reconcileProviderNonceGap();
    expect(state.reviews).toHaveLength(1);
  });

  it("reviews exhausted, unavailable, and rejected replacement paths", async () => {
    state.gap = gap({ fee_bump_count: 3 });
    await reconcileProviderNonceGap();
    expect(state.reviews).toHaveLength(1);

    state.gap = gap({ signed_tx_encrypted: null });
    await reconcileProviderNonceGap();
    expect(state.reviews).toHaveLength(2);

    state.gap = gap();
    state.replacementFails = new Error("fee ceiling reached");
    await reconcileProviderNonceGap();
    expect(state.reviews).toHaveLength(3);
  });

  it("persists and broadcasts a same-nonce replacement", async () => {
    state.gap = gap();
    await expect(reconcileProviderNonceGap()).resolves.toBe("replacement_broadcast");
    expect(state.inserted.at(-1)).toMatchObject({
      nonce: 7n,
      supersedesWriteId: "write-1",
      feeBumpCount: 1,
    });
    expect(queryApi.rebind).toHaveBeenCalledOnce();
    expect(state.updates.at(-1)?.status).toBe("broadcast");
  });

  it("keeps a persisted replacement recoverable after broadcast failure", async () => {
    state.gap = gap();
    state.broadcastError = new Error("timeout");
    await expect(reconcileProviderNonceGap()).resolves.toBe("replacement_broadcast");
    expect(state.updates.at(-1)).toMatchObject({
      status: "prepared",
      details: { errorCode: "rpc_timeout" },
    });
  });

  it("rolls back replacement when its domain binding is lost", async () => {
    state.gap = gap();
    state.rebinds = false;
    await expect(reconcileProviderNonceGap())
      .rejects.toThrow("lost its domain binding");
  });

  it("enforces human replacement eligibility and outcome", async () => {
    state.rows.set("write-1", writeRow({ status: "confirmed" }));
    await expect(replaceProviderWriteWithBoundedFee("write-1"))
      .rejects.toThrow("no longer eligible");

    state.rows.set("write-1", writeRow({ status: "attention" }));
    state.receipt = { status: "success" };
    await expect(replaceProviderWriteWithBoundedFee("write-1"))
      .rejects.toThrow("no longer requires");

    state.receipt = null;
    state.rows.set("write-1", writeRow({ status: "attention" }));
    await expect(replaceProviderWriteWithBoundedFee("write-1"))
      .resolves.toMatchObject({ hash: REPLACEMENT_HASH });
  });

  it("never reopens a write that was replaced or settled while its bytes were resent", async () => {
    state.rows.set("write-1", writeRow({ status: "replaced" }));
    await expect(rebroadcastProviderWrite("write-1")).resolves.toBe(HASH);
    expect(state.rows.get("write-1")!.status).toBe("replaced");

    state.rows.set("write-1", writeRow({ status: "prepared" }));
    await expect(rebroadcastProviderWrite("write-1")).resolves.toBe(HASH);
    expect(state.rows.get("write-1")!.status).toBe("broadcast");
  });

  it("rebroadcasts retained bytes and rejects missing or mismatched records", async () => {
    await expect(rebroadcastProviderWrite("missing"))
      .rejects.toThrow("no retained signed transaction");
    state.rows.set("write-1", writeRow());
    await expect(rebroadcastProviderWrite("write-1")).resolves.toBe(HASH);
    state.broadcastResult = REPLACEMENT_HASH;
    await expect(rebroadcastProviderWrite("write-1"))
      .rejects.toThrow("Rebroadcast hash did not match");
  });

  it("updates confirmation, revert, replacement, and load state idempotently", async () => {
    await confirmProviderWrite(null);
    await revertProviderWrite(undefined, "ignored");
    await replaceProviderWrite(null, null, "ignored");
    await expect(loadProviderWrite(undefined)).resolves.toBeNull();

    state.rows.set("replacement", writeRow({
      id: "replacement",
      supersedes_write_id: "write-1",
    }));
    await confirmProviderWrite("replacement");
    expect(state.closedReviews).toHaveLength(1);
    await revertProviderWrite("replacement", "reverted");
    await replaceProviderWrite("replacement", "next", "replaced");
    await expect(loadProviderWrite("replacement")).resolves.toMatchObject({
      id: "replacement",
    });
  });
});
