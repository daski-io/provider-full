import type { NextFunction, Request, Response } from "express";
import { normalizeMethod } from "../a2a/parts.js";

// Every SendMessage on /a2a/:serviceSlug is an anonymous public free-skill
// call: paid and order-bound work reaches the provider only through the
// gateway's standard rail, never this endpoint. So the stricter open-request
// limit counts every SendMessage, whatever its metadata says. Metadata only
// decides how the router answers (run the free skill or refuse the request),
// never whether the request is counted: a key such as `taskId`, which once
// continued a task under the retired native rail and is now ignored, must not
// move a request that still runs a free skill onto the general limit.
// Classification uses the canonical method, so an accepted alias
// (message/send) is counted too. GetTask polls and refused methods stay on
// the general limit only.
export function isOpenFreeA2aRequest(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const method = (body as Record<string, unknown>).method;
  return typeof method === "string" && normalizeMethod(method) === "SendMessage";
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
