import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// C05: crawler-friendly agent-card paths. A registry crawler that treats the
// card URL as a site root gets the same card at the derived well-known path.
const mocks = vi.hoisted(() => ({
  getServiceBySlug: vi.fn(),
  getSkillsByServiceId: vi.fn(),
}));

vi.mock("../src/core/db/queries/services.js", () => ({
  getServiceBySlug: mocks.getServiceBySlug,
}));
vi.mock("../src/core/db/queries/skills.js", () => ({
  getSkillsByServiceId: mocks.getSkillsByServiceId,
}));
vi.mock("../src/core/agentCards/generator.js", () => ({
  generateAgentCard: vi.fn((service: { slug: string }) => ({ name: service.slug })),
}));

import { agentCardRouter } from "../src/core/agentCards/routes.js";

const DERIVED_PATH = "/sample-service.json/.well-known/agent-card.json";

let server: Server;
let root: string;

beforeAll(async () => {
  const app = express();
  app.use("/agent-cards", agentCardRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP port");
  }
  root = `http://127.0.0.1:${address.port}/agent-cards`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

beforeEach(() => {
  mocks.getServiceBySlug.mockReset();
  mocks.getSkillsByServiceId.mockReset().mockResolvedValue([]);
});

describe("agent card routes", () => {
  it("serves the card again for crawlers that treat the card URL as a site root", async () => {
    mocks.getServiceBySlug.mockResolvedValue({ id: "service-1", slug: "sample-service", is_active: true });

    const direct = await fetch(`${root}/sample-service.json`);
    const derived = await fetch(`${root}${DERIVED_PATH}`);

    expect(direct.status).toBe(200);
    expect(derived.status).toBe(200);
    expect(derived.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await derived.json()).toEqual(await direct.json());
    expect(mocks.getServiceBySlug).toHaveBeenLastCalledWith("sample-service");
  });

  it("refuses an inactive service at both paths", async () => {
    mocks.getServiceBySlug.mockResolvedValue({ id: "service-1", slug: "sample-service", is_active: false });

    for (const path of ["/sample-service.json", DERIVED_PATH]) {
      const response = await fetch(`${root}${path}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Service not found" });
    }
    expect(mocks.getSkillsByServiceId).not.toHaveBeenCalled();
  });
});
