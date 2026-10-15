import { randomBytes } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import type { AdapterResult, FulfillmentAdapter } from "../src/core/serviceRegistry/types.js";
import type { ProviderStandardRailConfig } from "../src/core/standardRail/config.js";
import { postJson, startRailServer, statusQuery } from "./dispatchHttpHarness.js";
import { acceptDispatchResponse, readGatewayJson } from "./gatewayConsumer.js";
import { createMigratedDatabase, DATABASE_HOOK_TIMEOUT_MS, type DisposableDatabase } from "./postgresHarness.js";
import {
  fixtureModule, paidOrder, publishedContract, railConfig, railEnvironment, retainedWallet, seedService, SKILL,
  statusCall, versionHead, versionOutcome,
} from "./retainedVersionFixture.js";
import { GATEWAY_AUDIENCE, provider, SERVICE_SLUG } from "./standardRailFixture.js";

// F-T05, F-T15, C-T06: a timely-paid order of a superseded listing version
// keeps the definition, price, handler and signing key it was sold under,
// even after a new contract version is promoted and sales are paused. A
// build without that version's handler or key refuses the dispatch before
// admission instead of executing or signing it as the current version.
vi.setConfig({ testTimeout: 30_000 });
const h = vi.hoisted(() => ({ pool: null as pg.Pool | null, current: 0, retained: 0 }));
vi.mock("../src/core/db/pool.js", () => ({
  pool: {
    query: (...args: unknown[]) => (h.pool!.query as (...a: unknown[]) => unknown)(...args),
    connect: () => h.pool!.connect(),
  },
}));
const completed = (note: string): AdapterResult => ({
  status: "completed", artifacts: [{ name: "note", data: { note } }],
});
const currentAdapter: FulfillmentAdapter = {
  execute: async () => { h.current += 1; return completed("current"); },
  handleInput: vi.fn(),
  cancel: vi.fn(),
  quote: async () => ({ ok: true, amount: 250_000n, currency: "USDC" }),
};
const retainedAdapter: FulfillmentAdapter = {
  ...currentAdapter,
  execute: async () => { h.retained += 1; return completed("version one"); },
};
vi.mock("../src/core/serviceRegistry/registry.js", () => ({
  getAdapter: () => currentAdapter,
  getService: () => null,
  getAllServices: () => [],
}));
vi.mock("../src/core/engine/preExecuteRunner.js", () => ({
  consultPreExecuteAgent: async () => ({ action: "proceed" }),
}));

const { ProviderEvidenceVerifier } = await import("../src/core/standardRail/evidence.js");
const { promoteRuntimeListingVersions } = await import("../src/core/gatewayRegistration/runtimeCatalog.js");
const { registerRetainedContracts } = await import("../src/core/serviceRegistry/retainedHandlers.js");
const { refreshCatalogHeads } = await import("../src/core/standardRail/config.js");

const v1 = versionHead(1);
const v2 = versionHead(2);
const v1Outcome = versionOutcome(v1);
const DAY = 86_400;
let database: DisposableDatabase;
let config: ProviderStandardRailConfig;
let rail: Awaited<ReturnType<typeof startRailServer>>;

const asVersion = (head: typeof v1) => ({
  listingId: head.listingId, listingKey: head.listingKey, skillId: head.skillId, paymentRequired: true,
  runtimeCommitmentHash: head.runtimeCommitmentHash, runtimeCommitment: head.runtimeCommitment, bundle: head.bundle,
});

async function dispatch(order: Awaited<ReturnType<typeof paidOrder>>, base = rail.base) {
  const response = await postJson(`${base}/dispatch`, order);
  return { status: response.status, body: await readGatewayJson(response) as Record<string, any> };
}

const claims = async () => (await database.pool.query("SELECT count(*)::int AS n FROM standard_dispatch_claims")).rows[0].n;

beforeAll(async () => {
  // Each paid order carries its own deposit authorization.
  vi.spyOn(ProviderEvidenceVerifier.prototype, "verify").mockImplementation(async () => ({
    authorizationKey: `0x${randomBytes(32).toString("hex")}`,
  }));
  vi.spyOn(ProviderEvidenceVerifier.prototype, "assertNotSanctioned").mockResolvedValue();
  database = await createMigratedDatabase("retained_versions");
  h.pool = database.pool;
  await seedService(database.pool);
  // Version 1 was sold first; version 2's contract then superseded it.
  await promoteRuntimeListingVersions(GATEWAY_AUDIENCE, v1.serviceId, [asVersion(v1)]);
  await promoteRuntimeListingVersions(GATEWAY_AUDIENCE, v2.serviceId, [asVersion(v2)]);
  config = await railConfig();
  rail = await startRailServer(config);
}, DATABASE_HOOK_TIMEOUT_MS);

afterAll(async () => {
  vi.restoreAllMocks();
  await rail?.close();
  await database?.drop();
}, DATABASE_HOOK_TIMEOUT_MS);

beforeEach(async () => {
  h.current = 0;
  h.retained = 0;
  registerRetainedContracts(fixtureModule([{ contract: publishedContract(1), adapter: retainedAdapter }]));
  await database.pool.query("UPDATE services SET is_active=true");
  await database.pool.query("UPDATE skills SET is_active=true");
});

describe("retained listing versions (F-T05, F-T15, C-T06)", () => {
  it("admits a delayed first dispatch of a superseded version under its own handler and key while sales are paused", async () => {
    expect([...config.outcomes.values()].map((outcome) => outcome.listingManifestHash)).toEqual([v2.runtimeCommitmentHash]);
    // Paid two days ago, under version 1, before version 2 existed.
    const order = await paidOrder(v1Outcome, { item: "kept" }, Math.floor(Date.now() / 1_000) - 2 * DAY);
    await database.pool.query("UPDATE services SET is_active=false");
    await database.pool.query("UPDATE skills SET is_active=false");
    const answer = await dispatch(order);
    expect(answer.status).toBe(200);
    // Signed by the agent wallet version 1's checkout snapshot names.
    const accepted = await acceptDispatchResponse(answer.body, {
      dispatchHash: canonicalHash(order.dispatch), providerAuthorityKey: retainedWallet,
      terminalAttestationKey: retainedWallet, now: Math.floor(Date.now() / 1_000),
    });
    expect(accepted.body.state).toBe("completed");
    expect([h.retained, h.current]).toEqual([1, 0]);
    const task = (await database.pool.query(
      "SELECT standard_listing_manifest_hash FROM transactions WHERE id=$1", [accepted.body.taskId],
    )).rows[0];
    expect(`0x${task.standard_listing_manifest_hash.toString("hex")}`).toBe(v1.runtimeCommitmentHash);

    // Status and lifecycle reads of the order keep the version's key.
    const status = await postJson(`${rail.base}/dispatch/status`, { query: await statusQuery(order) });
    expect(status.status).toBe(200);
    await acceptDispatchResponse(await readGatewayJson(status), {
      dispatchHash: canonicalHash(order.dispatch), providerAuthorityKey: retainedWallet,
      terminalAttestationKey: retainedWallet, now: Math.floor(Date.now() / 1_000),
    });
    const lifecycle = await postJson(`${rail.base}/lifecycle`, await statusCall({
      orderId: order.dispatch.payload.orderId, taskId: accepted.body.taskId,
    }));
    expect(lifecycle.status).toBe(200);
    const read = await readGatewayJson(lifecycle) as Record<string, any>;
    const { signature, ...signed } = read;
    const { recoverMessageAddress } = await import("viem");
    expect(await recoverMessageAddress({ message: { raw: canonicalHash(signed) }, signature })).toBe(retainedWallet);
    expect(await recoverMessageAddress({
      message: { raw: canonicalHash(read.terminalAttestation.payload) }, signature: read.terminalAttestation.signature,
    })).toBe(retainedWallet);
  });

  it("runs a current-version order on the current handler and signs it with the current key", async () => {
    const order = await paidOrder(versionOutcome(v2), { item: "new", tier: "plus" }, Math.floor(Date.now() / 1_000) - 30);
    const answer = await dispatch(order);
    expect(answer.status).toBe(200);
    await acceptDispatchResponse(answer.body, {
      dispatchHash: canonicalHash(order.dispatch), providerAuthorityKey: provider.address,
      terminalAttestationKey: provider.address, now: Math.floor(Date.now() / 1_000),
    });
    expect([h.retained, h.current]).toEqual([0, 1]);
  });

  it("refuses a superseded version's dispatch before admission when this build lost its handler", async () => {
    registerRetainedContracts(fixtureModule([]));
    const before = await claims();
    const order = await paidOrder(v1Outcome, { item: "orphaned" }, Math.floor(Date.now() / 1_000) - DAY);
    const answer = await dispatch(order);
    expect([answer.status, answer.body]).toEqual([503, { error: "dispatch_rejected", reason: "service_unavailable" }]);
    expect(await claims()).toBe(before);
    expect(h.current + h.retained).toBe(0);
  });

  it("follows a promotion for new sales without a restart while the old head's orders keep their version", async () => {
    // Paid under version 2 while it was the head.
    const order = await paidOrder(versionOutcome(v2), { item: "before" }, Math.floor(Date.now() / 1_000) - 60);
    const v3 = versionHead(3);
    await promoteRuntimeListingVersions(GATEWAY_AUDIENCE, v3.serviceId, [asVersion(v3)]);
    // A process booted while version 2 was the head.
    const live = await railConfig();
    const server = await startRailServer(live);
    try {
      expect([...live.outcomes.values()].map((outcome) => outcome.fixedGrossAmount)).toEqual(["250000"]);
      await expect(refreshCatalogHeads(live, { paidSkills: [{ serviceSlug: SERVICE_SLUG, skillId: SKILL }] }, railEnvironment()))
        .resolves.toBe(true);
      expect([...live.outcomes.values()].map((outcome) => outcome.fixedGrossAmount)).toEqual(["300000"]);
      // Only the price changed, so the current handler serves version 2 too.
      const answer = await dispatch(order, server.base);
      expect(answer.status).toBe(200);
      expect(answer.body.state).toBe("completed");
      expect([h.retained, h.current]).toEqual([0, 1]);
    } finally {
      await server.close();
    }
  });

  it("never signs an earlier version's answers with the current key", async () => {
    const order = await paidOrder(v1Outcome, { item: "signed" }, Math.floor(Date.now() / 1_000) - DAY);
    expect((await dispatch(order)).status).toBe(200);
    const withoutKey = await railConfig([]);
    const other = await startRailServer(withoutKey);
    try {
      const status = await postJson(`${other.base}/dispatch/status`, { query: await statusQuery(order) });
      expect([status.status, await status.json()]).toEqual([503, {
        error: "dispatch_status_unavailable", reason: "unavailable",
      }]);
      const fresh = await paidOrder(v1Outcome, { item: "unsigned" }, Math.floor(Date.now() / 1_000) - DAY);
      const before = await claims();
      const refused = await dispatch(fresh, other.base);
      expect([refused.status, refused.body]).toEqual([503, { error: "dispatch_rejected", reason: "service_unavailable" }]);
      expect(await claims()).toBe(before);
    } finally {
      await other.close();
    }
  });

  it("refuses definitely an admission that a committed retirement overtook", async () => {
    const order = await paidOrder(v1Outcome, { item: "overtaken" }, Math.floor(Date.now() / 1_000) - DAY);
    const version = Buffer.from(v1.runtimeCommitmentHash.slice(2), "hex");
    // The version is retired after the dispatch resolved it and before its admission.
    vi.mocked(ProviderEvidenceVerifier.prototype.verify).mockImplementationOnce(async () => {
      await database.pool.query(
        "UPDATE provider_runtime_listing_versions SET retired_at=now(),retirement='{}'::jsonb WHERE runtime_commitment_hash=$1",
        [version],
      );
      return { authorizationKey: `0x${randomBytes(32).toString("hex")}` };
    });
    const before = await claims();
    try {
      const answer = await dispatch(order);
      expect([answer.status, answer.body]).toEqual([409, { error: "dispatch_rejected", reason: "outcome_policy" }]);
      expect(await claims()).toBe(before);
      expect(h.current + h.retained).toBe(0);
    } finally {
      // Retirement is final in the database; undo it for this suite with triggers off.
      const client = await database.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL session_replication_role = replica");
        await client.query(
          "UPDATE provider_runtime_listing_versions SET retired_at=NULL,retirement=NULL WHERE runtime_commitment_hash=$1",
          [version],
        );
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    }
  });
});
