import { describe, expect, it } from "vitest";
import { RetainedHandlerUnavailableError } from "../src/core/serviceRegistry/retainedHandlers.js";
import { AssetOwnerChangedError } from "../src/core/standardRail/assetOwnerFence.js";
import { OutboundAbortedError } from "../src/core/security/outboundHttp.js";
import { SupplierCostCeilingError } from "../src/core/serviceRegistry/supplierCostCeiling.js";
import { isDefiniteFailureAfterStart, isUndecidedPreStartFault } from "../src/core/standardRail/faultClassification.js";
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
      // A caller's abort, whatever its reason, and a lookup that met a resolver fault.
      new OutboundAbortedError("shutting down"),
      new Error("outbound target rejected: dns lookup failed for supplier.example: getaddrinfo EAI_AGAIN", {
        cause: Object.assign(new Error("getaddrinfo EAI_AGAIN supplier.example"), { code: "EAI_AGAIN" }),
      }),
      // A certificate or TLS handshake failure is the provider's or the supplier's condition.
      Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }),
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("Hostname/IP does not match certificate's altnames"), {
          code: "ERR_TLS_CERT_ALTNAME_INVALID",
        }),
      }),
      Object.assign(new Error("self-signed certificate in certificate chain"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }),
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
      // A target the outbound boundary refuses for what it is, not for a lookup fault.
      new Error("outbound target rejected: host supplier.example resolves to private/reserved address 10.0.0.1"),
    ]) expect(isUndecidedPreStartFault(refusal), refusal.message).toBe(false);
  });

  it("follows a bounded cause chain only", () => {
    let fault: Error = Object.assign(new Error("deep outage"), { code: "57P01" });
    for (let depth = 0; depth < 8; depth += 1) fault = new Error(`layer ${depth}`, { cause: fault });
    expect(isUndecidedPreStartFault(fault)).toBe(false);
  });
});

// After the start, a failure is signed only on affirmative evidence, a
// supplier's typed rejection or the admitted cost ceiling's refusal:
// anything else may have followed a call the supplier received and acted
// on, so its order is parked for reconciliation.
describe("post-start fault classification", () => {
  it("treats every failure without affirmative evidence as unknown", () => {
    for (const fault of [
      new SupplierOutcomeAmbiguousError("unknown"),
      new SupplierClientError("conflict", { supplier: "synthetic", category: "conflict" }),
      Object.assign(new Error("Connection terminated unexpectedly"), { code: "08006" }),
      Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
      }),
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      new DOMException("This operation was aborted", "AbortError"),
      new Error("outbound request timed out after 15000ms"),
      new OutboundAbortedError(new DOMException("This operation was aborted", "AbortError")),
      new OutboundAbortedError("shutting down"),
      new Error("report job failed", { cause: new SupplierOutcomeAmbiguousError("unknown") }),
      new Error("report job failed", { cause: named("TimeoutError") }),
      new AggregateError([new Error("primary"), named("TimeoutError")], "every attempt failed"),
      // Unrecognized exceptions: a decoder or mapper can fail after the supplier acted.
      new SyntaxError("Unexpected token < while parsing the supplier response"),
      new TypeError("Cannot read properties of undefined (reading 'reportId')"),
      new Error("The widget is not offered"),
      Object.assign(new Error("not found"), { status: 404 }),
      // A supplier's temporary or provider-side condition is no business failure.
      new SupplierClientError("unavailable", { supplier: "synthetic", status: 503 }),
      new SupplierClientError("credentials", { supplier: "synthetic", status: 401 }),
      new SupplierClientError("transport", { supplier: "synthetic", category: "transport", cause: named("TimeoutError") }),
      new SupplierMutationAuthorizationError("synthetic", "not authorized"),
      // One rejection among unknown failures proves nothing about the others.
      new AggregateError([
        new SupplierClientError("rejected", { supplier: "synthetic", status: 422 }), new Error("unknown"),
      ], "every attempt failed"),
      new Error("mapped", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) }),
    ]) expect(isDefiniteFailureAfterStart(fault), String((fault as Error).message)).toBe(false);
  });

  it("signs a typed rejection or a ceiling refusal, directly, as a cause or as every aggregated error", () => {
    for (const failure of [
      new SupplierClientError("rejected", { supplier: "synthetic", status: 422 }),
      new SupplierCostCeilingError("synthetic", "ceiling_exceeded"),
      new SupplierCostCeilingError("synthetic", "ceiling_missing"),
      new SupplierClientError("rejected", { supplier: "synthetic", category: "validation" }),
      new SupplierClientError("rejected", { supplier: "synthetic", category: "rejected" }),
      new Error("wrapped", { cause: new SupplierClientError("rejected", { supplier: "synthetic", category: "validation" }) }),
      new AggregateError([
        new SupplierClientError("rejected", { supplier: "synthetic", status: 400 }),
        new SupplierClientError("rejected", { supplier: "synthetic", category: "rejected" }),
      ], "every attempt was refused"),
    ]) expect(isDefiniteFailureAfterStart(failure), failure.message).toBe(true);
  });

  it("follows a bounded cause chain only", () => {
    let fault: Error = new SupplierClientError("rejected", { supplier: "synthetic", status: 422 });
    for (let depth = 0; depth < 8; depth += 1) fault = new Error(`layer ${depth}`, { cause: fault });
    expect(isDefiniteFailureAfterStart(fault)).toBe(false);
  });
});
