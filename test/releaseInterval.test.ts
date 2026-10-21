import { describe, expect, it } from "vitest";
import { pad, toHex, type Address, type Hex } from "viem";
import { verifyReleaseCoverage } from "../src/core/standardRail/releaseCoverage.js";
import { loadReleaseInterval } from "../src/core/standardRail/releaseInterval.js";

const token = "0x1111111111111111111111111111111111111111" as Address;
const splitter = "0x2222222222222222222222222222222222222222" as Address;
const payer = "0x3333333333333333333333333333333333333333" as Address;
const payee = "0x4444444444444444444444444444444444444444" as Address;
const receiver = "0x5555555555555555555555555555555555555555" as Address;
const hash = (byte: string) => `0x${byte.repeat(64)}` as Hex;
const txHash = (block: bigint, tx: number) => pad(toHex(block * 1_000n + BigInt(tx)), { size: 32 });
const policy = {
  token, splitter, providerPayee: payee, daskiCommissionReceiver: receiver, commissionBps: 500,
  outcomeIdHash: hash("1"), listingEpoch: 7n, policyVersionHash: hash("2"), listingCommitmentHash: hash("3"),
};
// A listing whose first payout comes three weeks of two-second blocks
// (907,226) after its activation.
const ACTIVATION = 30_000_000n;
const STARTING_SEQUENCE = 0n;
const STARTING_BALANCE = 7n;

interface Transfer {
  address: Address; blockNumber: bigint; transactionIndex: number; logIndex: number; transactionHash: Hex;
  args: { from: Address; to: Address; value: bigint };
}
interface Release {
  address: Address; blockNumber: bigint; transactionIndex: number; logIndex: number; transactionHash: Hex;
  args: {
    outcomeIdHash: Hex; listingEpoch: bigint; releaseSequence: bigint; policyVersionHash: Hex;
    listingCommitmentHash: Hex; grossAmount: bigint; providerNetAmount: bigint; daskiCommissionAmount: bigint;
  };
}
interface Interval { initialBalance: bigint; previousRelease: Release | null; credits: Transfer[] }
type Step = [offset: bigint, transactionIndex: number, logIndex: number, credit: bigint | "release"];

/** A splitter that behaves as its verified code does: each release pays out its whole balance. */
function splitterHistory(steps: Step[]) {
  const credits: Transfer[] = [];
  const payouts: Transfer[] = [];
  const releases: Release[] = [];
  const states: Array<{ blockNumber: bigint; tokenBalance: bigint; releaseSequence: bigint }> = [];
  let tokenBalance = STARTING_BALANCE;
  let releaseSequence = STARTING_SEQUENCE;
  for (const [offset, transactionIndex, logIndex, step] of steps) {
    const blockNumber = ACTIVATION + offset;
    const at = { blockNumber, transactionIndex, transactionHash: txHash(blockNumber, transactionIndex) };
    if (step === "release") {
      const commission = tokenBalance * 500n / 10_000n;
      payouts.push(
        { ...at, address: token, logIndex: logIndex - 2, args: { from: splitter, to: payee, value: tokenBalance - commission } },
        { ...at, address: token, logIndex: logIndex - 1, args: { from: splitter, to: receiver, value: commission } },
      );
      releaseSequence += 1n;
      releases.push({ ...at, address: splitter, logIndex, args: {
        outcomeIdHash: policy.outcomeIdHash, listingEpoch: policy.listingEpoch, releaseSequence,
        policyVersionHash: policy.policyVersionHash, listingCommitmentHash: policy.listingCommitmentHash,
        grossAmount: tokenBalance, providerNetAmount: tokenBalance - commission, daskiCommissionAmount: commission,
      } });
      tokenBalance = 0n;
    } else {
      credits.push({ ...at, address: token, logIndex, args: { from: payer, to: splitter, value: step } });
      tokenBalance += step;
    }
    states.push({ blockNumber, tokenBalance, releaseSequence });
  }
  const reads: Array<[string, ...bigint[]]> = [];
  const inRange = (from: bigint, to: bigint) => (log: { blockNumber: bigint }) =>
    log.blockNumber >= from && log.blockNumber <= to;
  return {
    credits,
    releases,
    reads,
    loaders: {
      checkpoint: async (blockNumber: bigint) => {
        reads.push(["checkpoint", blockNumber]);
        const last = states.filter((state) => state.blockNumber <= blockNumber).at(-1);
        return last ?? { tokenBalance: STARTING_BALANCE, releaseSequence: STARTING_SEQUENCE };
      },
      releases: async (sequence: bigint, fromBlock: bigint, toBlock: bigint) => {
        reads.push(["releases", fromBlock, toBlock]);
        return releases.filter(inRange(fromBlock, toBlock)).filter((log) => log.args.releaseSequence === sequence);
      },
      credits: async (fromBlock: bigint, toBlock: bigint) => {
        reads.push(["credits", fromBlock, toBlock]);
        return credits.filter(inRange(fromBlock, toBlock));
      },
    },
    receipt: (release: Release) => [...credits, ...payouts].filter((log) =>
      log.blockNumber === release.blockNumber && log.transactionIndex === release.transactionIndex),
  };
}

// Dust before activation, a donation, another order earlier in a deposit's
// block, two orders paid out 19 blocks apart, a credit after a payout in its
// block, an order three weeks later, a payout in the same block as the next
// deposit, and two payouts in one wrapper transaction.
const history = splitterHistory([
  [400_000n, 0, 1, 13n],
  [907_200n, 1, 1, 17n],
  [907_200n, 3, 1, 250_000_000n],
  [907_226n, 1, 5, "release"],
  [907_226n, 2, 1, 23n],
  [907_240n, 0, 1, 120_000_033n],
  [907_245n, 0, 4, "release"],
  [1_000_000n, 0, 1, 41n],
  [1_900_000n, 2, 1, 1_000_019n],
  [1_900_004n, 0, 3, "release"],
  [1_900_010n, 0, 1, 5_000_000n],
  [1_900_020n, 0, 5, "release"],
  [1_900_020n, 1, 1, 9_999_999n],
  [1_900_022n, 0, 3, "release"],
  [1_950_000n, 2, 1, 3_000_000n],
  [1_950_000n, 2, 4, "release"],
  [1_950_000n, 2, 5, 4_000_001n],
  [1_950_000n, 2, 8, "release"],
]);

function compare(left: Transfer | Release, right: Transfer | Release) {
  if (left.blockNumber !== right.blockNumber) return left.blockNumber < right.blockNumber ? -1 : 1;
  if (left.transactionIndex !== right.transactionIndex) return left.transactionIndex - right.transactionIndex;
  return left.logIndex - right.logIndex;
}
const releaseNo = (sequence: bigint) => history.releases[Number(sequence - 1n)]!;
const creditAt = (offset: bigint, transactionIndex: number, logIndex: number) => history.credits.find((log) =>
  log.blockNumber === ACTIVATION + offset && log.transactionIndex === transactionIndex && log.logIndex === logIndex)!;

/** The interval as the provider read it before: from the activation, or after a full search for release N - 1. */
function fullScan(release: Release): Interval {
  const sequence = release.args.releaseSequence;
  if (sequence === STARTING_SEQUENCE + 1n) {
    return { initialBalance: STARTING_BALANCE, previousRelease: null,
      credits: history.credits.filter((log) => log.blockNumber > ACTIVATION && log.blockNumber <= release.blockNumber) };
  }
  const previous = history.releases.filter((log) => log.args.releaseSequence === sequence - 1n);
  expect(previous).toHaveLength(1);
  return { initialBalance: 0n, previousRelease: previous[0]!,
    credits: history.credits.filter((log) => log.blockNumber >= previous[0]!.blockNumber && log.blockNumber <= release.blockNumber) };
}

const boundedInterval = (release: Release, deposit: Transfer): Promise<Interval> => loadReleaseInterval({
  release, releaseSequence: release.args.releaseSequence, startingReleaseSequence: STARTING_SEQUENCE,
  depositBlock: deposit.blockNumber, releaseBlock: release.blockNumber, maximumPageEvents: 1_000,
  reads: history.loaders,
});

/** Release coverage for one deposit, expecting the order amounts its interval implies. */
function cover(release: Release, deposit: Transfer, interval: Interval) {
  const before = interval.credits.filter((log) =>
    (!interval.previousRelease || compare(log, interval.previousRelease) > 0) && compare(log, deposit) < 0);
  const cumulative = before.reduce((total, log) => total + log.args.value, interval.initialBalance);
  const commission = (cumulative + deposit.args.value) * 500n / 10_000n - cumulative * 500n / 10_000n;
  return verifyReleaseCoverage({
    ...policy, ...interval, release, receiptTransfers: history.receipt(release),
    deposit: { transactionHash: deposit.transactionHash, blockNumber: deposit.blockNumber,
      transactionIndex: deposit.transactionIndex, logIndex: deposit.logIndex, payer, grossAmount: deposit.args.value },
    expectedProviderNetAmount: deposit.args.value - commission, expectedDaskiCommissionAmount: commission,
  });
}

describe("release interval", () => {
  it("accounts every deposit exactly as the full scan from activation or release N - 1 did", async () => {
    for (const deposit of history.credits) {
      const release = history.releases.find((candidate) => compare(candidate, deposit) > 0)!;
      const bounded = cover(release, deposit, await boundedInterval(release, deposit));
      const full = cover(release, deposit, fullScan(release));
      expect({ ...bounded, interval: undefined }).toEqual({ ...full, interval: undefined });
      expect(bounded.intervalGross).toBe(release.args.grossAmount);
    }
  });

  it("reads one window for a first payout three weeks after activation", async () => {
    history.reads.length = 0;
    const deposit = creditAt(907_200n, 3, 1);
    const interval = await boundedInterval(releaseNo(1n), deposit);
    expect(history.reads).toEqual([
      ["checkpoint", deposit.blockNumber - 1n],
      ["credits", deposit.blockNumber, releaseNo(1n).blockNumber],
    ]);
    expect(interval).toMatchObject({ initialBalance: STARTING_BALANCE + 13n, previousRelease: null });
  });

  it("reads one window three weeks after the previous payout, without searching for it", async () => {
    history.reads.length = 0;
    const deposit = creditAt(1_900_000n, 2, 1);
    const interval = await boundedInterval(releaseNo(3n), deposit);
    expect(history.reads).toEqual([
      ["checkpoint", deposit.blockNumber - 1n],
      ["credits", deposit.blockNumber, releaseNo(3n).blockNumber],
    ]);
    expect(interval).toMatchObject({ initialBalance: 41n, previousRelease: null });
  });

  it("requires release N - 1 exactly when it lies in the deposit block", async () => {
    history.reads.length = 0;
    const sameBlock = await boundedInterval(releaseNo(5n), creditAt(1_900_020n, 1, 1));
    expect(sameBlock).toMatchObject({ initialBalance: 0n, previousRelease: releaseNo(4n) });
    expect(history.reads.map(([kind]) => kind)).toEqual(["checkpoint", "releases", "credits"]);
    const wrapper = await boundedInterval(releaseNo(7n), creditAt(1_950_000n, 2, 5));
    expect(wrapper).toMatchObject({ initialBalance: 0n, previousRelease: releaseNo(6n) });
  });

  it("refuses a release that does not cover the deposit", async () => {
    const deposit = creditAt(907_240n, 0, 1);
    await expect(boundedInterval(releaseNo(1n), deposit))
      .rejects.toThrow("Release sequence checkpoint does not precede the release");
    await expect(boundedInterval(releaseNo(3n), deposit).then((interval) => cover(releaseNo(3n), deposit, interval)))
      .rejects.toThrow("Release interval does not contain the exact dispatched deposit");
  });

  it("refuses a missing, duplicated or impossible checkpoint sequence", async () => {
    const deposit = creditAt(1_900_020n, 1, 1);
    const read = (releaseSequence: bigint, found: Release[]) => loadReleaseInterval({
      release: releaseNo(5n), releaseSequence: 5n, startingReleaseSequence: STARTING_SEQUENCE,
      depositBlock: deposit.blockNumber, releaseBlock: releaseNo(5n).blockNumber, maximumPageEvents: 1_000,
      reads: { ...history.loaders, checkpoint: async () => ({ tokenBalance: 0n, releaseSequence }), releases: async () => found },
    });
    await expect(read(3n, [])).rejects.toThrow("Previous release event is missing or ambiguous");
    await expect(read(3n, [releaseNo(4n), releaseNo(4n)])).rejects.toThrow("Previous release event is missing or ambiguous");
    await expect(read(STARTING_SEQUENCE - 1n, [releaseNo(4n)])).rejects.toThrow("does not precede the release");
    await expect(read(5n, [releaseNo(4n)])).rejects.toThrow("does not precede the release");
  });
});
