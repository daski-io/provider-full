import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import type { Hex } from "viem";
import { vi } from "vitest";
import type { FulfillmentAdapter, ServiceModule } from "../src/core/serviceRegistry/types.js";
import { createMigratedDatabase, type DisposableDatabase } from "./postgresHarness.js";
import { fixedListing, dynamicListing, order, wireConfig, type WireAnswer } from "./providerWireFixture.js";
import { seedFixtureService } from "./standardRailFixture.js";

/*
 * A full provider configured from the provider-wire fixture keys and context,
 * served over HTTP against a disposable PostgreSQL database whose clock is
 * frozen. Every unqualified now() and clock_timestamp() the provider issues
 * resolves to the wire_clock schema first, so observedAt, completion times
 * and the admission fence read the vector's database clock; the JavaScript
 * clock is frozen with fake timers. Test files own their vi.mock calls and
 * delegate to the factories here.
 */
export const wire = {
  pool: null as pg.Pool | null,
  /** Task ids handed to new admissions; the fixture order's task by default. */
  taskIds: [] as string[],
  /** SQL fragments whose next execution fails like a lost connection. */
  faults: [] as string[],
  readinessFailures: [] as string[],
  /** Every statement the provider issued since the last reset. */
  statements: [] as string[],
  adapter: null as unknown as FulfillmentAdapter,
};

function injectFault(text: unknown): void {
  if (typeof text !== "string") return;
  wire.statements.push(text);
  const index = wire.faults.findIndex((fragment) => text.includes(fragment));
  if (index < 0) return;
  wire.faults.splice(index, 1);
  throw Object.assign(new Error("Connection terminated unexpectedly"), { code: "08006" });
}

/** `db/pool.js` over the disposable database, with injectable faults. */
export function poolModule() {
  const query = async (...args: unknown[]) => {
    injectFault(args[0]);
    return (wire.pool!.query as (...a: unknown[]) => unknown)(...args);
  };
  return {
    pool: {
      query,
      connect: async () => {
        const client = await wire.pool!.connect();
        const original = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
        (client as unknown as { query: (...a: unknown[]) => Promise<unknown> }).query = async (...args) => {
          injectFault(args[0]);
          return original(...args);
        };
        return client;
      },
    },
    migrationPool: { query: vi.fn(), connect: vi.fn() },
    closeMigrationPool: vi.fn(),
    checkDatabase: async () => true,
  };
}

/** The synthetic notes service the fixture listings name. */
export const notesModule = {
  manifest: { slug: "notes", version: "1" },
  operations: { readiness: { checkInvariants: async () => [...wire.readinessFailures] } },
} as unknown as ServiceModule;

export function registryModule() {
  return {
    getAdapter: () => wire.adapter,
    getService: (slug: string) => (slug === "notes" ? notesModule : null),
    getAllServices: () => [],
  };
}

export function identifiersModule() {
  return { newStandardTaskId: () => wire.taskIds.shift() ?? order.providerTaskId };
}

const WIRE_CLOCK_SQL = `
  CREATE SCHEMA wire_clock;
  CREATE TABLE wire_clock.frozen (at timestamptz);
  INSERT INTO wire_clock.frozen VALUES (NULL);
  CREATE FUNCTION wire_clock.now() RETURNS timestamptz LANGUAGE sql STABLE
    AS $$ SELECT COALESCE((SELECT at FROM wire_clock.frozen LIMIT 1), pg_catalog.now()) $$;
  CREATE FUNCTION wire_clock.clock_timestamp() RETURNS timestamptz LANGUAGE sql VOLATILE
    AS $$ SELECT COALESCE((SELECT at FROM wire_clock.frozen LIMIT 1), pg_catalog.clock_timestamp()) $$;`;

const KEPT_TABLES = new Set(["_migrations", "_service_migrations", "services", "skills"]);

export interface WireHarness {
  database: DisposableDatabase;
  serviceId: string;
  /** Freeze the provider clock and, unless given, the database clock. */
  at(now: number, database?: number): Promise<void>;
  send(http: { url: string; headers: Record<string, string>; bodyText?: string; body?: unknown }): Promise<WireAnswer>;
  /** Remove every order, quote and claim; keep the installed service. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function startWireHarness(label: string): Promise<WireHarness> {
  const database = await createMigratedDatabase(label);
  await database.pool.query(WIRE_CLOCK_SQL);
  wire.pool = new pg.Pool({
    connectionString: database.url, max: 10, options: "-c search_path=wire_clock,pg_catalog,public",
  });
  const serviceId = await seedFixtureService(database.pool, {
    skillIds: [fixedListing.skillId, dynamicListing.skillId],
  });
  await database.pool.query("UPDATE services SET slug='notes',adapter_name='notes' WHERE id=$1", [serviceId]);
  const { config: coreConfig } = await import("../src/core/config.js");
  Object.assign(coreConfig, { RATE_LIMIT_BYPASS_IPS: "127.0.0.1" });
  const { createProviderApp } = await import("../src/core/server.js");
  const server: Server = createProviderApp(wireConfig()).listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.useFakeTimers({ toFake: ["Date"] });
  return {
    database,
    serviceId,
    async at(now, databaseClock = now) {
      vi.setSystemTime(now * 1_000);
      await database.pool.query("UPDATE wire_clock.frozen SET at=to_timestamp($1)", [databaseClock]);
    },
    async send(http) {
      const response = await fetch(`${origin}${new URL(http.url).pathname}`, {
        method: "POST",
        headers: http.headers,
        body: http.bodyText ?? JSON.stringify(http.body),
      });
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        contentEncoding: response.headers.get("content-encoding"),
        text: await response.text(),
      };
    },
    async reset() {
      wire.faults.length = 0;
      wire.readinessFailures.length = 0;
      wire.taskIds.length = 0;
      wire.statements.length = 0;
      const tables = (await database.pool.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname='public'",
      )).rows.map((row) => row.tablename).filter((table) => !KEPT_TABLES.has(table));
      // Test-only reset of the disposable database: replica mode skips the
      // triggers that keep claims and frozen results undeletable, and is far
      // faster than TRUNCATE ... CASCADE for a handful of rows.
      const client = await database.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL session_replication_role = replica");
        await client.query(tables.map((table) => `DELETE FROM "${table}";`).join("\n"));
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      vi.useRealTimers();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await wire.pool?.end();
      wire.pool = null;
      await database.drop();
    },
  };
}

/** The deposit authorization key the stubbed evidence verifier reports. */
export const WIRE_AUTHORIZATION_KEY = `0x${"ab".repeat(32)}` as Hex;
