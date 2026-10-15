import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../src/core/config.js";
import { installHttpSecurityBoundary } from "../src/core/security/httpBoundary.js";
import { requestClientIp } from "../src/core/security/rateLimit.js";

const originalConfig = {
  BASE_URL: config.BASE_URL,
  TRUST_PROXY_HOPS: config.TRUST_PROXY_HOPS,
  TRUST_PROXY_CIDRS: config.TRUST_PROXY_CIDRS,
  EDGE_SECRET: config.EDGE_SECRET,
};

afterEach(() => Object.assign(config, originalConfig));

async function serveBoundary(overrides: Partial<typeof originalConfig>): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  Object.assign(config, overrides);
  const app = express();
  installHttpSecurityBoundary(app);
  app.get("/", (_req, res) => {
    res.type("html").send(
      '<!doctype html><script>plain()</script><script nonce="fixed">fixed()</script>',
    );
  });
  app.get("/health/live", (_req, res) => {
    res.json({ status: "alive" });
  });
  app.get("/echo-client", (req, res) => {
    res.json({
      client: requestClientIp(req),
      edgeVerified: req.edgeVerified === true,
      forwardedFor: req.get("x-forwarded-for") ?? null,
      forwardedProto: req.get("x-forwarded-proto") ?? null,
      edgeSecret: req.get("x-daski-edge-secret") ?? null,
    });
  });
  app.get("/echo-forwarding", (req, res) => {
    res.json({
      forwardedFor: req.get("x-forwarded-for") ?? null,
      forwardedProto: req.get("x-forwarded-proto") ?? null,
      forwardedHost: req.get("x-forwarded-host") ?? null,
      ip: req.ip,
    });
  });
  const server: Server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function withServer<T>(
  overrides: Partial<typeof originalConfig>,
  run: (url: string) => Promise<T>,
): Promise<T> {
  const server = await serveBoundary(overrides);
  try {
    return await run(server.url);
  } finally {
    await server.close();
  }
}

describe("global HTTP security boundary", () => {
  it("sets the HTTPS policy without authorizing inline scripts", async () => {
    await withServer({
      BASE_URL: "https://provider.example",
      TRUST_PROXY_HOPS: 0,
      TRUST_PROXY_CIDRS: "",
    }, async (url) => {
      const response = await fetch(url);
      const csp = response.headers.get("content-security-policy") ?? "";
      expect(response.status).toBe(200);
      expect(csp).toBe([
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "object-src 'none'",
      ].join("; "));
      expect(response.headers.get("strict-transport-security"))
        .toBe("max-age=63072000; includeSubDomains; preload");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      // A no-referrer policy makes Firefox send `Origin: null` for basic form
      // POSTs, so the policy must retain the origin for same-origin admin forms.
      expect(response.headers.get("referrer-policy")).toBe("same-origin");
      expect(response.headers.get("permissions-policy"))
        .toBe("camera=(), microphone=(), geolocation=(), payment=(), usb=()");
      expect(response.headers.has("x-powered-by")).toBe(false);
      const body = await response.text();
      expect(body).toContain("<script>plain()</script>");
      expect(body).toContain('<script nonce="fixed">fixed()');
      expect(body).not.toContain("cspNonce");
    });
  });

  it("omits HSTS when the validated public origin is HTTP", async () => {
    await withServer({
      BASE_URL: "http://provider.example",
      TRUST_PROXY_HOPS: 0,
      TRUST_PROXY_CIDRS: "",
    }, async (url) => {
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(response.headers.has("strict-transport-security")).toBe(false);
    });
  });

  it("strips forwarding headers instead of rejecting when no proxy topology is declared", async () => {
    // A managed edge may unconditionally stamp X-Forwarded-*
    // on every request. With zero declared hops the boundary must neither
    // trust nor 400 those headers — it strips them so downstream readers
    // see only socket-derived attribution.
    await withServer({
      BASE_URL: "https://provider.example",
      TRUST_PROXY_HOPS: 0,
      TRUST_PROXY_CIDRS: "",
    }, async (url) => {
      const response = await fetch(new URL("/echo-forwarding", url), {
        headers: {
          "x-forwarded-for": "203.0.113.9",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "spoofed.example",
        },
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        forwardedFor: null,
        forwardedProto: null,
        forwardedHost: null,
        ip: "127.0.0.1",
      });
    });
  });

  it("accepts a direct request without trusting caller-supplied topology", async () => {
    await withServer({
      BASE_URL: "https://provider.example",
      TRUST_PROXY_HOPS: 1,
      TRUST_PROXY_CIDRS: "192.0.2.0/24",
    }, async (url) => {
      const response = await fetch(url);
      expect(response.status).toBe(200);
    });
  });

  it("accepts a consistent one-hop forwarding set only from the configured proxy", async () => {
    await withServer({
      BASE_URL: "https://provider.example",
      TRUST_PROXY_HOPS: 1,
      TRUST_PROXY_CIDRS: "127.0.0.1/32",
    }, async (url) => {
      const response = await fetch(url, { headers: {
        "x-forwarded-for": "198.51.100.21",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "provider.example",
      } });
      expect(response.status).toBe(200);
    });
  });

  it("rejects spoofed forwarding from an untrusted peer and still applies global headers", async () => {
    await withServer({
      BASE_URL: "https://provider.example",
      TRUST_PROXY_HOPS: 1,
      TRUST_PROXY_CIDRS: "192.0.2.0/24",
    }, async (url) => {
      const response = await fetch(url, { headers: {
        "x-forwarded-for": "198.51.100.21",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "provider.example",
      } });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "untrusted_forwarding_headers" });
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.has("x-powered-by")).toBe(false);
    });
  });

  it.each([
    [
      "extra hop",
      { "x-forwarded-for": "198.51.100.21, 192.0.2.10", "x-forwarded-proto": "https" },
      "forwarding_hop_mismatch",
    ],
    [
      "unknown protocol",
      { "x-forwarded-for": "198.51.100.21", "x-forwarded-proto": "javascript" },
      "invalid_forwarded_proto",
    ],
    [
      "insecure protocol",
      { "x-forwarded-for": "198.51.100.21", "x-forwarded-proto": "http" },
      "insecure_forwarded_proto",
    ],
    [
      "different public host",
      {
        "x-forwarded-for": "198.51.100.21",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "attacker.example",
      },
      "forwarded_host_mismatch",
    ],
  ])("rejects a trusted proxy's %s", async (_case, headers, error) => {
    await withServer({
      BASE_URL: "https://provider.example",
      TRUST_PROXY_HOPS: 1,
      TRUST_PROXY_CIDRS: "127.0.0.1/32",
    }, async (url) => {
      const response = await fetch(url, { headers });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error });
    });
  });

  it("fails app construction on malformed trusted-proxy ranges", () => {
    Object.assign(config, {
      BASE_URL: "https://provider.example",
      TRUST_PROXY_HOPS: 1,
      TRUST_PROXY_CIDRS: "definitely-not-a-cidr",
    });
    const app = express();
    expect(() => installHttpSecurityBoundary(app)).toThrow("invalid IP/CIDR");
  });
});

// C05: an optional verified edge mode. The edge secret proves the path and
// names the client; a caller's forwarding headers are dropped unread, so
// the two are never interchangeable trust sources. Unset, nothing changes.
describe("verified edge mode", () => {
  const edge = {
    BASE_URL: "https://provider.example",
    TRUST_PROXY_HOPS: 0,
    TRUST_PROXY_CIDRS: "",
    EDGE_SECRET: "s".repeat(64),
  };

  it("refuses a public request without the edge secret and still answers health", async () => {
    await withServer(edge, async (url) => {
      const refused = await fetch(new URL("/echo-client", url), {
        headers: { "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "203.0.113.9" },
      });
      expect(refused.status).toBe(403);
      await expect(refused.json()).resolves.toEqual({ error: "edge_required" });
      const wrong = await fetch(new URL("/echo-client", url), {
        headers: { "x-daski-edge-secret": `${"s".repeat(63)}x`, "cf-connecting-ip": "203.0.113.9" },
      });
      expect(wrong.status).toBe(403);
      const health = await fetch(new URL("/health/live", url));
      expect(health.status).toBe(200);
    });
  });

  it("names the client the edge forwards and drops the forwarding chain and the secret", async () => {
    await withServer(edge, async (url) => {
      const admitted = await fetch(new URL("/echo-client", url), {
        headers: {
          "x-daski-edge-secret": "s".repeat(64),
          "cf-connecting-ip": "203.0.113.9",
          "x-forwarded-for": "198.51.100.1, 203.0.113.9, 172.67.1.1",
          "x-forwarded-proto": "https",
        },
      });
      expect(admitted.status).toBe(200);
      await expect(admitted.json()).resolves.toEqual({
        client: "203.0.113.9", edgeVerified: true, forwardedFor: null, forwardedProto: null, edgeSecret: null,
      });
      const unnamed = await fetch(new URL("/echo-client", url), {
        headers: { "x-daski-edge-secret": "s".repeat(64) },
      });
      expect(unnamed.status).toBe(400);
      await expect(unnamed.json()).resolves.toEqual({ error: "edge_client_address_missing" });
    });
  });

  it("never lets a caller-written client address stand in for the edge's when no secret is configured", async () => {
    await withServer({ ...edge, EDGE_SECRET: "" }, async (url) => {
      const response = await fetch(new URL("/echo-client", url), {
        headers: { "cf-connecting-ip": "203.0.113.9", "x-daski-edge-secret": "s".repeat(64) },
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ client: "127.0.0.1", edgeVerified: false });
    });
  });
});
