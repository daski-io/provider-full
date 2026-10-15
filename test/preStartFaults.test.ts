import { describe, expect, it } from "vitest";
import { RetainedHandlerUnavailableError } from "../src/core/serviceRegistry/retainedHandlers.js";
import { AssetOwnerChangedError } from "../src/core/standardRail/assetOwnerFence.js";
import { isUndecidedPreStartFault } from "../src/core/standardRail/faultClassification.js";
import {
  SupplierClientError,
  SupplierMutationAuthorizationError,
  SupplierOutcomeAmbiguousError,
} from "../src/core/suppliers/errorClassifier.js";

// Before a funded order started, only a definite refusal may fail it as
// never started; a fault that decides nothing leaves it to its fulfillment
// job, which tries again later.
const named = (name: string, message = "synthetic") => Object.assign(new Error(message), { name });

describe("pre-start fault classification", () => {
  it("leaves transient, ambiguous, provider-side and infrastructure faults undecided", () => {
    for (const fault of [
      Object.assign(new Error("Connection terminated unexpectedly"), { code: "08006" }),
      new RetainedHandlerUnavailableError("no handler for the admitted contract"),
      new SupplierClientError("unavailable", { supplier: "synthetic", status: 503 }),
      new SupplierClientError("throttled", { supplier: "synthetic", category: "rate_limited" }),
      new SupplierClientError("credentials", { supplier: "synthetic", status: 401 }),
      new SupplierOutcomeAmbiguousError("unknown"),
      new SupplierMutationAuthorizationError("synthetic", "not authorized"),
      Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      named("AbortError"),
      named("OutboundCircuitOpenError", "outbound circuit open for https://supplier.example"),
      new Error("outbound concurrency budget exhausted for https://supplier.example"),
      Object.assign(new Error("throttled"), { status: 429 }),
      Object.assign(new Error("bad gateway"), { status: 502 }),
      new AggregateError([new Error("primary down")], "RPC observation failed on the primary and every configured fallback"),
      new Error("hook failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) }),
    ]) expect(isUndecidedPreStartFault(fault), String((fault as Error).message)).toBe(true);
  });

  it("keeps definite refusals definite", () => {
    for (const refusal of [
      new AssetOwnerChangedError(),
      new SupplierClientError("rejected", { supplier: "synthetic", status: 422 }),
      new SupplierClientError("rejected", { supplier: "synthetic", category: "validation" }),
      new Error("Standard managed asset was not found"),
      new Error("Standard asset identifier is missing"),
      new Error("The review refused the request"),
      Object.assign(new Error("invalid argument"), { code: "ERR_INVALID_ARG_TYPE" }),
      Object.assign(new Error("not found"), { status: 404 }),
      new Error("wrapped", { cause: new Error("still definite") }),
    ]) expect(isUndecidedPreStartFault(refusal), refusal.message).toBe(false);
  });

  it("follows a bounded cause chain only", () => {
    let fault: Error = Object.assign(new Error("deep outage"), { code: "57P01" });
    for (let depth = 0; depth < 8; depth += 1) fault = new Error(`layer ${depth}`, { cause: fault });
    expect(isUndecidedPreStartFault(fault)).toBe(false);
  });
});
