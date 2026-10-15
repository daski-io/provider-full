import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  verifyReadiness: vi.fn(),
  verifyLiveReadiness: vi.fn(),
  setWorkerStatus: vi.fn(),
  heartbeatWorker: vi.fn(),
  failWorker: vi.fn(),
}));

vi.mock("../src/core/standardRail/evidence.js", () => ({
  ProviderEvidenceVerifier: class {
    verifyReadiness = h.verifyReadiness;
    verifyLiveReadiness = h.verifyLiveReadiness;
  },
}));
vi.mock("../src/core/health.js", () => ({
  setWorkerStatus: h.setWorkerStatus,
  heartbeatWorker: h.heartbeatWorker,
  failWorker: h.failWorker,
}));

import { startStandardRailReadiness } from "../src/core/standardRail/readiness.js";
import type { ProviderStandardRailConfig } from "../src/core/standardRail/config.js";
import type { Chain } from "viem";

const config = {} as ProviderStandardRailConfig;
const chain = {} as Chain;

beforeEach(() => {
  vi.useFakeTimers();
  for (const mock of Object.values(h)) mock.mockReset();
  h.verifyReadiness.mockResolvedValue(undefined);
  h.verifyLiveReadiness.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("standard-rail readiness worker", () => {
  it("runs the complete proof once and only live checks every five minutes", async () => {
    const stop = await startStandardRailReadiness(config, chain);

    expect(h.verifyReadiness).toHaveBeenCalledTimes(1);
    expect(h.verifyLiveReadiness).not.toHaveBeenCalled();
    // The heartbeat covers one interval plus 90 seconds for the next proof.
    expect(h.setWorkerStatus).toHaveBeenCalledWith("standard-rail-evidence", false, 390);
    expect(h.heartbeatWorker).toHaveBeenLastCalledWith("standard-rail-evidence", 390);

    await vi.advanceTimersByTimeAsync(299_000);
    expect(h.verifyLiveReadiness).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(601_000);

    expect(h.verifyReadiness).toHaveBeenCalledTimes(1);
    expect(h.verifyLiveReadiness).toHaveBeenCalledTimes(3);
    expect(h.heartbeatWorker).toHaveBeenCalledTimes(4);
    stop();
  });

  it("does not overlap slow live checks", async () => {
    let releaseFirst!: () => void;
    h.verifyLiveReadiness
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }))
      .mockResolvedValue(undefined);
    const stop = await startStandardRailReadiness(config, chain);

    await vi.advanceTimersByTimeAsync(900_000);
    expect(h.verifyLiveReadiness).toHaveBeenCalledTimes(1);

    releaseFirst();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.verifyLiveReadiness).toHaveBeenCalledTimes(2);
    stop();
  });
});
