import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMigratedDatabase, DATABASE_HOOK_TIMEOUT_MS, type DisposableDatabase } from "./postgresHarness.js";
import { fixtureConfig } from "./standardRailFixture.js";

// No request body is inflated anywhere in the provider HTTP stack. With
// inflation on, body-parser runs zlib on unauthenticated bytes before any
// route or authentication check; CVE-2026-111497 was an out-of-bounds write
// in Node's Brotli decoder reachable that way. Every JSON parser refuses a
// compressed body with 415, and no decompressor is ever created for it.
vi.setConfig({ testTimeout: 30_000 });
const h = vi.hoisted(() => ({ pool: null as pg.Pool | null }));
vi.mock("../src/core/db/pool.js", () => ({
  pool: {
    query: (...args: unknown[]) => (h.pool!.query as (...a: unknown[]) => unknown)(...args),
    connect: () => h.pool!.connect(),
  },
  migrationPool: { query: vi.fn(), connect: vi.fn() },
  closeMigrationPool: vi.fn(),
  checkDatabase: async () => true,
}));
vi.mock("../src/core/serviceRegistry/registry.js", () => ({
  getAdapter: () => ({ execute: vi.fn(), handleInput: vi.fn(), cancel: vi.fn(), quote: vi.fn() }),
  getService: () => null,
  getAllServices: () => [],
}));

const { createProviderApp } = await import("../src/core/server.js");

let database: DisposableDatabase;
let server: Server;
let origin: string;

beforeAll(async () => {
  database = await createMigratedDatabase("compressed_bodies");
  h.pool = database.pool;
  server = createProviderApp(fixtureConfig(), undefined, {
    salesAdmission: async () => ({ status: "open" as const }),
    contractIntegrity: async () => undefined,
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, DATABASE_HOOK_TIMEOUT_MS);

afterAll(async () => {
  vi.restoreAllMocks();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await database?.drop();
}, DATABASE_HOOK_TIMEOUT_MS);

const json = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: {} }));
const compressed = {
  br: zlib.brotliCompressSync(json),
  gzip: zlib.gzipSync(json),
  deflate: zlib.deflateSync(json),
};
// The catch-all parser, plus the two paths with parsers of their own.
const paths = ["/a2a", "/admin/ui/login/verify", "/services/unknown"];

function post(path: string, body: Buffer, encoding?: string): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(encoding ? { "content-encoding": encoding } : {}) },
    body: new Uint8Array(body),
  });
}

describe("compressed request bodies", () => {
  for (const path of paths) {
    for (const [encoding, body] of Object.entries(compressed)) {
      it(`refuses ${encoding} on ${path} without inflating it`, async () => {
        const decompressors = [
          vi.spyOn(zlib, "createBrotliDecompress"),
          vi.spyOn(zlib, "createGunzip"),
          vi.spyOn(zlib, "createInflate"),
        ];
        try {
          const response = await post(path, body, encoding);
          expect(response.status).toBe(415);
          expect(await response.json()).toEqual({ error: "uncompressed_application_json_required" });
          for (const decompressor of decompressors) expect(decompressor).not.toHaveBeenCalled();
        } finally {
          for (const decompressor of decompressors) decompressor.mockRestore();
        }
      });
    }

    // The route answers for itself (here often 503: no SIWE or provider
    // identity is configured); a parser refusal would be a 415 or a 500.
    it(`still parses an uncompressed body on ${path}`, async () => {
      for (const encoding of [undefined, "identity"]) {
        const response = await post(path, json, encoding);
        expect([415, 500]).not.toContain(response.status);
      }
    });
  }
});
