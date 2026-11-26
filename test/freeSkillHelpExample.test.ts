import { describe, expect, it, vi } from "vitest";
import {
  exampleInput,
  skillExampleInput,
  type OpenFreeSkill,
} from "../src/core/a2a/freeSkillHelp.js";
import { inputContract, schema } from "../src/core/serviceRegistry/skillContracts.js";
import type { SkillDefinition } from "../src/core/serviceRegistry/types.js";
import {
  compileProviderSchema,
  providerRequestFieldErrors,
} from "../src/core/standardRail/schema.js";
import { dummySkillContracts } from "../src/services/dummy/skillContracts.js";

// The registry's compiled skill contracts, for the schemas these tests name.
const contracts = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock("../src/core/serviceRegistry/registry.js", async () => {
  const { compileProviderSchema: compile, providerRequestFieldErrors: fieldErrors } =
    await import("../src/core/standardRail/schema.js");
  return {
    getService: () => null,
    skillInputFieldErrors: (_slug: string, skillId: string, value: unknown) => {
      const contract = contracts.get(skillId);
      if (!contract) throw new Error("Skill input contract is unavailable");
      return fieldErrors(compile(contract), value);
    },
  };
});

function freeSkill(
  skillId: string,
  inputSchema: Record<string, unknown>,
  requiredFields: readonly string[] = (inputSchema.required ?? []) as string[],
): OpenFreeSkill {
  contracts.set(skillId, inputSchema);
  return {
    skillId,
    definition: { id: skillId, inputSchema } as unknown as SkillDefinition,
    requiredFields,
    documentationUrl: `https://provider.test/skills/example/${skillId}.md`,
  };
}

const closed = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
  ...extra,
});

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

describe("free skill example checked against the skill's contract", () => {
  // Keywords the builder does not derive a value from: the contract refuses
  // the derived value, so the example marks it instead of calling itself a
  // working request.
  it.each([
    ["multipleOf", closed({ qty: { type: "integer", minimum: 1, maximum: 100, multipleOf: 5 } }), ["qty"]],
    ["exclusiveMaximum", closed({ ratio: { type: "number", exclusiveMaximum: 1 } }), ["ratio"]],
    ["a fractional integer minimum", closed({ n: { type: "integer", minimum: 0.5, maximum: 10 } }), ["n"]],
    [
      "uniqueItems",
      closed({ ids: { type: "array", minItems: 2, uniqueItems: true, items: { type: "integer", minimum: 1 } } }),
      ["ids"],
    ],
    [
      "a nested minProperties",
      closed({
        opts: {
          type: "object",
          properties: { a: { type: "boolean" } },
          required: [],
          additionalProperties: false,
          minProperties: 1,
        },
      }),
      ["opts"],
    ],
    [
      "a root minProperties",
      { type: "object", properties: { a: { type: "boolean" } }, additionalProperties: false, minProperties: 1 },
      [""],
    ],
  ])("marks a value refused through %s", (name, inputSchema, expected) => {
    const skill = freeSkill(`refused-${name.replaceAll(" ", "-")}`, inputSchema as Record<string, unknown>);
    expect(skillExampleInput("example", skill).placeholders).toEqual(expected);
  });

  it("marks an array item the contract refuses by its index", () => {
    const skill = freeSkill("refused-item", closed({
      sizes: { type: "array", minItems: 1, items: { type: "integer", minimum: 1, multipleOf: 4 } },
    }));
    expect(skillExampleInput("example", skill).placeholders).toEqual(["sizes[0]"]);
  });

  it("marks the whole input when more values are refused than the error list names", () => {
    const many = closed(Object.fromEntries(Array.from({ length: 9 }, (_, index) =>
      [`f${index}`, { type: "integer", minimum: 1, maximum: 100, multipleOf: 5 }])));
    expect(skillExampleInput("example", freeSkill("refused-many", many)).placeholders)
      .toEqual(["f0", "f1", "f2", "f3", "f4", "f5", "f6", "f7", ""]);
  });

  it("fills a field the skill requires and the schema leaves optional", () => {
    const pricing = inputContract(["units"], ["tier", "note"], {
      units: schema.integer(2, 16),
      tier: schema.stringEnum(["standard", "priority"]),
      note: schema.string(200),
    }) as Record<string, unknown>;
    expect(skillExampleInput("example", freeSkill("row-required", pricing, ["units", "tier"])))
      .toEqual({ input: { units: 2, tier: "standard" }, placeholders: [] });
    expect(skillExampleInput("example", freeSkill("row-required-text", pricing, ["units", "note"])))
      .toEqual({ input: { units: 2, note: "<note>" }, placeholders: ["note"] });
  });

  it("keeps a working example as it is", () => {
    const skill = freeSkill("works", closed({ units: schema.integer(2, 16) }));
    expect(skillExampleInput("example", skill)).toEqual({ input: { units: 2 }, placeholders: [] });
  });

  it("marks the whole input when the skill has no contract to check against", () => {
    const skill = freeSkill("no-contract", closed({ units: schema.integer(2, 16) }));
    contracts.delete("no-contract");
    expect(skillExampleInput("example", skill).placeholders).toEqual([""]);
  });
});
