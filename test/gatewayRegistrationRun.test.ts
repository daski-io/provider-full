import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// One daski:register run: configuration and the selection are checked before
// any chain write, and the gateway phases use the rows the ServiceRegistry
// bootstrap left behind.

const h = vi.hoisted(() => ({
  listActiveServices: vi.fn(),
  bootstrapServiceRegistry: vi.fn(),
  registerServiceWithGateway: vi.fn(),
}));

vi.mock("../src/core/db/queries/services.js", () => ({ listActiveServices: h.listActiveServices }));
vi.mock("../src/core/chain/serviceRegistrar.js", () => ({
  bootstrapServiceRegistry: h.bootstrapServiceRegistry,
}));
vi.mock("../src/core/gatewayRegistration/client.js", () => ({
  registerServiceWithGateway: h.registerServiceWithGateway,
}));

import { registerSelectedServices } from "../src/core/gatewayRegistration/registrationRun.js";
import type { ServiceRow } from "../src/core/db/queries/services.js";

const GATEWAY = "https://gateway.example";
const unregistered = { id: "service-1", slug: "orbital-logistics", on_chain_id: null } as unknown as ServiceRow;
const registered = { ...unregistered, on_chain_id: Buffer.alloc(32, 7) } as ServiceRow;
const all = (rows: ServiceRow[]) => rows;

beforeEach(() => {
  for (const mock of Object.values(h)) mock.mockReset();
  h.registerServiceWithGateway.mockImplementation(async (_gateway: string, service: ServiceRow) => ({
    serviceSlug: service.slug,
    state: "ACTIVE",
    registrationId: "registration-1",
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("registration run", () => {
  it("registers the rows the ServiceRegistry bootstrap left, in both phases", async () => {
    h.listActiveServices.mockResolvedValueOnce([unregistered]).mockResolvedValueOnce([registered]);
    const reported: unknown[] = [];

    const failures = await registerSelectedServices({
      gateway: GATEWAY,
      select: all,
      report: (outcome) => reported.push(outcome),
    });

    expect(failures).toEqual([]);
    expect(h.bootstrapServiceRegistry).toHaveBeenCalledOnce();
    expect(h.registerServiceWithGateway.mock.calls).toEqual([
      [GATEWAY, registered, 1, "broadcast"],
      [GATEWAY, registered],
    ]);
    expect(h.bootstrapServiceRegistry.mock.invocationCallOrder[0])
      .toBeLessThan(h.listActiveServices.mock.invocationCallOrder[1]!);
    expect(reported).toHaveLength(2);
  });

  it("refuses malformed activation polling or an unknown selection before any chain write", async () => {
    vi.stubEnv("REGISTRATION_ACTIVATION_POLL_MS", "20s");
    await expect(registerSelectedServices({ gateway: GATEWAY, select: all, report: () => undefined }))
      .rejects.toThrow(/REGISTRATION_ACTIVATION_POLL_MS must be an integer/);
    vi.unstubAllEnvs();

    h.listActiveServices.mockResolvedValue([registered]);
    await expect(registerSelectedServices({
      gateway: GATEWAY,
      select: () => { throw new Error("unknown or inactive services: missing"); },
      report: () => undefined,
    })).rejects.toThrow(/unknown or inactive services/);
    expect(h.bootstrapServiceRegistry).not.toHaveBeenCalled();
  });

  it("reports one service's failure without blocking another", async () => {
    const other = { ...registered, id: "service-2", slug: "second-service" } as ServiceRow;
    h.listActiveServices.mockResolvedValue([registered, other]);
    h.registerServiceWithGateway.mockImplementation(async (_gateway: string, service: ServiceRow) => {
      if (service.slug === "orbital-logistics") throw new Error("gateway unavailable");
      return { serviceSlug: service.slug, state: "ACTIVE", registrationId: "registration-2" };
    });

    const failures = await registerSelectedServices({ gateway: GATEWAY, select: all, report: () => undefined });
    expect(failures).toEqual([
      "orbital-logistics broadcast: gateway unavailable",
      "orbital-logistics activation: gateway unavailable",
    ]);
    expect(h.registerServiceWithGateway).toHaveBeenCalledTimes(4);
  });
});
