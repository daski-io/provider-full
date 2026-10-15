import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import type { Hex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMigratedDatabase, DATABASE_HOOK_TIMEOUT_MS, type DisposableDatabase } from "./postgresHarness.js";
import { GATEWAY_AUDIENCE, payerA } from "./standardRailFixture.js";

// B3: a provider quote stays owed until 31 days after its own validBefore
// (the 30-day first-dispatch bound plus a day). Core migration 016 refuses
// every earlier deletion, and every deletion of a quote a dispatch claim
// names, whoever deletes; the retention sweep prunes lapsed quotes that no
// claim names in bounded, best-effort batches.
vi.setConfig({ testTimeout: 30_000 });
const h = vi.hoisted(() => ({ pool: null as pg.Pool | null }));
vi.mock("../src/core/db/pool.js", () => ({
  pool: {
    query: (...args: unknown[]) => (h.pool!.query as (...a: unknown[]) => unknown)(...args),
    connect: () => h.pool!.connect(),
  },
}));

const { persistProviderQuote } = await import("../src/core/standardRail/quoteStore.js");
const { PROVIDER_QUOTE_OBLIGATION_SECONDS, pruneLapsedProviderQuotes } =
  await import("../src/core/standardRail/quoteRetention.js");

let database: DisposableDatabase;
const random32 = (): Hex => `0x${randomBytes(32).toString("hex")}`;
const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");
const now = () => Math.floor(Date.now() / 1_000);
const lapsedAt = () => now() - PROVIDER_QUOTE_OBLIGATION_SECONDS - 60;
const owedAt = () => now() - PROVIDER_QUOTE_OBLIGATION_SECONDS + 60;

/** A fixed readiness quote whose window closed (or closes) at `validBefore`. */
function quoteValidUntil(validBefore: number): Promise<Hex> {
  return persistProviderQuote({
    outcomeId: "fixed-skill", listingManifestHash: random32(), requestHash: random32(),
    grossAmount: "250000", payer: null, issuedAt: validBefore - 120, validBefore,
  }, { pricingMode: "fixed", supplierCostCeiling: null });
}

/** A dispatch claim admitted under the quote. */
async function claimNaming(quoteHash: Hex): Promise<void> {
  await database.pool.query(
    `INSERT INTO standard_dispatch_claims
       (gateway_audience,order_id,dispatch_nonce,dispatch_hash,request_hash,payer,state,provider_quote_hash)
     VALUES ($1,$2,$3,$4,$5,$6,'claimed',$7)`,
    [GATEWAY_AUDIENCE, `ord_${randomUUID()}`, bytes(random32()), bytes(random32()), bytes(random32()), payerA,
      bytes(quoteHash)],
  );
}

const deleteQuote = (quoteHash: Hex) =>
  database.pool.query("DELETE FROM standard_provider_quotes WHERE quote_hash=$1", [bytes(quoteHash)]);

async function stored(): Promise<Hex[]> {
  return (await database.pool.query<{ hash: string }>(
    "SELECT '0x' || encode(quote_hash,'hex') AS hash FROM standard_provider_quotes",
  )).rows.map((row) => row.hash as Hex).sort();
}

beforeAll(async () => {
  database = await createMigratedDatabase("quote_retention");
  h.pool = database.pool;
}, DATABASE_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await database?.drop();
}, DATABASE_HOOK_TIMEOUT_MS);

beforeEach(async () => {
  // A disposable reset: claims and owed quotes are otherwise undeletable.
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query("DELETE FROM standard_dispatch_claims");
    await client.query("DELETE FROM standard_provider_quotes");
    await client.query("COMMIT");
  } finally {
    client.release();
  }
});

describe("provider quote deletion guard (B3, core migration 016)", () => {
  it("keeps a quote that may still receive a first dispatch", async () => {
    for (const quote of [await quoteValidUntil(owedAt()), await quoteValidUntil(now() + 120)]) {
      await expect(deleteQuote(quote)).rejects.toMatchObject({
        code: "23000", message: "standard provider quotes are retained for their first-dispatch window",
      });
    }
    expect(await stored()).toHaveLength(2);
  });

  it("keeps a lapsed quote that a dispatch claim names", async () => {
    const quote = await quoteValidUntil(lapsedAt());
    await claimNaming(quote);
    await expect(deleteQuote(quote)).rejects.toMatchObject({
      code: "23000", message: "standard provider quotes named by a dispatch claim are retained",
    });
  });

  it("lets a lapsed quote no claim names go", async () => {
    const quote = await quoteValidUntil(lapsedAt());
    await expect(deleteQuote(quote)).resolves.toMatchObject({ rowCount: 1 });
    expect(await stored()).toEqual([]);
  });
});

describe("lapsed provider quote pruning (B3)", () => {
  it("prunes only lapsed quotes no claim names, in bounded batches", async () => {
    for (const age of [0, 86_400, 2 * 86_400]) await quoteValidUntil(lapsedAt() - age);
    const claimed = await quoteValidUntil(lapsedAt());
    await claimNaming(claimed);
    const kept = [claimed, await quoteValidUntil(owedAt()), await quoteValidUntil(now() + 120)];
    expect(await pruneLapsedProviderQuotes(database.pool, 2)).toBe(2);
    expect(await pruneLapsedProviderQuotes(database.pool, 2)).toBe(1);
    expect(await pruneLapsedProviderQuotes(database.pool, 2)).toBe(0);
    expect(await stored()).toEqual([...kept].sort());
  });

  it("never fails the sweep: a refused or failed prune removes nothing and is retried later", async () => {
    const failing = {
      query: async () => { throw Object.assign(new Error("deletion refused"), { code: "23000" }); },
    };
    await expect(pruneLapsedProviderQuotes(failing as never)).resolves.toBe(0);
    await expect(pruneLapsedProviderQuotes(failing as never)).resolves.toBe(0);
    await quoteValidUntil(lapsedAt());
    expect(await pruneLapsedProviderQuotes(database.pool)).toBe(1);
  });
});
