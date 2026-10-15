/** Bounded process-local telemetry state. Never use for business admission or audit. */
export class ConditionTracker {
  private readonly states = new Map<string, string>();
  constructor(private readonly capacity = 1_000) {}

  /** The state last recorded for `key`, if any. */
  get(key: string): string | undefined {
    return this.states.get(key);
  }

  /** Record `state` for `key`; true when it differs from the state recorded before. */
  changed(key: string, state: string): boolean {
    if (this.states.get(key) === state) return false;
    if (!this.states.has(key) && this.states.size >= this.capacity) {
      this.states.delete(this.states.keys().next().value!);
    }
    this.states.set(key, state);
    return true;
  }

  clear(key: string): boolean { return this.states.delete(key); }
}
