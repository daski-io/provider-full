import pg from "pg";
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { logError, logInfo } from "../logger.js";
import { databaseTlsConfig } from "./tls.js";
import { assertRuntimeSchemaEpoch, declareRuntimeEpoch } from "./runtimeEpoch.js";
import { withSessionAdvisoryLock } from "./sessionAdvisoryLock.js";
import {
  applyStandardRuntimePrivileges,
  RETIRED_STANDARD_RUNTIME_TABLES,
} from "./standardRuntimePrivileges.js";

function poolConfig(connectionString: string, applicationName: string): pg.PoolConfig {
  return {
  connectionString,
  ssl: databaseTlsConfig(config.DATABASE_SSL_MODE, config.DATABASE_CA_CERT),
  max: config.DATABASE_POOL_MAX,
  connectionTimeoutMillis: config.DATABASE_ACQUIRE_TIMEOUT_MS,
  idleTimeoutMillis: 30_000,
  statement_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS,
  query_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS,
  idle_in_transaction_session_timeout: config.DATABASE_IDLE_TX_TIMEOUT_MS,
  application_name: applicationName,
  // Every session declares this build's runtime epoch (core migration 011).
  onConnect: declareRuntimeEpoch,
  };
}

export const pool = new pg.Pool(
  poolConfig(config.DATABASE_URL, config.DATABASE_APPLICATION_NAME),
);
export const migrationPool = new pg.Pool(
  poolConfig(
    config.MIGRATION_DATABASE_URL ?? config.DATABASE_URL,
    `${config.DATABASE_APPLICATION_NAME}-migrations`.slice(0, 63),
  ),
);

pool.on("error", (error) => {
  logError("Unexpected idle PostgreSQL client error", { error: error.message });
});
migrationPool.on("error", (error) => {
  logError("Unexpected idle PostgreSQL migration-client error", { error: error.message });
});

let migrationPoolClosed = false;
export async function closeMigrationPool(): Promise<void> {
  if (migrationPoolClosed) return;
  migrationPoolClosed = true;
  await migrationPool.end();
}

export async function verifyDatabaseRoleSeparation(): Promise<void> {
  // Long-lived production deployments protect the same operator and buyer
  // data regardless of chain. Development can opt in by supplying a
  // migration principal explicitly.
  if (config.NODE_ENV !== "production" && !config.MIGRATION_DATABASE_URL) return;
  const [runtime, migration] = await Promise.all([
    pool.query<DatabaseRolePosture>(DATABASE_ROLE_POSTURE_SQL),
    migrationPool.query<DatabaseRolePosture>(DATABASE_ROLE_POSTURE_SQL),
  ]);
  const runtimeRole = runtime.rows[0];
  const migrationRole = migration.rows[0];
  if (!runtimeRole || !migrationRole) throw new Error("database role verification returned no rows");
  assertDatabaseRolePosture(runtimeRole, migrationRole);
  await assertNativePaymentTablesRevoked();
}

export async function configureStandardRuntimePrivileges(): Promise<void> {
  if (!config.MIGRATION_DATABASE_URL) {
    throw new Error("MIGRATION_DATABASE_URL is required for standard-runtime privilege isolation");
  }
  await applyStandardRuntimePrivileges({
    migrationPool,
    runtimeDatabaseUrl: config.DATABASE_URL,
    migrationDatabaseUrl: config.MIGRATION_DATABASE_URL,
  });
}

async function assertNativePaymentTablesRevoked(): Promise<void> {
  const result = await pool.query<{ tablename: string; admitted: boolean }>(
    `SELECT tablename,
            has_table_privilege(current_user,format('%I.%I',current_schema(),tablename),'SELECT') OR
            has_table_privilege(current_user,format('%I.%I',current_schema(),tablename),'INSERT') OR
            has_table_privilege(current_user,format('%I.%I',current_schema(),tablename),'UPDATE') OR
            has_table_privilege(current_user,format('%I.%I',current_schema(),tablename),'DELETE') AS admitted
       FROM unnest($1::text[]) AS tablename`,
    [[...RETIRED_STANDARD_RUNTIME_TABLES]],
  );
  if (result.rows.some((row) => row.admitted)) {
    throw new Error("standard runtime retains native provider payment-table authority");
  }
}

export interface DatabaseRolePosture {
  current_user: string;
  can_create: boolean;
  can_create_database: boolean;
  can_temporary: boolean;
  superuser: boolean;
  create_db: boolean;
  create_role: boolean;
  bypass_rls: boolean;
  member_of_any_role: boolean;
  owns_schema: boolean;
  owned_tables: number;
}

const DATABASE_ROLE_POSTURE_SQL = `
  SELECT current_user,
         has_schema_privilege(current_user, current_schema(), 'CREATE') AS can_create,
         has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_database,
         has_database_privilege(current_user, current_database(), 'TEMPORARY') AS can_temporary,
         r.rolsuper AS superuser,
         r.rolcreatedb AS create_db,
         r.rolcreaterole AS create_role,
         r.rolbypassrls AS bypass_rls,
         EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) AS member_of_any_role,
         pg_get_userbyid(n.nspowner) = current_user AS owns_schema,
         (
           SELECT COUNT(*)::int FROM pg_class c
            WHERE c.relnamespace = n.oid
              AND c.relkind IN ('r','p','v','m','S')
              AND pg_get_userbyid(c.relowner) = current_user
         ) AS owned_tables
    FROM pg_roles r
    JOIN pg_namespace n ON n.nspname = current_schema()
   WHERE r.rolname = current_user
`;

export function assertDatabaseRolePosture(
  runtimeRole: DatabaseRolePosture,
  migrationRole: DatabaseRolePosture,
): void {
  if (runtimeRole.current_user === migrationRole.current_user) {
    throw new Error("runtime and migration database principals must be distinct");
  }
  if (runtimeRole.can_create) {
    throw new Error("runtime database role must not have CREATE on the application schema");
  }
  if (runtimeRole.can_create_database || runtimeRole.can_temporary) {
    throw new Error("runtime database role must not create schemas or temporary relations");
  }
  if (runtimeRole.member_of_any_role) {
    throw new Error("runtime database role must not inherit authority from another role");
  }
  if (!migrationRole.can_create) {
    throw new Error("migration database role requires CREATE on the application schema");
  }
  for (const [name, role] of [["runtime", runtimeRole], ["migration", migrationRole]] as const) {
    if (role.superuser || role.create_db || role.create_role || role.bypass_rls) {
      throw new Error(`${name} database role has forbidden cluster-wide privileges`);
    }
  }
  if (runtimeRole.owns_schema || runtimeRole.owned_tables > 0) {
    throw new Error("runtime database role must not own the application schema or relations");
  }
}

export async function checkDatabase(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export async function runMigrations(): Promise<void> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
  const files = fs.readdirSync(migrationsDir)
    .filter((file: string) => file.endsWith(".sql"))
    .sort();
  const result = await withSessionAdvisoryLock({
    connect: () => migrationPool.connect(),
    async acquire(client) {
      await client.query(
        `SELECT pg_advisory_lock(hashtextextended('daski-core-migrations', 0))`,
      );
      return { status: "acquired" };
    },
    async unlock(client) {
      const unlocked = await client.query<{ unlocked: boolean }>(
        `SELECT pg_advisory_unlock(
           hashtextextended('daski-core-migrations', 0)
         ) AS unlocked`,
      );
      return unlocked.rows[0]?.unlocked === true;
    },
    async work(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS _migrations (
          name TEXT PRIMARY KEY,
          checksum TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(`ALTER TABLE _migrations ADD COLUMN IF NOT EXISTS checksum TEXT`);
      const applied = await client.query("SELECT name, checksum FROM _migrations ORDER BY name");
      const appliedMap = new Map(
        applied.rows.map((row: { name: string; checksum: string | null }) => [
          row.name,
          row.checksum,
        ]),
      );

      for (const file of files) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
        const checksum = createHash("sha256").update(sql, "utf8").digest("hex");
        if (appliedMap.has(file)) {
          const recorded = appliedMap.get(file);
          if (recorded === null) {
            throw new Error(`Applied migration is missing its checksum: ${file}`);
          } else if (recorded !== checksum) {
            throw new Error(`Applied migration checksum changed: ${file}`);
          }
          continue;
        }

        try {
          await client.query("BEGIN");
          await client.query(sql);
          await client.query(
            "INSERT INTO _migrations (name, checksum) VALUES ($1, $2)",
            [file, checksum],
          );
          await client.query("COMMIT");
          logInfo(`Migration applied: ${file}`);
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }
      await client.query(`ALTER TABLE _migrations ALTER COLUMN checksum SET NOT NULL`);
      const known = new Set(files);
      await assertRuntimeSchemaEpoch(client, [...appliedMap.keys()].filter((name) => !known.has(name)));
    },
  });
  if (result.status === "busy") {
    throw new Error("core migration lock unexpectedly reported busy");
  }
}
