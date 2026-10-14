// Deadline for one service-registration reconcile cycle.
//
// The chain reads, the signer lease, and the local writes of a cycle share
// one budget, so a hung read or lease frees the reconciler's in-flight slot
// before the next tick fires (a hung cycle otherwise freezes readiness for
// good). A transaction the cycle broadcast is different: its receipt wait is
// bounded on its own, and abandoning the cycle while the receipt is pending
// registers the service in a detached continuation after the caller already
// failed, which made a first boot with several first-time registrations fail
// against the fixed deadline. The clock therefore pauses while a broadcast is
// awaited, so the cycle's wall-clock bound is the budget plus one bounded
// receipt wait per transaction it broadcast.

export class RegistrationCycleBudget {
  /** Rejects when the budget is spent; never settles otherwise. */
  readonly expired: Promise<never>;
  private reject!: (error: Error) => void;
  private timer: NodeJS.Timeout | null = null;
  private remainingMs: number;
  private armedAt = 0;
  private suspensions = 0;
  private settled = false;

  constructor(
    private readonly totalMs: number,
    private readonly onExpire: () => void,
  ) {
    this.remainingMs = totalMs;
    this.expired = new Promise<never>((_, reject) => {
      this.reject = reject;
    });
    // The race is the consumer; never surface an unobserved rejection.
    this.expired.catch(() => undefined);
    this.arm();
  }

  /** Run a receipt wait with the clock paused; it resumes when the wait settles. */
  async awaitBroadcast<T>(wait: () => Promise<T>): Promise<T> {
    if (this.suspensions++ === 0) this.pause();
    try {
      return await wait();
    } finally {
      if (--this.suspensions === 0) this.arm();
    }
  }

  /** The cycle finished: nothing more can expire. */
  cancel(): void {
    this.settled = true;
    this.clear();
  }

  private arm(): void {
    if (this.settled) return;
    this.armedAt = Date.now();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.settled = true;
      this.onExpire();
      this.reject(new Error(
        `service registration reconcile exceeded ${this.totalMs}ms of chain reads and `
        + "signer work; a chain read/write or the signer lease is not completing",
      ));
    }, this.remainingMs);
    this.timer.unref();
  }

  private pause(): void {
    if (!this.timer) return;
    this.clear();
    this.remainingMs = Math.max(0, this.remainingMs - (Date.now() - this.armedAt));
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
