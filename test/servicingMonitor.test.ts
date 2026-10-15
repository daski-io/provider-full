import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// F-T06: a running replica follows catalog promotions without a restart. The
// activation revision is a sequence, so it can move before the promotion
// that moved it commits; the monitor therefore re-reads the heads on the
// poll after a move as well, and on every full check, so a replica never
// keeps stale heads until the next catalog write.
const h = vi.hoisted(() => ({
  revision: "1",
  refresh: vi.fn(async () => false),
}));
vi.mock("../src/core/db/pool.js", () => ({ pool: {} }));
vi.mock("../src/core/compatibility/compatibilityReport.js", () => ({
  activationRevision: async () => h.revision,
  compatibilityReport: async () => ({ ok: true, gaps: [] }),
  describeGap: (gap: { kind: string }) => gap.kind,
}));
vi.mock("../src/core/standardRail/config.js", () => ({
  refreshCatalogHeads: (...args: unknown[]) => (h.refresh as (...a: unknown[]) => Promise<boolean>)(...args),
}));
vi.mock("../src/core/health.js", () => ({ setRetainedServicing: vi.fn() }));
vi.mock("../src/core/serviceRegistry/registry.js", () => ({ getAllServices: () => [] }));
vi.mock("../src/core/standardRail/signingKeys.js", () => ({ signingKeyAddresses: () => new Set() }));
vi.mock("../src/core/buildIdentity.js", () => ({ buildIdentity: () => ({ sourceDigest: null, sourceCommit: null }) }));

const { startServicingMonitor } = await import("../src/core/compatibility/servicingMonitor.js");

const MINUTE = 60_000;
const catalogConfig = {
  gatewayOrigin: "https://gateway.example.invalid",
  providerControlProfileHash: `0x${"55".repeat(32)}`,
} as never;

beforeEach(() => {
  vi.useFakeTimers();
  h.revision = "1";
  h.refresh.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("servicing monitor (F-T06)", () => {
  it("re-reads the heads after a revision move, once more on the next poll, and on every full check", async () => {
    const stop = startServicingMonitor(catalogConfig, { paidSkills: [] }, "1");
    try {
      await vi.advanceTimersByTimeAsync(MINUTE);
      expect(h.refresh).not.toHaveBeenCalled();
      // A promotion advanced the revision before it committed.
      h.revision = "2";
      await vi.advanceTimersByTimeAsync(MINUTE);
      expect(h.refresh).toHaveBeenCalledTimes(1);
      // The next poll re-reads the committed heads.
      await vi.advanceTimersByTimeAsync(MINUTE);
      expect(h.refresh).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(MINUTE);
      expect(h.refresh).toHaveBeenCalledTimes(2);
      // A full check re-reads them even when nothing moved.
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      expect(h.refresh).toHaveBeenCalledTimes(3);
    } finally {
      stop();
    }
  });

  it("never refreshes a rail configured without the runtime catalog", async () => {
    const stop = startServicingMonitor({ gatewayOrigin: "https://gateway.example.invalid" } as never, { paidSkills: [] }, "1");
    try {
      h.revision = "2";
      await vi.advanceTimersByTimeAsync(12 * MINUTE);
      expect(h.refresh).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
});
