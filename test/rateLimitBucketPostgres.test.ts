import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { takeRateLimitToken } from "../src/core/security/rateLimit.js";
import { createMigratedTestDatabase, type MigratedTestDatabase } from "./postgresTestDatabase.js";

// C05's optional rate-limit WAL optimization against PostgreSQL, on the
// table exactly as the core migrations define it: a token spend commits
// without waiting for the WAL flush for its own implicit transaction only,
// and leaves every later transaction of the session durable.
let database: MigratedTestDatabase;

beforeAll(async () => {
  database = await createMigratedTestDatabase("rate_limit_buckets");
}, 120_000);

afterAll(async () => {
  await database?.drop();
}, 120_000);

describe("rate-limit buckets against PostgreSQL", () => {
  it("spends tokens without waiting for a WAL flush and leaves the session's next commit durable", async () => {
    const client = await database.pool.connect();
    const synchronousCommit = async () =>
      (await client.query<{ synchronous_commit: string }>("SHOW synchronous_commit")).rows[0]!.synchronous_commit;
    try {
      expect(await synchronousCommit()).toBe("on");
      // Two tokens and a refill of one a minute: the third spend finds it empty.
      await expect(takeRateLimitToken(client, "global:client", 2, 1)).resolves.toBe(true);
      await expect(takeRateLimitToken(client, "global:client", 2, 1)).resolves.toBe(true);
      await expect(takeRateLimitToken(client, "global:client", 2, 1)).resolves.toBe(false);
      // Each spend ran in its own implicit transaction; the setting ended with it.
      expect(await synchronousCommit()).toBe("on");

      // Inside an explicit transaction the setting is visible: only that
      // transaction commits asynchronously, and it ends with it.
      await client.query("BEGIN");
      await expect(takeRateLimitToken(client, "global:other", 2, 1)).resolves.toBe(true);
      expect(await synchronousCommit()).toBe("off");
      await client.query("COMMIT");
      expect(await synchronousCommit()).toBe("on");
      expect((await client.query("SELECT bucket_key FROM rate_limit_buckets ORDER BY bucket_key")).rows)
        .toEqual([{ bucket_key: "global:client" }, { bucket_key: "global:other" }]);
    } finally {
      client.release();
    }
  }, 30_000);
});
