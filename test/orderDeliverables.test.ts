import { beforeEach, describe, expect, it, vi } from "vitest";
import type { A2ATask } from "../src/core/a2a/responseTypes.js";

const state = vi.hoisted(() => ({
  module: null as unknown,
  assetId: null as string | null,
  queries: [] as unknown[][],
}));
vi.mock("../src/core/db/pool.js", () => ({
  pool: {
    query: async (...args: unknown[]) => {
      state.queries.push(args);
      return { rows: [{ asset_id: state.assetId }] };
    },
  },
}));
vi.mock("../src/core/db/queries/services.js", () => ({
  getServiceById: async (id: string) => (id === "service-notes" ? { id, slug: "notes" } : null),
}));
vi.mock("../src/core/serviceRegistry/registry.js", () => ({
  getService: (slug: string) => (slug === "notes" ? state.module : null),
}));

const {
  addOrderDeliverables,
  deliverableLabel,
  deliverablesPart,
  DELIVERABLES_PART_KEY,
  gatewayAcceptsDeliverables,
  ownerActionDeliverableProblem,
  withDeliverablesArtifact,
} = await import("../src/core/standardRail/orderDeliverables.js");
const { fixture, vector } = await import("./providerWireFixture.js");

const ASSET = "00000000-0000-4000-8000-00000000a0e1";
const item = {
  actionId: "get-note-access-code", assetType: "note", providerAssetId: ASSET,
  input: { note: "note-0001" }, label: "Access code",
};
const task: A2ATask = {
  id: "task-1",
  status: { state: "TASK_STATE_COMPLETED", message: { role: "ROLE_AGENT", parts: [{ kind: "text", text: "Done." }] } },
  artifacts: [{ artifactId: "note", name: "note_created", parts: [{ kind: "data", data: { note: "note-0001" } }] }],
};

beforeEach(() => {
  state.module = null;
  state.assetId = null;
  state.queries = [];
});

describe("the deliverables gate", () => {
  it("opens only when daski-order-status-additions names deliverables", () => {
    expect(gatewayAcceptsDeliverables("salesTax, deliverables")).toBe(true);
    expect(gatewayAcceptsDeliverables("deliverables")).toBe(true);
    expect(gatewayAcceptsDeliverables(" deliverables ,salesTax")).toBe(true);
    expect(gatewayAcceptsDeliverables("salesTax")).toBe(false);
    expect(gatewayAcceptsDeliverables("deliverables-v2")).toBe(false);
    expect(gatewayAcceptsDeliverables("")).toBe(false);
    expect(gatewayAcceptsDeliverables(undefined)).toBe(false);
  });

  it("is open for the vendored gateway's lifecycle POST headers", () => {
    const headers = fixture("lifecycle.json").headers as Record<string, string>;
    expect(gatewayAcceptsDeliverables(headers["daski-order-status-additions"])).toBe(true);
  });
});

describe("the deliverables part", () => {
  it("is exactly the part the vendored vector's provider adds", () => {
    const expected = vector(fixture("lifecycle.json"), "artifact.deliverables.accepted").provider;
    const { part, dropped } = deliverablesPart([item]);
    expect(dropped).toEqual([]);
    expect(withDeliverablesArtifact(expected.frozenResult, part!)).toEqual(expected.result);
  });

  it("lists the artifact first and leaves a null label out", () => {
    const { part } = deliverablesPart([{ ...item, label: null }]);
    expect(part).toEqual({ kind: "data", data: { [DELIVERABLES_PART_KEY]: { items: [
      { kind: "artifact" },
      { kind: "owner-action", actionId: item.actionId, assetType: "note", providerAssetId: ASSET, input: item.input },
    ] } } });
  });

  it("is absent when no owner action remains", () => {
    expect(deliverablesPart([]).part).toBeNull();
    expect(deliverablesPart([{ ...item, actionId: "Bad" }]).part).toBeNull();
  });

  it("drops malformed and repeated items by index and caps the list at 32", () => {
    const many = Array.from({ length: 40 }, (_, index) => ({ ...item, input: { note: `note-${index}` } }));
    const { part, dropped } = deliverablesPart([{ ...item, providerAssetId: ASSET.toUpperCase() }, item, item, ...many]);
    const items = (part!.data![DELIVERABLES_PART_KEY] as { items: unknown[] }).items;
    expect(items).toHaveLength(32);
    expect(dropped.slice(0, 2)).toEqual([{ index: 0, reason: "providerAssetId" }, { index: 2, reason: "duplicate" }]);
    expect(dropped.filter((entry) => entry.reason === "too many items")).toHaveLength(10);
  });

  it("appends its own artifact to a task without artifacts", () => {
    const { part } = deliverablesPart([item]);
    const { artifacts: _artifacts, ...bare } = task;
    expect(withDeliverablesArtifact(bare, part!).artifacts).toEqual([
      { artifactId: "deliverables", name: "deliverables", parts: [part] },
    ]);
  });
});

describe("an owner-action item", () => {
  it("accepts the gateway's shape", () => {
    expect(ownerActionDeliverableProblem(item)).toBeNull();
    expect(ownerActionDeliverableProblem({ ...item, label: undefined })).toBeNull();
    expect(ownerActionDeliverableProblem({ ...item, input: { a: null, b: true, c: 1.5, d: "" } })).toBeNull();
  });

  it.each([
    ["an unknown key", { ...item, kind: "owner-action" }, "unknown key"],
    ["an action id outside the grammar", { ...item, actionId: "-get" }, "actionId"],
    ["an empty asset type", { ...item, assetType: "" }, "assetType"],
    ["an uppercase asset id", { ...item, providerAssetId: ASSET.toUpperCase() }, "providerAssetId"],
    ["a nested input", { ...item, input: { note: { id: 1 } } }, "input"],
    ["an operation input", { ...item, input: { operation: "recover-action" } }, "input"],
    ["an input key outside the grammar", { ...item, input: { "note-id": "x" } }, "input"],
    ["an infinite input", { ...item, input: { n: Number.POSITIVE_INFINITY } }, "input"],
    ["a long input value", { ...item, input: { note: "x".repeat(257) } }, "input"],
    ["seventeen input keys", { ...item, input: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i])) }, "input"],
    ["an input over 2 KiB", { ...item, input: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, "x".repeat(250)])) }, "input"],
    ["an empty label", { ...item, label: "" }, "label"],
    ["a 65-character label", { ...item, label: "x".repeat(65) }, "label"],
    ["a label with a hidden character", { ...item, label: "API‮key" }, "label"],
    ["a label with active content", { ...item, label: "<script>" }, "label"],
  ])("refuses %s", (_name, candidate, reason) => {
    expect(ownerActionDeliverableProblem(candidate)).toBe(reason);
  });
});

describe("a deliverable label", () => {
  it("cleans hidden characters and cuts a long text at a character boundary", () => {
    expect(deliverableLabel("  Articles\u0000of‮Organization  ")).toBe("Articles of Organization");
    const long = deliverableLabel(`${"a".repeat(62)}😀😀`)!;
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long.endsWith("…")).toBe(true);
    expect(ownerActionDeliverableProblem({ ...item, label: long })).toBeNull();
    expect(deliverableLabel("")).toBeNull();
    expect(deliverableLabel(null)).toBeNull();
    expect(deliverableLabel("onload=alert")).toBeNull();
  });
});

describe("adding an order's deliverables to its artifact read", () => {
  const order = { id: "task-1", service_id: "service-notes", skill_id: "create-note" };

  it("asks the service with the linked asset and appends what it lists", async () => {
    state.assetId = ASSET;
    const orderDeliverables = vi.fn(async ({ assetId }: { assetId: string | null }) =>
      assetId ? [{ ...item, providerAssetId: assetId }] : []);
    state.module = { fulfillment: { orderDeliverables } };
    const result = await addOrderDeliverables(order, task);
    expect(orderDeliverables).toHaveBeenCalledWith({ id: "task-1", serviceId: "service-notes", skillId: "create-note", assetId: ASSET });
    expect(result).toEqual(withDeliverablesArtifact(task, deliverablesPart([item]).part!));
    expect(task.artifacts).toHaveLength(1);
  });

  it("leaves the task unchanged without the facet, with an empty list, or when the service fails", async () => {
    state.module = { fulfillment: {} };
    expect(await addOrderDeliverables(order, task)).toBe(task);
    expect(state.queries).toEqual([]);
    state.module = { fulfillment: { orderDeliverables: async () => [] } };
    expect(await addOrderDeliverables(order, task)).toBe(task);
    state.module = { fulfillment: { orderDeliverables: async () => { throw new Error("supplier down"); } } };
    expect(await addOrderDeliverables(order, task)).toBe(task);
    expect(await addOrderDeliverables({ ...order, service_id: "unknown" }, task)).toBe(task);
  });
});
