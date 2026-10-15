import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import type { Config } from "../src/core/config.js";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import type { FulfillmentAdapter } from "../src/core/serviceRegistry/types.js";
import {
  acceptIntakeResponse,
  acceptProviderQuote,
  gatewayQuoteFieldErrors,
  readGatewayJson,
  signGatewayEnvelope,
} from "./gatewayConsumer.js";
import { createMigratedDatabase, DATABASE_HOOK_TIMEOUT_MS, type DisposableDatabase } from "./postgresHarness.js";
import {
  CHAIN_ID, dynamicOutcome, ENVIRONMENT, fixedOutcome, fixtureConfig, gatewayKey, hash, otherKey,
  payerA, provider, PROVIDER_AUDIENCE, seedFixtureService,
} from "./standardRailFixture.js";

// Database-backed protocol tests: allow for a loaded shared host.
vi.setConfig({ testTimeout: 30_000 });
const h = vi.hoisted(() => ({
  pool: null as pg.Pool | null,
  adapter: null as unknown as FulfillmentAdapter,
}));
vi.mock("../src/core/db/pool.js", () => ({
  pool: {
    query: (...args: unknown[]) => (h.pool!.query as (...a: unknown[]) => unknown)(...args),
    connect: () => h.pool!.connect(),
  },
}));
vi.mock("../src/core/serviceRegistry/registry.js", () => ({
  getAdapter: () => h.adapter,
  getService: () => null,
  getAllServices: () => [],
}));

const { createStandardRailRouter } = await import("../src/core/standardRail/routes.js");
const { standardRailJsonIngress } = await import("../src/core/standardRail/transport.js");

let database: DisposableDatabase;
let server: Server;
let base: string;
const request = { item: "widget", tier: "basic" };
const lowerPayer = payerA.toLowerCase() as Hex;

function syntheticAdapter(overrides: Partial<FulfillmentAdapter> = {}): FulfillmentAdapter {
  return {
    execute: vi.fn(),
    handleInput: vi.fn(),
    cancel: vi.fn(),
    quote: vi.fn(async (skillId: string) => ({
      ok: true as const,
      amount: skillId === fixedOutcome.skillId ? 250_000n : 1_234_567n,
      currency: "USDC" as const,
      ...(skillId === dynamicOutcome.skillId ? {
        supplierCost: { supplier: "synthetic-supplier", currency: "USD", amount: "4.25" },
      } : {}),
    })),
    ...overrides,
  };
}

beforeAll(async () => {
  database = await createMigratedDatabase("quote");
  h.pool = database.pool;
  await seedFixtureService(database.pool, { skillIds: [fixedOutcome.skillId, dynamicOutcome.skillId] });
  const app = express();
  app.use("/standard-rail", ...standardRailJsonIngress(),
    createStandardRailRouter({ CHAIN_ID } as Config, fixtureConfig(), undefined, { salesAdmission: async () => ({ status: "open" as const }), contractIntegrity: async () => undefined }));
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/standard-rail`;
}, DATABASE_HOOK_TIMEOUT_MS);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await database?.drop();
}, DATABASE_HOOK_TIMEOUT_MS);

beforeEach(async () => {
  h.adapter = syntheticAdapter();
  // A disposable reset: a provider quote is otherwise kept for its whole
  // first-dispatch window (core migration 016).
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query("DELETE FROM standard_provider_quotes");
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  await database.pool.query("UPDATE services SET is_active=true");
});

const now = () => Math.floor(Date.now() / 1_000);

async function quoteEnvelope(args: {
  outcome?: typeof fixedOutcome;
  body?: Record<string, unknown>;
  payer?: Hex | null | string;
  artifactType?: string;
  issuedAt?: number;
  validBefore?: number;
  environment?: string;
  chainId?: number;
  audience?: string;
  signerKeyId?: string;
  privateKey?: Hex;
  payload?: Record<string, unknown>;
} = {}) {
  const outcome = args.outcome ?? fixedOutcome;
  const body = args.body ?? request;
  const issuedAt = args.issuedAt ?? now();
  return signGatewayEnvelope({
    artifactType: args.artifactType ?? "ProviderQuoteRequestV1",
    environment: args.environment ?? ENVIRONMENT,
    chainId: args.chainId ?? CHAIN_ID,
    audience: args.audience ?? PROVIDER_AUDIENCE,
    signerKeyId: args.signerKeyId ?? "gateway-dispatch",
    privateKey: args.privateKey ?? gatewayKey,
    issuedAt,
    validBefore: args.validBefore ?? issuedAt + 60,
    payload: args.payload ?? {
      outcomeId: outcome.outcomeId,
      listingManifestHash: outcome.listingManifestHash,
      requestHash: canonicalHash(body),
      request: body,
      payer: args.payer === undefined ? lowerPayer : args.payer,
    },
  });
}

async function postQuote(envelope: unknown): Promise<{ status: number; body: unknown; response: Response }> {
  const response = await fetch(`${base}/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request: envelope }),
  });
  return { status: response.status, body: await readGatewayJson(response.clone()), response };
}

async function quoteRows() {
  return (await database.pool.query(
    `SELECT encode(quote_hash,'hex') AS quote_hash,payer,pricing_mode,gross_amount::text AS gross,
            supplier_cost_ceiling,extract(epoch FROM issued_at)::int AS issued_at,
            extract(epoch FROM valid_before)::int AS valid_before
       FROM standard_provider_quotes`,
  )).rows;
}

function expectationFor(outcome: typeof fixedOutcome, payer: Hex | null, receivedAt = now()) {
  return {
    outcomeId: outcome.outcomeId,
    listingManifestHash: outcome.listingManifestHash,
    requestHash: canonicalHash(request),
    payer,
    fixed: outcome.pricingMode === "fixed",
    fixedGrossAmount: outcome.fixedGrossAmount,
    providerAuthorityKey: provider.address,
    minimumPaymentWindowSeconds: 30,
    maximumLifetimeSeconds: outcome.pricingMode === "dynamic" ? 180 : null,
    commissionBps: outcome.commissionBps,
    receivedAt,
  };
}

describe("fixed readiness quotes (C-T01)", () => {
  it("signs the exact payer-bound response the gateway verifies and persists its bindings", async () => {
    const { status, body } = await postQuote(await quoteEnvelope());
    expect(status).toBe(200);
    const accepted = await acceptProviderQuote(body, expectationFor(fixedOutcome, lowerPayer));
    expect(accepted.grossAmount).toBe(fixedOutcome.fixedGrossAmount);
    expect(accepted.validBefore - accepted.issuedAt).toBe(120);
    expect((body as { payer: unknown }).payer).toBe(lowerPayer);
    const rows = await quoteRows();
    expect(rows).toEqual([expect.objectContaining({
      quote_hash: accepted.providerQuoteHash.slice(2),
      payer: lowerPayer,
      pricing_mode: "fixed",
      gross: "250000",
      supplier_cost_ceiling: null,
      issued_at: accepted.issuedAt,
      valid_before: accepted.validBefore,
    })]);
    expect(accepted.providerQuoteHash).not.toBe(hash("0"));
  });

  it("echoes a null payer literally for a payer-unbound readiness check", async () => {
    const { status, body } = await postQuote(await quoteEnvelope({ payer: null }));
    expect(status).toBe(200);
    await acceptProviderQuote(body, expectationFor(fixedOutcome, null));
    expect((await quoteRows())[0]?.payer).toBeNull();
  });

  it("records a fixed listing's reported supplier cost with the configured price tolerance", async () => {
    h.adapter = syntheticAdapter({
      quote: vi.fn(async () => ({
        ok: true as const, amount: 250_000n, currency: "USDC" as const,
        supplierCost: { supplier: "synthetic-supplier", currency: "USD", amount: "1.20" },
      })),
    });
    const app = express();
    app.use("/standard-rail", ...standardRailJsonIngress(), createStandardRailRouter(
      { CHAIN_ID, SUPPLIER_PRICE_TOLERANCE_PERCENT: "2.5" } as Config, fixtureConfig(), undefined,
      { salesAdmission: async () => ({ status: "open" as const }), contractIntegrity: async () => undefined },
    ));
    const local = app.listen(0, "127.0.0.1");
    await once(local, "listening");
    try {
      const answered = await fetch(`http://127.0.0.1:${(local.address() as AddressInfo).port}/standard-rail/quote`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ request: await quoteEnvelope() }),
      });
      expect(answered.status).toBe(200);
      expect(await quoteRows()).toEqual([expect.objectContaining({
        pricing_mode: "fixed",
        gross: "250000",
        supplier_cost_ceiling: {
          kind: "supplier-cost-ceiling-v2", supplier: "synthetic-supplier", currency: "USD",
          quotedAmount: "1.20", tolerancePercent: "2.5",
        },
      })]);
    } finally {
      await new Promise<void>((resolve) => local.close(() => resolve()));
    }
  });

  it("keeps the listing price even when asked twice, and refuses a drifted service price", async () => {
    h.adapter = syntheticAdapter({
      quote: vi.fn(async () => ({ ok: true as const, amount: 999_999n, currency: "USDC" as const })),
    });
    const { status, body } = await postQuote(await quoteEnvelope());
    expect(status).toBe(503);
    expect(body).toEqual({ error: "quote_unavailable", reason: "price" });
    expect(await quoteRows()).toEqual([]);
  });

  it.each([
    ["a checksummed payer", { payer: payerA }, 400, "envelope"],
    ["an expired envelope", { issuedAt: now() - 90, validBefore: now() - 1 }, 400, "envelope_lifetime"],
    ["a future envelope", { issuedAt: now() + 60, validBefore: now() + 90 }, 400, "envelope_lifetime"],
    ["another environment", { environment: "mainnet" }, 400, "envelope"],
    ["another chain", { chainId: 8453 }, 400, "envelope"],
    ["another audience", { audience: "https://other.example" }, 400, "envelope"],
    ["another signer key id", { signerKeyId: "gateway-lifecycle" }, 400, "envelope"],
    ["a different signer", { privateKey: otherKey }, 401, "signature"],
    ["a status-query artifact type", { artifactType: "DispatchStatusQueryV1" }, 400, "envelope"],
  ])("refuses %s before any service work", async (_label, args, status, reason) => {
    const result = await postQuote(await quoteEnvelope(args as never));
    expect(result.status).toBe(status);
    expect(result.body).toEqual({ error: "quote_rejected", reason });
    expect(h.adapter.quote).not.toHaveBeenCalled();
    expect(await quoteRows()).toEqual([]);
  });

  it("refuses malformed payloads, request-hash drift and unknown outcomes before work", async () => {
    const valid = (await quoteEnvelope()).payload as Record<string, unknown>;
    const { payer: _payer, ...withoutPayer } = valid;
    const missingPayer = await quoteEnvelope({ payload: withoutPayer });
    const extra = await quoteEnvelope({ payload: { ...valid, extra: 1 } });
    const drift = await quoteEnvelope({ payload: { ...valid, requestHash: hash("1") } });
    const unknown = await quoteEnvelope({ payload: { ...valid, outcomeId: "missing" } });
    expect((await postQuote(missingPayer)).body).toEqual({ error: "quote_rejected", reason: "envelope" });
    expect((await postQuote(extra)).body).toEqual({ error: "quote_rejected", reason: "envelope" });
    expect((await postQuote(drift)).body).toEqual({ error: "quote_rejected", reason: "envelope" });
    expect((await postQuote(unknown)).body).toEqual({ error: "quote_rejected", reason: "outcome_policy" });
    expect(h.adapter.quote).not.toHaveBeenCalled();
  });
});

describe("quote refusals carry gateway-format field errors", () => {
  it("maps schema violations without echoing submitted values", async () => {
    const body = { item: "", tier: "gold", extra: "secret-value" };
    const result = await postQuote(await quoteEnvelope({ body }));
    expect(result.status).toBe(422);
    const fieldErrors = gatewayQuoteFieldErrors(result.body)!;
    expect(fieldErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "extra", rule: "unsupported-field" }),
      expect.objectContaining({ path: "item", rule: "min-length" }),
      expect.objectContaining({ path: "tier", rule: "enum", allowedValues: ["basic", "plus"] }),
    ]));
    expect(JSON.stringify(result.body)).not.toContain("secret-value");
    expect((result.body as { reason: string }).reason).toBe("request_invalid");
  });

  it("returns service validation errors and never prices a declined request", async () => {
    h.adapter = syntheticAdapter({
      quote: vi.fn(async () => ({
        ok: false as const,
        errors: [{ field: "item", code: "unavailable_item", message: "That item cannot be sold.\u0000" }],
      })),
    });
    const result = await postQuote(await quoteEnvelope());
    expect(result.status).toBe(422);
    expect(gatewayQuoteFieldErrors(result.body)).toEqual([
      { path: "item", rule: "unavailable_item", message: "That item cannot be sold." },
    ]);
    expect(await quoteRows()).toEqual([]);
  });
});

describe("read-only request readiness", () => {
  it("passes the exact quote payer and refuses with reviewed field errors", async () => {
    const readiness = vi.fn(async () => ({
      ready: false as const,
      fieldErrors: [{ path: "payer", rule: "payer_required", message: "Bind the quote to a payer." }],
    }));
    h.adapter = syntheticAdapter({ requestReadiness: readiness });
    const result = await postQuote(await quoteEnvelope({ payer: null }));
    expect(result.status).toBe(422);
    expect(gatewayQuoteFieldErrors(result.body)).toEqual([
      { path: "payer", rule: "payer_required", message: "Bind the quote to a payer." },
    ]);
    expect(readiness).toHaveBeenCalledWith(fixedOutcome.skillId, request,
      expect.objectContaining({ payer: null, signal: expect.any(AbortSignal) }));
    expect(await quoteRows()).toEqual([]);
  });

  it("stops new quotes while readiness is unavailable", async () => {
    h.adapter = syntheticAdapter({ requestReadiness: vi.fn(async () => { throw new Error("upstream down"); }) });
    const result = await postQuote(await quoteEnvelope());
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: "quote_unavailable", reason: "readiness_unavailable" });
  });

  it("issues the quote once readiness passes", async () => {
    h.adapter = syntheticAdapter({ requestReadiness: vi.fn(async () => ({ ready: true as const })) });
    expect((await postQuote(await quoteEnvelope())).status).toBe(200);
  });
});

describe("service availability and capacity stop new quotes", () => {
  it("refuses while sales are paused", async () => {
    await database.pool.query("UPDATE services SET is_active=false");
    const result = await postQuote(await quoteEnvelope());
    expect(result.body).toEqual({ error: "quote_unavailable", reason: "service_unavailable" });
    expect(h.adapter.quote).not.toHaveBeenCalled();
  });

  it("refuses new quotes in-process while this process takes no new sales (C05)", async () => {
    let admission: "open" | "stopped" = "stopped";
    const app = express();
    app.use("/standard-rail", ...standardRailJsonIngress(), createStandardRailRouter(
      { CHAIN_ID } as Config, fixtureConfig(), undefined,
      { salesAdmission: async () => ({ status: admission }), contractIntegrity: async () => undefined },
    ));
    const local = app.listen(0, "127.0.0.1");
    await once(local, "listening");
    const url = `http://127.0.0.1:${(local.address() as AddressInfo).port}/standard-rail/quote`;
    const ask = async () => fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: await quoteEnvelope() }),
    });
    try {
      const refused = await ask();
      expect([refused.status, await refused.json()])
        .toEqual([503, { error: "quote_unavailable", reason: "service_unavailable" }]);
      expect(h.adapter.quote).not.toHaveBeenCalled();
      expect((await database.pool.query("SELECT count(*)::int AS n FROM standard_provider_quotes")).rows[0].n).toBe(0);
      admission = "open";
      expect((await ask()).status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => local.close(() => resolve()));
    }
  });

  it("signs no quote whose fresh rail-contract proof fails (C05)", async () => {
    const app = express();
    app.use("/standard-rail", ...standardRailJsonIngress(), createStandardRailRouter(
      { CHAIN_ID } as Config, fixtureConfig(), undefined,
      { salesAdmission: async () => ({ status: "open" as const }), contractIntegrity: async () => { throw new Error("rpc down"); } },
    ));
    const local = app.listen(0, "127.0.0.1");
    await once(local, "listening");
    try {
      const refused = await fetch(`http://127.0.0.1:${(local.address() as AddressInfo).port}/standard-rail/quote`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ request: await quoteEnvelope() }),
      });
      expect([refused.status, await refused.json()])
        .toEqual([503, { error: "quote_unavailable", reason: "service_unavailable" }]);
      expect(h.adapter.quote).not.toHaveBeenCalled();
      expect((await database.pool.query("SELECT count(*)::int AS n FROM standard_provider_quotes")).rows[0].n).toBe(0);
    } finally {
      await new Promise<void>((resolve) => local.close(() => resolve()));
    }
  });

  it("counts open paid work of the same listing version only", async () => {
    const tight = fixtureConfig([{ ...fixedOutcome, maxOpenOrders: 1 }]);
    const app = express();
    app.use("/standard-rail", ...standardRailJsonIngress(), createStandardRailRouter({ CHAIN_ID } as Config, tight, undefined, { salesAdmission: async () => ({ status: "open" as const }), contractIntegrity: async () => undefined }));
    const local = app.listen(0, "127.0.0.1");
    await once(local, "listening");
    const url = `http://127.0.0.1:${(local.address() as AddressInfo).port}/standard-rail/quote`;
    const ask = async () => fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: await quoteEnvelope() }),
    });
    try {
      const serviceId = (await database.pool.query("SELECT id FROM services")).rows[0].id as string;
      const customer = (await database.pool.query(
        "INSERT INTO customers (wallet_address) VALUES ($1) RETURNING id", [payerA.toLowerCase()],
      )).rows[0].id as string;
      const insertTask = (id: string, listing: Hex) => database.pool.query(
        `INSERT INTO transactions (id,customer_id,service_id,skill_id,status,standard_order_id,standard_payer,
           standard_listing_manifest_hash,standard_order_key,standard_token,standard_gross_amount,
           standard_provider_net_amount,standard_daski_commission_amount)
         VALUES ($1,$2,$3,'fixed-skill','working',$1,$4,$5,$6,'0x6666666666666666666666666666666666666666',2,1,1)`,
        [id, customer, serviceId, payerA, Buffer.from(listing.slice(2), "hex"), Buffer.from(hash("c").slice(2), "hex")],
      );
      await insertTask("ord_other_version", hash("2"));
      expect((await ask()).status).toBe(200);
      await insertTask("ord_same_version", fixedOutcome.listingManifestHash);
      const refused = await ask();
      expect(refused.status).toBe(503);
      await expect(refused.json()).resolves.toEqual({ error: "quote_unavailable", reason: "capacity" });
    } finally {
      await new Promise<void>((resolve) => local.close(() => resolve()));
      await database.pool.query("DELETE FROM transactions");
      await database.pool.query("DELETE FROM customers");
    }
  });
});

describe("dynamic quotes", () => {
  it("prices from the service, records its supplier cost as a v2 ceiling and lives 180 s", async () => {
    const { status, body } = await postQuote(await quoteEnvelope({ outcome: dynamicOutcome }));
    expect(status).toBe(200);
    const accepted = await acceptProviderQuote(body, expectationFor(dynamicOutcome, lowerPayer));
    expect(accepted.grossAmount).toBe("1234567");
    expect(accepted.validBefore - accepted.issuedAt).toBe(180);
    expect((await quoteRows())[0]).toEqual(expect.objectContaining({
      pricing_mode: "dynamic",
      supplier_cost_ceiling: {
        kind: "supplier-cost-ceiling-v2", supplier: "synthetic-supplier", currency: "USD",
        quotedAmount: "4.25", tolerancePercent: "10",
      },
    }));
  });

  it("refuses a malformed supplier cost, the retired ceiling field and an unreleasable amount", async () => {
    for (const reported of [
      { supplierCost: { supplier: "x", currency: "usd", amount: "1e3" } },
      { supplierCost: { supplier: "synthetic-supplier", currency: "USD", amount: "4.25", maximumAmount: "5" } },
      { supplierCostCeiling: { kind: "supplier-cost-ceiling-v1", supplier: "x", currency: "USD", maximumAmount: "4.25" } },
    ]) {
      h.adapter = syntheticAdapter({
        quote: vi.fn(async () => ({ ok: true as const, amount: 1_000n, currency: "USDC" as const, ...reported } as never)),
      });
      expect((await postQuote(await quoteEnvelope({ outcome: dynamicOutcome }))).body)
        .toEqual({ error: "quote_unavailable", reason: "service_unavailable" });
    }
    h.adapter = syntheticAdapter({
      quote: vi.fn(async () => ({ ok: true as const, amount: 19n, currency: "USDC" as const })),
    });
    expect((await postQuote(await quoteEnvelope({ outcome: dynamicOutcome }))).body)
      .toEqual({ error: "quote_rejected", reason: "price" });
    expect(await quoteRows()).toEqual([]);
  });
});

describe("quote lifetime against gateway receipt time (C-T12)", () => {
  it("leaves a strictly larger window than the minimum for every admitted receipt skew", async () => {
    for (const outcome of [fixedOutcome, dynamicOutcome]) {
      const { body } = await postQuote(await quoteEnvelope({ outcome }));
      const issuedAt = (body as { issuedAt: number }).issuedAt;
      await expect(acceptProviderQuote(body, expectationFor(outcome, lowerPayer, issuedAt + 30)))
        .resolves.toBeDefined();
      await expect(acceptProviderQuote(body, expectationFor(outcome, lowerPayer, issuedAt - 30)))
        .resolves.toBeDefined();
      await expect(acceptProviderQuote(body, expectationFor(outcome, lowerPayer, issuedAt + 31)))
        .rejects.toThrow("PROVIDER_QUOTE_UNAVAILABLE");
    }
  });
});

describe("signed intake on the quote URL", () => {
  it("answers the current intake contract without pricing, storing or starting work", async () => {
    const intake = vi.fn(async () => ({
      requiredFields: { item: { label: "Item" } },
      selectorsRequired: ["tier"],
      fieldErrors: [{ path: "tier", rule: "selector_required", message: "Choose a tier first." }],
      supported: true,
      normalizedSelectors: { tier: "plus", ignored: "not-published" },
    }));
    h.adapter = syntheticAdapter({ intake });
    const body = { item: "widget" };
    const issuedAt = now();
    const envelope = await signGatewayEnvelope({
      artifactType: "ProviderIntakeRequestV1", environment: ENVIRONMENT, chainId: CHAIN_ID,
      audience: PROVIDER_AUDIENCE, signerKeyId: "gateway-dispatch", privateKey: gatewayKey,
      issuedAt, validBefore: issuedAt + 60,
      payload: {
        outcomeId: fixedOutcome.outcomeId, listingManifestHash: fixedOutcome.listingManifestHash,
        requestHash: canonicalHash(body), request: body,
      },
    });
    const result = await postQuote(envelope);
    expect(result.status).toBe(200);
    const accepted = await acceptIntakeResponse(result.body, {
      outcomeId: fixedOutcome.outcomeId, listingManifestHash: fixedOutcome.listingManifestHash,
      requestHash: canonicalHash(body), requestSchema: fixedOutcome.requestSchema,
      providerAuthorityKey: provider.address, now: now(),
    });
    expect(accepted.supported).toBe(true);
    expect(accepted.fieldErrors).toEqual([
      { path: "tier", rule: "selector_required", message: "Choose a tier first." },
    ]);
    expect(intake).toHaveBeenCalledOnce();
    expect(h.adapter.quote).not.toHaveBeenCalled();
    expect(await quoteRows()).toEqual([]);
  });

  it("does not accept a quote payload under the intake artifact type", async () => {
    const result = await postQuote(await quoteEnvelope({ artifactType: "ProviderIntakeRequestV1" }));
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "quote_rejected", reason: "envelope" });
  });
});
