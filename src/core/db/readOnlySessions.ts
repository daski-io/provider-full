import type pg from "pg";

const READ_ONLY_OPTION = "-c default_transaction_read_only=on";

/**
 * Open every later session of the pool with read-only transactions by
 * default, so a read-only command fails closed instead of writing if a code
 * path regresses. PostgreSQL applies the setting at session start, before
 * the first query. Install it before the pool's first query, then confirm
 * it with assertReadOnlySessions.
 *
 * node-postgres takes the startup `options` from the connection string's
 * `options` parameter when there is one, else from the pool config, else
 * from PGOPTIONS, each replacing the others. The flag is appended to
 * whichever of those the sessions would use, and an `options` parameter
 * moves from the connection string into the config, so the operator's own
 * session options (a search_path, an endpoint) are kept and the flag cannot
 * be dropped.
 */
export function enforceReadOnlySessions(target: pg.Pool): void {
  const config = target.options as pg.PoolConfig;
  let fromConnectionString: string | null = null;
  if (config.connectionString) {
    let url: URL | null = null;
    try {
      url = new URL(config.connectionString);
    } catch {
      // Not URL-shaped (a bare socket path): it cannot carry options.
    }
    fromConnectionString = url?.searchParams.get("options") ?? null;
    if (url && fromConnectionString !== null) {
      url.searchParams.delete("options");
      config.connectionString = url.toString();
    }
  }
  const base = fromConnectionString ?? config.options ?? process.env.PGOPTIONS ?? "";
  config.options = base.includes(READ_ONLY_OPTION)
    ? base
    : [base, READ_ONLY_OPTION].filter(Boolean).join(" ");
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
