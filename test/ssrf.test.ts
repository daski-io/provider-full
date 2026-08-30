import { describe, it, expect } from "vitest";
import { validatePublicUrl } from "../src/core/security/ssrf.js";

// validatePublicUrl is the SSRF gate for outbound URLs the provider
// fetches on behalf of buyers (push-notification webhooks today).
// Tests cover: scheme allowlist, userinfo rejection, and the
// private/loopback/link-local IP range blocklist for both v4 and v6.
//
// Hostnames `example.com` / `nonexistent-host.invalid` are deliberate:
// the former is RFC 2606 documentation domain that always resolves
// publicly, the latter is in `.invalid` so DNS lookup fails.

describe("validatePublicUrl: scheme + url shape", () => {
  it("rejects query credentials and fragments for push destinations", async () => {
    const query = await validatePublicUrl("https://8.8.8.8/hook?token=URL_SECRET", {
      allowQueryOrFragment: false,
    });
    const fragment = await validatePublicUrl("https://8.8.8.8/hook#URL_SECRET", {
      allowQueryOrFragment: false,
    });
    expect(query).toEqual(expect.objectContaining({ ok: false }));
    expect(fragment).toEqual(expect.objectContaining({ ok: false }));
    expect(JSON.stringify([query, fragment])).not.toContain("URL_SECRET");
  });
  it("rejects unparseable URL", async () => {
    const r = await validatePublicUrl("not a url");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/parseable/);
  });

  it("rejects file:// scheme", async () => {
    const r = await validatePublicUrl("file:///etc/passwd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/scheme/);
  });

  it("rejects gopher:// scheme", async () => {
    const r = await validatePublicUrl("gopher://example.com/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/scheme/);
  });

  it("rejects http:// by default (https-only)", async () => {
    const r = await validatePublicUrl("http://example.com/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/scheme/);
  });

  it("permits http:// when allowHttp = true", async () => {
    // This assertion is about scheme permission; a public IP avoids making
    // the test depend on DNS latency under a loaded parallel test battery.
    const r = await validatePublicUrl("http://8.8.8.8/", { allowHttp: true });
    expect(r.ok).toBe(true);
  });

  it("rejects URLs with embedded userinfo", async () => {
    const r = await validatePublicUrl("https://user:pass@example.com/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/userinfo/);
  });
});

describe("validatePublicUrl: IPv4 private/reserved blocks", () => {
  const cases: Array<[string, string]> = [
    ["https://127.0.0.1/", "loopback"],
    ["https://127.5.5.5/", "loopback /8"],
    ["https://10.0.0.1/", "RFC1918 10/8"],
    ["https://10.255.255.255/", "RFC1918 10/8 high"],
    ["https://172.16.0.1/", "RFC1918 172.16/12 low"],
    ["https://172.31.255.255/", "RFC1918 172.16/12 high"],
    ["https://192.168.1.1/", "RFC1918 192.168/16"],
    ["https://169.254.169.254/", "AWS/GCP/Azure metadata"],
    ["https://0.0.0.0/", "this network"],
    ["https://100.64.0.1/", "CGNAT"],
    ["https://224.0.0.1/", "multicast"],
    ["https://255.255.255.255/", "broadcast"],
    ["https://192.0.2.1/", "TEST-NET-1"],
    ["https://198.51.100.1/", "TEST-NET-2"],
    ["https://203.0.113.1/", "TEST-NET-3"],
    ["https://198.18.0.1/", "benchmark /15"],
  ];

  for (const [url, label] of cases) {
    it(`rejects ${label} (${url})`, async () => {
      const r = await validatePublicUrl(url);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/private|reserved/);
    });
  }

  it("rejects 172.15.x.x — outside RFC1918 but still tested as a sanity check (should pass)", async () => {
    // 172.15.0.1 is NOT in 172.16/12; it should be allowed by the IP rules.
    // This is a public-routable address from the perspective of the rule set.
    const r = await validatePublicUrl("https://172.15.0.1/");
    expect(r.ok).toBe(true);
  });

  it("rejects 172.32.x.x — outside RFC1918, allowed", async () => {
    const r = await validatePublicUrl("https://172.32.0.1/");
    expect(r.ok).toBe(true);
  });
});

describe("validatePublicUrl: IPv6 private/reserved blocks", () => {
  const cases: Array<[string, string]> = [
    ["https://[::1]/", "loopback"],
    ["https://[fe80::1]/", "link-local fe80::/10"],
    ["https://[fc00::1]/", "ULA fc00::/7"],
    ["https://[fd00::1]/", "ULA fd00::/8"],
    ["https://[ff02::1]/", "multicast"],
    ["https://[::ffff:127.0.0.1]/", "IPv4-mapped loopback"],
    ["https://[::ffff:169.254.169.254]/", "IPv4-mapped IMDS"],
    ["https://[::7f00:1]/", "IPv4-compatible loopback"],
    ["https://[64:ff9b::7f00:1]/", "NAT64-translated loopback"],
    ["https://[64:ff9b:1::1]/", "local-use translation prefix"],
    ["https://[100::1]/", "discard-only prefix"],
    ["https://[2002:7f00:1::]/", "6to4-encoded loopback"],
    ["https://[fec0::1]/", "deprecated site-local"],
    ["https://[2001:db8::1]/", "documentation prefix"],
  ];

  for (const [url, label] of cases) {
    it(`rejects ${label} (${url})`, async () => {
      const r = await validatePublicUrl(url);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/private|reserved/);
    });
  }
});

describe("validatePublicUrl: hostname resolution", () => {
  it("returns a clear error when DNS lookup fails", async () => {
    const r = await validatePublicUrl(
      "https://nonexistent-host.invalid/",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/dns lookup failed/);
  });

  it("accepts a publicly-resolving hostname", async () => {
    // example.com is a stable RFC 2606 reserved domain that resolves
    // to public addresses. If this ever flips off, the test is a
    // canary for upstream DNS, not a code regression.
    const r = await validatePublicUrl("https://example.com/");
    expect(r.ok).toBe(true);
  });
});

describe("validatePublicUrl: returns validated addresses for connection pinning", () => {
  it("returns the literal IP in `addresses` for a public IPv4 literal", async () => {
    const r = await validatePublicUrl("https://8.8.8.8/");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.addresses).toEqual(["8.8.8.8"]);
  });

  it("returns the resolved public address(es) for a hostname", async () => {
    // Callers (pushNotifier) pin the connection to these instead of
    // re-resolving — so they must come back, and must be public.
    const r = await validatePublicUrl("https://example.com/");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.addresses.length).toBeGreaterThan(0);
      for (const a of r.addresses) {
        expect(a).not.toMatch(/^(127\.|10\.|192\.168\.|169\.254\.)/);
      }
    }
  });
});
