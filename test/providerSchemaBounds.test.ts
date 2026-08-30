import { describe, expect, it } from "vitest";
import {
  compileProviderSchema,
  validateProviderRequest,
} from "../src/core/standardRail/schema.js";
import { schema } from "../src/core/serviceRegistry/skillContracts.js";

const nested = (depth: number): unknown => (depth === 0 ? 1 : { a: nested(depth - 1) });

const request = (formData: Record<string, unknown>) => ({
  type: "object",
  properties: { formData },
  required: ["formData"],
  additionalProperties: false,
} as Record<string, unknown>);

describe("provider bounded dynamic records", () => {
  it("accepts the helper's record form", () => {
    expect(() => compileProviderSchema(request(schema.boundedRecord(96)))).not.toThrow();
  });

  it("rejects a record without pinned key bounds", () => {
    const { propertyNames: _propertyNames, ...bare } = schema.boundedRecord(96);
    expect(() => compileProviderSchema(request(bare)))
      .toThrow(/bounded dynamic record/);
  });

  it("rejects a dynamic record at the schema root", () => {
    expect(() => compileProviderSchema(schema.boundedRecord(96) as Record<string, unknown>))
      .toThrow(/root/);
  });

  it("rejects propertyNames outside a dynamic record", () => {
    const withPropertyNames = {
      ...request({ type: "string", maxLength: 8 } as Record<string, unknown>),
      propertyNames: { maxLength: 4 },
    };
    expect(() => compileProviderSchema(withPropertyNames)).toThrow(/propertyNames/);
  });

  it("bounds record values through the runtime budget", () => {
    const validate = compileProviderSchema(request(schema.boundedRecord(96)));
    expect(() => validateProviderRequest(validate, {
      formData: { "principal_office_address": { line_1: "2 New St", city: "Cheyenne" } },
    })).not.toThrow();
    expect(() => validateProviderRequest(validate, { formData: nested(30) }))
      .toThrow(/too deeply nested/);
    expect(() => validateProviderRequest(validate, {
      formData: JSON.parse('{"__proto__": {"x": 1}}') as unknown,
    })).toThrow(/unsafe key/);
  });
});

describe("schema mismatch errors name the field and its allowed values", () => {
  const validate = compileProviderSchema({
    type: "object",
    properties: {
      country: { type: "string", const: "US" },
      kind: schema.stringEnum(["alpha", "beta"]),
    },
    required: ["country", "kind"],
    additionalProperties: false,
    maxProperties: 2,
  });

  it("enum mismatch lists the allowed values, never the submitted one", () => {
    let message = "";
    try {
      validateProviderRequest(validate, { country: "US", kind: "SUBMITTED-SECRET" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("does not match the provider outcome schema");
    expect(message).toContain("'kind'");
    expect(message).toContain('"alpha", "beta"');
    expect(message).not.toContain("SUBMITTED-SECRET");
  });

  it("const, missing-property, and unknown-key failures stay field-precise", () => {
    expect(() => validateProviderRequest(validate, { country: "CA", kind: "alpha" }))
      .toThrow(/'country' .*"US"/);
    expect(() => validateProviderRequest(validate, { kind: "alpha" }))
      .toThrow(/required property 'country'/);
    expect(() => validateProviderRequest(validate, { country: "US", kind: "alpha", extra: 1 }))
      .toThrow(/additional properties \('extra'\)/);
  });

  it("caps the detail at three problems", () => {
    let message = "";
    try {
      validateProviderRequest(validate, { a: 1, b: 2, c: 3, d: 4 });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/\+\d+ more$/);
  });
});
