import { afterEach, describe, expect, it, vi } from "vitest";
import { createMigratedTestDatabase } from "./postgresTestDatabase.js";

// The disposable-database helper interpolates its prefix into unquoted
// CREATE/DROP DATABASE identifiers, so it accepts only names that cannot be
// case-folded, truncated or injected, and refuses others before connecting.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("PostgreSQL test databases", () => {
  it("refuse a prefix that is not a short lowercase identifier before connecting", async () => {
    vi.stubEnv("DATABASE_URL_TEST", "postgres://nobody@unreachable.invalid:1/none");
    for (const prefix of ["Forecast", "bad-prefix", "x;DROP DATABASE y", "a".repeat(42), "_lead"]) {
      await expect(createMigratedTestDatabase(prefix)).rejects.toThrow(/must match/);
    }
  });
});
