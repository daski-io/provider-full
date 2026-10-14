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

export function isStrictlyParsedStandardRailJson(req: Request): boolean {
  return (req as StandardRailRequest).standardRailJson === true;
}

function requireUncompressedJson(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== "POST" && req.method !== "PUT") {
    next();
    return;
  }
  const [mediaType, ...parameters] = (req.header("content-type") ?? "")
    .split(";")
    .map((part) => part.trim().toLowerCase());
  const charset = parameters.find((part) => part.startsWith("charset="))
    ?.slice("charset=".length).replace(/^"|"$/g, "");
  const encoding = req.header("content-encoding")?.trim().toLowerCase();
  if (
    mediaType !== "application/json" ||
    (charset !== undefined && charset !== "utf-8") ||
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
