import type { ErrorRequestHandler, Router } from "express";
import { logError, logWarn } from "../logger.js";
import type { DispatchRequest, StandardDispatchService } from "./dispatch.js";
import { DispatchRejectedError, DispatchStatusError } from "./dispatchErrors.js";
import type { StandardQuoteService } from "./quote.js";
import { QuoteRefusedError } from "./quoteErrors.js";
import { isIpInRanges, requestClientIp } from "../security/rateLimit.js";
import { createStatusFailureBudget, sendAmbiguousUnavailable, sendSignedJson } from "./transport.js";

const DISPATCH_BODY_KEYS = "dispatch,evidenceBundle,quote,request";

const errorClass = (error: unknown) => error instanceof Error ? error.name : "UnknownError";

function exactBody(body: unknown, keys: string): body is Record<string, unknown> {
  return !!body && typeof body === "object" && !Array.isArray(body) &&
    Object.keys(body).sort().join(",") === keys;
}

/**
 * Quote, dispatch and dispatch-status routes. A dispatch has three outcomes:
 * a definite pre-admission refusal (`409 {"error":"dispatch_rejected",
 * "reason"}`, 503 for `service_unavailable`), the signed snapshot, or an
 * empty 503 whenever admission exists
 * or its outcome is unknown, never a JSON error. Status uses
 * `404 {"error":"dispatch_status_unavailable","reason":"outcome_policy"}`
 * only for proven absence of any claim for the order.
 */
export function mountProtocolRoutes(router: Router, services: {
  quote: StandardQuoteService;
  dispatch: StandardDispatchService;
  rateLimitBypassIps?: string[];
}): void {
  const statusFailures = createStatusFailureBudget({
    bypassIps: services.rateLimitBypassIps ?? [],
    clientIp: requestClientIp,
    matches: isIpInRanges,
  });
  router.post("/quote", async (req, res) => {
    try {
      if (!exactBody(req.body, "request")) throw new QuoteRefusedError(400, "envelope");
      sendSignedJson(res, await services.quote.handle(req.body.request));
    } catch (error) {
      const refusal = error instanceof QuoteRefusedError ? error : new QuoteRefusedError(503, "unavailable");
      if (refusal === error) {
        logWarn("Standard quote refused", { reason: refusal.reason, status: refusal.status });
      } else {
        logError("Standard quote failed", { errorClass: errorClass(error) });
      }
      res.status(refusal.status).json(refusal.body());
    }
  });

  router.post("/dispatch", async (req, res) => {
    try {
      if (!exactBody(req.body, DISPATCH_BODY_KEYS)) {
        throw new DispatchRejectedError("validator", "Dispatch request shape is invalid");
      }
      sendSignedJson(res, await services.dispatch.accept(req.body as unknown as DispatchRequest));
    } catch (error) {
      if (error instanceof DispatchRejectedError) {
        logWarn("Standard dispatch refused before admission", { reason: error.reason });
        // A product outage is a retryable refusal; every other reason is a
        // conflict with the order. Both are definite: nothing was admitted.
        res.status(error.reason === "service_unavailable" ? 503 : 409)
          .json({ error: "dispatch_rejected", reason: error.reason });
        return;
      }
      logError("Standard dispatch answered ambiguously", { errorClass: errorClass(error) });
      sendAmbiguousUnavailable(res);
    }
  });

  router.post("/dispatch/status", async (req, res) => {
    if (statusFailures.exhausted(req)) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({ error: "rate_limit_exceeded" });
      return;
    }
    try {
      if (!exactBody(req.body, "query")) throw DispatchStatusError.rejected(null);
      sendSignedJson(res, await services.dispatch.status(req.body.query));
    } catch (error) {
      const failure = error instanceof DispatchStatusError ? error : DispatchStatusError.unavailable();
      if (failure.status === 400 || failure.status === 401) statusFailures.recordFailure(req);
      if (failure.status === 503) {
        logError("Standard dispatch status unavailable", { reason: failure.reason, errorClass: errorClass(error) });
      } else {
        logWarn("Standard dispatch status refused", { reason: failure.reason, status: failure.status });
      }
      res.status(failure.status).json(failure.body());
    }
  });

  // Defense in depth: an error escaping the dispatch handler could follow an
  // admission, so it is never turned into a JSON refusal by later middleware.
  const ambiguousDispatchErrors: ErrorRequestHandler = (error, req, res, next) => {
    if (req.method === "POST" && /^\/dispatch\/?$/.test(req.path) && !res.headersSent) {
      logError("Standard dispatch failed outside its handler", { errorClass: errorClass(error) });
      sendAmbiguousUnavailable(res);
      return;
    }
    next(error);
  };
  router.use(ambiguousDispatchErrors);
}
