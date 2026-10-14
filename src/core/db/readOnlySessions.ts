import type pg from "pg";

const READ_ONLY_OPTION = "-c default_transaction_read_only=on";

/**
 * Open every later session of the pool with read-only transactions by
 * default, so a read-only command fails closed instead of writing if a code
 * path regresses. PostgreSQL applies the setting at session start, before
 * the first query. Install it before the pool's first query, then confirm
 * it with assertReadOnlySessions.
 */
export function enforceReadOnlySessions(target: pg.Pool): void {
  const existing = target.options.options;
  if (existing?.includes(READ_ONLY_OPTION)) return;
  target.options.options = [existing, READ_ONLY_OPTION].filter(Boolean).join(" ");
}

/** Fail unless the pool's sessions really refuse writes. */
export async function assertReadOnlySessions(target: pg.Pool): Promise<void> {
  const result = await target.query<{ default_transaction_read_only: string }>(
    "SHOW default_transaction_read_only",
  );
  if (result.rows[0]?.default_transaction_read_only !== "on") {
    throw new Error("database sessions are not read-only");
  }
}
