import type { Request } from "express";
import { config } from "../config.js";
import { isIpInRanges } from "./rateLimit.js";

export interface TrustedRequestCountry {
  country: string;
  source: string;
  observedAt: string;
}

/**
 * Read an edge-replaced country assertion only across a proven boundary: a
 * request the edge secret verified (the edge sets the header itself), or a
 * peer inside the declared proxy trust ranges.
 */
export function trustedRequestCountry(
  req: Pick<Request, "get" | "socket"> & { edgeVerified?: boolean },
  now = new Date(),
): TrustedRequestCountry | null {
  const header = config.TRUSTED_REQUEST_COUNTRY_HEADER.trim().toLowerCase();
  if (!header) return null;
  if (!req.edgeVerified) {
    if (config.TRUST_PROXY_HOPS < 1) return null;
    const trustedCidrs = config.TRUST_PROXY_CIDRS
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const peer = req.socket.remoteAddress ?? "";
    if (!peer || !isIpInRanges(peer, trustedCidrs)) return null;
  }
  const value = req.get(header)?.trim();
  if (!value || !/^[A-Za-z]{2}$/.test(value)) return null;
  return {
    country: value.toUpperCase(),
    source: `${req.edgeVerified ? "edge-header" : "trusted-proxy-header"}:${header}`,
    observedAt: now.toISOString(),
  };
}
