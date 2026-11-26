import { describe, expect, it } from "vitest";
import { exampleInput } from "../src/core/a2a/freeSkillHelp.js";
import { inputContract, schema } from "../src/core/serviceRegistry/skillContracts.js";
import {
  compileProviderSchema,
  providerRequestFieldErrors,
} from "../src/core/standardRail/schema.js";
import { dummySkillContracts } from "../src/services/dummy/skillContracts.js";

// The example a free-skill error returns is built from the skill's published
// input schema. Where the schema fixes every value it must pass that schema
// as sent; anywhere else the schema refuses it, the value is marked as a
// placeholder to replace.

const everySchema = Object.entries(dummySkillContracts).map(([skillId, contract]) =>
  [`dummy ${skillId}`, contract.inputSchema as Record<string, unknown>] as const);

describe("free skill example input", () => {
  it("is a valid request with nothing to replace when the schema fixes every value", () => {
    const pricing = inputContract(["units", "days", "tier", "rush"], ["note"], {
      units: schema.integer(2, 16),
      days: schema.integer(1, 30),
      tier: schema.stringEnum(["standard", "priority"]),
      rush: schema.boolean(),
      note: schema.string(200),
    }) as Record<string, unknown>;
    const { input, placeholders } = exampleInput(pricing);
    expect(input).toEqual({ units: 2, days: 1, tier: "standard", rush: false });
    expect(placeholders).toEqual([]);
    expect(providerRequestFieldErrors(compileProviderSchema(pricing), input)).toEqual([]);
  });

  it("finds published schemas to check", () => {
    expect(everySchema.length).toBeGreaterThan(0);
  });

  // Any refusal of an example by its own published schema must sit at a
  // value the example marks as a placeholder, never at a derived one.
  it.each(everySchema)("marks every value %s cannot derive", (_name, published) => {
    const { input, placeholders } = exampleInput(published);
    const marked = placeholders.map((path) => path.replace(/\[(\d+)\]/g, ".$1"));
    for (const error of providerRequestFieldErrors(compileProviderSchema(published), input)) {
      expect(
        marked.some((path) => error.field === path || error.field.startsWith(`${path}.`)),
        `${error.field}: ${error.problem}`,
      ).toBe(true);
    }
  });

  it("marks the starter echo skill's message as the value to replace", () => {
    expect(exampleInput(dummySkillContracts.echo!.inputSchema as Record<string, unknown>))
      .toEqual({ input: { message: "<message>" }, placeholders: ["message"] });
  });

  it("fills only required fields and marks the stand-ins", () => {
    expect(exampleInput({
      type: "object",
      properties: {
        name: { type: "string" },
        code: { type: "string", minLength: 12, maxLength: 14 },
        kind: { type: "string", enum: ["a", "b"] },
        fixed: { type: "string", const: "US" },
        count: { type: "number", exclusiveMinimum: 0.5 },
        whole: { type: "integer", exclusiveMinimum: 3 },
        capped: { type: "integer", exclusiveMinimum: 9, maximum: 9 },
        flag: { type: "boolean" },
        list: { type: "array", minItems: 2, items: { type: "string" } },
        empty: { type: "array", items: { type: "string" } },
        record: {
          type: "object",
          properties: {},
          additionalProperties: true,
          maxProperties: 4,
          propertyNames: { maxLength: 8 },
        },
        child: {
          type: "object",
          properties: { label: { type: "string" }, note: { type: "string" } },
          required: ["label"],
        },
        optional: { type: "string" },
      },
      required: [
        "name", "code", "kind", "fixed", "count", "whole", "capped", "flag",
        "list", "empty", "record", "child", "missing",
      ],
    })).toEqual({
      input: {
        name: "<name>",
        code: "<code>______",
        kind: "a",
        fixed: "US",
        count: 1.5,
        whole: 4,
        capped: 9,
        flag: false,
        list: ["<list>", "<list>"],
        empty: [],
        record: {},
        child: { label: "<label>" },
      },
      placeholders: ["name", "code", "list[0]", "list[1]", "record", "child.label"],
    });
  });

  it("stops at a bounded depth and marks it", () => {
    let nested: Record<string, unknown> = { type: "integer" };
    for (let index = 0; index < 20; index++) {
      nested = { type: "object", properties: { next: nested }, required: ["next"] };
    }
    const { input, placeholders } = exampleInput(nested);
    expect(JSON.stringify(input)).toContain("null");
    expect(placeholders).toHaveLength(1);
  });
});
