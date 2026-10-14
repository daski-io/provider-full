import type { SupplierCostCeiling } from "./adapterTypes.js";

const SUPPLIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const CURRENCY = /^[A-Z][A-Z0-9]{2,11}$/;
/** Non-negative decimal without exponent or sign; scale is bounded. */
export const SUPPLIER_COST_AMOUNT = /^(0|[1-9][0-9]{0,29})(\.[0-9]{1,18})?$/;

export class SupplierCostCeilingInvalidError extends Error {
  constructor() {
    super("Supplier cost ceiling is invalid");
    this.name = "SupplierCostCeilingInvalidError";
  }
}

/**
 * Strictly parse a supplier-cost ceiling returned by a quote or loaded from a
 * durable binding. Unknown keys, malformed amounts or identifiers fail closed;
 * the result is a fresh object so callers never alias stored JSON.
 */
export function parseSupplierCostCeiling(value: unknown): SupplierCostCeiling {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SupplierCostCeilingInvalidError();
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (
    keys !== "currency,kind,maximumAmount,supplier" ||
    record.kind !== "supplier-cost-ceiling-v1" ||
    typeof record.supplier !== "string" || !SUPPLIER.test(record.supplier) ||
    typeof record.currency !== "string" || !CURRENCY.test(record.currency) ||
    typeof record.maximumAmount !== "string" || !SUPPLIER_COST_AMOUNT.test(record.maximumAmount)
  ) throw new SupplierCostCeilingInvalidError();
  return {
    kind: "supplier-cost-ceiling-v1",
    supplier: record.supplier,
    currency: record.currency,
    maximumAmount: record.maximumAmount,
  };
}

/** A ceiling is optional: no-spend services quote without one. */
export function parseOptionalSupplierCostCeiling(value: unknown): SupplierCostCeiling | null {
  return value === undefined || value === null ? null : parseSupplierCostCeiling(value);
}
