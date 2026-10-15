import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// SSRF guard for outbound URLs the provider fetches on behalf of buyers
// (push-notification webhooks today; potentially other webhook surfaces
// later). Both the registration handler and the delivery worker call
// this so a TOCTOU / DNS-rebinding flip between set time and dispatch
// time can't bypass the check.

export type ValidatePublicUrlResult =
  // `addresses` are the validated public IP(s) the host resolved to (or the
  // literal IP itself). Callers should pin their connection to one of these
  // rather than re-resolving the hostname, which would reopen the rebinding
  // window this guard closes.
  | { ok: true; url: URL; addresses: string[] }
  // `cause` is the resolver's own error when the lookup failed, so a caller
  // can tell a transient resolver fault (EAI_AGAIN) from a refused target.
  | { ok: false; reason: string; cause?: unknown };

interface ValidateOptions {
  /// `true` permits http:// in addition to https://. Default: false.
  /// Set via PUSH_NOTIFICATION_ALLOW_HTTP for local-dev round-trips
  /// against a non-TLS gateway.
  allowHttp?: boolean;
  /** Webhook registrations should reject signed/query-secret URLs. */
  allowQueryOrFragment?: boolean;
  /** Total DNS resolution budget. Defaults to three seconds. */
  dnsTimeoutMs?: number;
}

export async function validatePublicUrl(
  rawUrl: string,
  options: ValidateOptions = {},
): Promise<ValidatePublicUrlResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "url is not parseable" };
  }

  const allowedProtocols = options.allowHttp
    ? new Set(["https:", "http:"])
    : new Set(["https:"]);
  if (!allowedProtocols.has(url.protocol)) {
    return {
      ok: false,
      reason: `unsupported scheme '${url.protocol}'. Allowed: ${[...allowedProtocols].join(", ")}`,
    };
  }

  if (url.username || url.password) {
    return { ok: false, reason: "url must not include userinfo (user:pass@)" };
  }
  if (options.allowQueryOrFragment === false && (url.search || url.hash)) {
    return { ok: false, reason: "url query strings and fragments are not permitted" };
  }

  // url.hostname keeps brackets on IPv6 literals per WHATWG URL —
  // `new URL("https://[::1]/").hostname` is "[::1]". Strip them before
  // running through isIP / dns.lookup, which expect bare addresses.
  const host = url.hostname.replace(/^\[|\]$/g, "");

  // Skip DNS for IP literals — lookup() succeeds on them but the
  // round-trip is wasteful, and any non-IP host that fails the literal
  // check should still go through resolution.
  if (isIP(host)) {
    if (isPrivateOrReservedIp(host)) {
      return {
        ok: false,
        reason: `host ${url.hostname} is a private/reserved address`,
      };
    }
    return { ok: true, url, addresses: [host] };
  }

  let addresses: Array<{ address: string; family: number }>;
  let timer: NodeJS.Timeout | null = null;
  try {
    addresses = await Promise.race([
      lookup(host, { all: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("DNS resolution timed out")), options.dnsTimeoutMs ?? 3_000);
        timer.unref();
      }),
    ]);
  } catch (err) {
    return {
      ok: false,
      reason: `dns lookup failed for ${host}: ${(err as Error).message}`,
      cause: err,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (addresses.length === 0) {
    return { ok: false, reason: `no addresses resolved for ${host}` };
  }

  for (const { address } of addresses) {
    if (isPrivateOrReservedIp(address)) {
      return {
        ok: false,
        reason: `host ${host} resolves to private/reserved address ${address}`,
      };
    }
  }

  return { ok: true, url, addresses: addresses.map((a) => a.address) };
}

function isPrivateOrReservedIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);
  return true; // unknown — fail closed
}

function isPrivateIPv4(addr: string): boolean {
  const parts = addr.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b, c] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + IMDS
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224 && a <= 239) return true; // 224.0.0.0/4 multicast
  if (a >= 240) return true; // 240.0.0.0/4 reserved (incl. 255.255.255.255)
  return false;
}

function isPrivateIPv6(addr: string): boolean {
  const value = parseIPv6(addr);
  if (value === null) return true;
  const blockedPrefixes: Array<[string, number]> = [
    ["::", 96], // IPv4-compatible and low-address space
    ["::ffff:0:0", 96], // IPv4-mapped
    ["64:ff9b::", 96], // IPv4/IPv6 translation
    ["64:ff9b:1::", 48], // local-use translation
    ["100::", 64], // discard-only
    ["2001::", 23], // IETF special-purpose assignments
    ["2001:db8::", 32], // documentation
    ["2002::", 16], // 6to4
    ["3fff::", 20], // documentation
    ["5f00::", 16], // segment-routing SIDs
    ["fc00::", 7], // unique-local
    ["fe80::", 10], // link-local
    ["fec0::", 10], // deprecated site-local
    ["ff00::", 8], // multicast
  ];
  return blockedPrefixes.some(([prefix, bits]) => {
    const prefixValue = parseIPv6(prefix);
    return prefixValue === null || isIPv6Prefix(value, prefixValue, bits);
  });
}

function isIPv6Prefix(value: bigint, prefix: bigint, bits: number): boolean {
  const shift = 128n - BigInt(bits);
  return value >> shift === prefix >> shift;
}

function parseIPv6(address: string): bigint | null {
  if (address.includes("%")) return null;
  let normalized = address.toLowerCase();
  const ipv4Match = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Match) {
    const octets = ipv4Match[1].split(".").map(Number);
    if (
      octets.length !== 4 ||
      octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
    ) {
      return null;
    }
    const replacement =
      ((octets[0] << 8) | octets[1]).toString(16) +
      ":" +
      ((octets[2] << 8) | octets[3]).toString(16);
    normalized = normalized.slice(0, -ipv4Match[1].length) + replacement;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return null;
  }
  const groups = [
    ...left,
    ...Array<string>(missing).fill("0"),
    ...right,
  ];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))
  ) {
    return null;
  }
  return groups.reduce(
    (value, group) => (value << 16n) | BigInt(`0x${group}`),
    0n,
  );
}
