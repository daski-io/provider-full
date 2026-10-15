/*
 * Exact decimal arithmetic for supplier-cost ceilings. Amounts and
 * tolerances stay decimal strings and are compared as scaled BigInt
 * integers: no floating point and no rounding anywhere. Callers validate
 * every value's shape before calling.
 */

/** Non-negative decimal without exponent or sign; scale is bounded. */
export const SUPPLIER_COST_AMOUNT = /^(0|[1-9][0-9]{0,29})(\.[0-9]{1,18})?$/;
const TOLERANCE_PERCENT = /^(0|[1-9][0-9]?|100)(\.[0-9]{1,2})?$/;

interface Scaled {
  units: bigint;
  scale: number;
}

function scaled(value: string): Scaled {
  const [whole, fraction = ""] = value.split(".");
  return { units: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

const pow10 = (exponent: number): bigint => 10n ** BigInt(exponent);

/** A price tolerance from 0 to 100 percent with at most two decimals ("100.5" is none). */
export function isTolerancePercent(value: unknown): value is string {
  if (typeof value !== "string" || !TOLERANCE_PERCENT.test(value)) return false;
  const { units, scale } = scaled(value);
  return units <= 100n * pow10(scale);
}

/** `quoted * (100 + tolerancePercent)`, as integer units at the returned scale. */
function toleratedHundredths(quoted: string, tolerancePercent: string): Scaled {
  const amount = scaled(quoted);
  const tolerance = scaled(tolerancePercent);
  return {
    units: amount.units * (100n * pow10(tolerance.scale) + tolerance.units),
    scale: amount.scale + tolerance.scale,
  };
}

/** Whether `amount * 100 <= quoted * (100 + tolerancePercent)`, exactly. */
export function withinTolerance(amount: string, quoted: string, tolerancePercent: string): boolean {
  const planned = scaled(amount);
  const limit = toleratedHundredths(quoted, tolerancePercent);
  const scale = Math.max(planned.scale, limit.scale);
  return planned.units * 100n * pow10(scale - planned.scale) <= limit.units * pow10(scale - limit.scale);
}

/**
 * The limit `quoted * (100 + tolerancePercent) / 100` as an exact decimal
 * string: trailing fraction zeros trimmed, no trailing dot.
 */
export function toleranceLimit(quoted: string, tolerancePercent: string): string {
  const limit = toleratedHundredths(quoted, tolerancePercent);
  const scale = limit.scale + 2;
  const whole = limit.units / pow10(scale);
  const fraction = (limit.units % pow10(scale)).toString().padStart(scale, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
