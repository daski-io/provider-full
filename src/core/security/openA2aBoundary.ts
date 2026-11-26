import type { NextFunction, Request, Response } from "express";
import { normalizeMethod } from "../a2a/parts.js";

const DASKI_EXTENSION = "https://daski.io/a2a/v1";

export function isOpenFreeA2aRequest(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const request = body as Record<string, unknown>;
  // Classify by the canonical method so an accepted alias (message/send)
  // never skips the open-request limiter.
  if (typeof request.method !== "string") return false;
  if (normalizeMethod(request.method) !== "SendMessage") return false;
  const params = request.params as Record<string, unknown> | undefined;
  const message = params?.message as Record<string, unknown> | undefined;
  const metadata = message?.metadata as Record<string, unknown> | undefined;
  const daski = metadata?.[DASKI_EXTENSION] as Record<string, unknown> | undefined;
  return typeof daski?.skillId === "string"
    && !daski.serviceRef
    && !daski.taskId;
}

export function applyOnlyToOpenFreeRequests(
  middleware: (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => void | Promise<void>,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!isOpenFreeA2aRequest(req.body)) {
      next();
      return;
    }
    await middleware(req, res, next);
  };
}
