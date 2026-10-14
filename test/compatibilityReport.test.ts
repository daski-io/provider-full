import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FulfillmentAdapter } from "../src/core/serviceRegistry/types.js";
import { createMigratedDatabase, DATABASE_HOOK_TIMEOUT_MS, type DisposableDatabase } from "./postgresHarness.js";
import {
  fixtureModule, publishedContract, RETAINED_KEY, retainedWallet, SERVICE_ID, SKILL, versionHead,
} from "./retainedVersionFixture.js";
import { GATEWAY_AUDIENCE, payerA, provider } from "./standardRailFixture.js";

// F-T16, C-T06: the compatibility check compares this artifact's compiled
// capability manifest and the deployment's keys with what the database
// still owes, and needs nothing but the database, the gateway origin and the
// provider keys: no hosting metadata, no release coordinator, no signed
// rail artifacts.
vi.setConfig({ testTimeout: 60_000 });
const h = vi.hoisted(() => ({ pool: null as pg.Pool | null }));
vi.mock("../src/core/db/pool.js", () => ({
  pool: {
    query: (...args: unknown[]) => (h.pool!.query as (...a: unknown[]) => unknown)(...args),
    connect: () => h.pool!.connect(),
  },
}));

const { compatibilityReport } = await import("../src/core/compatibility/compatibilityReport.js");
const { capabilityHash, capabilityManifest } = await import("../src/core/compatibility/capabilityManifest.js");
const { promoteRuntimeListingVersions } = await import("../src/core/gatewayRegistration/runtimeCatalog.js");
const { persistProviderQuote } = await import("../src/core/standardRail/quoteStore.js");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const adapter = {} as FulfillmentAdapter;
const v1 = versionHead(1);
const v2 = versionHead(2);
const build = { sourceDigest: `sha256:${"1".repeat(64)}`, sourceCommit: null };
const allKeys = new Set([provider.address, retainedWallet]);
let database: DisposableDatabase;

const asVersion = (head: typeof v1) => ({
  listingId: head.listingId, listingKey: head.listingKey, skillId: head.skillId, paymentRequired: true,
  runtimeCommitmentHash: head.runtimeCommitmentHash, runtimeCommitment: head.runtimeCommitment, bundle: head.bundle,
});
const report = (modules: unknown[], keys = allKeys) => compatibilityReport(database.pool, {
  gatewayOrigin: GATEWAY_AUDIENCE, modules: modules as never, signingKeys: keys, build,
});
const retainedModule = () => fixtureModule([{ contract: publishedContract(1), adapter }]);

async function reset(): Promise<void> {
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of ["standard_provider_quotes", "transactions", "provider_runtime_listing_versions"]) {
      await client.query(`DELETE FROM ${table}`);
    }
    await client.query("COMMIT");
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  database = await createMigratedDatabase("compatibility_report");
  h.pool = database.pool;
}, DATABASE_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await database?.drop();
}, DATABASE_HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await reset();
  await promoteRuntimeListingVersions(GATEWAY_AUDIENCE, SERVICE_ID, [asVersion(v1)]);
  await promoteRuntimeListingVersions(GATEWAY_AUDIENCE, SERVICE_ID, [asVersion(v2)]);
});

describe("compiled capability manifest", () => {
  it("lists every executable contract deterministically and hashes capability apart from build identity", () => {
    const manifest = capabilityManifest([retainedModule()], build);
    expect(manifest.executableContracts).toEqual([
      expect.objectContaining({ serviceSlug: "fixture", skillId: SKILL }),
      expect.objectContaining({ serviceSlug: "fixture", skillId: SKILL }),
    ]);
    expect(manifest.executableContracts.map((entry) => entry.retained).sort()).toEqual([false, true]);
    expect(manifest.coreMigrations).toEqual(expect.arrayContaining([
      "009_retained_listing_versions.sql", "011_runtime_epoch_barrier.sql",
    ]));
    expect(manifest.runtimeEpoch).toBe(1);
    expect(manifest.workerQueues).toContain("standard-paid-fulfillment");
    expect(capabilityHash(manifest)).toBe(capabilityHash(capabilityManifest([retainedModule()], {
      sourceDigest: null, sourceCommit: "abcdef1",
    })));
    expect(capabilityHash(manifest)).not.toBe(capabilityHash(capabilityManifest([fixtureModule([])], build)));
  });
});

describe("compatibility report (F-T16, C-T06)", () => {
  it("is compatible when a superseded version that may still be dispatched keeps its handler and key", async () => {
    await persistProviderQuote({
      outcomeId: SKILL, listingManifestHash: v1.runtimeCommitmentHash, requestHash: `0x${"ab".repeat(32)}`,
      grossAmount: "250000", payer: null, issuedAt: 1_700_000_000, validBefore: 1_700_000_120,
    }, { pricingMode: "fixed", supplierCostCeiling: null });
    const result = await report([retainedModule()]);
    expect(result).toMatchObject({ artifactType: "ProviderCompatibilityReportV1", ok: true, gaps: [] });
    expect(result.versions).toEqual([
      expect.objectContaining({ listingManifestHash: v1.runtimeCommitmentHash, head: false, unadmittedQuotes: 1,
        requiresHandler: true, requiresSigningKey: true, signingKey: retainedWallet }),
      expect.objectContaining({ listingManifestHash: v2.runtimeCommitmentHash, head: true, requiresHandler: true }),
    ]);
    expect(Number(result.activationRevision)).toBeGreaterThan(0);
  });

  it("names the missing handler and key of a version that may still be dispatched", async () => {
    await persistProviderQuote({
      outcomeId: SKILL, listingManifestHash: v1.runtimeCommitmentHash, requestHash: `0x${"cd".repeat(32)}`,
      grossAmount: "250000", payer: null, issuedAt: 1_700_000_000, validBefore: 1_700_000_120,
    }, { pricingMode: "fixed", supplierCostCeiling: null });
    const result = await report([fixtureModule([])], new Set([provider.address]));
    expect(result.ok).toBe(false);
    expect(result.gaps).toEqual([
      expect.objectContaining({ kind: "handler", listingManifestHash: v1.runtimeCommitmentHash }),
      expect.objectContaining({ kind: "signing_key", listingManifestHash: v1.runtimeCommitmentHash, signingKey: retainedWallet }),
    ]);
  });

  it("asks nothing of a superseded version that was never sold, and only its key of one with read-only orders", async () => {
    await expect(report([fixtureModule([])], new Set([provider.address]))).resolves.toMatchObject({ ok: true });
    const customer = (await database.pool.query<{ id: string }>(
      "INSERT INTO customers(wallet_address) VALUES ($1) ON CONFLICT (wallet_address) DO UPDATE SET last_seen_at=now() RETURNING id",
      [payerA.toLowerCase()],
    )).rows[0]!.id;
    const service = (await database.pool.query<{ id: string }>(
      `INSERT INTO services (name,slug,category_family,service_type,jurisdictions,service_description,adapter_name)
       VALUES ('Fixture','fixture','other','other','["global"]'::jsonb,'Synthetic','fixture')
       ON CONFLICT (slug,version) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
    )).rows[0]!.id;
    await database.pool.query(
      `INSERT INTO transactions (id,customer_id,service_id,skill_id,status,standard_order_id,standard_payer,
         standard_listing_manifest_hash,standard_order_key,standard_token,standard_gross_amount,
         standard_provider_net_amount,standard_daski_commission_amount,completed_at)
       VALUES ($1,$2,$3,$4,'completed',$5,$6,$7,$8,'0x6666666666666666666666666666666666666666',250000,237500,12500,now())`,
      [`task-${randomUUID()}`, customer, service, SKILL, `ord_${randomUUID()}`, payerA,
        Buffer.from(v1.runtimeCommitmentHash.slice(2), "hex"), Buffer.alloc(32, 4)],
    );
    const result = await report([fixtureModule([])], new Set([provider.address]));
    expect(result.versions[0]).toMatchObject({ terminalTasks: 1, requiresHandler: false, requiresSigningKey: true });
    expect(result.gaps).toEqual([expect.objectContaining({ kind: "signing_key", signingKey: retainedWallet })]);
  });

  it("runs as a read-only command without hosting, coordinator or signed rail variables", async () => {
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (!/^(RAILWAY_|DASKI_COMMERCE|STANDARD_RAIL_)/.test(name)) env[name] = value;
    }
    const run = (extra: NodeJS.ProcessEnv) => new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
      const child = spawn(process.execPath, ["--import=tsx", "src/checkCompatibility.ts"], {
        cwd: root,
        env: { ...env, DATABASE_URL: database.url, GATEWAY_BASE_URL: GATEWAY_AUDIENCE, ...extra },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (code) => done({ code, stdout, stderr }));
    });
    // An empty catalog owes nothing.
    await reset();
    const clean = await run({});
    expect([clean.code, clean.stderr]).toEqual([0, ""]);
    const parsed = JSON.parse(clean.stdout) as { ok: boolean; capability: { executableContracts: unknown[] } };
    expect(parsed.ok).toBe(true);
    expect(parsed.capability.executableContracts.length).toBeGreaterThan(0);
    // A sold version this build (the dummy service) has no handler for: exit 1.
    await promoteRuntimeListingVersions(GATEWAY_AUDIENCE, SERVICE_ID, [asVersion(v1)]);
    await persistProviderQuote({
      outcomeId: SKILL, listingManifestHash: v1.runtimeCommitmentHash, requestHash: `0x${"ef".repeat(32)}`,
      grossAmount: "250000", payer: null, issuedAt: 1_700_000_000, validBefore: 1_700_000_120,
    }, { pricingMode: "fixed", supplierCostCeiling: null });
    const gapped = await run({ PROVIDER_RETAINED_WALLET_PRIVATE_KEYS: RETAINED_KEY });
    expect(gapped.code).toBe(1);
    const gaps = (JSON.parse(gapped.stdout) as { gaps: Array<{ kind: string }> }).gaps;
    expect(gaps.map((gap) => gap.kind)).toEqual(["handler"]);
    expect(gapped.stdout).not.toContain(RETAINED_KEY.slice(2, 20));
    expect(privateKeyToAccount(RETAINED_KEY as Hex).address).toBe(retainedWallet);
  });
});
