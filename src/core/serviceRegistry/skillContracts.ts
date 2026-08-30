import type {
  ClosedJsonSchema,
  SkillContractDefinition,
  SkillDefinition,
} from "./manifestTypes.js";

export type SkillDefinitionDraft = Omit<SkillDefinition, keyof SkillContractDefinition>;

export const schema = {
  string: (maximum = 4_096): ClosedJsonSchema => ({
    type: "string",
    minLength: 1,
    maxLength: maximum,
  }),
  optionalString: (maximum = 4_096): ClosedJsonSchema => ({
    type: "string",
    maxLength: maximum,
  }),
  // Closed value set, published verbatim on the agent card so callers see
  // the accepted values instead of guessing. Enum matching is exact and
  // case-sensitive; validateProviderRequest names the allowed values on a
  // mismatch. The optional description is the place for scoping rules the
  // closed schema cannot express (no conditional keywords).
  stringEnum: (values: readonly string[], description?: string): ClosedJsonSchema => {
    if (values.length === 0 || new Set(values).size !== values.length) {
      throw new Error("stringEnum requires a non-empty list of unique values");
    }
    return {
      type: "string",
      enum: [...values],
      ...(description === undefined ? {} : { description }),
    };
  },
  boolean: (): ClosedJsonSchema => ({ type: "boolean" }),
  integer: (minimum = 0, maximum = Number.MAX_SAFE_INTEGER): ClosedJsonSchema => ({
    type: "integer",
    minimum,
    maximum,
  }),
  number: (minimum = 0): ClosedJsonSchema => ({ type: "number", minimum }),
  null: (): ClosedJsonSchema => ({ type: "null" }),
  array: (items: ClosedJsonSchema, maximum = 128): ClosedJsonSchema => ({
    type: "array",
    items,
    maxItems: maximum,
  }),
  object: (
    properties: Record<string, ClosedJsonSchema>,
    required: readonly string[] = [],
  ): ClosedJsonSchema => ({
    type: "object",
    properties,
    required: [...required],
    additionalProperties: false,
    maxProperties: Object.keys(properties).length,
  }),
  // Record values are bounded at runtime by the shared JSON budget; the
  // schema pins the key count and key length.
  boundedRecord: (maximum = 64, keyLength = 128): ClosedJsonSchema => ({
    type: "object",
    properties: {},
    additionalProperties: true,
    maxProperties: maximum,
    propertyNames: { maxLength: keyLength },
  }),
} as const;

export function inputContract(
  required: readonly string[],
  optional: readonly string[] = [],
  overrides: Record<string, ClosedJsonSchema> = {},
): ClosedJsonSchema {
  const fields = [...required, ...optional];
  const properties = Object.fromEntries(fields.map((field) => [
    field,
    overrides[field] ?? schema.string(),
  ]));
  return schema.object(properties, required);
}

export function defineSkills(
  drafts: readonly SkillDefinitionDraft[],
  contracts: Readonly<Record<string, SkillContractDefinition>>,
): SkillDefinition[] {
  const ids = new Set(drafts.map((skill) => skill.id));
  if (ids.size !== drafts.length) {
    throw new Error("Skill ids must be unique within a service");
  }
  const contractIds = Object.keys(contracts);
  if (
    contractIds.length !== ids.size ||
    contractIds.some((id) => !ids.has(id)) ||
    [...ids].some((id) => contracts[id] === undefined)
  ) {
    throw new Error("Every service skill must have exactly one skill contract");
  }
  return drafts.map((draft) => ({ ...draft, ...contracts[draft.id]! }));
}
