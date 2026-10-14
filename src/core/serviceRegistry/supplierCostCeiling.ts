import { SupplierMutationAuthorizationError } from "../suppliers/errorClassifier.js";
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

/**
 * The ceiling core bound to a paid task at dispatch admission. It is the same
 * immutable value for every later attempt, retry, input or cancellation of
 * the order; services read it here (or from `TaskContext`) and never derive a
 * new one from a fresh supplier quote.
 */
export function admittedSupplierCostCeiling(
  metadata: Record<string, unknown> | null | undefined,
): SupplierCostCeiling | undefined {
  return parseOptionalSupplierCostCeiling(metadata?.supplier_cost_ceiling) ?? undefined;
}

/** The supplier operation a service is about to pay for, in the ceiling's units. */
export interface PlannedSupplierSpend {
  supplier: string;
  currency: string;
  amount: string;
}

export type SupplierCostCeilingRefusal =
  | "ceiling_missing"
  | "ceiling_invalid"
  | "spend_invalid"
  | "ceiling_mismatch"
  | "ceiling_exceeded";

/**
 * The planned spend is not admitted by the order's ceiling. It is a
 * pre-mutation authorization refusal: the supplier was not called.
 */
export class SupplierCostCeilingError extends SupplierMutationAuthorizationError {
  constructor(supplier: string, readonly refusal: SupplierCostCeilingRefusal) {
    super(supplier, `Planned supplier spend is not admitted: ${refusal}`);
    this.name = "SupplierCostCeilingError";
  }
}

function compareDecimal(left: string, right: string): number {
  const [leftWhole, leftFraction = ""] = left.split(".");
  const [rightWhole, rightFraction = ""] = right.split(".");
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const scaled = (whole: string, fraction: string) => BigInt(`${whole}${fraction.padEnd(scale, "0")}`);
  const difference = scaled(leftWhole!, leftFraction) - scaled(rightWhole!, rightFraction);
  return difference === 0n ? 0 : difference > 0n ? 1 : -1;
}

/**
 * Compare a planned supplier operation with the admitted ceiling before any
 * spend. A task without an admitted ceiling, a different supplier or
 * currency, or an amount above the maximum is refused.
 */
export function assertSupplierSpendWithinCeiling(
  ceiling: SupplierCostCeiling | null | undefined,
  planned: PlannedSupplierSpend,
): void {
  const supplier = typeof planned.supplier === "string" ? planned.supplier.slice(0, 64) : "unknown";
  if (ceiling === null || ceiling === undefined) throw new SupplierCostCeilingError(supplier, "ceiling_missing");
  let admitted: SupplierCostCeiling;
  try {
    admitted = parseSupplierCostCeiling(ceiling);
  } catch {
    throw new SupplierCostCeilingError(supplier, "ceiling_invalid");
  }
  if (
    typeof planned.supplier !== "string" || !SUPPLIER.test(planned.supplier) ||
    typeof planned.currency !== "string" || !CURRENCY.test(planned.currency) ||
    typeof planned.amount !== "string" || !SUPPLIER_COST_AMOUNT.test(planned.amount)
  ) throw new SupplierCostCeilingError(supplier, "spend_invalid");
  if (planned.supplier !== admitted.supplier || planned.currency !== admitted.currency) {
    throw new SupplierCostCeilingError(supplier, "ceiling_mismatch");
  }
  if (compareDecimal(planned.amount, admitted.maximumAmount) > 0) {
    throw new SupplierCostCeilingError(supplier, "ceiling_exceeded");
  }
}
