import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { decodeStrictJson } from "./strictJson.js";

/** Largest body the gateway sends to a standard-rail endpoint. */
export const STANDARD_RAIL_MAX_REQUEST_BYTES = 2 * 1024 * 1024;
/** A signed status query is a few hundred bytes; keep its parser tight. */
export const STANDARD_RAIL_STATUS_MAX_REQUEST_BYTES = 16 * 1024;

type StandardRailRequest = Request & { rawBody?: Buffer; standardRailJson?: true };

const STATUS_PATH = /^\/dispatch\/status\/?$/;
const STATUS_URL = /^\/standard-rail\/dispatch\/status\/?(?:\?.*)?$/;
const LIFECYCLE_URL = /^\/standard-rail\/lifecycle\/?(?:\?.*)?$/;
const DISPATCH_URL = /^\/standard-rail\/dispatch\/?(?:\?.*)?$/;

/**
 * Servicing traffic for admitted orders: the gateway's reconciliation status
 * reads, polled roughly every ten seconds for the whole life of an order, and
 * the lifecycle calls it proxies for every buyer from its own addresses. Both
 * are exempt from purchase and per-client rate limits; the process
 * concurrency budget, body bounds, an authentication-failure budget and
 * signature verification before any database read still apply.
 */
export function isStandardRailStatusRead(req: Request): boolean {
  return req.method === "POST" && (STATUS_URL.test(req.originalUrl) || LIFECYCLE_URL.test(req.originalUrl));
}

export function isStandardRailDispatch(req: Request): boolean {
  return req.method === "POST" && DISPATCH_URL.test(req.originalUrl);
}

/** Run a rate limiter for every request except servicing status and lifecycle traffic. */
export function exceptStatusReads(
  limiter: (req: Request, res: Response, next: NextFunction) => void | Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void | Promise<void> {
  return (req, res, next) => (isStandardRailStatusRead(req) ? next() : limiter(req, res, next));
}

export function isStrictlyParsedStandardRailJson(req: Request): boolean {
  return (req as StandardRailRequest).standardRailJson === true;
}

/**
 * Media type and every charset parameter, parsed as leniently as the body
 * parser itself (whitespace around `=`, quoted values), so no spelling can
 * select a decoder other than the strict UTF-8 one the scan applies.
 */
function mediaTypeOf(header: string | undefined): { type: string; charsets: string[] } {
  const [type = "", ...parameters] = (header ?? "").split(";");
  const charsets = parameters.flatMap((parameter) => {
    const separator = parameter.indexOf("=");
    if (separator < 0 || parameter.slice(0, separator).trim().toLowerCase() !== "charset") return [];
    return [parameter.slice(separator + 1).trim().replace(/^"(.*)"$/, "$1").trim().toLowerCase()];
  });
  return { type: type.trim().toLowerCase(), charsets };
}

function requireUncompressedJson(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== "POST" && req.method !== "PUT") {
    next();
    return;
  }
  const { type, charsets } = mediaTypeOf(req.header("content-type"));
  const encoding = req.header("content-encoding")?.trim().toLowerCase();
  if (
    type !== "application/json" || charsets.length > 1 ||
    (charsets.length === 1 && charsets[0] !== "utf-8") ||
    (encoding !== undefined && encoding !== "" && encoding !== "identity")
  ) {
    res.status(415).json({ error: "uncompressed_application_json_required" });
    return;
  }
  next();
}

const captureRawBody = (req: Request, _res: Response, buffer: Buffer): void => {
  (req as StandardRailRequest).rawBody = buffer;
};
const statusParser = express.json({
  limit: STANDARD_RAIL_STATUS_MAX_REQUEST_BYTES,
  inflate: false,
  verify: captureRawBody,
});
const bodyParser = express.json({
  limit: STANDARD_RAIL_MAX_REQUEST_BYTES,
  inflate: false,
  verify: captureRawBody,
});

function parseBoundedJson(req: Request, res: Response, next: NextFunction): void {
  (STATUS_PATH.test(req.path) ? statusParser : bodyParser)(req, res, next);
}

// Parser failures happen before any handler runs, so a JSON refusal is always
// definite here; a malformed body must not surface as an internal error.
const ingressErrors: ErrorRequestHandler = (error, _req, res, next) => {
  const status = (error as { status?: unknown }).status;
  if (typeof status !== "number" || status < 400 || status >= 500) {
    next(error);
    return;
  }
  if (status === 413) {
    res.status(413).json({ error: "request_too_large" });
  } else if (status === 415) {
    res.status(415).json({ error: "uncompressed_application_json_required" });
  } else {
    res.status(400).json({ error: "invalid_json" });
  }
};

function rejectNonStrictJson(req: Request, res: Response, next: NextFunction): void {
  const raw = (req as StandardRailRequest).rawBody;
  if (!raw?.length) {
    next();
    return;
  }
  try {
    decodeStrictJson(raw);
    (req as StandardRailRequest).standardRailJson = true;
    next();
  } catch {
    res.status(400).json({ error: "invalid_json" });
  }
}

/**
 * Standard-rail ingress: bounded, uncompressed `application/json` in strict
 * UTF-8 with duplicate, unsafe and oversized keys rejected before parsing is
 * trusted. Responses are plain JSON; no compression middleware is installed.
 */
export function standardRailJsonIngress(): Array<RequestHandler | ErrorRequestHandler> {
  return [requireUncompressedJson, parseBoundedJson, ingressErrors, rejectNonStrictJson];
}

/** Every signed body is built for one request and must never be cached. */
export function sendSignedJson(res: Response, body: unknown): void {
  res.setHeader("Cache-Control", "no-store");
  res.json(body);
}

/**
 * Deliberately ambiguous transport answer: an empty 503 the gateway cannot
 * read as a definite refusal, so it reconciles through the status endpoint
 * with the original dispatch hash instead of sending a new envelope.
 */
export function sendAmbiguousUnavailable(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Retry-After", "10");
  res.status(503).end();
}

/** Authentication failures one client may spend on status reads per minute. */
export const STATUS_AUTH_FAILURES_PER_MINUTE = 30;
const STATUS_FAILURE_CLIENTS = 10_000;

/**
 * Status reads skip the per-client rate limiters, so unauthenticated callers
 * get a separate process-local failure budget instead: once a client spends
 * it, further status queries are refused before any signature recovery.
 * Verified reads never consume it; reviewed bypass addresses are exempt.
 */
export function createStatusFailureBudget(options: {
  bypassIps: string[];
  failuresPerMinute?: number;
  clientIp: (req: Request) => string;
  matches: (ip: string, ranges: string[]) => boolean;
}) {
  const limit = options.failuresPerMinute ?? STATUS_AUTH_FAILURES_PER_MINUTE;
  const failures = new Map<string, { count: number; resetAt: number }>();
  const current = (ip: string, now: number) => {
    const entry = failures.get(ip);
    return entry && entry.resetAt > now ? entry : null;
  };
  return {
    exhausted(req: Request, now = Date.now()): boolean {
      const ip = options.clientIp(req);
      return !options.matches(ip, options.bypassIps) && (current(ip, now)?.count ?? 0) >= limit;
    },
    recordFailure(req: Request, now = Date.now()): void {
      const ip = options.clientIp(req);
      if (options.matches(ip, options.bypassIps)) return;
      const entry = current(ip, now) ?? { count: 0, resetAt: now + 60_000 };
      entry.count += 1;
      failures.set(ip, entry);
      if (failures.size > STATUS_FAILURE_CLIENTS) {
        for (const [key, value] of failures) if (value.resetAt <= now) failures.delete(key);
        while (failures.size > STATUS_FAILURE_CLIENTS) {
          const oldest = failures.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          failures.delete(oldest);
        }
      }
    },
  };
}
