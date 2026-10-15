import { SupplierMutationAuthorizationError } from "../suppliers/errorClassifier.js";
import type { SupplierCost, SupplierCostCeiling, SupplierCostCeilingV2 } from "./adapterTypes.js";
import { isTolerancePercent, SUPPLIER_COST_AMOUNT, toleranceLimit, withinTolerance } from "./supplierCostDecimal.js";

const SUPPLIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const CURRENCY = /^[A-Z][A-Z0-9]{2,11}$/;

export class SupplierCostCeilingInvalidError extends Error {
  constructor() {
    super("Supplier cost ceiling is invalid");
    this.name = "SupplierCostCeilingInvalidError";
  }
}

function exactRecord(value: unknown, keys: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.keys(value).sort().join(",") === keys ? value as Record<string, unknown> : null;
}

const supplierAndCurrency = (record: Record<string, unknown>): boolean =>
  typeof record.supplier === "string" && SUPPLIER.test(record.supplier) &&
  typeof record.currency === "string" && CURRENCY.test(record.currency);

const amount = (value: unknown): value is string => typeof value === "string" && SUPPLIER_COST_AMOUNT.test(value);

/**
 * Strictly parse a supplier-cost ceiling loaded from a durable binding: the
 * v2 ceiling core records now, or a v1 ceiling an earlier release recorded.
 * Unknown keys, malformed amounts, tolerances or identifiers fail closed; the
 * result is a fresh object so callers never alias stored JSON.
 */
export function parseSupplierCostCeiling(value: unknown): SupplierCostCeiling {
  const v2 = exactRecord(value, "currency,kind,quotedAmount,supplier,tolerancePercent");
  if (
    v2 && v2.kind === "supplier-cost-ceiling-v2" && supplierAndCurrency(v2) &&
    amount(v2.quotedAmount) && isTolerancePercent(v2.tolerancePercent)
  ) {
    return {
      kind: "supplier-cost-ceiling-v2",
      supplier: v2.supplier as string,
      currency: v2.currency as string,
      quotedAmount: v2.quotedAmount,
      tolerancePercent: v2.tolerancePercent,
    };
  }
  const v1 = exactRecord(value, "currency,kind,maximumAmount,supplier");
  if (v1 && v1.kind === "supplier-cost-ceiling-v1" && supplierAndCurrency(v1) && amount(v1.maximumAmount)) {
    return {
      kind: "supplier-cost-ceiling-v1",
      supplier: v1.supplier as string,
      currency: v1.currency as string,
      maximumAmount: v1.maximumAmount,
    };
  }
  throw new SupplierCostCeilingInvalidError();
}

/** A ceiling is optional: a quote that reported no supplier cost binds none. */
export function parseOptionalSupplierCostCeiling(value: unknown): SupplierCostCeiling | null {
  return value === undefined || value === null ? null : parseSupplierCostCeiling(value);
}

/**
 * The ceiling a quote records: the supplier cost the service reported at
 * quote time and the tolerance in force, or null when it reported none.
 * A malformed cost or tolerance fails closed.
 */
export function supplierCostCeilingFromQuote(
  cost: SupplierCost | null | undefined,
  tolerancePercent: string,
): SupplierCostCeilingV2 | null {
  if (cost === undefined || cost === null) return null;
  const reported = exactRecord(cost, "amount,currency,supplier");
  if (!reported) throw new SupplierCostCeilingInvalidError();
  return parseSupplierCostCeiling({
    kind: "supplier-cost-ceiling-v2",
    supplier: reported.supplier,
    currency: reported.currency,
    quotedAmount: reported.amount,
    tolerancePercent,
  }) as SupplierCostCeilingV2;
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

/** A v1 ceiling is its maximum with no tolerance: exactly its earlier meaning. */
function quotedTerms(ceiling: SupplierCostCeiling): { quoted: string; tolerancePercent: string } {
  return ceiling.kind === "supplier-cost-ceiling-v2"
    ? { quoted: ceiling.quotedAmount, tolerancePercent: ceiling.tolerancePercent }
    : { quoted: ceiling.maximumAmount, tolerancePercent: "0" };
}

/**
 * The most a ceiling admits, as an exact decimal string (quoted amount plus
 * tolerance, trailing zeros trimmed): for display, or for a supplier API
 * that takes a maximum price. Throws on a malformed ceiling.
 */
export function supplierCostLimit(ceiling: SupplierCostCeiling): string {
  const { quoted, tolerancePercent } = quotedTerms(parseSupplierCostCeiling(ceiling));
  return toleranceLimit(quoted, tolerancePercent);
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

/**
 * Compare a planned supplier operation with the admitted ceiling before any
 * spend. A task without an admitted ceiling, a different supplier or
 * currency, or an amount above the quoted amount plus the recorded
 * tolerance (`amount * 100 > quotedAmount * (100 + tolerancePercent)`) is
 * refused.
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
    !amount(planned.amount)
  ) throw new SupplierCostCeilingError(supplier, "spend_invalid");
  if (planned.supplier !== admitted.supplier || planned.currency !== admitted.currency) {
    throw new SupplierCostCeilingError(supplier, "ceiling_mismatch");
  }
  const { quoted, tolerancePercent } = quotedTerms(admitted);
  if (!withinTolerance(planned.amount, quoted, tolerancePercent)) {
    throw new SupplierCostCeilingError(supplier, "ceiling_exceeded");
  }
}
