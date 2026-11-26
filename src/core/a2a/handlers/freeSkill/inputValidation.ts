import type { TaskDurability } from "../../../serviceRegistry/types.js";

type ValidationResult =
  | { ok: true; messageId: string }
  | { ok: false; message: string; field: "messageId" | "data" };

export function validateFreeSkillInput(args: {
  messageId: unknown;
  data: Record<string, unknown>;
  taskDurability: TaskDurability;
  requiredFields: string[] | null;
  optionalFields: string[] | null;
}): ValidationResult {
  if (
    typeof args.messageId !== "string"
    || args.messageId.trim().length === 0
    || args.messageId.length > 256
  ) {
    return {
      ok: false,
      message: "message.messageId is required and must be at most 256 characters",
      field: "messageId",
    };
  }
  if (args.taskDurability === "ephemeral") {
    const declared = new Set([
      ...(args.requiredFields ?? []),
      ...(args.optionalFields ?? []),
    ]);
    const undeclared = Object.keys(args.data)
      .filter((field) => !declared.has(field))
      .sort();
    if (undeclared.length > 0) {
      return {
        ok: false,
        message: `Undeclared fields: ${undeclared.join(", ")}`,
        field: "data",
      };
    }
  }
  return { ok: true, messageId: args.messageId };
}
