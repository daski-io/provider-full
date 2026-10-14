import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type pg from "pg";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterResult } from "../src/core/serviceRegistry/types.js";
import type { DispatchArgs } from "./dispatchWire.js";
import { statusQuery } from "./dispatchHttpHarness.js";
import { acceptDispatchResponse } from "./gatewayConsumer.js";
import { paidOrderHarness } from "./paidOrderHarness.js";
import { createMigratedDatabase, DATABASE_HOOK_TIMEOUT_MS, type DisposableDatabase } from "./postgresHarness.js";
import {
  CHAIN_ID, fixedOutcome, fixtureConfig, otherKey, provider, providerKey, seedFixtureService,
} from "./standardRailFixture.js";

// F-T14 / C06: terminal rows that predate frozen results take distinct paths
// from recorded evidence alone: matching evidence freezes its bytes, a
// verified identity without matching bytes keeps status evidence only,
// conflicting historical hashes isolate the row, and nothing is guessed.
vi.setConfig({ testTimeout: 30_000 });
const h = vi.hoisted(() => ({ pool: null as pg.Pool | null, result: { status: "working" } as AdapterResult }));
vi.mock("../src/core/db/pool.js", () => ({
  pool: {
    query: (...args: unknown[]) => (h.pool!.query as (...a: unknown[]) => unknown)(...args),
    connect: () => h.pool!.connect(),
  },
}));
vi.mock("../src/core/serviceRegistry/registry.js", () => ({
  getAdapter: () => ({
    execute: async () => h.result,
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

const { StandardDispatchService } = await import("../src/core/standardRail/dispatch.js");
const { StandardQuoteService } = await import("../src/core/standardRail/quote.js");
const { ProviderEvidenceVerifier } = await import("../src/core/standardRail/evidence.js");
const { canonicalHash } = await import("../src/core/standardRail/canonical.js");
const { recordMandatoryAudit } = await import("../src/core/events/emitter.js");
const { runRetention } = await import("../src/core/db/retention.js");
const { buildStandardTaskProjection, ORDER_SUPPORT_CHANNEL } = await import("../src/core/a2a/taskHistory.js");
const { loadFrozenTerminalProjection } = await import("../src/core/standardRail/terminalResult.js");
const legacy = await import("../src/core/standardRail/terminalLegacy.js");
const { createTerminalReconciliationRouter } = await import("../src/core/standardRail/terminalReconciliationRoutes.js");
const { makeRequireAdminAuth } = await import("../src/core/admin/auth.js");

const config = fixtureConfig();
const request = { item: "widget" };
let database: DisposableDatabase;
const { paidOrder } = paidOrderHarness({ config, request, quoteService: () => new StandardQuoteService(config, CHAIN_ID) });
const service = () => new StandardDispatchService(config, baseSepolia, CHAIN_ID);
const terminalKey = privateKeyToAccount(providerKey);
const now = () => Math.floor(Date.now() / 1_000);

interface LegacyOrder { order: DispatchArgs; id: string; completedAt: number }

/** An order an earlier release finalized: terminal, with events, never frozen. */
async function legacyCompletedOrder(): Promise<LegacyOrder> {
  const order = await paidOrder();
  await service().accept(order);
  const id = (await database.pool.query("SELECT id FROM transactions WHERE standard_order_id=$1",
    [order.dispatch.payload.orderId])).rows[0].id as string;
  for (const [type, payload] of [
    ["transaction.artifact.created", { name: "report", data: { reportId: "r-legacy" } }],
    ["transaction.message.agent", { role: "agent", content: "Legacy report ready." }],
  ] as const) {
    await recordMandatoryAudit(database.pool, { transactionId: id, source: "adapter", type, message: "legacy", payload });
  }
  const completed = await database.pool.query<{ completed_at: Date }>(
    `UPDATE transactions SET status='completed',completed_at=date_trunc('second',now()),version=version+1
      WHERE id=$1 RETURNING completed_at`, [id],
  );
  return { order, id, completedAt: Math.floor(completed.rows[0]!.completed_at.getTime() / 1_000) };
}

/** The dispatch-form attestation an earlier release signed for its reconstruction. */
async function retainedAttestation(row: LegacyOrder, overrides: Record<string, unknown> = {}, key = terminalKey) {
  const projection = await buildStandardTaskProjection({ id: row.id, status: "completed" }, { includeSupport: true });
  const payload = {
    taskId: row.id, dispatchHash: canonicalHash(row.order.dispatch), state: "completed",
    resultHash: canonicalHash(projection), completedAt: row.completedAt, ...overrides,
  };
  return { payload, signature: await key.signMessage({ message: { raw: canonicalHash(payload) } }) };
}

async function status(row: LegacyOrder) {
  return service().status(await statusQuery(row.order));
}

const record = (row: LegacyOrder, evidence: { kind: "attestation"; attestation: unknown } | { kind: "unobserved" }) =>
  legacy.recordLegacyTerminalEvidence(config, { transactionId: row.id, reference: "gateway-handoff-1", actor: "ops@example.com", ...evidence });

beforeAll(async () => {
  database = await createMigratedDatabase("terminal_legacy");
  h.pool = database.pool;
  await seedFixtureService(database.pool, { skillIds: [fixedOutcome.skillId] });
}, DATABASE_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await database?.drop();
}, DATABASE_HOOK_TIMEOUT_MS);

beforeEach(() => {
  vi.spyOn(ProviderEvidenceVerifier.prototype, "verify")
    .mockImplementation(async () => ({ authorizationKey: `0x${randomBytes(32).toString("hex")}` as Hex }));
  vi.spyOn(ProviderEvidenceVerifier.prototype, "assertNotSanctioned").mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("legacy terminal rows (F-T14)", () => {
  it("never answers or freezes an unreconciled row, however often it is read, and keeps its events", async () => {
    const row = await legacyCompletedOrder();
    for (let read = 0; read < 3; read += 1) {
      await expect(status(row)).rejects.toMatchObject({ status: 503, reason: "unavailable" });
    }
    expect((await database.pool.query("SELECT 1 FROM standard_terminal_results WHERE transaction_id=$1", [row.id])).rowCount).toBe(0);
    const listed = (await legacy.listUnresolvedLegacyTerminalResults()).find((entry) => entry.transactionId === row.id);
    expect(listed).toEqual({
      transactionId: row.id, orderId: row.order.dispatch.payload.orderId, state: "completed",
      completedAt: new Date(row.completedAt * 1_000).toISOString(), diagnostic: "legacy_identity_unverified",
    });
    await database.pool.query("UPDATE events SET created_at=now() - interval '4000 days' WHERE transaction_id=$1", [row.id]);
    await runRetention();
    expect((await database.pool.query("SELECT count(*)::int AS n FROM events WHERE transaction_id=$1", [row.id])).rows[0].n)
      .toBeGreaterThan(0);
  });

  it("freezes the matching bytes of a retained attestation and answers that identity", async () => {
    const row = await legacyCompletedOrder();
    // The earlier release hashed a later support message into its projection.
    await recordMandatoryAudit(database.pool, {
      transactionId: row.id, source: "system", type: "transaction.message.user", message: "Thanks",
      payload: { content: "Thanks", channel: ORDER_SUPPORT_CHANNEL },
    });
    const attestation = await retainedAttestation(row);
    await expect(record(row, { kind: "attestation", attestation }))
      .resolves.toEqual({ status: "frozen", provenance: "verified-attestation", bytes: true });
    const answer = await acceptDispatchResponse(await status(row), {
      dispatchHash: canonicalHash(row.order.dispatch), providerAuthorityKey: provider.address,
      terminalAttestationKey: provider.address, now: now(),
    });
    expect(answer.evidence?.payload).toEqual(attestation.payload);
    expect(canonicalHash((await loadFrozenTerminalProjection(database.pool, row.id))!.projection))
      .toBe(attestation.payload.resultHash);
  });

  it("keeps a verified identity whose bytes are gone for status, without an artifact", async () => {
    const row = await legacyCompletedOrder();
    const attestation = await retainedAttestation(row);
    // An earlier release's retention already purged the deliverable events.
    await database.pool.query("DELETE FROM events WHERE transaction_id=$1", [row.id]);
    await expect(record(row, { kind: "attestation", attestation }))
      .resolves.toEqual({ status: "frozen", provenance: "verified-attestation", bytes: false });
    const answer = await acceptDispatchResponse(await status(row), {
      dispatchHash: canonicalHash(row.order.dispatch), providerAuthorityKey: provider.address,
      terminalAttestationKey: provider.address, now: now(),
    });
    expect(answer.evidence?.payload).toEqual(attestation.payload);
    await expect(loadFrozenTerminalProjection(database.pool, row.id)).resolves.toBeNull();
  });

  it("isolates conflicting historical hashes and mismatched evidence instead of choosing one", async () => {
    const conflicting = await legacyCompletedOrder();
    await record(conflicting, { kind: "attestation", attestation: await retainedAttestation(conflicting) });
    await expect(record(conflicting, {
      kind: "attestation", attestation: await retainedAttestation(conflicting, { resultHash: `0x${"ab".repeat(32)}` }),
    })).resolves.toEqual({ status: "isolated", diagnostic: "legacy_evidence_conflict" });
    const isolated = await status(conflicting).catch((error: unknown) => error);
    expect(isolated).toMatchObject({ status: 503, reason: "unavailable" });

    const mismatched = await legacyCompletedOrder();
    await expect(record(mismatched, {
      kind: "attestation", attestation: await retainedAttestation(mismatched, { completedAt: mismatched.completedAt - 5 }),
    })).resolves.toEqual({ status: "unresolved", diagnostic: "legacy_evidence_mismatch" });
    await expect(status(mismatched)).rejects.toMatchObject({ status: 503 });
    const listed = await legacy.listUnresolvedLegacyTerminalResults();
    expect(listed.find((entry) => entry.transactionId === conflicting.id)?.diagnostic).toBe("legacy_evidence_conflict");
    expect(listed.find((entry) => entry.transactionId === mismatched.id)?.diagnostic).toBe("legacy_evidence_mismatch");
  });

  it("freezes a reconstruction only on a recorded no-identity handoff, and isolates it if one turns up", async () => {
    const row = await legacyCompletedOrder();
    await expect(record(row, { kind: "unobserved" }))
      .resolves.toEqual({ status: "frozen", provenance: "unobserved-reconstruction", bytes: true });
    const answered = await acceptDispatchResponse(await status(row), {
      dispatchHash: canonicalHash(row.order.dispatch), providerAuthorityKey: provider.address,
      terminalAttestationKey: provider.address, now: now(),
    });
    expect(answered.evidence?.payload.resultHash)
      .toBe(canonicalHash(await buildStandardTaskProjection({ id: row.id, status: "completed" })));
    // A retained gateway identity that differs proves the handoff wrong.
    await expect(record(row, {
      kind: "attestation", attestation: await retainedAttestation(row, { resultHash: `0x${"cd".repeat(32)}` }),
    })).resolves.toEqual({ status: "isolated", diagnostic: "legacy_evidence_conflict" });
    await expect(status(row)).rejects.toMatchObject({ status: 503 });
  });

  it("refuses evidence it cannot verify and records nothing for it", async () => {
    const row = await legacyCompletedOrder();
    const other = await legacyCompletedOrder();
    for (const attestation of [
      await retainedAttestation(row, {}, privateKeyToAccount(otherKey)),
      await retainedAttestation(other),
      { payload: (await retainedAttestation(row)).payload, signature: "0x00" },
    ]) {
      await expect(record(row, { kind: "attestation", attestation })).rejects.toThrow(/terminal attestation/);
    }
    expect((await database.pool.query("SELECT count(*)::int AS n FROM standard_terminal_evidence WHERE transaction_id=$1",
      [row.id])).rows[0].n).toBe(0);
    await expect(database.pool.query("DELETE FROM standard_terminal_evidence")).rejects.toThrow(/append-only/);
  });
});

describe("bearer-admin legacy reconciliation routes", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use("/admin/standard-rail/terminal-results", makeRequireAdminAuth(() => "test-admin-token-0123456789abcdef"),
      createTerminalReconciliationRouter(config));
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/admin/standard-rail/terminal-results`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const headers = { authorization: "Bearer test-admin-token-0123456789abcdef", "content-type": "application/json" };

  it("lists unresolved rows read-only behind the bearer token and records evidence with an actor", async () => {
    const row = await legacyCompletedOrder();
    expect((await fetch(`${base}/unresolved`)).status).toBe(401);
    const listing = await fetch(`${base}/unresolved?limit=1000`, { headers });
    expect(listing.status).toBe(200);
    const body = await listing.json() as { unresolved: Array<{ transactionId: string; diagnostic: string }> };
    expect(body.unresolved.find((entry) => entry.transactionId === row.id)?.diagnostic).toBe("legacy_identity_unverified");
    expect(JSON.stringify(body)).not.toContain("Legacy report ready.");
    const refused = await fetch(`${base}/${row.id}/evidence`, {
      method: "POST", headers, body: JSON.stringify({ kind: "unobserved", reference: "handoff" }),
    });
    expect(refused.status).toBe(409);
    const accepted = await fetch(`${base}/${row.id}/evidence`, {
      method: "POST", headers: { ...headers, "x-admin-actor": "ops@example.com" },
      body: JSON.stringify({ kind: "attestation", attestation: await retainedAttestation(row), reference: "handoff-2" }),
    });
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({ ok: true, outcome: { status: "frozen", bytes: true } });
  });
});
