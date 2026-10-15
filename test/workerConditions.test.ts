import { describe, expect, it } from "vitest";
import { ConditionTracker } from "../src/core/observability/conditionTracker.js";
import { workerCycleFailed, workerCycleSucceeded } from "../src/core/observability/workerConditions.js";

// C05: log meaningful state transitions rather than every unchanged poll.
describe("condition transitions", () => {
  it("reports a state only when it changes, within a bounded capacity", () => {
    const tracker = new ConditionTracker(2);
    expect(tracker.changed("a", "down")).toBe(true);
    expect(tracker.changed("a", "down")).toBe(false);
    expect(tracker.changed("a", "up")).toBe(true);
    tracker.changed("b", "x");
    tracker.changed("c", "y");
    // The oldest key made room for the newest; it reads as new again.
    expect(tracker.get("a")).toBeUndefined();
    expect(tracker.changed("a", "up")).toBe(true);
    expect(tracker.clear("a")).toBe(true);
  });

  it("logs a worker's failure on a change of failure class and its recovery once", () => {
    const worker = `worker-${Math.random()}`;
    expect(workerCycleSucceeded(worker)).toBe(false);
    expect(workerCycleFailed(worker, new TypeError("down"))).toBe(true);
    expect(workerCycleFailed(worker, new TypeError("still down"))).toBe(false);
    expect(workerCycleFailed(worker, new RangeError("differently down"))).toBe(true);
    expect(workerCycleSucceeded(worker)).toBe(true);
    expect(workerCycleSucceeded(worker)).toBe(false);
  });
});
