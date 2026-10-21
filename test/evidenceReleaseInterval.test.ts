import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress, keccak256, padHex, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { canonicalHash, recipeNonce } from "../src/core/standardRail/canonical.js";
import type { ProviderStandardRailConfig } from "../src/core/standardRail/config.js";
import { ProviderEvidenceVerifier } from "../src/core/standardRail/evidence.js";
import type {
  ProviderOutcomeConfig,
  QuoteV1,
  SignedEnvelope,
  StandardEvidenceBundleV2,
  StandardRailDispatchV2,
} from "../src/core/standardRail/types.js";
import { fixtureConfig, fixtureOutcome, hash } from "./standardRailFixture.js";

const h = vi.hoisted(() => ({
  getBlockNumber: vi.fn(), getBlock: vi.fn(), getCode: vi.fn(), getStorageAt: vi.fn(), receipt: vi.fn(),
  readContract: vi.fn(), getLogs: vi.fn(), parsedLogs: vi.fn(), coverage: vi.fn(),
}));
vi.mock("../src/core/standardRail/releaseCoverage.js", () => ({ verifyReleaseCoverage: h.coverage }));
vi.mock("viem", async (original) => ({
  ...await original<typeof import("viem")>(),
  createPublicClient: () => ({
    getBlockNumber: h.getBlockNumber, getBlock: h.getBlock, getCode: h.getCode, getStorageAt: h.getStorageAt,
    getTransactionReceipt: h.receipt, readContract: h.readContract, getLogs: h.getLogs,
  }),
  parseEventLogs: h.parsedLogs,
}));

const runtime = "0x6000" as Hex;
const outcome: ProviderOutcomeConfig = fixtureOutcome({
  outcomeId: "fixed-skill", pricingMode: "fixed", bindingProfile: "recipe-bound-v1",
  splitterRuntimeCodeHash: keccak256(runtime),
});
// Today's oracle, EAS and canonical-token code, proved before each dispatch.
const config: ProviderStandardRailConfig = {
  ...fixtureConfig([outcome]),
  globalPolicy: {
    sanctionsOracleRuntimeCodeHash: keccak256(runtime),
    chainEvidencePolicy: { payload: {
      canonicalToken: outcome.token,
      canonicalTokenRuntimeCodeHash: outcome.tokenRuntimeCodeHash,
      tokenImplementationAddress: outcome.tokenImplementationAddress,
      tokenImplementationRuntimeCodeHash: outcome.tokenImplementationRuntimeCodeHash,
      tokenImplementationSlot: outcome.tokenImplementationSlot,
      tokenDomainSeparator: outcome.tokenDomainSeparator,
    } },
  } as unknown as ProviderStandardRailConfig["globalPolicy"],
};
// A deposit three weeks of two-second blocks after the listing's activation,
// paid out 300 blocks later.
const DEPOSIT_BLOCK = BigInt(outcome.splitterActivationBlockNumber) + 907_200n;
const RELEASE_BLOCK = DEPOSIT_BLOCK + 300n;
const DEPOSIT_TIME = 1_790_000_000;
const payer = "0x3333333333333333333333333333333333333333" as Address;
const depositEvidence = { kind: "deposit" };
const releaseEvidence = { kind: "release" };
const quote: SignedEnvelope<QuoteV1> = {
  artifactType: "QuoteV1", schemaVersion: 1, environment: "testnet", chainId: 84532,
  audience: "https://gateway.example", signerKeyId: "gateway", signature: "0x",
  issuedAt: DEPOSIT_TIME - 60, validBefore: DEPOSIT_TIME + 120,
  payload: {
    listingManifestHash: outcome.listingManifestHash, providerOfferHash: outcome.providerOfferHash,
    providerQuoteHash: hash("9"), canonicalRequestHash: hash("5"), grossAmount: outcome.fixedGrossAmount,
    token: outcome.token, splitter: outcome.splitter, orderNonce: hash("6"),
    issuedAt: DEPOSIT_TIME - 60, validBefore: DEPOSIT_TIME + 120,
  },
};

function dispatchFor(releaseSequence: bigint): StandardRailDispatchV2 {
  return {
    environment: "testnet", chainId: 84532, gatewayAudience: "https://gateway.example",
    providerAudience: "https://provider.example", providerControlProfileHash: outcome.providerControlProfileHash,
    orderId: "ord_11111111-1111-4111-8111-111111111111", orderKey: hash("1"), serviceId: outcome.serviceId,
    reputationEligible: false, reputationContract: "0x4545454545454545454545454545454545454545",
    outcomeSchemaUid: hash("2"), dispatchNonce: hash("3"), payer,
    listingManifestHash: outcome.listingManifestHash, providerOfferHash: outcome.providerOfferHash,
    quoteHash: canonicalHash(quote), bindingProfile: "recipe-bound-v1", canonicalRequestHash: hash("5"),
    orderNonce: hash("6"), buyerIdentityProofHash: hash("0"), activeRailProfileHash: outcome.activeRailProfileHash,
    facilitatorConfirmationHash: hash("7"),
    settlementTxHash: hash("a"), depositBlockNumber: DEPOSIT_BLOCK.toString(), depositBlockHash: hash("b"),
    depositTransactionIndex: 3, depositLogIndex: 6, depositEvidenceHash: canonicalHash(depositEvidence),
    releaseTxHash: hash("c"), releaseBlockNumber: RELEASE_BLOCK.toString(), releaseBlockHash: hash("d"),
    releaseTransactionIndex: 1, releaseLogIndex: 4, releaseSequence: releaseSequence.toString(),
    releaseEvidenceHash: canonicalHash(releaseEvidence),
    grossAmount: outcome.fixedGrossAmount, providerNetAmount: "237500", daskiCommissionAmount: "12500",
    canonicalProviderRequestHash: hash("5"), dispatchDeadlineSeconds: 300,
    issuedAt: DEPOSIT_TIME + 600, validBefore: DEPOSIT_TIME + 900,
  };
}

function bundleFor(dispatch: StandardRailDispatchV2): StandardEvidenceBundleV2 {
  return {
    deposit: {
      transactionHash: dispatch.settlementTxHash, blockNumber: dispatch.depositBlockNumber,
      blockHash: dispatch.depositBlockHash, transactionIndex: dispatch.depositTransactionIndex,
      logIndex: dispatch.depositLogIndex, evidenceHash: dispatch.depositEvidenceHash,
      canonicalEvidence: depositEvidence, sources: [],
    },
    release: {
      transactionHash: dispatch.releaseTxHash, blockNumber: dispatch.releaseBlockNumber,
      blockHash: dispatch.releaseBlockHash, transactionIndex: dispatch.releaseTransactionIndex,
      logIndex: dispatch.releaseLogIndex, releaseSequence: dispatch.releaseSequence,
      evidenceHash: dispatch.releaseEvidenceHash, canonicalEvidence: releaseEvidence, sources: [],
    },
  };
}

/**
 * A chain on which the dispatch's deposit and release are final, the token
 * and splitter code is unchanged, and the splitter had `checkpoint` at the end
 * of the block before the deposit. Released-event searches find `previous`.
 */
function chain(dispatch: StandardRailDispatchV2, checkpoint: { balance: bigint; releaseSequence: bigint },
  previous: unknown[] = []) {
  h.getBlockNumber.mockResolvedValue(RELEASE_BLOCK + 10n);
  h.getBlock.mockResolvedValue({ hash: dispatch.depositBlockHash, timestamp: BigInt(DEPOSIT_TIME) });
  h.getCode.mockResolvedValue(runtime);
  h.getStorageAt.mockResolvedValue(padHex(outcome.tokenImplementationAddress, { size: 32 }));
  h.receipt.mockImplementation(async ({ hash: transactionHash }: { hash: Hex }) => {
    const deposit = transactionHash === dispatch.settlementTxHash;
    return {
      status: "success", transactionHash,
      blockNumber: deposit ? DEPOSIT_BLOCK : RELEASE_BLOCK,
      blockHash: deposit ? dispatch.depositBlockHash : dispatch.releaseBlockHash,
      transactionIndex: deposit ? dispatch.depositTransactionIndex : dispatch.releaseTransactionIndex,
      logs: [deposit ? "deposit" : "release"],
    };
  });
  h.readContract.mockImplementation(async ({ functionName }: { functionName: string }) =>
    functionName === "balanceOf" ? checkpoint.balance
      : functionName === "releaseSequence" ? checkpoint.releaseSequence
        : outcome.tokenDomainSeparator);
  h.parsedLogs.mockImplementation(({ eventName, logs }: { eventName: string; logs: string[] }) => {
    if (eventName === "AuthorizationUsed") return [{
      address: outcome.token, logIndex: dispatch.depositLogIndex - 1,
      args: { authorizer: payer, nonce: recipeNonce({
        chainId: dispatch.chainId, canonicalToken: outcome.token, payer, splitter: outcome.splitter,
        grossAmount: BigInt(dispatch.grossAmount), listingManifestHash: dispatch.listingManifestHash,
        providerOfferHash: dispatch.providerOfferHash, quoteHash: dispatch.quoteHash,
        canonicalRequestHash: dispatch.canonicalRequestHash, orderNonce: dispatch.orderNonce,
      }) },
    }];
    if (eventName === "Released") return [{
      address: outcome.splitter, blockNumber: RELEASE_BLOCK, transactionIndex: dispatch.releaseTransactionIndex,
      logIndex: dispatch.releaseLogIndex, args: { releaseSequence: BigInt(dispatch.releaseSequence) },
    }];
    if (logs[0] === "deposit") return [{
      address: outcome.token, blockNumber: DEPOSIT_BLOCK, transactionIndex: dispatch.depositTransactionIndex,
      logIndex: dispatch.depositLogIndex, args: { from: payer, to: outcome.splitter, value: BigInt(dispatch.grossAmount) },
    }];
    return [];
  });
  h.getLogs.mockImplementation(async ({ event }: { event: { name: string } }) =>
    event.name === "Released" ? previous : []);
}

const verify = (dispatch: StandardRailDispatchV2) => new ProviderEvidenceVerifier(config, baseSepolia)
  .verify({ dispatch, quote, outcome, bundle: bundleFor(dispatch) });
const creditScan = expect.objectContaining({
  address: getAddress(outcome.token), args: { to: getAddress(outcome.splitter) },
  fromBlock: DEPOSIT_BLOCK, toBlock: RELEASE_BLOCK,
});

beforeEach(() => {
  for (const mock of Object.values(h)) mock.mockReset();
});
afterEach(() => { vi.useRealTimers(); });

describe("paid-dispatch evidence payout interval", () => {
  it("reads the payout interval from the end of the block before the deposit, not from activation", async () => {
    const dispatch = dispatchFor(1n);
    chain(dispatch, { balance: 11n, releaseSequence: 0n });
    await expect(verify(dispatch)).resolves.toMatchObject({ authorizationKey: expect.stringMatching(/^0x/) });
    expect(h.readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: getAddress(outcome.token), functionName: "balanceOf", args: [getAddress(outcome.splitter)],
      blockNumber: DEPOSIT_BLOCK - 1n,
    }));
    expect(h.readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: getAddress(outcome.splitter), functionName: "releaseSequence", blockNumber: DEPOSIT_BLOCK - 1n,
    }));
    expect(h.getLogs).toHaveBeenCalledOnce();
    expect(h.getLogs).toHaveBeenCalledWith(creditScan);
    expect(h.coverage).toHaveBeenCalledWith(expect.objectContaining({ initialBalance: 11n, previousRelease: null }));
  });

  it("requires release N - 1 from the deposit block when it was paid out in that block", async () => {
    const dispatch = dispatchFor(3n);
    const previous = {
      address: outcome.splitter, blockNumber: DEPOSIT_BLOCK, transactionIndex: 1, logIndex: 2,
      args: { releaseSequence: 2n },
    };
    chain(dispatch, { balance: 0n, releaseSequence: 1n }, [previous]);
    await expect(verify(dispatch)).resolves.toMatchObject({ authorizationKey: expect.stringMatching(/^0x/) });
    expect(h.getLogs).toHaveBeenCalledTimes(2);
    expect(h.getLogs).toHaveBeenNthCalledWith(1, expect.objectContaining({
      address: getAddress(outcome.splitter), args: { releaseSequence: 2n },
      fromBlock: DEPOSIT_BLOCK, toBlock: RELEASE_BLOCK,
    }));
    expect(h.getLogs).toHaveBeenNthCalledWith(2, creditScan);
    expect(h.coverage).toHaveBeenCalledWith(expect.objectContaining({ initialBalance: 0n, previousRelease: previous }));
  });

  it("refuses a payout that the checkpoint shows was made before the deposit", async () => {
    vi.useFakeTimers();
    const dispatch = dispatchFor(1n);
    chain(dispatch, { balance: 0n, releaseSequence: 1n });
    const rejected = expect(verify(dispatch)).rejects.toThrow("RPC observation failed");
    await vi.advanceTimersByTimeAsync(6_001);
    await rejected;
    expect(h.readContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: "releaseSequence", blockNumber: DEPOSIT_BLOCK - 1n,
    }));
    expect(h.getLogs).not.toHaveBeenCalled();
    expect(h.coverage).not.toHaveBeenCalled();
  });
});
