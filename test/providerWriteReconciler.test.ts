import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Readiness of the provider-wallet write reconciler across replicas. The
// cycle lease is a session advisory lock: a busy lease is a live peer doing
// this cycle's work, so it keeps this replica ready, but a lease that never
// frees again is a stuck peer, and a failed or nonce-gapped cycle is still
// reported not ready.

const h = vi.hoisted(() => ({
  withCycleLease: vi.fn(),
  reconcileProviderNonceGap: vi.fn(),
  setWorkerStatus: vi.fn(),
  heartbeatWorker: vi.fn(),
  failWorker: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock("../src/core/chain/client.js", () => ({ CHAIN_MODE_MOCK: false }));
vi.mock("../src/core/db/cycleLease.js", () => ({ withCycleLease: h.withCycleLease }));
vi.mock("../src/core/chain/providerWriteCoordinator.js", () => ({
  reconcileProviderNonceGap: h.reconcileProviderNonceGap,
}));
vi.mock("../src/core/health.js", () => ({
  setWorkerStatus: h.setWorkerStatus,
  heartbeatWorker: h.heartbeatWorker,
  failWorker: h.failWorker,
}));
vi.mock("../src/core/logger.js", () => ({
  logWarn: h.logWarn,
  logError: h.logError,
  logInfo: h.logInfo,
  errorExtra: (error: unknown) => ({ error: String(error) }),
}));

import {
  PEER_LEASE_TRUST_MS,
  RECONCILE_JITTER_MS,
  runProviderWriteReconciliation,
  startProviderWriteReconciler,
  stopProviderWriteReconciler,
} from "../src/core/chain/providerWriteReconciler.js";

const WORKER = "provider-write-reconciler";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
  for (const mock of Object.values(h)) mock.mockReset();
  // Run the leased work by default; individual cases override the lease.
  h.withCycleLease.mockImplementation(
    async (_name: string, work: () => Promise<unknown>) => work(),
  );
  h.reconcileProviderNonceGap.mockResolvedValue("clear");
});

afterEach(async () => {
  await stopProviderWriteReconciler();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("provider write reconciler readiness", () => {
  it("counts a lease held by another replica as a healthy cycle", async () => {
    h.withCycleLease.mockResolvedValue(null);

    await runProviderWriteReconciliation();

    expect(h.heartbeatWorker).toHaveBeenCalledWith(WORKER);
    expect(h.failWorker).not.toHaveBeenCalled();
    expect(h.logWarn).not.toHaveBeenCalled();
    expect(h.reconcileProviderNonceGap).not.toHaveBeenCalled();
  });

  it("heartbeats a clear cycle", async () => {
    await runProviderWriteReconciliation();

    expect(h.reconcileProviderNonceGap).toHaveBeenCalledOnce();
    expect(h.heartbeatWorker).toHaveBeenCalledWith(WORKER);
    expect(h.failWorker).not.toHaveBeenCalled();
  });

  it.each(["attention", "replacement_broadcast"] as const)(
    "keeps the worker not ready while nonce-gap recovery is %s",
    async (result) => {
      h.reconcileProviderNonceGap.mockResolvedValue(result);

      await runProviderWriteReconciliation();

      expect(h.failWorker).toHaveBeenCalledWith(WORKER);
      expect(h.heartbeatWorker).not.toHaveBeenCalled();
      expect(h.logWarn).toHaveBeenCalledWith(
        "Provider wallet nonce gap recovery is active",
        { result },
      );
    },
  );

  it("keeps its own nonce-gap verdict while another replica holds the lease", async () => {
    h.reconcileProviderNonceGap.mockResolvedValue("attention");
    await runProviderWriteReconciliation();
    expect(h.failWorker).toHaveBeenCalledWith(WORKER);

    // The peer's busy lease says nothing about the gap this replica saw.
    h.withCycleLease.mockResolvedValue(null);
    await runProviderWriteReconciliation();
    await runProviderWriteReconciliation();
    expect(h.heartbeatWorker).not.toHaveBeenCalled();

    // Only this replica's own clear cycle restores it.
    h.withCycleLease.mockImplementation(
      async (_name: string, work: () => Promise<unknown>) => work(),
    );
    h.reconcileProviderNonceGap.mockResolvedValue("clear");
    await runProviderWriteReconciliation();
    expect(h.heartbeatWorker).toHaveBeenCalledTimes(1);
    h.withCycleLease.mockResolvedValue(null);
    await runProviderWriteReconciliation();
    expect(h.heartbeatWorker).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed own cycle not ready while another replica holds the lease", async () => {
    h.withCycleLease.mockRejectedValueOnce(new Error("lease connection reset"));
    await expect(runProviderWriteReconciliation()).rejects.toThrow("lease connection reset");
    h.withCycleLease.mockResolvedValue(null);
    await runProviderWriteReconciliation();
    expect(h.heartbeatWorker).not.toHaveBeenCalled();
  });

  it("stops vouching for a lease that another session never frees", async () => {
    h.withCycleLease.mockResolvedValue(null);
    await runProviderWriteReconciliation();
    vi.advanceTimersByTime(PEER_LEASE_TRUST_MS);
    await runProviderWriteReconciliation();
    expect(h.heartbeatWorker).toHaveBeenCalledTimes(2);
    expect(h.failWorker).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    await runProviderWriteReconciliation();
    await runProviderWriteReconciliation();
    expect(h.heartbeatWorker).toHaveBeenCalledTimes(2);
    expect(h.failWorker).toHaveBeenCalledTimes(2);
    expect(h.logWarn).toHaveBeenCalledTimes(1);
    expect(h.logWarn).toHaveBeenCalledWith(
      "Provider write reconciliation lease has been held by another session for too long",
      { busyForMs: PEER_LEASE_TRUST_MS + 1 },
    );

    // The peer frees the lease: this replica's own clear cycle restores it,
    // and the trust window starts over for the next busy lease.
    h.withCycleLease.mockImplementation(
      async (_name: string, work: () => Promise<unknown>) => work(),
    );
    await runProviderWriteReconciliation();
    expect(h.heartbeatWorker).toHaveBeenCalledTimes(3);
    h.withCycleLease.mockResolvedValue(null);
    await runProviderWriteReconciliation();
    expect(h.heartbeatWorker).toHaveBeenCalledTimes(4);
  });
});

describe("provider write reconciler schedule", () => {
  it("runs at start and then on a jittered interval so replicas cannot phase-lock", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    h.withCycleLease.mockResolvedValue("clear");

    startProviderWriteReconciler();
    expect(h.setWorkerStatus).toHaveBeenCalledWith(WORKER, false);
    expect(h.withCycleLease).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.withCycleLease).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(RECONCILE_JITTER_MS / 2);
    expect(h.withCycleLease).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30_000 + RECONCILE_JITTER_MS / 2);
    expect(h.withCycleLease).toHaveBeenCalledTimes(3);
  });

  it("stops scheduling once stopped", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    h.withCycleLease.mockResolvedValue("clear");

    startProviderWriteReconciler();
    await stopProviderWriteReconciler();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(h.withCycleLease).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("marks a thrown cycle not ready and logs it", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    h.withCycleLease.mockRejectedValue(new Error("controlled failure"));

    startProviderWriteReconciler();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.failWorker).toHaveBeenCalledWith(WORKER);
    expect(h.logError).toHaveBeenCalledWith(
      "Provider wallet write reconciliation failed",
      expect.objectContaining({ error: expect.stringContaining("controlled failure") }),
    );
  });

  it("stops heartbeating while one cycle hangs, so a stuck reconciler goes stale", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    let release!: (value: string) => void;
    h.withCycleLease.mockImplementation(() => new Promise((resolve) => { release = resolve; }));

    startProviderWriteReconciler();
    await vi.advanceTimersByTimeAsync(10 * 30_000);

    // The in-flight guard skips every later tick: no heartbeat ever arrives,
    // so readiness fails once the last one ages out.
    expect(h.withCycleLease).toHaveBeenCalledTimes(1);
    expect(h.heartbeatWorker).not.toHaveBeenCalled();
    release("clear");
  });
});
