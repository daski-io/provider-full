import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import type { FulfillmentAdapter } from "../src/core/serviceRegistry/types.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../src/core/db/pool.js", () => ({ pool: { query: h.query } }));

const {
  executableDefinitionHash,
} = await import("../src/core/serviceRegistry/executableContracts.js");
const {
  assetActionHandler, contractHandler, hasRetainedContracts, registerRetainedContracts,
  registeredExecutableHashes, retainedTaskHandler, RetainedHandlerUnavailableError,
} = await import("../src/core/serviceRegistry/retainedHandlers.js");
const { orderSigningKeys, parseRetainedSigningKeys, SigningKeyUnavailableError } =
  await import("../src/core/standardRail/signingKeys.js");
const { admittedActionDefinition, retainAdmittedActionDefinitions } =
  await import("../src/core/standardRail/actionDefinitions.js");

// F-T05, C-T06: an order or action runs only on the handler of the contract
// it was admitted under; commercial terms alone never need a retained
// handler, and an unknown contract has no handler at all.
const closed = (properties: Record<string, unknown>) => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false,
});
const text = { type: "string", maxLength: 40 };
const adapter = (label: string): FulfillmentAdapter => ({
  execute: async () => ({ status: "completed", message: label }),
  handleInput: async () => ({ status: "working" }),
  cancel: async () => undefined,
  quote: async () => ({ ok: true, amount: 1n, currency: "USDC" }),
});
const contract = (input: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  inputSchema: closed(input), resultSchema: closed({ note: text }),
  pricing: { USDC: { type: "one-time", fixed_amount: "250000" } }, paymentRequired: true,
  requiresAssetOwnership: false, assetType: null, fulfillmentMode: "automated", purchaseReadiness: null,
  capacity: { maxOpenOrders: 10 }, deadlines: { dispatchSeconds: 300, fulfillmentSeconds: 43_200 },
  assetAction: null, ...extra,
});
const retained = adapter("retained");
const module = (previous: Array<{ contract: Record<string, unknown>; adapter: FulfillmentAdapter }>) => ({
  manifest: { slug: "notes", defaultFulfillmentMode: "automated" },
  skills: [{
    id: "write", inputSchema: closed({ title: text, body: text }), resultSchema: closed({ note: text }),
    pricing: { USDC: { type: "one-time", fixed_amount: "250000" } }, requiresAssetOwnership: false,
    previousContracts: previous,
  }],
}) as never;
const current = contract({ title: text, body: text });
const earlier = contract({ title: text });

beforeEach(() => {
  h.query.mockReset();
  registerRetainedContracts(module([{ contract: earlier, adapter: retained }]));
});

describe("executable contracts", () => {
  it("ignore pricing, capacity and deadlines but bind every executable field", () => {
    const hash = executableDefinitionHash("notes", "write", current);
    expect(executableDefinitionHash("notes", "write", {
      ...current, pricing: { USDC: { type: "one-time", fixed_amount: "999" } },
      capacity: { maxOpenOrders: 1 }, deadlines: { dispatchSeconds: 600 },
    })).toBe(hash);
    // A contract published before purchaseReadiness existed had none.
    const { purchaseReadiness: _readiness, ...legacy } = current;
    expect(executableDefinitionHash("notes", "write", legacy)).toBe(hash);
    for (const changed of [
      { ...current, resultSchema: closed({ other: text }) },
      { ...current, requiresAssetOwnership: true },
      { ...current, fulfillmentMode: "human" },
    ]) expect(executableDefinitionHash("notes", "write", changed)).not.toBe(hash);
    expect(executableDefinitionHash("other", "write", current)).not.toBe(hash);
    expect(() => executableDefinitionHash("notes", "write", { inputSchema: {} })).toThrow(/executable fields/);
  });

  it("route each admitted contract to its handler and leave unknown ones without one", () => {
    expect(contractHandler("notes", "write", current)).toEqual({ kind: "current" });
    expect(contractHandler("notes", "write", earlier)).toEqual({ kind: "retained", adapter: retained });
    expect(contractHandler("notes", "write", contract({ subject: text }))).toBeNull();
    expect(contractHandler("notes", "other", current)).toBeNull();
    expect(contractHandler("unknown", "write", current)).toBeNull();
    expect(contractHandler("notes", "write", { malformed: true })).toBeNull();
    // A head configured without the runtime catalog runs on the current handler.
    expect(contractHandler("unknown", "write", null)).toEqual({ kind: "current" });
    expect(hasRetainedContracts("notes", "write")).toBe(true);
    expect(registeredExecutableHashes()).toEqual(expect.objectContaining(new Set([
      executableDefinitionHash("notes", "write", current), executableDefinitionHash("notes", "write", earlier),
    ])));
  });

  it("refuse retained contracts that are invalid, handlerless or not distinct", () => {
    expect(() => registerRetainedContracts(module([{ contract: current, adapter: retained }])))
      .toThrow(/duplicates another contract/);
    expect(() => registerRetainedContracts(module([
      { contract: earlier, adapter: retained }, { contract: { ...earlier, pricing: {} }, adapter: retained },
    ]))).toThrow(/duplicates another contract/);
    expect(() => registerRetainedContracts(module([{ contract: { inputSchema: {} }, adapter: retained }])))
      .toThrow(/executable fields/);
    expect(() => registerRetainedContracts(module([{
      contract: contract({ title: text }, { inputSchema: { type: "object", properties: {} } }), adapter: retained,
    }]))).toThrow();
    expect(() => registerRetainedContracts(module([{ contract: earlier, adapter: { execute: vi.fn() } as never }])))
      .toThrow(/complete fulfillment adapter/);
  });

  it("match a signed asset-action definition to the contract whose action and schemas it names", () => {
    const action = { ownershipPolicy: "owner-only", effect: "mutate", replayPolicy: "stable-result", retentionSeconds: 3_600 };
    const rename = contract({ title: text }, { requiresAssetOwnership: true, assetType: "note", assetAction: action });
    registerRetainedContracts(module([{ contract: rename, adapter: retained }]));
    const definition = {
      serviceSlug: "notes", actionId: "write", assetType: "note", destructive: false,
      replayPolicy: "stable-result", retentionSeconds: 3_600,
      requestSchema: rename.inputSchema, responseSchema: rename.resultSchema,
    };
    expect(assetActionHandler(definition)).toEqual({ kind: "retained", adapter: retained });
    expect(assetActionHandler({ ...definition, retentionSeconds: 60 })).toBeNull();
    expect(assetActionHandler({ ...definition, requestSchema: closed({ subject: text }) })).toBeNull();
  });

  it("route a task to the handler of its admitted version and fail closed for an unknown one", async () => {
    h.query.mockResolvedValueOnce({ rows: [{ listing: Buffer.alloc(32, 1), contract: earlier }] });
    await expect(retainedTaskHandler("notes", "write", "task-1")).resolves.toEqual({ kind: "retained", adapter: retained });
    h.query.mockResolvedValueOnce({ rows: [{ listing: Buffer.alloc(32, 1), contract: contract({ x: text }) }] });
    await expect(retainedTaskHandler("notes", "write", "task-2")).rejects.toBeInstanceOf(RetainedHandlerUnavailableError);
    h.query.mockResolvedValueOnce({ rows: [{ listing: null, action_definition_hash: Buffer.alloc(32, 2), action_definition: null }] });
    await expect(retainedTaskHandler("notes", "write", "task-3")).rejects.toBeInstanceOf(RetainedHandlerUnavailableError);
    h.query.mockResolvedValueOnce({ rows: [{ listing: null, action_definition_hash: null }] });
    await expect(retainedTaskHandler("notes", "write", "task-4")).resolves.toEqual({ kind: "current" });
  });
});

describe("retained signing keys", () => {
  const current = privateKeyToAccount(`0x${"44".repeat(32)}`).address;
  const earlierKey = `0x${"57".repeat(32)}` as Hex;
  const earlierWallet = privateKeyToAccount(earlierKey).address;
  const source = (keys: ReadonlyMap<`0x${string}`, Hex>) => ({
    providerAuthorityPrivateKey: `0x${"44".repeat(32)}` as Hex,
    terminalAttestationPrivateKey: `0x${"44".repeat(32)}` as Hex,
    terminalAttestationKey: current,
    retainedSigningKeys: keys,
  });

  it("parse earlier wallet keys without ever echoing key material", () => {
    expect(parseRetainedSigningKeys(undefined, current).size).toBe(0);
    expect([...parseRetainedSigningKeys(` ${earlierKey} ,`, current).keys()]).toEqual([earlierWallet]);
    for (const [raw, message] of [
      ["0x1234", /entry 1 must be a non-zero 32-byte private key/],
      [`0x${"0".repeat(64)}`, /non-zero/],
      [`0x${"44".repeat(32)}`, /repeats the current provider key/],
      [`${earlierKey},${earlierKey}`, /entry 2 is a duplicate/],
      [Array.from({ length: 17 }, (_, index) => `0x${(index + 1).toString(16).padStart(64, "0")}`).join(","), /at most 16/],
    ] as const) {
      let failure = "";
      try {
        parseRetainedSigningKeys(raw, current);
      } catch (error) {
        failure = (error as Error).message;
      }
      expect(failure).toMatch(message);
      expect(failure).not.toContain("5757");
    }
  });

  it("sign an order with the keys its version names, and never with another", () => {
    const keys = parseRetainedSigningKeys(earlierKey, current);
    expect(orderSigningKeys(source(keys), current)).toEqual({
      authorityPrivateKey: `0x${"44".repeat(32)}`, terminalPrivateKey: `0x${"44".repeat(32)}`,
    });
    expect(orderSigningKeys(source(keys), earlierWallet)).toEqual({
      authorityPrivateKey: earlierKey, terminalPrivateKey: earlierKey,
    });
    expect(() => orderSigningKeys(source(new Map()), earlierWallet)).toThrow(SigningKeyUnavailableError);
  });
});

describe("admitted asset-action definitions", () => {
  const preimage = {
    providerAgentId: "1", serviceId: `0x${"11".repeat(32)}`, serviceSlug: "notes", actionId: "write",
    assetType: "note", ownershipPolicy: "owner-only", destructive: false, requestSchema: closed({ title: text }),
    responseSchema: closed({ note: text }), confirmationSummarySchema: null, confirmationSummaryTemplate: null,
    endpoint: "https://provider.example/standard-rail/assets/action", replayPolicy: "stable-result",
    retentionSeconds: 3_600, validFrom: 0, validBefore: 4_000_000_000,
  };
  const definition = { ...preimage, actionDefinitionHash: canonicalHash(preimage) } as never as {
    actionDefinitionHash: Hex;
  };
  const wallet = (actions: unknown[]) => ({
    catalog: { providerAgentId: "1", actions }, actionCatalogHash: `0x${"aa".repeat(32)}`,
  }) as never;

  it("record verified definitions and resolve an execution's definition after the catalog moved on", async () => {
    const db = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) };
    await expect(retainAdmittedActionDefinitions(wallet([definition]), db as never)).resolves.toBe(1);
    await expect(retainAdmittedActionDefinitions(wallet([{ ...definition, retentionSeconds: 1 }]), db as never))
      .rejects.toThrow(/does not reproduce its hash/);
    const stored = { query: vi.fn(async () => ({ rows: [{ definition }] })) };
    await expect(admittedActionDefinition(wallet([]), definition.actionDefinitionHash, stored as never))
      .resolves.toEqual(definition);
    const tampered = { query: vi.fn(async () => ({ rows: [{ definition: { ...definition, retentionSeconds: 1 } }] })) };
    await expect(admittedActionDefinition(wallet([]), definition.actionDefinitionHash, tampered as never))
      .resolves.toBeNull();
    const empty = { query: vi.fn(async () => ({ rows: [] })) };
    await expect(admittedActionDefinition(wallet([definition]), definition.actionDefinitionHash, empty as never))
      .resolves.toEqual(definition);
    expect(empty.query).not.toHaveBeenCalled();
  });
});
