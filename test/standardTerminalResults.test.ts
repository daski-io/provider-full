import { randomBytes } from "node:crypto";
import type pg from "pg";
import type { Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterResult, FulfillmentAdapter } from "../src/core/serviceRegistry/types.js";
import type { DispatchArgs } from "./dispatchWire.js";
import { statusQuery } from "./dispatchHttpHarness.js";
import { acceptDispatchResponse } from "./gatewayConsumer.js";
import { paidOrderHarness } from "./paidOrderHarness.js";
import { createMigratedDatabase, DATABASE_HOOK_TIMEOUT_MS, type DisposableDatabase } from "./postgresHarness.js";
import { CHAIN_ID, fixedOutcome, fixtureConfig, provider, seedFixtureService } from "./standardRailFixture.js";

// F-T13 / C-T14 / C06: a standard order's terminal identity is frozen with
// its terminal transition and never changes afterwards, whatever later
// messages, event retention, restarts or internal revivals do.
vi.setConfig({ testTimeout: 30_000 });
const h = vi.hoisted(() => ({
  pool: null as pg.Pool | null,
  result: { status: "working" } as AdapterResult,
}));
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
  } satisfies Partial<FulfillmentAdapter>),
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
const { processAdapterResult } = await import("../src/core/engine/taskFinalization.js");
const { recordMandatoryAudit } = await import("../src/core/events/emitter.js");
const { runRetention } = await import("../src/core/db/retention.js");
const { encryptString } = await import("../src/core/chain/encryption.js");
const { buildStandardTaskProjection, ORDER_SUPPORT_CHANNEL } = await import("../src/core/a2a/taskHistory.js");
const { revealFrozenTaskProjection } = await import("../src/core/a2a/responseBuilder.js");
const { loadFrozenTerminalProjection, terminalProjectionContext } = await import("../src/core/standardRail/terminalResult.js");
const { recordLegacyTerminalEvidence } = await import("../src/core/standardRail/terminalLegacy.js");

const config = fixtureConfig();
const request = { item: "widget" };
let database: DisposableDatabase;
let serviceId: string;
const { paidOrder } = paidOrderHarness({
  config, request, quoteService: () => new StandardQuoteService(config, CHAIN_ID),
});
const service = () => new StandardDispatchService(config, baseSepolia, CHAIN_ID);
const now = () => Math.floor(Date.now() / 1_000);

const completed: AdapterResult = {
  status: "completed",
  message: "Report ready.",
  artifacts: [{ name: "report", data: { reportId: "r-1", accessCode: "[protected]" } }],
};

async function statusAnswer(order: DispatchArgs, dispatch = service()) {
  const answer = await dispatch.status(await statusQuery(order));
  return acceptDispatchResponse(answer, {
    dispatchHash: canonicalHash(order.dispatch), providerAuthorityKey: provider.address,
    terminalAttestationKey: provider.address, now: now(),
  });
}

async function taskId(order: DispatchArgs): Promise<string> {
  return (await database.pool.query("SELECT id FROM transactions WHERE standard_order_id=$1",
    [order.dispatch.payload.orderId])).rows[0].id;
}

beforeAll(async () => {
  database = await createMigratedDatabase("terminal_results");
  h.pool = database.pool;
  serviceId = await seedFixtureService(database.pool, { skillIds: [fixedOutcome.skillId] });
}, DATABASE_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await database?.drop();
}, DATABASE_HOOK_TIMEOUT_MS);

beforeEach(() => {
  h.result = { status: "working" };
  vi.spyOn(ProviderEvidenceVerifier.prototype, "verify")
    .mockImplementation(async () => ({ authorizationKey: `0x${randomBytes(32).toString("hex")}` as Hex }));
  vi.spyOn(ProviderEvidenceVerifier.prototype, "assertNotSanctioned").mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("frozen terminal identity (F-T13, C-T14)", () => {
  it("freezes the unrevealed projection with completion and keeps it through messages, retention and restart", async () => {
    h.result = completed;
    const order = await paidOrder();
    const answer = await service().accept(order);
    expect(answer.state).toBe("completed");
    const id = await taskId(order);
    const frozen = (await database.pool.query(
      "SELECT state,provenance,completed_at,encode(result_hash,'hex') AS hash FROM standard_terminal_results WHERE transaction_id=$1",
      [id],
    )).rows[0];
    const task = (await database.pool.query("SELECT completed_at FROM transactions WHERE id=$1", [id])).rows[0];
    expect(frozen).toMatchObject({ state: "completed", provenance: "terminal-transition" });
    expect(frozen.completed_at.getTime()).toBe(task.completed_at.getTime());
    const projection = await buildStandardTaskProjection({ id, status: "completed" });
    expect(`0x${frozen.hash}`).toBe(canonicalHash(projection));
    const original = await statusAnswer(order);
    expect(original.evidence?.payload).toMatchObject({ state: "completed", resultHash: canonicalHash(projection) });

    // A later buyer support message and agent message change the event log
    // (and the projection earlier releases re-hashed) but not the identity.
    await recordMandatoryAudit(database.pool, {
      transactionId: id, source: "system", type: "transaction.message.user", message: "Where is my report?",
      payload: { content: "Where is my report?", channel: ORDER_SUPPORT_CHANNEL },
    });
    await recordMandatoryAudit(database.pool, {
      transactionId: id, source: "adapter", type: "transaction.message.agent", message: "Late note.",
      payload: { role: "agent", content: "Late note." },
    });
    expect(canonicalHash(await buildStandardTaskProjection({ id, status: "completed" }))).not.toBe(canonicalHash(projection));
    expect((await statusAnswer(order)).evidence?.payload).toEqual(original.evidence?.payload);

    // Retention removes every event of a frozen order; identity and bytes stay.
    await database.pool.query("UPDATE events SET created_at=now() - interval '4000 days' WHERE transaction_id=$1", [id]);
    await runRetention();
    expect((await database.pool.query("SELECT count(*)::int AS n FROM events WHERE transaction_id=$1", [id])).rows[0].n).toBe(0);
    // A fresh service instance (a restart) answers the same identity.
    expect((await statusAnswer(order, service())).evidence?.payload).toEqual(original.evidence?.payload);
    const stored = await loadFrozenTerminalProjection(database.pool, id);
    expect(stored?.projection).toEqual(projection);
  });

  it("reveals only the protected fields frozen with the projection, while authorized and unexpired", async () => {
    h.result = completed;
    const order = await paidOrder();
    await service().accept(order);
    const id = await taskId(order);
    const secret = (field: string, value: string, expiresAt: Date) => database.pool.query(
      `INSERT INTO artifact_secrets (transaction_id,artifact_name,field_path,secret,expires_at) VALUES ($1,'report',$2,$3,$4)`,
      [id, field, encryptString(value, {
        purpose: "customer-artifact", table: "artifact_secrets", recordId: `${id}:report:${field}`, field: "secret",
      }), expiresAt],
    );
    // A secret attached after completion was never part of the frozen result.
    await secret("accessCode", "later-secret", new Date(Date.now() + 3_600_000));
    const frozen = await loadFrozenTerminalProjection(database.pool, id);
    expect(frozen?.references).toEqual([]);
    const revealed = await revealFrozenTaskProjection(id, frozen!.projection, frozen!.references);
    expect(revealed).toEqual(frozen!.projection);
    // With a frozen reference the current, unexpired value is grafted into a
    // separate representation; the frozen projection is untouched.
    const reference = [{ artifactName: "report", fieldPath: "accessCode" }];
    const shown = await revealFrozenTaskProjection(id, frozen!.projection, reference);
    expect(shown.artifacts?.[0]?.parts[0]?.data).toMatchObject({ accessCode: "later-secret" });
    expect(frozen!.projection.artifacts?.[0]?.parts[0]?.data).toMatchObject({ accessCode: "[protected]" });
    expect(canonicalHash(shown)).not.toBe(canonicalHash(frozen!.projection));
    await database.pool.query("UPDATE artifact_secrets SET expires_at=now() - interval '1 second' WHERE transaction_id=$1", [id]);
    const expired = await revealFrozenTaskProjection(id, frozen!.projection, reference);
    expect(expired.artifacts?.[0]?.parts[0]?.data).toMatchObject({ accessCode: "[protected]" });
  });

  it("keeps publishing the frozen identity after an internal revival of the task", async () => {
    h.result = { status: "failed", error: "supplier refused" };
    const order = await paidOrder();
    await service().accept(order);
    const failed = await statusAnswer(order);
    expect(failed.body.state).toBe("failed");
    const id = await taskId(order);
    // An admin-path revival (failed -> working -> completed) is internal: the
    // public terminal identity stays the original failure.
    await processAdapterResult(id, completed, serviceId);
    expect((await database.pool.query("SELECT status FROM transactions WHERE id=$1", [id])).rows[0].status).toBe("completed");
    const after = await statusAnswer(order);
    expect(after.body.state).toBe("failed");
    expect(after.evidence?.payload).toEqual(failed.evidence?.payload);
  });

  it("lets an order whose deliverables have no canonical form become terminal, unfrozen and unanswered", async () => {
    h.result = { status: "completed", message: "Report ready.", artifacts: [{ name: "report", data: { prototype: "v2" } }] };
    const order = await paidOrder();
    // The supplier's work is persisted and the order completes; only the
    // signed answer is withheld, never replaced by a guess.
    await expect(service().accept(order)).rejects.toMatchObject({ name: "DispatchAmbiguousError" });
    const id = await taskId(order);
    expect((await database.pool.query("SELECT status FROM transactions WHERE id=$1", [id])).rows[0].status).toBe("completed");
    expect((await database.pool.query(
      "SELECT count(*)::int AS n FROM standard_terminal_results WHERE transaction_id=$1", [id])).rows[0].n).toBe(0);
    expect((await database.pool.query(
      "SELECT count(*)::int AS n FROM standard_security_incidents WHERE incident_kind='noncanonical_terminal_result' AND order_id=$1",
      [order.dispatch.payload.orderId])).rows[0].n).toBe(1);
    await expect(service().status(await statusQuery(order))).rejects.toMatchObject({ status: 503 });
    // Reconciliation cannot freeze a reconstruction that has no canonical form either.
    await expect(recordLegacyTerminalEvidence(config, {
      transactionId: id, kind: "unobserved", reference: "handoff-1", actor: "operator@example.com",
    })).resolves.toEqual({ status: "unresolved", diagnostic: "legacy_projection_noncanonical" });
  });

  it("refuses any change to a frozen identity except re-encryption and a one-way isolation", async () => {
    h.result = completed;
    const order = await paidOrder();
    await service().accept(order);
    const id = await taskId(order);
    for (const statement of [
      "UPDATE standard_terminal_results SET state='failed' WHERE transaction_id=$1",
      "UPDATE standard_terminal_results SET result_hash=decode(repeat('00',32),'hex') WHERE transaction_id=$1",
      "UPDATE standard_terminal_results SET completed_at=now() WHERE transaction_id=$1",
      "UPDATE standard_terminal_results SET projection_encrypted=NULL WHERE transaction_id=$1",
      "DELETE FROM standard_terminal_results WHERE transaction_id=$1",
    ]) {
      await expect(database.pool.query(statement, [id])).rejects.toThrow(/standard terminal results/);
    }
    const reencrypted = encryptString(JSON.stringify((await loadFrozenTerminalProjection(database.pool, id))!.projection),
      terminalProjectionContext(id));
    await database.pool.query("UPDATE standard_terminal_results SET projection_encrypted=$2 WHERE transaction_id=$1", [id, reencrypted]);
    await database.pool.query("UPDATE standard_terminal_results SET isolated_diagnostic='legacy_evidence_conflict' WHERE transaction_id=$1", [id]);
    await expect(database.pool.query("UPDATE standard_terminal_results SET isolated_diagnostic=NULL WHERE transaction_id=$1", [id]))
      .rejects.toThrow(/immutable/);
    // An isolated identity is never answered.
    await expect(service().status(await statusQuery(order))).rejects.toMatchObject({ status: 503 });
  });
});

describe("event retention and unfrozen standard orders (C04)", () => {
  it("keeps the events of nonterminal and unreconciled terminal orders, never frozen results", async () => {
    const order = await paidOrder();
    await service().accept(order);
    const id = await taskId(order);
    await recordMandatoryAudit(database.pool, {
      transactionId: id, source: "adapter", type: "transaction.message.agent", message: "Working.",
      payload: { role: "agent", content: "Working." },
    });
    await database.pool.query("UPDATE events SET created_at=now() - interval '4000 days' WHERE transaction_id=$1", [id]);
    const frozenBefore = (await database.pool.query("SELECT count(*)::int AS n FROM standard_terminal_results")).rows[0].n;
    await runRetention();
    expect((await database.pool.query("SELECT count(*)::int AS n FROM events WHERE transaction_id=$1", [id])).rows[0].n)
      .toBeGreaterThan(0);
    expect(frozenBefore).toBeGreaterThan(0);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM standard_terminal_results")).rows[0].n)
      .toBe(frozenBefore);
  });
});
