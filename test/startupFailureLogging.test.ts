import { describe, expect, it, vi } from "vitest";
import { logError } from "../src/core/logger.js";

// The startup-failure path puts the error cause into the log MESSAGE so
// platform log viewers (which render only the message) show why boot died.
// That is safe only while the logger redacts message text; this pins it.
describe("startup failure logging", () => {
  it("keeps the cause in the message with secrets redacted", () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      logError(
        "Startup failed: fetch of https://gateway.internal/v1/service-registrations/abc " +
        "rejected with token=supersecretvalue for operator@example.com",
      );
    } finally {
      spy.mockRestore();
    }
    const line = JSON.parse(writes.join(""));
    expect(line.level).toBe("error");
    expect(line.message).toContain("Startup failed:");
    expect(line.message).toContain("<redacted:");
    expect(line.message).not.toContain("supersecretvalue");
    expect(line.message).not.toContain("operator@example.com");
    expect(line.message).not.toContain("/v1/service-registrations/abc");
  });
});
