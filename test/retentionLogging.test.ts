import { beforeEach, expect, it, vi } from "vitest";

// An empty retention sweep is the normal case every five minutes: it stays
// silent while still refreshing the worker's readiness heartbeat.
const h = vi.hoisted(() => ({
  query: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), heartbeat: vi.fn(), failWorker: vi.fn(), purge: vi.fn(),
}));
vi.mock("../src/core/db/pool.js", () => ({ pool: { query: h.query } }));
vi.mock("../src/core/db/queryable.js", () => ({
  inTransaction: async (db: unknown, callback: (db: unknown) => Promise<unknown>) => callback(db),
}));
vi.mock("../src/core/logger.js", () => ({ logInfo: h.info, logError: h.error, logWarn: h.warn }));
vi.mock("../src/core/health.js", () => ({
  heartbeatWorker: h.heartbeat, failWorker: h.failWorker, setWorkerStatus: vi.fn(),
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

it("keeps the sweep and its heartbeat when pruning lapsed provider quotes fails", async () => {
  h.query.mockImplementation(async (text: string) => {
    if (text.includes("DELETE FROM standard_provider_quotes")) {
      throw Object.assign(new Error("deletion refused"), { code: "23000" });
    }
    return { rows: [], rowCount: 0 };
  });
  await expect(runRetention()).resolves.toMatchObject({ providerQuotes: 0, rateBuckets: 0 });
  expect(h.heartbeat).toHaveBeenCalledWith("retention");
  expect(h.failWorker).not.toHaveBeenCalled();
  expect(h.warn).toHaveBeenCalledWith(
    "Provider quote pruning failed; the next retention sweep retries it", { errorClass: "Error", code: "23000" },
  );
});
