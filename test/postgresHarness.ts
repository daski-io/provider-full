import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS = fileURLToPath(new URL("../src/core/db/migrations/", import.meta.url));

/** Creating and migrating a database can take a while on a loaded host. */
export const DATABASE_HOOK_TIMEOUT_MS = 120_000;

/** CI supplies DATABASE_URL_TEST; developers fall back to the local container. */
export function testDatabaseUrl(): string {
  return process.env.DATABASE_URL_TEST ??
    "postgresql://daski_provider:local-only-provider-password@127.0.0.1:55432/daski_provider";
}

export interface DisposableDatabase {
  pool: pg.Pool;
  drop(): Promise<void>;
}

async function admin<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/postgres";
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/**
 * A fresh database with every core migration applied in order, so tests run
 * against the real schema, constraints and triggers. Dropped after use.
 */
export async function createMigratedDatabase(label: string): Promise<DisposableDatabase> {
  const name = `test_${label}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await admin((client) => client.query(`CREATE DATABASE "${name}"`));
  const url = new URL(testDatabaseUrl());
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 10 });
  try {
    for (const file of readdirSync(MIGRATIONS).filter((entry) => entry.endsWith(".sql")).sort()) {
      await pool.query(readFileSync(join(MIGRATIONS, file), "utf8"));
    }
  } catch (error) {
    await pool.end();
    await admin((client) => client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    throw error;
  }
  return {
    pool,
    async drop() {
      await pool.end();
      await admin((client) => client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    },
  };
}
