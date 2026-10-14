import { describe, expect, it, vi } from "vitest";
import {
  parseOptionalSupplierCostCeiling,
  parseSupplierCostCeiling,
} from "../src/core/serviceRegistry/supplierCostCeiling.js";
import type { FulfillmentAdapter } from "../src/core/serviceRegistry/types.js";
import { QuoteRefusedError } from "../src/core/standardRail/quoteErrors.js";
import {
  MAX_QUOTE_FIELD_ERRORS,
  MAX_QUOTE_REFUSAL_BYTES,
  serviceFieldErrors,
} from "../src/core/standardRail/quoteFieldErrors.js";
import {
  FIXED_READINESS_QUOTE_LIFETIME_SECONDS,
  readinessQuoteLifetimeSeconds,
} from "../src/core/standardRail/quotePolicy.js";
import { assertRequestReadiness } from "../src/core/standardRail/requestReadiness.js";
import { dynamicOutcome, fixedOutcome } from "./standardRailFixture.js";

const adapter = (requestReadiness: FulfillmentAdapter["requestReadiness"]) =>
  ({ requestReadiness }) as FulfillmentAdapter;

describe("request readiness runner", () => {
  it("aborts a slow hook and stops the quote instead of guessing", async () => {
    let aborted = false;
    const hook = vi.fn((_skill: string, _request: Record<string, unknown>, context: { signal: AbortSignal }) =>
      new Promise<never>(() => { context.signal.addEventListener("abort", () => { aborted = true; }); }));
    await expect(assertRequestReadiness({
      adapter: adapter(hook as never), skillId: "s", request: {}, payer: null, timeoutMs: 20,
    })).rejects.toMatchObject({ status: 503, reason: "readiness_unavailable" });
    expect(aborted).toBe(true);
  });

  it("fails closed on an unreadable verdict and fills an empty refusal", async () => {
    await expect(assertRequestReadiness({
      adapter: adapter(async () => ({ ready: "yes" }) as never), skillId: "s", request: {}, payer: null,
    })).rejects.toMatchObject({ reason: "readiness_unavailable" });
    await expect(assertRequestReadiness({
      adapter: adapter(async () => ({ ready: false, fieldErrors: [] })), skillId: "s", request: {}, payer: null,
    })).rejects.toMatchObject({ status: 422, fieldErrors: [expect.objectContaining({ rule: "not_ready" })] });
  });

  it("hands the hook a copy so it cannot change the request being quoted", async () => {
    const request = { item: "a" };
    await assertRequestReadiness({
      adapter: adapter(async (_skill, data) => {
        data.item = "mutated";
        return { ready: true };
      }),
      skillId: "s", request, payer: null,
    });
    expect(request.item).toBe("a");
  });

  it("is skipped for services without a hook", async () => {
    await expect(assertRequestReadiness({
      adapter: {} as FulfillmentAdapter, skillId: "s", request: {}, payer: null,
    })).resolves.toBeUndefined();
  });
});

describe("readiness quote lifetime", () => {
  it("uses 120 s for fixed and the admitted policy, at most 180 s, for dynamic quotes", () => {
    expect(readinessQuoteLifetimeSeconds(fixedOutcome)).toBe(FIXED_READINESS_QUOTE_LIFETIME_SECONDS);
    expect(readinessQuoteLifetimeSeconds(dynamicOutcome)).toBe(180);
    expect(readinessQuoteLifetimeSeconds({ ...dynamicOutcome, quoteMaximumLifetimeSeconds: 300 })).toBe(180);
    expect(readinessQuoteLifetimeSeconds({ ...dynamicOutcome, quoteMaximumLifetimeSeconds: 120 })).toBe(120);
  });

  it("refuses a policy that would leave no margin above the minimum payment window", () => {
    expect(() => readinessQuoteLifetimeSeconds({
      ...dynamicOutcome, quoteMaximumLifetimeSeconds: 89, quoteMinimumPaymentWindowSeconds: 30,
    })).toThrow(QuoteRefusedError);
    expect(readinessQuoteLifetimeSeconds({
      ...dynamicOutcome, quoteMaximumLifetimeSeconds: 90, quoteMinimumPaymentWindowSeconds: 30,
    })).toBe(90);
  });
});

describe("quote field errors", () => {
  it("bounds service text and normalizes unreviewed rule names", () => {
    const [error] = serviceFieldErrors([{
      field: "x".repeat(300), code: "not a rule!", message: `${"m".repeat(400)}\n`,
    }]);
    expect(error!.path).toHaveLength(128);
    expect(error!.rule).toBe("invalid");
    expect(error!.message).toHaveLength(256);
  });

  it("ignores non-object entries and never splits a surrogate pair", () => {
    const errors = serviceFieldErrors([null, "text", 7, {
      field: "item", code: "invalid", message: `${"a".repeat(255)}\u{1f600}tail`,
    }] as unknown[]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message.endsWith("\u{1f600}")).toBe(true);
    expect(Array.from(errors[0]!.message)).toHaveLength(256);
  });

  it("keeps the refusal body under the gateway's read bound", () => {
    const errors = Array.from({ length: 40 }, (_unused, index) => ({
      path: `field${index}${"p".repeat(120)}`,
      rule: "enum",
      message: "m".repeat(256),
      allowedValues: Array.from({ length: 12 }, () => "v".repeat(64)),
    }));
    const refusal = new QuoteRefusedError(422, "request_invalid", serviceFieldErrors(errors));
    const body = refusal.body();
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(MAX_QUOTE_REFUSAL_BYTES);
    expect((body.fieldErrors as unknown[]).length).toBeGreaterThan(0);
    expect((body.fieldErrors as unknown[]).length).toBeLessThanOrEqual(MAX_QUOTE_FIELD_ERRORS);
  });
});

describe("supplier cost ceiling parsing", () => {
  const ceiling = {
    kind: "supplier-cost-ceiling-v1", supplier: "synthetic-supplier", currency: "USD", maximumAmount: "12.50",
  };

  it("accepts the exact v1 shape and returns a copy", () => {
    const parsed = parseSupplierCostCeiling(ceiling);
    expect(parsed).toEqual(ceiling);
    expect(parsed).not.toBe(ceiling);
    expect(parseOptionalSupplierCostCeiling(null)).toBeNull();
    expect(parseOptionalSupplierCostCeiling(undefined)).toBeNull();
  });

  it.each([
    { ...ceiling, extra: true },
    { ...ceiling, kind: "supplier-cost-ceiling-v2" },
    { ...ceiling, maximumAmount: "-1" },
    { ...ceiling, maximumAmount: "1e3" },
    { ...ceiling, maximumAmount: "01" },
    { ...ceiling, maximumAmount: 12 },
    { ...ceiling, currency: "usd" },
    { ...ceiling, supplier: "" },
    [],
  ])("fails closed on %j", (value) => {
    expect(() => parseSupplierCostCeiling(value)).toThrow("Supplier cost ceiling is invalid");
  });
});
