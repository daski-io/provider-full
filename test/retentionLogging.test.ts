import { beforeEach, expect, it, vi } from "vitest";

// An empty retention sweep is the normal case every five minutes: it stays
// silent while still refreshing the worker's readiness heartbeat.
const h = vi.hoisted(() => ({ query: vi.fn(), info: vi.fn(), error: vi.fn(), heartbeat: vi.fn(), purge: vi.fn() }));
vi.mock("../src/core/db/pool.js", () => ({ pool: { query: h.query } }));
vi.mock("../src/core/db/queryable.js", () => ({
  inTransaction: async (db: unknown, callback: (db: unknown) => Promise<unknown>) => callback(db),
}));
vi.mock("../src/core/logger.js", () => ({ logInfo: h.info, logError: h.error, logWarn: vi.fn() }));
vi.mock("../src/core/health.js", () => ({
  heartbeatWorker: h.heartbeat, failWorker: vi.fn(), setWorkerStatus: vi.fn(),
}));
vi.mock("../src/core/db/ephemeralRetention.js", () => ({ purgeExpiredEphemeralTransactions: h.purge }));
const { runRetention } = await import("../src/core/db/retention.js");

beforeEach(() => {
  vi.clearAllMocks();
  h.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  h.purge.mockReset().mockResolvedValue(0);
});

it("keeps empty retention sweeps silent while refreshing worker health", async () => {
  await runRetention();
  expect(h.info).not.toHaveBeenCalled();
  expect(h.heartbeat).toHaveBeenCalledWith("retention");
});

it("reports a sweep that removed something", async () => {
  h.query.mockResolvedValueOnce({ rows: [], rowCount: 2 });
  await runRetention();
  expect(h.info).toHaveBeenCalledWith("Retention sweep completed", expect.objectContaining({ outboundEmails: 2 }));
  expect(h.heartbeat).toHaveBeenCalledWith("retention");
});
