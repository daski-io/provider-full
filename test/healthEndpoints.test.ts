import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// /health/ready answers routing readiness: 200 while persisted reads can be
// served, whatever stops new sales; /health/admission answers new-sale
// admission for a load balancer that routes sales separately. Inactive
// services keep their workers required while they still owe work.
const h = vi.hoisted(() => ({
  database: true,
  minimumEpoch: 1 as number | null,
  identity: true,
  owing: new Set<string>(),
  queries: [] as string[],
}));
vi.mock("../src/core/db/pool.js", () => ({
  checkDatabase: async () => h.database,
  pool: {
    query: async (text: string) => {
      h.queries.push(text);
      if (text.includes("provider_minimum_runtime_epoch")) return { rows: [{ minimum: h.minimumEpoch }] };
      throw new Error(`unexpected query: ${text}`);
    },
  },
}));
vi.mock("../src/core/chain/client.js", () => ({ CHAIN_MODE_MOCK: true, publicClient: {} }));
vi.mock("../src/core/db/queries/services.js", () => ({
  listAllServices: async () => [
    { slug: "svc-live", version: "1", is_active: true },
    { slug: "svc-paused", version: "1", is_active: false },
  ],
  listInactiveServicesOwingWork: async () => h.owing,
}));
vi.mock("../src/core/db/queries/durableJobs.js", () => ({ getDurableQueueMetrics: async () => [] }));
vi.mock("../src/core/serviceRegistry/registry.js", () => ({
  getAllServices: () => [
    { manifest: { slug: "svc-live" }, operations: { readiness: { requiredWorkers: ["svc-live-worker"] } } },
    { manifest: { slug: "svc-paused" }, operations: { readiness: { requiredWorkers: ["svc-paused-poller"] } } },
  ],
}));
vi.mock("../src/core/serviceRegistry/readiness.js", () => ({ serviceInvariantFailures: async () => [] }));
vi.mock("../src/core/chain/providerIdentity.js", () => ({
  getProviderIdentityAuthorization: () => ({ ok: h.identity, checkedAt: new Date(), reason: null }),
  recordProviderIdentityVerification: () => undefined,
}));
vi.mock("../src/core/chain/serviceRegistrar.js", () => ({
  getServiceRegistrationHealth: () => ({ ok: true, checkedAt: new Date(), error: null }),
  getServiceRegistrationAuthorization: () => ({ ok: true, reason: null }),
}));

const health = await import("../src/core/health.js");
const CORE = [
  "email-ingress", "auth-cleanup", "retention", "standard-rail-evidence", "standard-task-watchdog",
  "standard-reputation-outcome", "standard-review-resolution", "standard-paid-fulfillment", "operator-escalation",
];
let server: Server;
let base: string;

async function get(path: string) {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

beforeAll(async () => {
  const app = express();
  app.use("/health", health.healthRouter);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  Object.assign(h, { database: true, minimumEpoch: 1, identity: true, owing: new Set<string>(), queries: [] });
  health.setServiceStatuses({ "svc-live": { active: true, tokenId: "1", registrationVerified: true, standardRailVerified: true } });
  health.setRetainedServicing({ ok: true, gaps: [] });
  for (const worker of [...CORE, "svc-live-worker"]) health.heartbeatWorker(worker);
  health.failWorker("svc-paused-poller");
  health.resetReadinessForTests();
});

describe("health endpoints (C05)", () => {
  it("is ready and admitting when every part is healthy, ignoring an idle paused service's worker", async () => {
    await expect(get("/ready")).resolves.toMatchObject({
      status: 200,
      body: { status: "ready", reads: { status: "ok" }, admission: { status: "open" }, servicing: { status: "ok" } },
    });
    await expect(get("/admission")).resolves.toMatchObject({ status: 200, body: { status: "open", codes: [] } });
  });

  it("stays routable for reads while a paused service that still owes work has a dead worker", async () => {
    h.owing = new Set(["svc-paused"]);
    const ready = await get("/ready");
    expect(ready).toMatchObject({
      status: 200,
      body: {
        reads: { status: "ok", codes: [] },
        admission: { status: "stopped", codes: ["worker_stale"] },
        servicing: { status: "degraded", codes: ["worker_stale"] },
      },
    });
    expect(JSON.stringify(ready.body)).not.toContain("svc-paused-poller");
    await expect(get("/admission")).resolves.toMatchObject({ status: 503, body: { status: "stopped" } });
    await expect(health.salesAdmission()).resolves.toMatchObject({ status: "stopped" });
  });

  it("stops new sales but not reads when the provider identity is unverified", async () => {
    h.identity = false;
    await expect(get("/ready")).resolves.toMatchObject({
      status: 200, body: { admission: { status: "stopped", codes: ["identity_unverified"] } },
    });
  });

  it("takes the process off routing only when reads cannot be served", async () => {
    h.minimumEpoch = 2;
    await expect(get("/ready")).resolves.toMatchObject({
      status: 503, body: { status: "not_ready", reads: { status: "unavailable", codes: ["schema_epoch_unsupported"] } },
    });
    health.resetReadinessForTests();
    h.database = false;
    await expect(get("/ready")).resolves.toMatchObject({
      status: 503, body: { reads: { codes: ["database_unavailable"] } },
    });
  });
});
