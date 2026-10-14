import type { Hex } from "viem";
import type { FulfillmentAdapter } from "../serviceRegistry/types.js";
import { QuoteRefusedError, requestInvalid } from "./quoteErrors.js";
import { serviceFieldErrors } from "./quoteFieldErrors.js";

/** Readiness runs inside the gateway's quote timeout; keep it well below it. */
export const REQUEST_READINESS_TIMEOUT_MS = 5_000;

const NOT_READY = {
  path: "$",
  rule: "not_ready",
  message: "The request cannot be fulfilled right now. Revise it or request a new quote later.",
};

/**
 * Run a service's optional read-only request-readiness hook with a bounded
 * signal. It can only refuse the quote; the amount stays core's. An outage or
 * an unreadable verdict stops new quotes rather than guessing readiness.
 */
export async function assertRequestReadiness(args: {
  adapter: FulfillmentAdapter;
  skillId: string;
  request: Record<string, unknown>;
  payer: Hex | null;
  timeoutMs?: number;
}): Promise<void> {
  const hook = args.adapter.requestReadiness?.bind(args.adapter);
  if (!hook) return;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new QuoteRefusedError(503, "readiness_unavailable"));
    }, args.timeoutMs ?? REQUEST_READINESS_TIMEOUT_MS);
  });
  let verdict: unknown;
  try {
    verdict = await Promise.race([
      hook(args.skillId, structuredClone(args.request), { payer: args.payer, signal: controller.signal }),
      timedOut,
    ]);
  } catch (error) {
    if (error instanceof QuoteRefusedError) throw error;
    throw new QuoteRefusedError(503, "readiness_unavailable");
  } finally {
    clearTimeout(timer);
  }
  const value = verdict as { ready?: unknown; fieldErrors?: unknown } | null;
  if (value?.ready === true) return;
  if (value?.ready === false && Array.isArray(value.fieldErrors)) {
    const fieldErrors = serviceFieldErrors(value.fieldErrors.filter(
      (entry): entry is { path: string; rule: string; message: string } =>
        !!entry && typeof entry === "object" && !Array.isArray(entry),
    ));
    throw requestInvalid(fieldErrors.length > 0 ? fieldErrors : [NOT_READY]);
  }
  throw new QuoteRefusedError(503, "readiness_unavailable");
}
