import type { Express, NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { isIpInRanges } from "./rateLimit.js";

/** Install the security controls that must run before every public route. */
export function installHttpSecurityBoundary(app: Express): void {
  app.disable("x-powered-by");
  const trustedProxyCidrs = config.TRUST_PROXY_CIDRS
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  // Parse every configured range at boot so malformed trust cannot fail open.
  trustedProxyCidrs.forEach((cidr) => isIpInRanges("127.0.0.1", [cidr]));
  app.set("trust proxy", (ip: string, hop: number) =>
    hop < config.TRUST_PROXY_HOPS && isIpInRanges(ip, trustedProxyCidrs));
  app.use(securityHeaders());
  app.use(rejectUntrustedForwardingHeaders(trustedProxyCidrs));
}

function securityHeaders() {
  const publicHttps = new URL(config.BASE_URL).protocol === "https:";
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("Content-Security-Policy", [
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
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    // Keep referrers off cross-origin requests while preserving the source
    // origin on same-origin form POSTs. Firefox serializes the Origin header
    // as `null` under `no-referrer`, which makes legitimate admin forms fail
    // the CORS and CSRF origin checks before their handlers run.
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    );
    if (publicHttps) {
      res.setHeader(
        "Strict-Transport-Security",
        "max-age=63072000; includeSubDomains; preload",
      );
    }

    next();
  };
}

function rejectUntrustedForwardingHeaders(trustedCidrs: string[]) {
  const expectedHost = new URL(config.BASE_URL).host.toLowerCase();
  return (req: Request, res: Response, next: NextFunction): void => {
    const forwardedFor = req.get("x-forwarded-for");
    const forwardedProto = req.get("x-forwarded-proto");
    const forwardedHost = req.get("x-forwarded-host");
    const hasForwarding = Boolean(forwardedFor || forwardedProto || forwardedHost);
    if (config.TRUST_PROXY_HOPS === 0) {
      // No proxy topology is declared (local dev, or a managed edge whose
      // peer ranges aren't published — e.g. the Railway sandbox). Client
      // attribution already uses the socket peer because express's trust
      // proxy is disabled at zero hops; strip the headers so no manual
      // reader can be spoofed, and let the request through. Rejecting here
      // would 400 every request on platforms that unconditionally add
      // X-Forwarded-For at their edge. Declared topologies — mainnet
      // config requires one — keep the fail-closed checks below.
      if (hasForwarding) {
        delete req.headers["x-forwarded-for"];
        delete req.headers["x-forwarded-proto"];
        delete req.headers["x-forwarded-host"];
      }
      next();
      return;
    }
    const peer = req.socket.remoteAddress ?? "";
    const trustedPeer = isIpInRanges(peer, trustedCidrs);
    if (hasForwarding && !trustedPeer) {
      res.status(400).json({ error: "untrusted_forwarding_headers" });
      return;
    }
    if (forwardedFor && forwardedFor.split(",").length > config.TRUST_PROXY_HOPS) {
      res.status(400).json({ error: "forwarding_hop_mismatch" });
      return;
    }
    if (forwardedProto) {
      const protocols = forwardedProto.split(",").map((value) => value.trim().toLowerCase());
      if (protocols.length > config.TRUST_PROXY_HOPS
        || protocols.some((value) => value !== "http" && value !== "https")) {
        res.status(400).json({ error: "invalid_forwarded_proto" });
        return;
      }
      if (new URL(config.BASE_URL).protocol === "https:" && protocols[0] !== "https") {
        res.status(400).json({ error: "insecure_forwarded_proto" });
        return;
      }
    }
    if (forwardedHost && forwardedHost.split(",", 1)[0].trim().toLowerCase() !== expectedHost) {
      res.status(400).json({ error: "forwarded_host_mismatch" });
      return;
    }
    next();
  };
}
