import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertStrictJsonText,
  decodeStrictJson,
  STRICT_JSON_SCAN_LIMITS,
} from "../src/core/standardRail/strictJson.js";
import {
  isStrictlyParsedStandardRailJson,
  sendSignedJson,
  STANDARD_RAIL_MAX_REQUEST_BYTES,
  STANDARD_RAIL_STATUS_MAX_REQUEST_BYTES,
  standardRailJsonIngress,
} from "../src/core/standardRail/transport.js";

// C01/C-T12: the gateway sends bounded, uncompressed application/json with
// unique keys and reads provider answers the same way.
let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use("/standard-rail", ...standardRailJsonIngress());
  app.post(/^\/standard-rail\/.+/, (req, res) => {
    sendSignedJson(res, { received: req.body, strict: isStrictlyParsedStandardRailJson(req) });
  });
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/standard-rail`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

function post(path: string, body: BodyInit, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("standard-rail JSON ingress", () => {
  it("accepts strict JSON and answers uncompressed, uncached application/json", async () => {
    const response = await post("/quote", JSON.stringify({ request: { a: [1, "x", null] } }), {
      "accept-encoding": "gzip, br",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")?.split(";")[0]).toBe("application/json");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      received: { request: { a: [1, "x", null] } },
      strict: true,
    });
  });

  it("rejects duplicate keys at any depth before a handler runs", async () => {
    for (const text of ['{"a":1,"a":2}', '{"request":{"payload":{"payer":null,"payer":"0x"}}}']) {
      const response = await post("/dispatch", text);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_json" });
    }
  });

  it("rejects compressed, non-JSON and non-UTF-8 media types", async () => {
    const body = JSON.stringify({ request: {} });
    const gzip = await post("/quote", gzipSync(body), { "content-encoding": "gzip" });
    expect(gzip.status).toBe(415);
    await expect(gzip.json()).resolves.toEqual({ error: "uncompressed_application_json_required" });
    for (const contentType of [
      "text/plain", "application/json; charset=utf-16", "application/x-json",
      "application/json; charset =utf-7", "application/json; Charset= \"UTF-7\"",
      "application/json; charset=utf-8; charset=utf-7",
    ]) {
      const response = await post("/quote", body, { "content-type": contentType });
      expect(response.status).toBe(415);
    }
    const identity = await post("/quote", body, {
      "content-encoding": "identity",
      "content-type": "application/json; charset=utf-8",
    });
    expect(identity.status).toBe(200);
    expect((await post("/quote", body, { "content-type": 'application/json; charset = "UTF-8"' })).status)
      .toBe(200);
  });

  it("bounds request bodies, with a tighter bound for status queries", async () => {
    const large = JSON.stringify({ value: "x".repeat(STANDARD_RAIL_MAX_REQUEST_BYTES) });
    const tooLarge = await post("/dispatch", large);
    expect(tooLarge.status).toBe(413);
    await expect(tooLarge.json()).resolves.toEqual({ error: "request_too_large" });
    const status = JSON.stringify({ query: "x".repeat(STANDARD_RAIL_STATUS_MAX_REQUEST_BYTES) });
    expect((await post("/dispatch/status", status)).status).toBe(413);
    expect((await post("/quote", status)).status).toBe(200);
  });

  it("answers malformed and pathological JSON with a definite client error", async () => {
    const deep = `${"[".repeat(STRICT_JSON_SCAN_LIMITS.maxDepth + 1)}${"]".repeat(STRICT_JSON_SCAN_LIMITS.maxDepth + 1)}`;
    for (const text of [
      "{\"a\":",
      deep,
      JSON.stringify({ ["k".repeat(STRICT_JSON_SCAN_LIMITS.maxKeyLength + 1)]: 1 }),
      '{"__proto__":{"polluted":true}}',
      '{"constructor":1}',
    ]) {
      const response = await post("/quote", text);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_json" });
    }
    const invalidUtf8 = Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
    const response = await post("/quote", invalidUtf8);
    expect(response.status).toBe(400);
  });
});

describe("strict JSON scanner", () => {
  it("accepts ordinary JSON documents", () => {
    expect(() => assertStrictJsonText('{"a":{"b":[1,2.5,-3e2,true,false,null,"\\"x\\u0041"]}}')).not.toThrow();
    expect(decodeStrictJson(Buffer.from('{"emoji":"\u{1f600}"}'))).toBe('{"emoji":"\u{1f600}"}');
  });

  it("rejects duplicates hidden by escapes and trailing content", () => {
    expect(() => assertStrictJsonText('{"a":1,"\\u0061":2}')).toThrow("duplicate key");
    expect(() => assertStrictJsonText('{"a":1} {}')).toThrow("Trailing JSON content");
  });

  it("bounds the number of values", () => {
    const many = `[${new Array(STRICT_JSON_SCAN_LIMITS.maxNodes).fill(0).join(",")}]`;
    expect(() => assertStrictJsonText(many)).toThrow("too many values");
  });
});
