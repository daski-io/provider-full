import type { Request, Response, NextFunction } from "express";
import { isIP } from "node:net";
import { pool } from "../db/pool.js";
import type { Queryable } from "../db/queryable.js";
import { createHmac } from "node:crypto";
import { config } from "../config.js";

export interface RateLimitConfig {
  capacity: number;
  perMinute: number;
  namespace: string;
  bypassIps?: string[];
}

interface IpRange {
  version: 4 | 6;
  network: bigint;
  prefix: number;
}

export function normalizeIp(value: string): string {
  let ip = value.trim().replace(/^\[|\]$/g, "").split("%", 1)[0];
  if (ip.toLowerCase().startsWith("::ffff:") && isIP(ip.slice(7)) === 4) {
    ip = ip.slice(7);
  }
  return ip;
}

function parseIp(value: string): { version: 4 | 6; value: bigint } | null {
  const ip = normalizeIp(value);
  const version = isIP(ip);
  if (version === 4) {
    const parts = ip.split(".").map(Number);
    return {
      version: 4,
      value: parts.reduce((acc, part) => (acc << 8n) | BigInt(part), 0n),
    };
  }
  if (version !== 6) return null;
  const halves = ip.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const parseHalf = (half: string): number[] => {
    if (!half) return [];
    const groups = half.split(":");
    const out: number[] = [];
    for (const group of groups) {
      if (group.includes(".")) {
        const v4 = parseIp(group);
        if (!v4 || v4.version !== 4) return [];
        out.push(Number((v4.value >> 16n) & 0xffffn), Number(v4.value & 0xffffn));
      } else {
        out.push(Number.parseInt(group, 16));
      }
    }
    return out;
  };
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? "");
  const omitted = 8 - left.length - right.length;
  if (omitted < 0 || (halves.length === 1 && omitted !== 0)) return null;
  const groups = [...left, ...Array.from({ length: omitted }, () => 0), ...right];
  if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) {
    return null;
  }
  return {
    version: 6,
    value: groups.reduce((acc, group) => (acc << 16n) | BigInt(group), 0n),
  };
}

function parseRange(value: string): IpRange {
  const [address, rawPrefix] = value.trim().split("/");
  const parsed = parseIp(address);
  if (!parsed) throw new Error(`invalid IP/CIDR '${value}'`);
  const bits = parsed.version === 4 ? 32 : 128;
  const prefix = rawPrefix === undefined ? bits : Number(rawPrefix);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) {
    throw new Error(`invalid IP/CIDR prefix '${value}'`);
  }
  const shift = BigInt(bits - prefix);
  return {
    version: parsed.version,
    prefix,
    network: shift === 0n ? parsed.value : (parsed.value >> shift) << shift,
  };
}

export function isIpInRanges(ip: string, ranges: string[]): boolean {
  const parsed = parseIp(ip);
  if (!parsed) return false;
  return ranges.some((raw) => {
    const range = parseRange(raw);
    if (range.version !== parsed.version) return false;
    const bits = range.version === 4 ? 32 : 128;
    const shift = BigInt(bits - range.prefix);
    const network = shift === 0n ? parsed.value : (parsed.value >> shift) << shift;
    return network === range.network;
  });
}

// The client address the HTTP boundary established (the edge's
// CF-Connecting-IP in edge mode), else express's trusted-proxy view, else
// the socket peer.
export function requestClientIp(req: Request): string {
  return normalizeIp(req.clientAddress || req.ip || req.socket.remoteAddress || "unknown");
}

/**
 * Spend one token from the bucket at `key`, refilled at `perMinute` up to
 * `capacity`; false when the bucket is empty.
 *
 * A bucket is throttling state, not a record: a database crash that loses
 * its last spends lets a client through a few requests early, whereas
 * waiting for the WAL flush put storage write latency in front of every
 * limited request. set_config(..., true) holds only until the end of the
 * transaction the statement runs in, so this runs on the pool, as its own
 * implicit transaction, and never inside a transaction whose writes must be
 * durable; every financial, evidence, job and result write stays fully
 * durable.
 */
export async function takeRateLimitToken(
  db: Queryable,
  key: string,
  capacity: number,
  perMinute: number,
): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO rate_limit_buckets (bucket_key, tokens, last_refill, expires_at)
     SELECT $1::text, $2::double precision - 1, now(), now() + interval '10 minutes'
       FROM (SELECT set_config('synchronous_commit', 'off', true)) AS async_commit
     ON CONFLICT (bucket_key) DO UPDATE
       SET tokens = LEAST(
             $2::double precision,
             rate_limit_buckets.tokens
               + EXTRACT(EPOCH FROM (now() - rate_limit_buckets.last_refill))
                 * ($3::double precision / 60.0)
           ) - 1,
           last_refill = now(),
           expires_at = now() + interval '10 minutes'
     WHERE LEAST(
             $2::double precision,
             rate_limit_buckets.tokens
               + EXTRACT(EPOCH FROM (now() - rate_limit_buckets.last_refill))
                 * ($3::double precision / 60.0)
           ) >= 1
     RETURNING tokens`,
    [key, capacity, perMinute],
  );
  return result.rows.length > 0;
}

export function makeRateLimiter(cfg: RateLimitConfig) {
  if (!(cfg.capacity > 0) || !(cfg.perMinute > 0)) {
    throw new Error(`invalid rate limit configuration for '${cfg.namespace}'`);
  }
  const bypass = cfg.bypassIps ?? [];
  // Parse once at boot so malformed operator CIDRs fail before serving.
  bypass.forEach(parseRange);

  return async function rateLimit(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const ip = requestClientIp(req);
    if (isIpInRanges(ip, bypass)) return next();
    // Persist only a keyed, namespace-bound identifier. Raw client IPs are
    // transient routing data and do not belong in the shared bucket table.
    const identity = createHmac("sha256", config.ADMIN_TOKEN)
      .update(`${cfg.namespace}\0${ip}`, "utf8")
      .digest("hex");
    const key = `${cfg.namespace}:${identity}`;
    try {
      if (!(await takeRateLimitToken(pool, key, cfg.capacity, cfg.perMinute))) {
        const retryAfterSec = Math.max(1, Math.ceil(60 / cfg.perMinute));
        res.setHeader("Retry-After", String(retryAfterSec));
        res.status(429).json({
          error: "rate_limit_exceeded",
          retryAfter: retryAfterSec,
          namespace: cfg.namespace,
        });
        return;
      }
      next();
    } catch {
      res.status(503).json({ error: "rate_limit_store_unavailable" });
    }
  };
}
