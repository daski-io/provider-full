import type pg from "pg";
import { logError } from "../logger.js";
import type { Queryable } from "./queryable.js";

/*
 * The schema epoch this build's runtimes are written for. Every session
 * declares it before its first statement; the database refuses ledger
 * writes from a session that declared none or an older one (core migration
 * 011). A build also refuses to run on a schema whose minimum epoch is newer
 * than its own, including one migrated by a newer build.
 */

export const RUNTIME_SCHEMA_EPOCH = 1;
export const RUNTIME_EPOCH_STATEMENT = `SET daski.runtime_epoch = '${RUNTIME_SCHEMA_EPOCH}'`;

/**
 * The pools' onConnect hook: a new session declares this build's runtime
 * epoch before it serves anything. If the declaration fails, the pool ends
 * the session and the caller's connect fails.
 */
export async function declareRuntimeEpoch(client: pg.ClientBase): Promise<void> {
  try {
    await client.query(RUNTIME_EPOCH_STATEMENT);
  } catch (error) {
    logError("Database session could not declare its runtime epoch", {
      errorClass: error instanceof Error ? error.name : "UnknownError",
    });
    throw error;
  }
}

/**
 * Refuse a schema that needs a newer runtime. Applied migrations this build
 * does not know are accepted only while the schema's minimum epoch still
 * admits this build: a later release adds compatible migrations without
 * raising it.
 */
export async function assertRuntimeSchemaEpoch(db: Queryable, unknownMigrations: readonly string[]): Promise<void> {
  const present = (await db.query<{ present: boolean }>(
    "SELECT to_regproc('public.provider_minimum_runtime_epoch') IS NOT NULL AS present",
  )).rows[0]?.present === true;
  if (!present) {
    if (unknownMigrations.length > 0) {
      throw new Error(`database has migrations this build does not know: ${unknownMigrations.join(", ")}`);
    }
    return;
  }
  const minimum = Number((await db.query<{ minimum: number }>(
    "SELECT public.provider_minimum_runtime_epoch() AS minimum",
  )).rows[0]?.minimum);
  if (!Number.isSafeInteger(minimum) || minimum > RUNTIME_SCHEMA_EPOCH) {
    throw new Error(
      `database schema requires runtime epoch ${minimum}; this build supports ${RUNTIME_SCHEMA_EPOCH}`,
    );
  }
}

/**
 * Whether the schema's minimum runtime epoch still admits this build, for
 * readiness: a schema migrated by a newer build refuses this one's writes.
 * True on a schema that predates the epoch barrier.
 */
export async function runtimeEpochAdmitted(db: Queryable): Promise<boolean> {
  const row = (await db.query<{ minimum: number | null }>(
    `SELECT CASE WHEN to_regproc('public.provider_minimum_runtime_epoch') IS NULL THEN NULL
                 ELSE public.provider_minimum_runtime_epoch() END AS minimum`,
  )).rows[0];
  if (row?.minimum === null || row?.minimum === undefined) return true;
  const minimum = Number(row.minimum);
  return Number.isSafeInteger(minimum) && minimum <= RUNTIME_SCHEMA_EPOCH;
}
