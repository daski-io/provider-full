import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/core/config.js";
import {
  assertSupplierSpendWithinCeiling,
  parseOptionalSupplierCostCeiling,
  parseSupplierCostCeiling,
  supplierCostCeilingFromQuote,
  supplierCostLimit,
} from "../src/core/serviceRegistry/supplierCostCeiling.js";

// F-T01 units: the strict v2 and legacy v1 ceiling shapes, the exact
// tolerance limit (no floating point, no rounding), the spend check, the
// ceiling a quote records from a reported supplier cost, and the strict
// SUPPLIER_PRICE_TOLERANCE_PERCENT boot parsing.
const v2 = {
  kind: "supplier-cost-ceiling-v2", supplier: "synthetic-supplier", currency: "USD",
  quotedAmount: "4.25", tolerancePercent: "10",
} as const;
const v1 = {
  kind: "supplier-cost-ceiling-v1", supplier: "synthetic-supplier", currency: "USD", maximumAmount: "12.50",
} as const;

describe("supplier cost ceiling parsing", () => {
  it("accepts the exact v2 shape and the legacy v1 shape, returning copies", () => {
    for (const ceiling of [v2, v1, { ...v2, tolerancePercent: "100.00" }, { ...v2, quotedAmount: "0" }]) {
      const parsed = parseSupplierCostCeiling(ceiling);
      expect(parsed).toEqual(ceiling);
      expect(parsed).not.toBe(ceiling);
    }
    expect(parseOptionalSupplierCostCeiling(null)).toBeNull();
    expect(parseOptionalSupplierCostCeiling(undefined)).toBeNull();
  });

  it.each([
    { ...v2, extra: true },
    { ...v1, extra: true },
    { ...v1, kind: "supplier-cost-ceiling-v2" },
    { ...v2, kind: "supplier-cost-ceiling-v1" },
    { ...v2, kind: "supplier-cost-ceiling-v3" },
    { kind: v2.kind, supplier: v2.supplier, currency: v2.currency, quotedAmount: "4.25" },
    { ...v2, quotedAmount: "-1" },
    { ...v2, quotedAmount: "1e3" },
    { ...v2, quotedAmount: "01" },
    { ...v2, quotedAmount: "1." },
    { ...v2, quotedAmount: 4.25 },
    { ...v2, tolerancePercent: "100.5" },
    { ...v2, tolerancePercent: "100.01" },
    { ...v2, tolerancePercent: "101" },
    { ...v2, tolerancePercent: "-1" },
    { ...v2, tolerancePercent: "10.001" },
    { ...v2, tolerancePercent: "010" },
    { ...v2, tolerancePercent: "1e1" },
    { ...v2, tolerancePercent: "" },
    { ...v2, tolerancePercent: 10 },
    { ...v2, currency: "usd" },
    { ...v2, supplier: "" },
    { ...v1, maximumAmount: "-1" },
    { ...v1, maximumAmount: 12 },
    [],
    "supplier-cost-ceiling-v2",
  ])("fails closed on %j", (value) => {
    expect(() => parseSupplierCostCeiling(value)).toThrow("Supplier cost ceiling is invalid");
  });
});

describe("supplier price tolerance limit (A2)", () => {
  it.each([
    ["4.25", "10", "4.675"],
    ["10", "0", "10"],
    ["12.50", "0", "12.5"],
    ["0", "10", "0"],
    ["10", "12.5", "11.25"],
    ["1", "100", "2"],
    ["0.000000000000000001", "0.01", "0.0000000000000000010001"],
    ["999999999999999999999999999999.999999999999999999", "100", "1999999999999999999999999999999.999999999999999998"],
  ])("quoted %s with %s%% tolerance is limited to %s", (quotedAmount, tolerancePercent, limit) => {
    expect(supplierCostLimit({ ...v2, quotedAmount, tolerancePercent })).toBe(limit);
  });

  it("keeps a v1 ceiling's maximum as its limit and refuses a malformed ceiling", () => {
    expect(supplierCostLimit(v1)).toBe("12.5");
    expect(() => supplierCostLimit({ ...v2, tolerancePercent: "100.5" })).toThrow("Supplier cost ceiling is invalid");
  });
});

describe("planned spend against the admitted ceiling", () => {
  const planned = (amount: string, overrides: Record<string, string> = {}) =>
    ({ supplier: "synthetic-supplier", currency: "USD", amount, ...overrides });
  const refusal = (ceiling: unknown, spend: ReturnType<typeof planned>) => {
    try {
      assertSupplierSpendWithinCeiling(ceiling as never, spend);
      return null;
    } catch (error) {
      return (error as { refusal?: string }).refusal;
    }
  };

  it("admits a supplier price increase up to the tolerance, exactly", () => {
    for (const amount of ["0", "4.25", "4.26", "4.67", "4.675", "4.67500"]) expect(refusal(v2, planned(amount))).toBeNull();
    for (const amount of ["4.6750001", "4.676", "5"]) expect(refusal(v2, planned(amount))).toBe("ceiling_exceeded");
    const exact = { ...v2, quotedAmount: "10", tolerancePercent: "0" };
    expect(refusal(exact, planned("10.000"))).toBeNull();
    expect(refusal(exact, planned("10.000000000000000001"))).toBe("ceiling_exceeded");
  });

  it("keeps a v1 ceiling's exact semantics: its maximum, with no tolerance", () => {
    for (const amount of ["12.5", "12.50", "12.4999"]) expect(refusal(v1, planned(amount))).toBeNull();
    for (const amount of ["12.5000001", "12.51", "13.75"]) expect(refusal(v1, planned(amount))).toBe("ceiling_exceeded");
  });

  it("refuses a missing, malformed or mismatched ceiling and a malformed spend", () => {
    expect(refusal(undefined, planned("1"))).toBe("ceiling_missing");
    expect(refusal(null, planned("1"))).toBe("ceiling_missing");
    expect(refusal({ ...v2, tolerancePercent: "101" }, planned("1"))).toBe("ceiling_invalid");
    expect(refusal(v2, planned("1", { supplier: "other-supplier" }))).toBe("ceiling_mismatch");
    expect(refusal(v2, planned("1", { currency: "EUR" }))).toBe("ceiling_mismatch");
    expect(refusal(v2, planned("1e1"))).toBe("spend_invalid");
    expect(refusal(v2, planned("-1"))).toBe("spend_invalid");
  });
});

describe("the ceiling a quote records", () => {
  const cost = { supplier: "synthetic-supplier", currency: "USD", amount: "4.25" };

  it("records the reported supplier cost with the tolerance in force", () => {
    expect(supplierCostCeilingFromQuote(cost, "10")).toEqual(v2);
    expect(supplierCostCeilingFromQuote(cost, "0")).toEqual({ ...v2, tolerancePercent: "0" });
    expect(supplierCostCeilingFromQuote(undefined, "10")).toBeNull();
    expect(supplierCostCeilingFromQuote(null, "10")).toBeNull();
  });

  it.each([
    [{ ...cost, extra: "x" }, "10"],
    [{ supplier: cost.supplier, currency: cost.currency }, "10"],
    [{ ...cost, amount: "4.2.5" }, "10"],
    [{ ...cost, amount: 4.25 }, "10"],
    [{ ...cost, currency: "usd" }, "10"],
    [{ ...cost, supplier: "bad supplier" }, "10"],
    [[], "10"],
    [cost, "100.5"],
    [cost, ""],
  ])("fails closed on %j with tolerance %j", (reported, tolerance) => {
    expect(() => supplierCostCeilingFromQuote(reported as never, tolerance)).toThrow("Supplier cost ceiling is invalid");
  });
});

describe("SUPPLIER_PRICE_TOLERANCE_PERCENT (A5)", () => {
  const parse = (value: string | undefined) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (value === undefined) delete env.SUPPLIER_PRICE_TOLERANCE_PERCENT;
    else env.SUPPLIER_PRICE_TOLERANCE_PERCENT = value;
    return parseConfig(env).SUPPLIER_PRICE_TOLERANCE_PERCENT;
  };

  it("defaults to 10 and keeps an admitted decimal exactly as configured", () => {
    expect(parse(undefined)).toBe("10");
    for (const value of ["0", "0.5", "12.5", "99.99", "100", "100.0", "100.00"]) expect(parse(value)).toBe(value);
  });

  it.each(["", " 10", "10 ", "100.5", "100.01", "101", "-1", "10.001", "1e1", "010", "10%", "ten"])(
    "refuses boot on %j, naming the variable",
    (value) => {
      expect(() => parse(value)).toThrow(/SUPPLIER_PRICE_TOLERANCE_PERCENT must be a decimal from 0 to 100/);
    },
  );
});
