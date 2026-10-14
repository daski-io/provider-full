import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import type { Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import type { AdapterResult, FulfillmentAdapter } from "../src/core/serviceRegistry/types.js";
import type { DispatchStatusQueryV1, SignedEnvelope } from "../src/core/standardRail/types.js";
import type { DispatchArgs } from "./dispatchWire.js";
import {
  acceptDispatchResponse,
  gatewayOperationsDecision,
  semanticOperationsHash,
  signGatewayEnvelope,
} from "./gatewayConsumer.js";
import { paidOrderHarness } from "./paidOrderHarness.js";
import { createMigratedDatabase, DATABASE_HOOK_TIMEOUT_MS, type DisposableDatabase } from "./postgresHarness.js";
import {
  CHAIN_ID, ENVIRONMENT, fixedOutcome, fixtureConfig, gatewayKey, provider, PROVIDER_AUDIENCE,
  seedFixtureService,
} from "./standardRailFixture.js";

// Database-backed protocol tests: allow for a loaded shared host.
vi.setConfig({ testTimeout: 30_000 });
const h = vi.hoisted(() => ({
  pool: null as pg.Pool | null,
  result: { status: "working" } as AdapterResult,
  execute: null as unknown as FulfillmentAdapter["execute"],
}));
vi.mock("../src/core/db/pool.js", () => ({
  pool: {
    query: (...args: unknown[]) => (h.pool!.query as (...a: unknown[]) => unknown)(...args),
    connect: () => h.pool!.connect(),
  },
}));
vi.mock("../src/core/serviceRegistry/registry.js", () => ({
  getAdapter: () => ({
    execute: (...args: Parameters<FulfillmentAdapter["execute"]>) => h.execute(...args),
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

const config = fixtureConfig();
const request = { item: "widget" };
let database: DisposableDatabase;
const { paidOrder } = paidOrderHarness({
  config, request, quoteService: () => new StandardQuoteService(config, CHAIN_ID),
});
const service = () => new StandardDispatchService(config, baseSepolia, CHAIN_ID);
const now = () => Math.floor(Date.now() / 1_000);
const expectation = (dispatchHash: Hex, at = now()) => ({
  dispatchHash, providerAuthorityKey: provider.address, terminalAttestationKey: provider.address, now: at,
});

beforeAll(async () => {
  database = await createMigratedDatabase("operations");
  h.pool = database.pool;
  await seedFixtureService(database.pool, { skillIds: [fixedOutcome.skillId] });
}, DATABASE_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await database?.drop();
}, DATABASE_HOOK_TIMEOUT_MS);

beforeEach(() => {
  h.result = { status: "working" };
  h.execute = vi.fn(async () => h.result);
  vi.spyOn(ProviderEvidenceVerifier.prototype, "verify")
    .mockImplementation(async () => ({ authorizationKey: `0x${randomBytes(32).toString("hex")}` as Hex }));
  vi.spyOn(ProviderEvidenceVerifier.prototype, "assertNotSanctioned").mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function statusQuery(order: DispatchArgs): Promise<SignedEnvelope<DispatchStatusQueryV1>> {
  const issuedAt = now();
  return signGatewayEnvelope<DispatchStatusQueryV1>({
    artifactType: "DispatchStatusQueryV1", environment: ENVIRONMENT, chainId: CHAIN_ID,
    audience: PROVIDER_AUDIENCE, signerKeyId: "gateway-dispatch", privateKey: gatewayKey,
    issuedAt, validBefore: issuedAt + 60,
    payload: { orderId: order.dispatch.payload.orderId, dispatchHash: canonicalHash(order.dispatch), issuedAt, validBefore: issuedAt + 60 },
  }) as Promise<SignedEnvelope<DispatchStatusQueryV1>>;
}

async function admitted(result: AdapterResult) {
  h.result = result;
  const order = await paidOrder();
  const response = await service().accept(order);
  return { order, response, dispatchHash: canonicalHash(order.dispatch) };
}

async function databaseNow(): Promise<number> {
  return Number((await database.pool.query("SELECT floor(extract(epoch FROM now()))::int AS now")).rows[0].now);
}

describe("dispatch and status answers pass gateway validation (C-T02)", () => {
  it("signs a pending answer with an all-null revision-0 observation and no attestation", async () => {
    const { response, dispatchHash } = await admitted({ status: "working" });
    const accepted = await acceptDispatchResponse(response, expectation(dispatchHash));
    expect(accepted.body.state).toBe("working");
    expect(accepted.evidence).toBeNull();
    expect(accepted.operations).toMatchObject({ schemaVersion: 1, revision: 0, fulfillment: null, support: null, recovery: null });
    expect(Math.abs(accepted.operations.observedAt - await databaseNow())).toBeLessThanOrEqual(1);
  });

  it("attests a terminal answer and keeps the same identity on the status path", async () => {
    const { order, response, dispatchHash } = await admitted({
      status: "completed", artifacts: [{ name: "receipt", data: { ok: true } }],
    });
    const fromDispatch = await acceptDispatchResponse(response, expectation(dispatchHash));
    const fromStatus = await acceptDispatchResponse(
      await service().status(await statusQuery(order)), expectation(dispatchHash),
    );
    expect(fromDispatch.evidence?.payload).toMatchObject({ taskId: response.taskId, state: "completed" });
    expect(fromStatus.evidence?.payload).toEqual(fromDispatch.evidence?.payload);
    const completedAt = (await database.pool.query(
      "SELECT floor(extract(epoch FROM completed_at))::int AS at FROM transactions WHERE id=$1", [response.taskId],
    )).rows[0].at;
    expect(fromDispatch.evidence?.payload.completedAt).toBe(completedAt);
  });

  it("is invalidated by any change to state, operations or attestation data", async () => {
    const pending = await admitted({ status: "working" });
    const terminal = await admitted({ status: "completed", artifacts: [{ name: "receipt", data: { ok: true } }] });
    const tampered = (base: unknown, change: (body: Record<string, any>) => void) => {
      const copy = structuredClone(base) as Record<string, any>;
      change(copy);
      return copy;
    };
    for (const change of [
      (body: Record<string, any>) => { body.state = "submitted"; },
      (body: Record<string, any>) => { body.operations.revision = 1; },
      (body: Record<string, any>) => { body.operations.observedAt -= 1; },
      (body: Record<string, any>) => { body.taskId = `${body.taskId}x`; },
      (body: Record<string, any>) => { body.terminalAttestation = terminal.response.terminalAttestation; },
    ]) {
      await expect(acceptDispatchResponse(tampered(pending.response, change), expectation(pending.dispatchHash)))
        .rejects.toThrow();
    }
    for (const change of [
      (body: Record<string, any>) => { body.terminalAttestation.payload.resultHash = `0x${"ab".repeat(32)}`; },
      (body: Record<string, any>) => { body.terminalAttestation.payload.completedAt -= 1; },
      (body: Record<string, any>) => { delete body.terminalAttestation; },
      (body: Record<string, any>) => { body.state = "failed"; },
    ]) {
      await expect(acceptDispatchResponse(tampered(terminal.response, change), expectation(terminal.dispatchHash)))
        .rejects.toThrow();
    }
  });
});

describe("fresh observations of unchanged orders (C-T10)", () => {
  async function age(taskId: string, seconds: number) {
    await database.pool.query(
      `UPDATE transactions SET created_at=created_at-make_interval(secs=>$2),
              updated_at=updated_at-make_interval(secs=>$2),
              completed_at=completed_at-make_interval(secs=>$2)
        WHERE id=$1`, [taskId, seconds],
    );
    await database.pool.query(
      "UPDATE standard_dispatch_claims SET claimed_at=claimed_at-make_interval(secs=>$2) WHERE transaction_id=$1",
      [taskId, seconds],
    );
  }

  it.each([6 * 60, 8 * 3_600])("re-observes a pending order %i s later with a fresh stamp and stable revision",
    async (seconds) => {
      const { order, response, dispatchHash } = await admitted({ status: "working" });
      const first = await acceptDispatchResponse(response, expectation(dispatchHash));
      await age(response.taskId, seconds);
      const later = await acceptDispatchResponse(await service().status(await statusQuery(order)), expectation(dispatchHash));
      expect(later.operations.revision).toBe(first.operations.revision);
      expect(semanticOperationsHash(later.operations)).toBe(semanticOperationsHash(first.operations));
      expect(later.operations.observedAt).toBeGreaterThanOrEqual(first.operations.observedAt);
      // A cached copy of the first answer would be stale once five minutes pass.
      await expect(acceptDispatchResponse(response, expectation(dispatchHash, first.operations.observedAt + 301)))
        .rejects.toThrow("provider_operations_observation_stale");
    });

  it("keeps a completed order's terminal identity while each read stamps and signs anew", async () => {
    const { order, response, dispatchHash } = await admitted({
      status: "completed", artifacts: [{ name: "receipt", data: { ok: true } }],
    });
    await age(response.taskId, 8 * 3_600);
    const first = await acceptDispatchResponse(await service().status(await statusQuery(order)), expectation(dispatchHash));
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const second = await acceptDispatchResponse(await service().status(await statusQuery(order)), expectation(dispatchHash));
    expect(second.evidence?.payload).toEqual(first.evidence?.payload);
    expect(second.operations.observedAt).toBeGreaterThan(first.operations.observedAt);
    expect(second.body.signature).not.toBe(first.body.signature);
    expect(gatewayOperationsDecision({
      revision: first.operations.revision,
      observedAt: first.operations.observedAt,
      projectionHash: semanticOperationsHash(first.operations),
    }, second.operations)).toBe("store");
  });

  it("writes nothing and calls no product while answering repeated status reads", async () => {
    const { order, response } = await admitted({ status: "working" });
    const versions = async () => (await database.pool.query(
      `SELECT c.xmin::text AS claim,t.xmin::text AS task FROM standard_dispatch_claims c
         JOIN transactions t ON t.id=c.transaction_id WHERE c.transaction_id=$1`, [response.taskId],
    )).rows[0];
    const before = await versions();
    vi.mocked(h.execute).mockClear();
    for (let read = 0; read < 5; read += 1) await service().status(await statusQuery(order));
    expect(await versions()).toEqual(before);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("requires a higher revision for changed content and signs the new projection", async () => {
    const { order, response, dispatchHash } = await admitted({ status: "working" });
    const first = await acceptDispatchResponse(response, expectation(dispatchHash));
    const support = {
      reviewId: randomUUID(), status: "open",
      lastAcceptedRequest: { requestId: randomUUID(), messageId: randomUUID(), acceptedAt: now() },
    };
    const projection = JSON.stringify({ fulfillment: null, support, recovery: null });
    const update = (revision: number, value: string) => database.pool.query(
      "UPDATE standard_dispatch_claims SET operations_revision=$2,operations_projection=$3::jsonb WHERE transaction_id=$1",
      [response.taskId, revision, value],
    );
    await expect(update(0, projection)).rejects.toMatchObject({ code: "23000" });
    await expect(update(1, JSON.stringify({ fulfillment: null, support: null, recovery: null })))
      .rejects.toMatchObject({ code: "23000" });
    await update(1, projection);
    await expect(update(0, projection)).rejects.toMatchObject({ code: "23000" });
    const changed = await acceptDispatchResponse(await service().status(await statusQuery(order)), expectation(dispatchHash));
    expect(changed.operations).toMatchObject({ revision: 1, support });
    const stored = {
      revision: first.operations.revision, observedAt: first.operations.observedAt,
      projectionHash: semanticOperationsHash(first.operations),
    };
    expect(gatewayOperationsDecision(stored, changed.operations)).toBe("store");
    // The same content under the old revision is what the gateway refuses.
    expect(gatewayOperationsDecision(stored, { ...changed.operations, revision: 0 })).toBe("conflict");
  });
});
