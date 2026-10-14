import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRuntimeSchemaEpoch, RUNTIME_SCHEMA_EPOCH } from "../src/core/db/runtimeEpoch.js";
import {
  createMigratedDatabase, DATABASE_HOOK_TIMEOUT_MS, RUNTIME_EPOCH_OPTION, type DisposableDatabase,
} from "./postgresHarness.js";

// C-T07: a process built for an older schema cannot change this release's
// rows. Every write to a core table needs a session that declared a
// sufficient runtime epoch, enforced per statement by the database (core
// migration 011), so an earlier image that ignores unknown migrations still
// fails on its first write; this release refuses a schema whose minimum
// epoch it does not reach. scripts/security/prior-runtime-compatibility.mjs
// proves the same against the prior release's compiled code.
let database: DisposableDatabase;
let legacy: pg.Pool;

const minimumEpoch = (epoch: number) => `CREATE OR REPLACE FUNCTION provider_minimum_runtime_epoch()
  RETURNS integer LANGUAGE sql STABLE AS $$ SELECT ${epoch} $$`;

beforeAll(async () => {
  database = await createMigratedDatabase("runtime_epoch");
  // An earlier image's sessions declare nothing.
  legacy = new pg.Pool({ connectionString: database.url, max: 2 });
}, DATABASE_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await legacy?.end();
  await database?.drop();
}, DATABASE_HOOK_TIMEOUT_MS);

describe("runtime epoch barrier (C-T07)", () => {
  it("refuses every write statement of an undeclared session, even one matching no rows", async () => {
    for (const statement of [
      "UPDATE transactions SET status='failed' WHERE status IN ('submitted','working')",
      "UPDATE durable_jobs SET status='running' WHERE queue='standard-paid-fulfillment'",
      "DELETE FROM events WHERE created_at < now()",
      "INSERT INTO standard_security_incidents(incident_id,incident_kind,fingerprint) VALUES (gen_random_uuid(),'stuck_standard_task','\\x00')",
      "UPDATE services SET is_active=false WHERE slug='none'",
      "UPDATE provider_runtime_listing_versions SET superseded_at=now() WHERE false",
      "UPDATE emails_outbound SET delivery_status='sent' WHERE false",
      "TRUNCATE standard_security_incidents",
    ]) {
      await expect(legacy.query(statement), statement).rejects.toMatchObject({
        code: "55000", message: expect.stringMatching(/predates the database schema/),
      });
    }
    await expect(legacy.query("SELECT count(*) FROM transactions")).resolves.toBeDefined();
  });

  it("guards every core table; only the migration ledgers stay writable", async () => {
    const tables = (await database.pool.query<{ table: string; guarded: boolean }>(
      `SELECT c.relname AS table,
              EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgname=c.relname || '_runtime_epoch'
                       AND t.tgfoid='public.provider_require_runtime_epoch'::regproc) AS guarded
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p')`,
    )).rows;
    expect(tables.length).toBeGreaterThan(50);
    // This harness applies the files directly, so no _migrations ledger exists here.
    expect(tables.filter((row) => !row.guarded).map((row) => row.table)).toEqual([]);
  });

  it("refuses an older declared epoch and admits this release's", async () => {
    const older = new pg.Pool({ connectionString: database.url, max: 1, options: "-c daski.runtime_epoch=0" });
    try {
      await expect(older.query("UPDATE skills SET is_active=true WHERE false")).rejects.toMatchObject({ code: "55000" });
    } finally {
      await older.end();
    }
    await expect(database.pool.query("UPDATE skills SET is_active=true WHERE false")).resolves.toBeDefined();
  });

  it("refuses a schema that requires a newer runtime, also in a session that already wrote", async () => {
    await expect(assertRuntimeSchemaEpoch(database.pool, ["012_later_compatible_change.sql"])).resolves.toBeUndefined();
    const session = new pg.Client({ connectionString: database.url, options: RUNTIME_EPOCH_OPTION });
    await session.connect();
    try {
      await session.query("UPDATE skills SET is_active=true WHERE false");
      await legacy.query(minimumEpoch(RUNTIME_SCHEMA_EPOCH + 1));
      await expect(assertRuntimeSchemaEpoch(database.pool, [])).rejects.toThrow(/requires runtime epoch 2/);
      // The same long-lived session of this release is now refused as well.
      await expect(session.query("UPDATE skills SET is_active=true WHERE false")).rejects.toMatchObject({ code: "55000" });
    } finally {
      await legacy.query(minimumEpoch(RUNTIME_SCHEMA_EPOCH));
      await session.end();
    }
  });

  it("refuses migrations it does not know on a schema without the barrier", async () => {
    const bare = { query: async () => ({ rows: [{ present: false }] }) } as never;
    await expect(assertRuntimeSchemaEpoch(bare, ["999_unknown.sql"])).rejects.toThrow(/does not know/);
    await expect(assertRuntimeSchemaEpoch(bare, [])).resolves.toBeUndefined();
  });
});
