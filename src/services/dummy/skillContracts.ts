import type { SkillContractDefinition } from "../../core/serviceRegistry/types.js";
import { inputContract, schema } from "../../core/serviceRegistry/types.js";

export const dummySkillContracts: Record<string, SkillContractDefinition> = {
  echo: {
    inputSchema: inputContract(["message"], [], {
      message: schema.string(500),
    }),
    resultSchema: schema.object({
      message: schema.string(500),
      processedAt: schema.string(64),
    }, ["message", "processedAt"]),
  },
  "create-note": {
    inputSchema: inputContract(["title"], ["body"], {
      title: schema.string(80),
      body: schema.optionalString(2_000),
    }),
    resultSchema: schema.object({
      note: schema.string(128),
      title: schema.string(80),
      characters: schema.integer(0, 2_000),
    }, ["note", "title", "characters"]),
  },
};
