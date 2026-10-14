import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";

// Another replica's reconciler lease, held as a real PostgreSQL session
// advisory lock, keeps this replica's worker readiness healthy; a reconciler
// that fails, or whose heartbeat ages out, is still reported not ready.

const h = vi.hoisted(() => ({
  db: null as import("pg").Pool | null,
  nonceGap: vi.fn(),
}));

vi.mock("../src/core/db/pool.js", () => ({
  pool: {
    query: (...args: unknown[]) => (h.db as unknown as { query: (...a: unknown[]) => unknown }).query(...args),
    connect: () => h.db!.connect(),
  },
  checkDatabase: async () => true,
}));
vi.mock("../src/core/chain/client.js", () => ({
  CHAIN_MODE_MOCK: false,
  publicClient: {},
  walletClient: {},
  providerAddress: "0x2222222222222222222222222222222222222222",
}));
vi.mock("../src/core/chain/providerWriteCoordinator.js", () => ({
  reconcileProviderNonceGap: h.nonceGap,
}));
vi.mock("../src/core/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  errorExtra: (error: unknown) => ({ error: String(error) }),
}));

import { isWorkerReady, setWorkerStatus } from "../src/core/health.js";
import { runProviderWriteReconciliation } from "../src/core/chain/providerWriteReconciler.js";
import { createMigratedTestDatabase, type MigratedTestDatabase } from "./postgresTestDatabase.js";

const WORKER = "provider-write-reconciler";
const LEASE = "daski:provider-write-reconcile:v1";
let database: MigratedTestDatabase;

beforeAll(async () => {
  database = await createMigratedTestDatabase("daski_reconciler_lease");
  h.db = database.pool;
}, 120_000);

afterAll(async () => {
  await database?.drop();
});

beforeEach(() => {
  h.nonceGap.mockReset();
  h.nonceGap.mockResolvedValue("clear");
  setWorkerStatus(WORKER, false);
});

async function peerHoldingLease(): Promise<pg.Client> {
  const peer = new pg.Client({ connectionString: database.connectionString });
  await peer.connect();
  await peer.query("SELECT pg_advisory_lock(hashtext($1))", [LEASE]);
  return peer;
}

describe("provider write reconciler lease readiness", { timeout: 30_000 }, () => {
  it("stays ready while another replica's session holds the cycle lease", async () => {
    const peer = await peerHoldingLease();
    try {
      await runProviderWriteReconciliation();
      expect(h.nonceGap).not.toHaveBeenCalled();
      expect(isWorkerReady(WORKER)).toBe(true);
    } finally {
      await peer.end();
    }
    // The lease died with the peer's session: this replica now does the work.
    await runProviderWriteReconciliation();
    expect(h.nonceGap).toHaveBeenCalledOnce();
    expect(isWorkerReady(WORKER)).toBe(true);
  });

  it("still reports a failed or stale reconciler not ready", async () => {
    h.nonceGap.mockResolvedValue("attention");
    await runProviderWriteReconciliation();
    expect(isWorkerReady(WORKER)).toBe(false);

    h.nonceGap.mockResolvedValue("clear");
    await runProviderWriteReconciliation();
    expect(isWorkerReady(WORKER)).toBe(true);
    // A heartbeat older than the worker's maximum age is not ready, whoever
    // held the lease.
    expect(isWorkerReady(WORKER, Date.now() + 601_000)).toBe(false);
  });
});
