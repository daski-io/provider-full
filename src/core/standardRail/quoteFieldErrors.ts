import type { ErrorObject } from "ajv";
import type { QuoteError, QuoteFieldError } from "../serviceRegistry/types.js";

/** The gateway keeps at most 32 field errors from a quote refusal. */
export const MAX_QUOTE_FIELD_ERRORS = 32;
/** The gateway reads at most 32 KiB of a quote refusal; stay under it. */
export const MAX_QUOTE_REFUSAL_BYTES = 30_000;
const MAX_PATH = 128;
const MAX_MESSAGE = 256;
const MAX_ALLOWED_VALUES = 12;
const MAX_ALLOWED_VALUE = 64;
const RULE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

const RULE_BY_KEYWORD: Readonly<Record<string, string>> = {
  additionalProperties: "unsupported-field",
  const: "const",
  enum: "enum",
  maxItems: "max-items",
  maxLength: "max-length",
  maxProperties: "max-properties",
  maximum: "maximum",
  minItems: "min-items",
  minLength: "min-length",
  minProperties: "min-properties",
  minimum: "minimum",
  pattern: "pattern",
  required: "required",
  type: "type",
};

function pointerSegments(pointer: string): string[] {
  if (!pointer) return [];
  return pointer.split("/").slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function appendPath(path: string, segment: string): string {
  if (/^(0|[1-9]\d*)$/.test(segment)) return `${path}[${segment}]`;
  if (/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(segment)) return path ? `${path}.${segment}` : segment;
  return `${path}[${JSON.stringify(segment)}]`;
}

function errorPath(error: ErrorObject): string {
  let path = pointerSegments(error.instancePath).reduce(appendPath, "");
  const params = error.params as Record<string, unknown>;
  const property = error.keyword === "required"
    ? params.missingProperty
    : error.keyword === "additionalProperties" ? params.additionalProperty : undefined;
  if (typeof property === "string") path = appendPath(path, property);
  return path || "$";
}

function allowedStrings(error: ErrorObject): string[] | undefined {
  const params = error.params as Record<string, unknown>;
  const values = error.keyword === "enum" ? params.allowedValues
    : error.keyword === "const" ? [params.allowedValue] : undefined;
  if (!Array.isArray(values) || values.length === 0 || !values.every((value) => typeof value === "string")) {
    return undefined;
  }
  return (values as string[]).slice(0, MAX_ALLOWED_VALUES).map((value) => truncate(value, MAX_ALLOWED_VALUE));
}

function schemaMessage(error: ErrorObject, path: string): string {
  const label = path === "$" ? "Request" : `Field '${path}'`;
  const params = error.params as Record<string, unknown>;
  const limit = typeof params.limit === "number" ? params.limit : null;
  switch (error.keyword) {
    case "required": return `${label} is required.`;
    case "additionalProperties": return `${label} is not accepted by the published request contract.`;
    case "type": {
      const expected = typeof params.type === "string" ? params.type : "expected type";
      return `${label} must be ${/^[aeiou]/i.test(expected) ? "an" : "a"} ${expected}.`;
    }
    case "minLength":
      return limit === 1 ? `${label} must not be empty.`
        : `${label} must contain at least ${limit ?? "the required number of"} characters.`;
    case "maxLength": return `${label} must contain at most ${limit ?? "the allowed number of"} characters.`;
    case "enum": return `${label} must be one of the values published in the request contract.`;
    case "const": return `${label} must match the value published in the request contract.`;
    case "pattern": return `${label} must match the published pattern.`;
    case "minimum": return `${label} must be at least ${limit ?? "the published minimum"}.`;
    case "maximum": return `${label} must be at most ${limit ?? "the published maximum"}.`;
    case "minItems": return `${label} must contain at least ${limit ?? "the required number of"} entries.`;
    case "maxItems": return `${label} must contain at most ${limit ?? "the allowed number of"} entries.`;
    case "minProperties": return `${label} must contain at least ${limit ?? "the required number of"} fields.`;
    case "maxProperties": return `${label} must contain at most ${limit ?? "the allowed number of"} fields.`;
    default: return `${label} does not match the published request contract.`;
  }
}

/**
 * Field errors derived only from the published schema (paths, keywords and
 * allowed values), never from submitted values, which may be protected.
 */
export function providerSchemaFieldErrors(errors: ErrorObject[] | null | undefined): QuoteFieldError[] {
  return (errors ?? []).slice(0, MAX_QUOTE_FIELD_ERRORS).map((error) => {
    const path = errorPath(error);
    const allowedValues = allowedStrings(error);
    return {
      path,
      rule: RULE_BY_KEYWORD[error.keyword] ?? "schema",
      message: schemaMessage(error, path),
      ...(allowedValues ? { allowedValues } : {}),
    };
  });
}

/** Truncate by code point so a surrogate pair is never split. */
const truncate = (text: string, maximum: number): string => Array.from(text).slice(0, maximum).join("");

function boundedText(value: unknown, maximum: number, fallback: string): string {
  if (typeof value !== "string") return fallback;
  // Control characters never belong in a buyer-facing diagnostic.
  const text = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  return text ? truncate(text, maximum) : fallback;
}

const isObject = (value: unknown): value is QuoteError | QuoteFieldError =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Service-authored errors (quote validation and request readiness) are
 * reviewed buyer-facing text; core still bounds and normalizes their shape
 * and ignores entries that are not objects.
 */
export function serviceFieldErrors(errors: ReadonlyArray<unknown>): QuoteFieldError[] {
  return errors.filter(isObject).slice(0, MAX_QUOTE_FIELD_ERRORS).map((error) => {
    const path = boundedText("field" in error ? error.field : error.path, MAX_PATH, "$");
    const rawRule = "code" in error ? error.code : error.rule;
    const allowed = "allowedValues" in error && Array.isArray(error.allowedValues)
      ? error.allowedValues.filter((value) => typeof value === "string")
        .slice(0, MAX_ALLOWED_VALUES).map((value) => truncate(value, MAX_ALLOWED_VALUE))
      : [];
    return {
      path,
      rule: typeof rawRule === "string" && RULE.test(rawRule) ? rawRule : "invalid",
      message: boundedText(error.message, MAX_MESSAGE, "The request does not satisfy the service contract."),
      ...(allowed.length > 0 ? { allowedValues: allowed } : {}),
    };
  });
}

/** Drop trailing errors until the refusal body fits the gateway's read bound. */
export function fitFieldErrors(
  body: Record<string, unknown>,
  fieldErrors: QuoteFieldError[],
): QuoteFieldError[] {
  const kept = fieldErrors.slice(0, MAX_QUOTE_FIELD_ERRORS);
  while (kept.length > 0 &&
    Buffer.byteLength(JSON.stringify({ ...body, fieldErrors: kept })) > MAX_QUOTE_REFUSAL_BYTES) {
    kept.pop();
  }
  return kept;
}
