import { randomBytes } from "node:crypto";
import express, { Router } from "express";
import type pg from "pg";
import type { Hex } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import type { AdapterResult } from "../src/core/serviceRegistry/types.js";
import { faultyClient, postJson, startRailServer, statusQuery } from "./dispatchHttpHarness.js";
import type { DispatchArgs } from "./dispatchWire.js";
import { gatewayDispatch } from "./dispatchWire.js";
import {
  acceptDispatchResponse,
  classifyDispatchAnswer,
  classifyStatusAnswer,
  readGatewayJson,
} from "./gatewayConsumer.js";
import { paidOrderHarness } from "./paidOrderHarness.js";
import { createMigratedDatabase, type DisposableDatabase } from "./postgresHarness.js";
import {
  CHAIN_ID, fixedOutcome, fixtureConfig, otherKey, payerB, provider, seedFixtureService,
} from "./standardRailFixture.js";

// C03 / C-T11: definite refusal before admission, the signed snapshot (or an
// empty 503) once admission exists or is uncertain, and the no-claim 404 only
// for proven absence.
const h = vi.hoisted(() => ({
  pool: null as pg.Pool | null,
  fault: { mode: null as "after" | "before" | null },
  snapshotFailures: 0,
  evidenceDelayMs: 0,
  failClaimLookup: false,
  result: { status: "completed" } as AdapterResult,
  executions: 0,
}));
vi.mock("../src/core/db/pool.js", () => ({
  pool: {
    query: (...args: unknown[]) => {
      if (h.failClaimLookup && typeof args[0] === "string" &&
          args[0].startsWith("SELECT dispatch_hash,transaction_id FROM standard_dispatch_claims")) {
        return Promise.reject(new Error("database unavailable"));
      }
      return (h.pool!.query as (...a: unknown[]) => unknown)(...args);
    },
    connect: async () => faultyClient(await h.pool!.connect(), h.fault),
  },
}));
vi.mock("../src/core/serviceRegistry/registry.js", () => ({
  getAdapter: () => ({
    execute: async () => { h.executions += 1; return h.result; },
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
vi.mock("../src/core/standardRail/dispatchResponse.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/core/standardRail/dispatchResponse.js")>();
  return {
    ...original,
    signedDispatchSnapshot: (...args: Parameters<typeof original.signedDispatchSnapshot>) => {
      if (h.snapshotFailures > 0) {
        h.snapshotFailures -= 1;
        return Promise.reject(new Error("signer unavailable"));
      }
      return original.signedDispatchSnapshot(...args);
    },
  };
});

const { StandardQuoteService } = await import("../src/core/standardRail/quote.js");
const { ProviderEvidenceVerifier } = await import("../src/core/standardRail/evidence.js");
const { mountProtocolRoutes } = await import("../src/core/standardRail/protocolRoutes.js");

const config = fixtureConfig();
const request = { item: "widget" };
let database: DisposableDatabase;
let rail: Awaited<ReturnType<typeof startRailServer>>;
const { paidOrder, redispatch } = paidOrderHarness({
  config, request, quoteService: () => new StandardQuoteService(config, CHAIN_ID),
});
const expectation = (dispatchHash: Hex) => ({
  dispatchHash, providerAuthorityKey: provider.address, terminalAttestationKey: provider.address,
  now: Math.floor(Date.now() / 1_000),
});
const NO_CLAIM = '{"error":"dispatch_status_unavailable","reason":"outcome_policy"}';

beforeAll(async () => {
  database = await createMigratedDatabase("dispatch_outcomes");
  h.pool = database.pool;
  await seedFixtureService(database.pool, { skillIds: [fixedOutcome.skillId] });
  rail = await startRailServer(config);
});

afterAll(async () => {
  await rail.close();
  await database.drop();
});

beforeEach(() => {
  h.fault.mode = null;
  h.snapshotFailures = 0;
  h.evidenceDelayMs = 0;
  h.failClaimLookup = false;
  h.result = { status: "completed" };
  h.executions = 0;
  vi.spyOn(ProviderEvidenceVerifier.prototype, "verify").mockImplementation(async () => {
    if (h.evidenceDelayMs) await new Promise((resolve) => setTimeout(resolve, h.evidenceDelayMs));
    return { authorizationKey: `0x${randomBytes(32).toString("hex")}` as Hex };
  });
  vi.spyOn(ProviderEvidenceVerifier.prototype, "assertNotSanctioned").mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const dispatchOrder = (order: DispatchArgs) => postJson(`${rail.base}/dispatch`, order);
const queryStatus = async (order: DispatchArgs, options?: Parameters<typeof statusQuery>[1]) =>
  postJson(`${rail.base}/dispatch/status`, { query: await statusQuery(order, options) });

async function tasksFor(orderId: string): Promise<number> {
  return Number((await database.pool.query(
    "SELECT count(*)::int AS n FROM transactions WHERE standard_order_id=$1", [orderId],
  )).rows[0].n);
}

async function expectEmpty503(response: Response) {
  expect(response.status).toBe(503);
  expect(response.headers.get("content-type")).toBeNull();
  expect(await response.clone().text()).toBe("");
  expect(await classifyDispatchAnswer(response)).toBe("ambiguous");
}

async function settledStatus(order: DispatchArgs): Promise<Response> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await queryStatus(order);
    if (response.status !== 503) return response;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("status never settled");
}

describe("dispatch recovery outcomes (C-T11)", () => {
  it("proves absence for a lost request with exactly the reviewed no-claim body", async () => {
    const order = await paidOrder();
    const response = await queryStatus(order);
    expect(response.status).toBe(404);
    expect(await response.clone().text()).toBe(NO_CLAIM);
    expect(await classifyStatusAnswer(response)).toBe("no_claim");
  });

  it("answers a lost response by status with the original hash", async () => {
    const order = await paidOrder();
    await (await dispatchOrder(order)).arrayBuffer();
    const response = await queryStatus(order);
    expect(await classifyStatusAnswer(response.clone())).toBe("snapshot");
    const accepted = await acceptDispatchResponse(await readGatewayJson(response), expectation(canonicalHash(order.dispatch)));
    expect(accepted.body.state).toBe("completed");
  });

  it("finishes and answers its own admission when only the commit acknowledgement was lost", async () => {
    const order = await paidOrder();
    h.fault.mode = "after";
    const response = await dispatchOrder(order);
    expect(await classifyDispatchAnswer(response.clone())).toBe("accepted");
    await acceptDispatchResponse(await readGatewayJson(response), expectation(canonicalHash(order.dispatch)));
    expect(h.executions).toBe(1);
    expect(await tasksFor(order.dispatch.payload.orderId)).toBe(1);
  });

  it("stays ambiguous when the commit never happened, then proves absence", async () => {
    const order = await paidOrder();
    h.fault.mode = "before";
    await expectEmpty503(await dispatchOrder(order));
    expect(h.executions).toBe(0);
    const status = await settledStatus(order);
    expect(await status.clone().text()).toBe(NO_CLAIM);
    expect(await tasksFor(order.dispatch.payload.orderId)).toBe(0);
  });

  it("never turns a signing failure after admission into a JSON refusal", async () => {
    const order = await paidOrder();
    h.snapshotFailures = 1;
    await expectEmpty503(await dispatchOrder(order));
    expect(h.executions).toBe(1);
    h.snapshotFailures = 1;
    const failedStatus = await queryStatus(order);
    expect(failedStatus.status).toBe(503);
    await expect(failedStatus.json()).resolves.toEqual({ error: "dispatch_status_unavailable", reason: "unavailable" });
    const recovered = await queryStatus(order);
    expect(await classifyStatusAnswer(recovered)).toBe("snapshot");
  });

  it("keeps a replacement envelope from displacing admitted work", async () => {
    const order = await paidOrder();
    expect(await classifyDispatchAnswer(await dispatchOrder(order))).toBe("accepted");
    const replacement = await redispatch(order);
    await expectEmpty503(await dispatchOrder(replacement));
    expect(await tasksFor(order.dispatch.payload.orderId)).toBe(1);
    expect(h.executions).toBe(1);
    const conflict = await queryStatus(replacement);
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({ error: "dispatch_status_unavailable", reason: "dispatch_conflict" });
    const incidents = await database.pool.query(
      "SELECT count(*)::int AS n FROM standard_security_incidents WHERE incident_kind='changed_dispatch_replay' AND order_id=$1",
      [order.dispatch.payload.orderId],
    );
    expect(incidents.rows[0].n).toBe(1);
    await expect(database.pool.query("DELETE FROM standard_dispatch_claims WHERE order_id=$1",
      [order.dispatch.payload.orderId])).rejects.toMatchObject({ code: "23000" });
  });

  it("fences a slow request at the admission commit, so absence is provable afterwards", async () => {
    const order = await paidOrder();
    const nearlyExpired = await gatewayDispatch({
      outcome: fixedOutcome, quote: order.quote, request, payer: order.dispatch.payload.payer,
      issuedAt: Math.floor(Date.now() / 1_000) - fixedOutcome.dispatchDeadlineSeconds + 1,
      reputationContract: config.reputationContract, outcomeSchemaUid: config.reputationOutcomeSchemaUid,
    });
    h.evidenceDelayMs = 2_100;
    const response = await dispatchOrder(nearlyExpired);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "dispatch_rejected", reason: "envelope_lifetime" });
    expect(h.executions).toBe(0);
    expect(await tasksFor(nearlyExpired.dispatch.payload.orderId)).toBe(0);
    expect(await (await queryStatus(nearlyExpired)).text()).toBe(NO_CLAIM);
  });

  it("does not claim absence while an admission for the order is in flight", async () => {
    const order = await paidOrder();
    const holder = await database.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('standard-dispatch-claim:' || $1 || ':' || $2, 0))",
        [config.gatewayAudience, order.dispatch.payload.orderId],
      );
      const busy = await queryStatus(order);
      expect(busy.status).toBe(503);
      await expect(busy.json()).resolves.toEqual({ error: "dispatch_status_unavailable", reason: "admission_in_progress" });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    expect(await (await queryStatus(order)).text()).toBe(NO_CLAIM);
  });

  it("never uses outcome_policy for authentication, freshness or lookup failures", async () => {
    const order = await paidOrder();
    const cases: Array<[Promise<Response>, number, Record<string, string>]> = [
      [queryStatus(order, { privateKey: otherKey }), 401, { error: "dispatch_status_rejected", reason: "signature" }],
      [queryStatus(order, { issuedAt: Math.floor(Date.now() / 1_000) - 200 }), 400,
        { error: "dispatch_status_rejected", reason: "envelope_lifetime" }],
      [queryStatus(order, { artifactType: "ProviderQuoteRequestV1" }), 400,
        { error: "dispatch_status_rejected", reason: "validator" }],
      [postJson(`${rail.base}/dispatch/status`, { query: {} }), 400,
        { error: "dispatch_status_rejected", reason: "validator" }],
    ];
    for (const [pending, status, body] of cases) {
      const response = await pending;
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual(body);
    }
    h.failClaimLookup = true;
    const unavailable = await queryStatus(order);
    expect(unavailable.status).toBe(503);
    expect(await classifyStatusAnswer(unavailable)).toBe("unknown");
  });

  it("refuses definitely, with a reviewed reason, only before any admission", async () => {
    const order = await paidOrder({ dispatchPayer: payerB });
    const response = await dispatchOrder(order);
    expect(await classifyDispatchAnswer(response.clone())).toBe("refused");
    await expect(response.json()).resolves.toEqual({ error: "dispatch_rejected", reason: "price" });
    h.failClaimLookup = true;
    await expectEmpty503(await dispatchOrder(await paidOrder()));
  });

  it("keeps errors that escape the dispatch handler ambiguous", async () => {
    const router = Router();
    router.post("/dispatch", (_req, _res, next) => next(new Error("unexpected")));
    mountProtocolRoutes(router, { quote: {} as never, dispatch: {} as never });
    const app = express();
    app.use(express.json());
    app.use("/standard-rail", router);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      await expectEmpty503(await postJson(`http://127.0.0.1:${port}/standard-rail/dispatch`, {}));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
