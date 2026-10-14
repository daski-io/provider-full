import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const migrationsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src/core/db/migrations",
);

export interface MigratedTestDatabase {
  pool: pg.Pool;
  connectionString: string;
  drop(): Promise<void>;
}

/**
 * A fresh database on the DATABASE_URL_TEST server with every core
 * migration applied (unless `migrate` is false), dropped again by `drop()`.
 * The server must be a disposable test instance; the suite never falls back
 * to another one.
 */
export async function createMigratedTestDatabase(
  prefix: string,
  { migrate = true }: { migrate?: boolean } = {},
): Promise<MigratedTestDatabase> {
  const server = process.env.DATABASE_URL_TEST;
  if (!server) {
    throw new Error("set DATABASE_URL_TEST to a disposable PostgreSQL server for this test");
  }
  // The name is an unquoted identifier: lowercase, and short enough to keep
  // the random suffix within PostgreSQL's 63-byte limit.
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(prefix)) {
    throw new Error(`test database prefix ${JSON.stringify(prefix)} must match ^[a-z][a-z0-9_]{0,40}$`);
  }
  const name = `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const admin = new pg.Client({ connectionString: server });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const target = new URL(server);
  target.pathname = `/${name}`;
  const connectionString = target.toString();
  const dropDatabase = async () => {
    const cleanup = new pg.Client({ connectionString: server });
    await cleanup.connect();
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  };
  if (migrate) {
    try {
      const migrator = new pg.Client({ connectionString });
      await migrator.connect();
      try {
        for (const file of readdirSync(migrationsDir).filter((entry) => entry.endsWith(".sql")).sort()) {
          await migrator.query(readFileSync(join(migrationsDir, file), "utf8"));
        }
      } finally {
        await migrator.end();
      }
    } catch (error) {
      // The suite never receives drop(): remove the half-built database now.
      await dropDatabase().catch(() => undefined);
      throw error;
    }
  }
  const pool = new pg.Pool({ connectionString, max: 4 });
  return {
    pool,
    connectionString,
    async drop() {
      await pool.end().catch(() => undefined);
      await dropDatabase();
    },
  };
}
