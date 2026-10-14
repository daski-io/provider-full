import { afterEach, describe, expect, it, vi } from "vitest";
import { forbidGatewayWrites, requestBoundedJson } from "../src/core/gatewayRegistration/wire.js";

// The read-only forecast forbids gateway writes for the rest of the process:
// a request other than GET fails before anything is sent, while reads work.
// This file owns the module state it changes.

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("read-only gateway access", () => {
  it("refuses every non-GET registration request before sending it, and keeps reads", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetch);
    forbidGatewayWrites();

    for (const method of ["POST", "post", "PUT", "DELETE"]) {
      await expect(requestBoundedJson("https://gateway.example/v1/service-registrations", {
        method,
        body: "{}",
      })).rejects.toThrow(/read-only run refused to send a gateway [A-Z]+ request/);
    }
    expect(fetch).not.toHaveBeenCalled();

    await expect(requestBoundedJson("https://gateway.example/v1/service-registrations/x"))
      .resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
