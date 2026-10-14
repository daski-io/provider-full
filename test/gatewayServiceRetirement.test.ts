import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Hex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMigratedDatabase, DATABASE_HOOK_TIMEOUT_MS, type DisposableDatabase } from "./postgresHarness.js";
import {
  RECEIPT_DOMAIN, retirementReceipt, SERVICE_ID, seedService, SKILL, versionHead,
} from "./retainedVersionFixture.js";
import { GATEWAY_AUDIENCE, otherKey, payerA } from "./standardRailFixture.js";

// F-T05, F-T15, C-T07: retirement ends a listing version's dispatch support
// only with the gateway's signed receipt and no open local obligation,
// counted under the same row locks every admission takes. An expired paid
// quote awaiting its first dispatch blocks retirement; a retired version
// refuses new orders in the database while its orders stay readable.
vi.setConfig({ testTimeout: 30_000 });
const h = vi.hoisted(() => ({ pool: null as pg.Pool | null }));
vi.mock("../src/core/db/pool.js", () => ({
  pool: {
    query: (...args: unknown[]) => (h.pool!.query as (...a: unknown[]) => unknown)(...args),
    connect: () => h.pool!.connect(),
  },
}));

const { promoteRuntimeListingVersions } = await import("../src/core/gatewayRegistration/runtimeCatalog.js");
const { retireListingVersion, ListingRetirementBlockedError } = await import("../src/core/gatewayRegistration/listingRetirement.js");
const { retireGatewayService, ServiceRetirementBlockedError } = await import("../src/core/gatewayRegistration/retirement.js");
const { persistProviderQuote } = await import("../src/core/standardRail/quoteStore.js");

const v1 = versionHead(1);
const v2 = versionHead(2);
const NOW = () => Math.floor(Date.now() / 1_000);
let database: DisposableDatabase;
let serviceRowId: string;

const asVersion = (head: typeof v1) => ({
  listingId: head.listingId, listingKey: head.listingKey, skillId: head.skillId, paymentRequired: true,
  runtimeCommitmentHash: head.runtimeCommitmentHash, runtimeCommitment: head.runtimeCommitment, bundle: head.bundle,
});
const bytes = (value: Hex) => Buffer.from(value.slice(2), "hex");
const random32 = () => `0x${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}` as Hex;

/** A provider quote of `listing`, issued at `issuedAt` and never admitted. */
async function quote(listing: Hex, issuedAt: number): Promise<void> {
  await persistProviderQuote({
    outcomeId: SKILL, listingManifestHash: listing, requestHash: random32(),
    grossAmount: "250000", payer: payerA.toLowerCase() as Hex, issuedAt, validBefore: issuedAt + 120,
  }, { pricingMode: "fixed", supplierCostCeiling: null });
}

/** An admitted standard order of `listing` in `status`, written as admission writes one. */
async function order(db: pg.Pool | pg.PoolClient, listing: Hex, status = "working"): Promise<string> {
  const id = `task-${randomUUID()}`;
  const customer = (await db.query<{ id: string }>(
    `INSERT INTO customers(wallet_address) VALUES ($1)
     ON CONFLICT (wallet_address) DO UPDATE SET last_seen_at=now() RETURNING id`,
    [payerA.toLowerCase()],
  )).rows[0]!.id;
  await db.query(
    `INSERT INTO transactions (id,customer_id,service_id,skill_id,status,standard_order_id,standard_payer,
       standard_listing_manifest_hash,standard_order_key,standard_token,standard_gross_amount,
       standard_provider_net_amount,standard_daski_commission_amount)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'0x6666666666666666666666666666666666666666',250000,237500,12500)`,
    [id, customer, serviceRowId, SKILL, status, `ord_${randomUUID()}`, payerA, bytes(listing), bytes(random32())],
  );
  return id;
}

async function versionRows() {
  return (await database.pool.query<{ hash: Buffer; superseded: boolean; retired: boolean }>(
    `SELECT runtime_commitment_hash AS hash,superseded_at IS NOT NULL AS superseded,retired_at IS NOT NULL AS retired
       FROM provider_runtime_listing_versions ORDER BY promoted_at,id`,
  )).rows.map((row) => ({ hash: `0x${row.hash.toString("hex")}`, superseded: row.superseded, retired: row.retired }));
}

beforeAll(async () => {
  database = await createMigratedDatabase("listing_retirement");
  h.pool = database.pool;
}, DATABASE_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await database?.drop();
}, DATABASE_HOOK_TIMEOUT_MS);

beforeEach(async () => {
  // A disposable reset: versions are otherwise undeletable (core migration 009).
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of [
      "durable_jobs", "standard_dispatch_claims", "standard_provider_quotes", "assets", "transactions",
      "customers", "events", "operator_config_revisions", "provider_gateway_registrations",
      "provider_runtime_listing_versions", "skills", "services",
    ]) await client.query(`DELETE FROM ${table}`);
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  serviceRowId = await seedService(database.pool);
  await promoteRuntimeListingVersions(GATEWAY_AUDIENCE, SERVICE_ID, [asVersion(v1)]);
  await promoteRuntimeListingVersions(GATEWAY_AUDIENCE, SERVICE_ID, [asVersion(v2)]);
});

const retireV1 = async (receipt?: unknown) => retireListingVersion({
  gatewayOrigin: GATEWAY_AUDIENCE, listingManifestHash: v1.runtimeCommitmentHash,
  receipt: receipt ?? await retirementReceipt(v1.runtimeCommitmentHash),
  providerAgentId: "1", domain: RECEIPT_DOMAIN,
});

describe("listing version retirement (F-T05, F-T15)", () => {
  it("keeps a version with an expired paid quote serviceable until the gateway proves its orders ended", async () => {
    // Quoted two days ago and possibly paid: only the gateway can prove it
    // will never be dispatched.
    await quote(v1.runtimeCommitmentHash, NOW() - 2 * 86_400);
    await expect(retireGatewayService(GATEWAY_AUDIENCE, SERVICE_ID, {
      receipts: [], providerAgentId: "1", domain: RECEIPT_DOMAIN,
    })).rejects.toMatchObject({
      name: "ServiceRetirementBlockedError",
      listingBlockers: {
        [v1.runtimeCommitmentHash]: { gatewayEvidence: 1 },
        [v2.runtimeCommitmentHash]: { gatewayEvidence: 1 },
      },
    });
    await expect(retireV1(await retirementReceipt(v1.runtimeCommitmentHash, { privateKey: otherKey })))
      .rejects.toThrow(/signature/);
    await expect(retireV1(await retirementReceipt(v2.runtimeCommitmentHash)))
      .rejects.toThrow(/does not retire this listing version/);
    expect((await versionRows()).every((row) => !row.retired)).toBe(true);

    await expect(retireV1()).resolves.toMatchObject({ listingManifestHash: v1.runtimeCommitmentHash, alreadyRetired: false });
    expect(await versionRows()).toEqual([
      { hash: v1.runtimeCommitmentHash, superseded: true, retired: true },
      { hash: v2.runtimeCommitmentHash, superseded: false, retired: false },
    ]);
    // Idempotent: the same receipt again changes nothing.
    await expect(retireV1()).resolves.toMatchObject({ alreadyRetired: true });
  });

  it("refuses to retire the current head on its own", async () => {
    await expect(retireListingVersion({
      gatewayOrigin: GATEWAY_AUDIENCE, listingManifestHash: v2.runtimeCommitmentHash,
      receipt: await retirementReceipt(v2.runtimeCommitmentHash), providerAgentId: "1", domain: RECEIPT_DOMAIN,
    })).rejects.toMatchObject({ blockers: { [v2.runtimeCommitmentHash]: { currentHead: 1 } } });
  });

  it("is blocked by pending orders, unfinished jobs and an unexpired quote even with the gateway receipt", async () => {
    const pending = await order(database.pool, v1.runtimeCommitmentHash, "working");
    await expect(retireV1()).rejects.toMatchObject({
      name: "ListingRetirementBlockedError",
      blockers: { [v1.runtimeCommitmentHash]: { pendingTasks: 1 } },
    });
    await database.pool.query("UPDATE transactions SET status='completed',completed_at=now() WHERE id=$1", [pending]);
    await database.pool.query(
      "INSERT INTO durable_jobs(queue,idempotency_key,payload) VALUES ('service-poll',$1,$2)",
      [pending, JSON.stringify({ taskId: pending })],
    );
    await quote(v1.runtimeCommitmentHash, NOW() - 10);
    await expect(retireV1()).rejects.toMatchObject({
      blockers: { [v1.runtimeCommitmentHash]: { durableJobs: 1, unexpiredQuotes: 1 } },
    });
    expect((await versionRows())[0]!.retired).toBe(false);
  });

  it("serializes with admission on the version rows: an admission committed meanwhile blocks it", async () => {
    const admission = await database.pool.connect();
    try {
      await admission.query("BEGIN");
      await order(admission, v1.runtimeCommitmentHash, "submitted");
      let settled = false;
      const retirement = retireV1().finally(() => { settled = true; });
      retirement.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      await admission.query("COMMIT");
      await expect(retirement).rejects.toBeInstanceOf(ListingRetirementBlockedError);
    } finally {
      admission.release();
    }
    expect((await versionRows())[0]!.retired).toBe(false);
  });

  it("refuses an admission that waited for a committed retirement", async () => {
    const retirement = await database.pool.connect();
    try {
      await retirement.query("BEGIN");
      await retirement.query(
        `UPDATE provider_runtime_listing_versions SET retired_at=now(),retirement='{}'::jsonb
          WHERE runtime_commitment_hash=$1`,
        [bytes(v1.runtimeCommitmentHash)],
      );
      const admission = order(database.pool, v1.runtimeCommitmentHash, "submitted");
      admission.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await retirement.query("COMMIT");
      await expect(admission).rejects.toThrow(/retired/);
    } finally {
      retirement.release();
    }
  });

  it("refuses new orders, quotes, reactivation and removal of a retired version in the database", async () => {
    await retireV1();
    await expect(order(database.pool, v1.runtimeCommitmentHash)).rejects.toThrow(/retired/);
    await expect(quote(v1.runtimeCommitmentHash, NOW())).rejects.toThrow(/retired/);
    await expect(promoteRuntimeListingVersions(GATEWAY_AUDIENCE, SERVICE_ID, [asVersion(v1)]))
      .rejects.toThrow(/retired/);
    await expect(database.pool.query("DELETE FROM provider_runtime_listing_versions")).rejects.toThrow(/retained/);
    // The current version is untouched.
    await expect(order(database.pool, v2.runtimeCommitmentHash)).resolves.toMatch(/^task-/);
  });

  it("retires a whole service with a receipt for every paid version and keeps its history", async () => {
    await quote(v1.runtimeCommitmentHash, NOW() - 86_400);
    const done = await order(database.pool, v1.runtimeCommitmentHash, "completed");
    const receipts = [
      await retirementReceipt(v1.runtimeCommitmentHash),
      await retirementReceipt(v2.runtimeCommitmentHash),
    ];
    const result = await retireGatewayService(GATEWAY_AUDIENCE, SERVICE_ID, {
      receipts, providerAgentId: "1", domain: RECEIPT_DOMAIN,
    });
    expect(result).toMatchObject({
      serviceDeactivated: true,
      alreadyRetired: false,
      supersededListings: [{ skillId: SKILL }],
      retiredListings: [
        { listingManifestHash: v1.runtimeCommitmentHash, alreadyRetired: false },
        { listingManifestHash: v2.runtimeCommitmentHash, alreadyRetired: false },
      ],
    });
    expect((await versionRows()).every((row) => row.retired && row.superseded)).toBe(true);
    expect((await database.pool.query("SELECT status FROM transactions WHERE id=$1", [done])).rows[0].status)
      .toBe("completed");
    await expect(retireGatewayService(GATEWAY_AUDIENCE, SERVICE_ID, {
      receipts, providerAgentId: "1", domain: RECEIPT_DOMAIN,
    })).resolves.toMatchObject({ alreadyRetired: true, serviceDeactivated: false });
  });

  it("fails closed and writes nothing while any service obligation remains", async () => {
    await database.pool.query(
      `INSERT INTO assets(id,service_id,type,identifier,identifier_hash,status)
       VALUES ($1,$2,'note','kept','kept-hash','active')`,
      [randomUUID(), serviceRowId],
    );
    await expect(retireGatewayService(GATEWAY_AUDIENCE, SERVICE_ID, {
      receipts: [await retirementReceipt(v1.runtimeCommitmentHash), await retirementReceipt(v2.runtimeCommitmentHash)],
      providerAgentId: "1", domain: RECEIPT_DOMAIN,
    })).rejects.toBeInstanceOf(ServiceRetirementBlockedError);
    expect(await versionRows()).toEqual([
      { hash: v1.runtimeCommitmentHash, superseded: true, retired: false },
      { hash: v2.runtimeCommitmentHash, superseded: false, retired: false },
    ]);
    expect((await database.pool.query("SELECT is_active FROM services")).rows[0].is_active).toBe(true);
  });
});
