import { describe, expect, it } from "vitest";
import { validateFreeSkillInput } from "../src/core/a2a/handlers/freeSkill/inputValidation.js";

describe("free skill input validation", () => {
  it("requires a bounded message id for every free request", () => {
    for (const messageId of [undefined, "", "   ", "x".repeat(257)]) {
      expect(validateFreeSkillInput({
        messageId,
        data: {},
        taskDurability: "ephemeral",
        requiredFields: [],
        optionalFields: [],
      })).toMatchObject({ ok: false });
    }
  });

  it("rejects undeclared fields before ephemeral materialization", () => {
    expect(validateFreeSkillInput({
      messageId: "request-1",
      data: { country: "US", debug: true, extra: "value" },
      taskDurability: "ephemeral",
      requiredFields: [],
      optionalFields: ["country"],
    })).toEqual({
      ok: false,
      message: "Undeclared fields: debug, extra",
      field: "data",
    });
  });

  it("keeps persistent skill validation extensible", () => {
    expect(validateFreeSkillInput({
      messageId: "request-1",
      data: { futureField: true },
      taskDurability: "persistent",
      requiredFields: [],
      optionalFields: [],
    })).toEqual({ ok: true, messageId: "request-1" });
  });
});
