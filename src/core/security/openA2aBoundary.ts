import type { NextFunction, Request, Response } from "express";

const DASKI_EXTENSION = "https://daski.io/a2a/v1";

export function isOpenFreeA2aRequest(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const request = body as Record<string, unknown>;
  if (request.method !== "SendMessage") return false;
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
