import { z } from "zod";

// skills.pricing JSONB schema + helpers.
//
// Pricing is a map keyed by currency (e.g. "USDC"). Each entry defines
// an independent pricing scheme for that currency. Free skills are
// expressed as `fixed_amount: "0"` — there is no separate "free" type
// so we can model free monthly subscriptions, free intro tiers, etc.
//
// All amounts are atomic-unit STRINGS (BigInt-safe; PostgreSQL JSONB
// can't carry arbitrary-precision integers natively). Use BigInt(...)
// when comparing.

const atomicAmount = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,77})$/, "pricing amount must be a canonical uint256 string");

const intervalUnit = z.enum(["day", "week", "month", "year"]);

const intervalSchema = z.object({
  unit: intervalUnit,
  count: z.number().int().positive(),
});

const currencyPricingSchema = z
  .object({
    type: z.enum([
      "one-time",
      "hourly",
      "daily",
      "weekly",
      "monthly",
      "quarterly",
      "annually",
      "usage",
    ]),
    fixed_amount: atomicAmount.optional(),
    min_amount: atomicAmount.optional(),
    max_amount: atomicAmount.optional(),
    price_list: z.record(z.string(), atomicAmount).optional(),
    unit: z.string().optional(),
    amount_per_unit: atomicAmount.optional(),
    interval: intervalSchema.optional(),
  })
  .superRefine((p, ctx) => {
    if (
      p.fixed_amount !== undefined &&
      (
        p.min_amount !== undefined ||
        p.max_amount !== undefined ||
        p.price_list !== undefined ||
        p.amount_per_unit !== undefined
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "fixed_amount cannot be combined with another amount mechanism",
      });
    }
    if (p.type === "usage") {
      if (!p.amount_per_unit) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "type=usage requires amount_per_unit",
        });
      }
      return;
    }
    const has =
      p.fixed_amount !== undefined ||
      p.min_amount !== undefined ||
      p.max_amount !== undefined ||
      p.price_list !== undefined;
    if (!has) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "pricing scheme requires at least one of fixed_amount, min_amount, max_amount, or price_list",
      });
    }
    if (p.min_amount && p.max_amount) {
      try {
        if (BigInt(p.min_amount) > BigInt(p.max_amount)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "min_amount must not exceed max_amount",
          });
        }
      } catch {
        /* atomicAmount regex already caught non-integer strings */
      }
    }
  });

export type CurrencyPricing = z.infer<typeof currencyPricingSchema>;

export const pricingSchema = z
  .record(z.string(), currencyPricingSchema)
  .refine(
    (p) => Object.keys(p).length > 0,
    "pricing must declare at least one currency",
  );

export type SkillPricing = z.infer<typeof pricingSchema>;

/** Parse a positive decimal USDC amount without a floating-point round trip. */
export function parseUsdcDecimal(
  input: string,
  maxFractionDigits = 6,
): bigint | null {
  if (
    !Number.isInteger(maxFractionDigits) ||
    maxFractionDigits < 0 ||
    maxFractionDigits > 6
  ) {
    throw new Error("USDC fraction digits must be between 0 and 6");
  }
  const match = input.trim().match(/^([0-9]+)(?:\.([0-9]+))?$/);
  const fraction = match?.[2] ?? "";
  if (!match || fraction.length > maxFractionDigits) return null;
  const atomic =
    BigInt(match[1]!) * 1_000_000n +
    BigInt(fraction.padEnd(6, "0") || "0");
  return atomic > 0n ? atomic : null;
}

/// Validate a raw value against the pricing schema. Throws ZodError on
/// invalid input. Use at write boundaries (manifest registration,
/// admin UI updates).
export function validatePricing(raw: unknown): SkillPricing {
  return pricingSchema.parse(raw);
}

const DEFAULT_CURRENCY = "USDC";

function pricingFor(
  p: SkillPricing,
  currency = DEFAULT_CURRENCY,
): CurrencyPricing | null {
  return p[currency] ?? null;
}

export function supportsCurrency(p: SkillPricing, currency: string): boolean {
  return p[currency] !== undefined;
}

/// True iff the skill is free in the given currency. Free is encoded as
/// fixed_amount = "0" (any type / interval). Variable-priced skills with
/// min_amount === "0" are NOT free; they merely admit free quotes.
export function isFree(p: SkillPricing, currency = DEFAULT_CURRENCY): boolean {
  const c = pricingFor(p, currency);
  return c?.fixed_amount === "0";
}

/// True iff the actual price needs to be resolved at quote time (no fixed
/// amount; min/max bounds and/or a price_list are present). Free skills
/// (fixed_amount=0) are NOT variable.
export function isVariable(p: SkillPricing, currency = DEFAULT_CURRENCY): boolean {
  const c = pricingFor(p, currency);
  if (!c) return false;
  if (c.fixed_amount !== undefined) return false;
  return (
    c.min_amount !== undefined ||
    c.max_amount !== undefined ||
    c.price_list !== undefined ||
    c.type === "usage"
  );
}

/// Lower bound on price in atomic units. Returns null if the scheme
/// admits any non-negative amount (no fixed, no min, no price_list).
export function getFloor(
  p: SkillPricing,
  currency = DEFAULT_CURRENCY,
): bigint | null {
  const c = pricingFor(p, currency);
  if (!c) return null;
  if (c.fixed_amount !== undefined) return BigInt(c.fixed_amount);
  if (c.min_amount !== undefined) return BigInt(c.min_amount);
  if (c.price_list) {
    const values = Object.values(c.price_list).map((v) => BigInt(v));
    if (values.length === 0) return null;
    return values.reduce((a, b) => (a < b ? a : b));
  }
  return null;
}

/// True iff this skill requires payment. Inverse of `isFree`, but also
/// returns false when no entry exists for the currency (caller should
/// gate on `supportsCurrency` separately).
export function isPaymentRequired(
  p: SkillPricing,
  currency = DEFAULT_CURRENCY,
): boolean {
  if (!supportsCurrency(p, currency)) return false;
  return !isFree(p, currency);
}
