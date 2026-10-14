import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { isIpInRanges, requestClientIp } from "./rateLimit.js";

export function concurrencyBudget(args: {
  maxConcurrent: number;
  maxConcurrentPerIp: number;
  bypassIps: string[];
  /** The 503 body for a request refused for capacity, where a protocol names its own. */
  busyBody?: (req: Request) => Record<string, string>;
}) {
  let active = 0;
  const activeByIp = new Map<string, number>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = requestClientIp(req);
    const bypassed = isIpInRanges(ip, args.bypassIps);
    const sourceActive = activeByIp.get(ip) ?? 0;
    if (
      active >= args.maxConcurrent
      || (!bypassed && sourceActive >= args.maxConcurrentPerIp)
    ) {
      res.setHeader("Retry-After", "1");
      res.status(503).json(args.busyBody?.(req) ?? { error: "server_busy" });
      return;
    }
    active++;
    if (!bypassed) activeByIp.set(ip, sourceActive + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active--;
      if (bypassed) return;
      const remaining = (activeByIp.get(ip) ?? 1) - 1;
      if (remaining <= 0) activeByIp.delete(ip);
      else activeByIp.set(ip, remaining);
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  };
}

export function configureHttpTimeouts(httpServer: {
  headersTimeout: number;
  requestTimeout: number;
  keepAliveTimeout: number;
}): void {
  httpServer.headersTimeout = config.HTTP_HEADERS_TIMEOUT_MS;
  httpServer.requestTimeout = config.HTTP_REQUEST_TIMEOUT_MS;
  httpServer.keepAliveTimeout = config.HTTP_KEEP_ALIVE_TIMEOUT_MS;
}
