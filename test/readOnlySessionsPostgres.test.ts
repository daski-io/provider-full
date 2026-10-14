import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { assertReadOnlySessions, enforceReadOnlySessions } from "../src/core/db/readOnlySessions.js";
import { createMigratedTestDatabase, type MigratedTestDatabase } from "./postgresTestDatabase.js";

// Read-only sessions for --check-only against PostgreSQL. node-postgres takes
// the startup options from the connection string, else the pool config, else
// PGOPTIONS; the read-only flag must survive each of them without dropping the
// operator's own session options.

let database: MigratedTestDatabase;
const pools: pg.Pool[] = [];

beforeAll(async () => {
  database = await createMigratedTestDatabase("daski_read_only_sessions", { migrate: false });
}, 60_000);

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end().catch(() => undefined)));
  await database?.drop();
});

function readOnlyPool(config: pg.PoolConfig): pg.Pool {
  const pool = new pg.Pool({ max: 1, ...config });
  pools.push(pool);
  enforceReadOnlySessions(pool);
  return pool;
}

async function searchPath(pool: pg.Pool): Promise<string> {
  return (await pool.query<{ search_path: string }>("SHOW search_path")).rows[0]!.search_path;
}

describe("read-only database sessions", { timeout: 30_000 }, () => {
  it("keep the read-only flag when the connection string carries its own options", async () => {
    const url = new URL(database.connectionString);
    url.searchParams.set("options", "-c search_path=public");
    const pool = readOnlyPool({ connectionString: url.toString() });

    await expect(assertReadOnlySessions(pool)).resolves.toBeUndefined();
    expect(await searchPath(pool)).toBe("public");
    await expect(pool.query("CREATE TABLE refused (id int)")).rejects.toMatchObject({ code: "25006" });
  });

  it("keep the operator's PGOPTIONS alongside the read-only flag", async () => {
    vi.stubEnv("PGOPTIONS", "-c search_path=public");
    const pool = readOnlyPool({ connectionString: database.connectionString });

    await expect(assertReadOnlySessions(pool)).resolves.toBeUndefined();
    expect(await searchPath(pool)).toBe("public");
  });

  it("append the flag to options set in the pool config, once", async () => {
    const pool = readOnlyPool({
      connectionString: database.connectionString,
      options: "-c search_path=public",
    });
    enforceReadOnlySessions(pool);

    expect(pool.options.options).toBe("-c search_path=public -c default_transaction_read_only=on");
    await expect(assertReadOnlySessions(pool)).resolves.toBeUndefined();
    expect(await searchPath(pool)).toBe("public");
  });
});
