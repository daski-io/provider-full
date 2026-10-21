import { loadLogsPaged } from "./chainLogPagination.js";
import { selectPreviousRelease, type ReleasedLog } from "./evidencePosition.js";

/** Chain reads that bound one release's accounting interval, all from one evidence source. */
export interface ReleaseIntervalReads<C, P extends ReleasedLog> {
  /** The splitter's token balance and release sequence at the end of `blockNumber`. */
  checkpoint(blockNumber: bigint): Promise<{ tokenBalance: bigint; releaseSequence: bigint }>;
  /** The splitter's Released events carrying `releaseSequence` from `fromBlock` to `toBlock`. */
  releases(releaseSequence: bigint, fromBlock: bigint, toBlock: bigint): Promise<readonly P[]>;
  /** Canonical-token transfers to the splitter from `fromBlock` to `toBlock`. */
  credits(fromBlock: bigint, toBlock: bigint): Promise<readonly C[]>;
}

export interface ReleaseInterval<C, P> {
  /** The splitter's balance where the interval's credits begin. */
  initialBalance: bigint;
  /** The release the interval starts strictly after, or null when it starts at a checkpoint. */
  previousRelease: P | null;
  /** Every credit from the interval's first block through the release block. */
  credits: C[];
}

/**
 * The accounting interval of release N, read from the end of the block before
 * the deposit. Scanning from the activation or release N - 1 grew with the
 * listing's age and the time since its previous order, one 10,000-block log
 * window at a time (about 90 sequential windows three weeks after activation
 * on a two-second chain); this costs the windows from the deposit to its
 * release.
 *
 * The splitter's verified code pays out its whole balance on each release,
 * moves the token at no other time and numbers releases one by one. A
 * sequence of N - 1 at the checkpoint therefore means no release came between
 * it and release N: its balance is the signed starting balance, or zero, plus
 * every credit since the activation or release N - 1, and the interval goes on
 * from the deposit block. A lower sequence puts release N - 1 in the deposit
 * block or later, where it is required exactly, and accounting starts at zero
 * strictly after it. Any other sequence is refused.
 */
export async function loadReleaseInterval<C, P extends ReleasedLog, R extends ReleasedLog>(args: {
  release: R;
  releaseSequence: bigint;
  startingReleaseSequence: bigint;
  depositBlock: bigint;
  releaseBlock: bigint;
  maximumPageEvents: number;
  reads: ReleaseIntervalReads<C, P>;
}): Promise<ReleaseInterval<C, P>> {
  const previousSequence = args.releaseSequence - 1n;
  const checkpoint = await args.reads.checkpoint(args.depositBlock - 1n);
  if (
    checkpoint.releaseSequence < args.startingReleaseSequence ||
    checkpoint.releaseSequence > previousSequence
  ) throw new Error("Release sequence checkpoint does not precede the release");
  const creditsFrom = (fromBlock: bigint) => loadLogsPaged({
    fromBlock,
    toBlock: args.releaseBlock,
    maximumPageEvents: args.maximumPageEvents,
    load: args.reads.credits,
  });
  if (checkpoint.releaseSequence === previousSequence) {
    return {
      initialBalance: checkpoint.tokenBalance,
      previousRelease: null,
      credits: await creditsFrom(args.depositBlock),
    };
  }
  const previousRelease = selectPreviousRelease(
    await loadLogsPaged({
      fromBlock: args.depositBlock,
      toBlock: args.releaseBlock,
      maximumPageEvents: args.maximumPageEvents,
      load: (fromBlock, toBlock) => args.reads.releases(previousSequence, fromBlock, toBlock),
    }),
    args.release,
    previousSequence,
  );
  return {
    initialBalance: 0n,
    previousRelease,
    credits: await creditsFrom(previousRelease.blockNumber!),
  };
}
