import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import type { Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import { postJson, statusQuery } from "./dispatchHttpHarness.js";
import type { DispatchArgs } from "./dispatchWire.js";
import { acceptDispatchResponse, readGatewayJson, signGatewayEnvelope } from "./gatewayConsumer.js";
import { paidOrderHarness } from "./paidOrderHarness.js";
import { createMigratedDatabase, DATABASE_HOOK_TIMEOUT_MS, type DisposableDatabase } from "./postgresHarness.js";
import {
  CHAIN_ID, ENVIRONMENT, fixedOutcome, fixtureConfig, gatewayKey, otherKey, provider, PROVIDER_AUDIENCE,
  seedFixtureService,
} from "./standardRailFixture.js";

// C-T13: about eight hours of ten-second reconciliation polls for one order
// through the full provider HTTP stack. Reads never call the product, never
// spend purchase or per-client rate limits and never write; signature checks
// and body bounds still apply, and purchase paths stay rate limited.
const POLLS = 2_880;
// Database-backed protocol tests: allow for a loaded shared host.
vi.setConfig({ testTimeout: 30_000 });
const h = vi.hoisted(() => ({ pool: null as pg.Pool | null, executions: 0 }));
vi.mock("../src/core/db/pool.js", () => ({
  pool: {
    query: (...args: unknown[]) => (h.pool!.query as (...a: unknown[]) => unknown)(...args),
    connect: () => h.pool!.connect(),
  },
  migrationPool: { query: vi.fn(), connect: vi.fn() },
  closeMigrationPool: vi.fn(),
  checkDatabase: async () => true,
}));
vi.mock("../src/core/serviceRegistry/registry.js", () => ({
  getAdapter: () => ({
    execute: async () => { h.executions += 1; return { status: "working" }; },
    handleInput: vi.fn(),
    cancel: vi.fn(),
    quote: async () => ({ ok: true, amount: 250_000n, currency: "USDC" }),
  }),
  getService: () => null,
  getAllServices: () => [],
}));
vi.mock("../src/core/engine/preExecuteRunner.js", () => ({
  consultPreExecuteAgent: async () => ({ action: "proceed" }),
}));

const { config: coreConfig } = await import("../src/core/config.js");
const { createProviderApp } = await import("../src/core/server.js");
const { StandardQuoteService } = await import("../src/core/standardRail/quote.js");
const { ProviderEvidenceVerifier } = await import("../src/core/standardRail/evidence.js");

const railConfig = fixtureConfig();
let database: DisposableDatabase;
let server: Server;
let base: string;
let order: DispatchArgs;
const { paidOrder } = paidOrderHarness({
  config: railConfig, request: { item: "widget" },
  quoteService: () => new StandardQuoteService(railConfig, CHAIN_ID),
});
const originalLimits = {
  RATE_LIMIT_GLOBAL_CAPACITY: coreConfig.RATE_LIMIT_GLOBAL_CAPACITY,
  RATE_LIMIT_GLOBAL_PER_MIN: coreConfig.RATE_LIMIT_GLOBAL_PER_MIN,
  RATE_LIMIT_A2A_CAPACITY: coreConfig.RATE_LIMIT_A2A_CAPACITY,
  RATE_LIMIT_A2A_PER_MIN: coreConfig.RATE_LIMIT_A2A_PER_MIN,
  RATE_LIMIT_BYPASS_IPS: coreConfig.RATE_LIMIT_BYPASS_IPS,
};

beforeAll(async () => {
  database = await createMigratedDatabase("servicing_reads");
  h.pool = database.pool;
  await seedFixtureService(database.pool, { skillIds: [fixedOutcome.skillId] });
  vi.spyOn(ProviderEvidenceVerifier.prototype, "verify")
    .mockImplementation(async () => ({ authorizationKey: `0x${randomBytes(32).toString("hex")}` as Hex }));
  vi.spyOn(ProviderEvidenceVerifier.prototype, "assertNotSanctioned").mockResolvedValue();
  // Tiny purchase and per-client budgets make any spend on reads visible.
  Object.assign(coreConfig, {
    RATE_LIMIT_GLOBAL_CAPACITY: 6, RATE_LIMIT_GLOBAL_PER_MIN: 1,
    RATE_LIMIT_A2A_CAPACITY: 3, RATE_LIMIT_A2A_PER_MIN: 1, RATE_LIMIT_BYPASS_IPS: "",
  });
  server = createProviderApp(railConfig, undefined, { salesAdmission: async () => ({ status: "open" as const }) }).listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/standard-rail`;
  order = await paidOrder();
  const admitted = await postJson(`${base}/dispatch`, order);
  expect(admitted.status).toBe(200);
}, DATABASE_HOOK_TIMEOUT_MS);

afterAll(async () => {
  Object.assign(coreConfig, originalLimits);
  vi.restoreAllMocks();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await database?.drop();
}, DATABASE_HOOK_TIMEOUT_MS);

async function limiterState() {
  return (await database.pool.query(
    "SELECT bucket_key,tokens,last_refill FROM rate_limit_buckets ORDER BY bucket_key",
  )).rows;
}

async function rowVersions() {
  return (await database.pool.query(
    `SELECT c.xmin::text AS claim,t.xmin::text AS task,c.operations_revision::text AS revision
       FROM standard_dispatch_claims c JOIN transactions t ON t.id=c.transaction_id
      WHERE c.order_id=$1`, [order.dispatch.payload.orderId],
  )).rows[0];
}

describe("servicing status reads (C-T13)", () => {
  it("serves ~2,880 signed polls without product calls, rate-limit spend or writes", async () => {
    const limitsBefore = await limiterState();
    const versionsBefore = await rowVersions();
    const executionsBefore = h.executions;
    const dispatchHash = canonicalHash(order.dispatch);
    let next = 0;
    const statuses = new Map<number, number>();
    const worker = async () => {
      while (next < POLLS) {
        const poll = next++;
        const response = await postJson(`${base}/dispatch/status`, { query: await statusQuery(order) });
        statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
        if (poll % 240 === 0) {
          const accepted = await acceptDispatchResponse(await readGatewayJson(response), {
            dispatchHash, providerAuthorityKey: provider.address, terminalAttestationKey: provider.address,
            now: Math.floor(Date.now() / 1_000),
          });
          expect(accepted.operations.revision).toBe(0);
        } else {
          await response.arrayBuffer();
        }
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    expect(Object.fromEntries(statuses)).toEqual({ 200: POLLS });
    expect(h.executions).toBe(executionsBefore);
    expect(await limiterState()).toEqual(limitsBefore);
    expect(await rowVersions()).toEqual(versionsBefore);
  }, 120_000);

  it("still authenticates and bounds status reads", async () => {
    const forged = await postJson(`${base}/dispatch/status`, { query: await statusQuery(order, { privateKey: otherKey }) });
    expect(forged.status).toBe(401);
    const oversized = await fetch(`${base}/dispatch/status`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "x".repeat(17 * 1024) }),
    });
    expect(oversized.status).toBe(413);
  });

  it("keeps purchase paths under the rate limits", async () => {
    const quoteBody = async () => {
      const issuedAt = Math.floor(Date.now() / 1_000);
      return {
        request: await signGatewayEnvelope({
          artifactType: "ProviderQuoteRequestV1", environment: ENVIRONMENT, chainId: CHAIN_ID,
          audience: PROVIDER_AUDIENCE, signerKeyId: "gateway-dispatch", privateKey: gatewayKey,
          issuedAt, validBefore: issuedAt + 60,
          payload: {
            outcomeId: fixedOutcome.outcomeId, listingManifestHash: fixedOutcome.listingManifestHash,
            requestHash: canonicalHash({ item: "widget" }), request: { item: "widget" }, payer: null,
          },
        }),
      };
    };
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      statuses.push((await postJson(`${base}/quote`, await quoteBody())).status);
    }
    expect(statuses).toContain(429);
  });
});
