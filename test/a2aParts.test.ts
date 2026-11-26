import { describe, expect, it } from "vitest";
import {
  extractDataFromParts,
  extractTextFromParts,
  normalizeMethod,
} from "../src/core/a2a/parts.js";

describe("A2A v1 input normalization", () => {
  it("accepts canonical PascalCase method names and only the message/send alias", () => {
    expect(normalizeMethod("SendMessage")).toBe("SendMessage");
    expect(normalizeMethod("GetTask")).toBe("GetTask");
    expect(normalizeMethod("message/send")).toBe("SendMessage");
    for (const other of [
      "tasks/get", "tasks/send", "tasks/cancel", "message/stream",
      "sendMessage", "__proto__", "constructor", "toString",
    ]) {
      expect(normalizeMethod(other)).toBeUndefined();
    }
  });

  it("reads only the v1 kind discriminator", () => {
    const message = {
      parts: [
        { type: "text", text: "obsolete" },
        { kind: "text", text: "current" },
        { type: "data", data: { ignored: true } },
        { kind: "data", data: { accepted: true } },
      ],
    };

    expect(extractTextFromParts(message)).toBe("current");
    expect(extractDataFromParts(message)).toEqual({ accepted: true });
  });
});
