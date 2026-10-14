import { beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  canonicalHash,
  unsignedEnvelopeHash,
} from "../src/core/standardRail/canonical.js";
import type { ProviderStandardRailConfig } from "../src/core/standardRail/config.js";

/// The lifecycle service must claim a task with a conditional status/version
/// update before any supplier-facing adapter call, act on the claimed row
/// (not the load-time snapshot), and persist the terminal state behind the
/// same fence so a racing worker completion is never overwritten. These
/// tests drive perform() through the real grant and payer signature
/// verification with a scripted pg pool.
const h = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  adapterCancel: vi.fn(),
  adapterHandleInput: vi.fn(),
  getServiceById: vi.fn(),
  processAdapterResult: vi.fn(),
  fetchStandardTaskResponse: vi.fn(),
  getTransactionById: vi.fn(),
  enqueueReputationOutcome: vi.fn(),
  decryptString: vi.fn(),
  emitEvent: vi.fn(),
  recordMandatoryAudit: vi.fn(),
  freezeTerminalResult: vi.fn(),
  loadFrozenTerminalProjection: vi.fn(),
}));

vi.mock("../src/core/db/pool.js", () => ({
  pool: { query: h.query, connect: h.connect },
}));
vi.mock("../src/core/serviceRegistry/registry.js", () => ({
  getAdapter: () => ({ cancel: h.adapterCancel, handleInput: h.adapterHandleInput }),
}));
vi.mock("../src/core/db/queries/services.js", () => ({
  getServiceById: h.getServiceById,
}));
vi.mock("../src/core/engine/taskFinalization.js", () => ({
  processAdapterResult: h.processAdapterResult,
}));
vi.mock("../src/core/a2a/responseBuilder.js", () => ({
  revealFrozenTaskProjection: h.fetchStandardTaskResponse,
}));
vi.mock("../src/core/standardRail/terminalResult.js", async (importActual) => ({
  ...await importActual<typeof import("../src/core/standardRail/terminalResult.js")>(),
  freezeTerminalResult: h.freezeTerminalResult,
  loadFrozenTerminalProjection: h.loadFrozenTerminalProjection,
}));
vi.mock("../src/core/db/queries/transactions.js", () => ({
  getTransactionById: h.getTransactionById,
}));
vi.mock("../src/core/standardRail/reputationOutcomeStore.js", () => ({
  enqueueReputationOutcome: h.enqueueReputationOutcome,
}));
vi.mock("../src/core/chain/encryption.js", () => ({
  decryptString: h.decryptString,
}));
vi.mock("../src/core/events/emitter.js", () => ({
  emitEvent: h.emitEvent,
  recordMandatoryAudit: h.recordMandatoryAudit,
}));

import { StandardLifecycleService } from "../src/core/standardRail/lifecycle.js";

const CHAIN_ID = 84532;
const ORDER = "ord_2f2f2f2f-2f2f-42f2-8f2f-2f2f2f2f2f2f";
const TASK = "task-1";
const gateway = privateKeyToAccount(`0x${"22".repeat(32)}`);
const payer = privateKeyToAccount(`0x${"33".repeat(32)}`);

const railConfig = {
  environment: "testnet",
  gatewayAudience: "https://gateway.example",
  gatewayOrigin: "https://gateway.example",
  providerAudience: "https://provider.example",
  gatewayLifecycleSigner: gateway.address,
  providerAuthorityPrivateKey: `0x${"44".repeat(32)}`,
  terminalAttestationPrivateKey: `0x${"44".repeat(32)}`,
} as unknown as ProviderStandardRailConfig;

const service = new StandardLifecycleService(railConfig, CHAIN_ID);

interface TaskRowFixture {
  id: string;
  service_id: string;
  skill_id: string;
  status: string;
  standard_order_id: string;
  standard_payer: Hex;
  metadata: Record<string, unknown>;
  completed_at: Date | null;
  version: string;
}

function taskRow(overrides: Partial<TaskRowFixture> = {}): TaskRowFixture {
  return {
    id: TASK,
    service_id: "svc-1",
    skill_id: "skill-1",
    status: "working",
    standard_order_id: ORDER,
    standard_payer: payer.address,
    metadata: {},
    completed_at: null,
    version: "3",
    ...overrides,
  };
}

async function signedAuthorization(
  action: string,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const now = Math.floor(Date.now() / 1_000);
  const authorization = {
    orderId: ORDER,
    action,
    method: "POST" as const,
    absoluteResourceUri:
      `https://gateway.example/standard/orders/${ORDER}/actions/${action}`,
    requestHash: canonicalHash(request),
    nonce: `0x${"77".repeat(32)}` as Hex,
    issuedAt: now,
    validBefore: now + 120,
  };
  const signature = await payer.signTypedData({
    domain: { name: "DaskiStandardOrder", version: "1", chainId: CHAIN_ID },
    types: {
      OrderActionAuthorizationV1: [
        { name: "orderIdHash", type: "bytes32" },
        { name: "actionHash", type: "bytes32" },
        { name: "methodHash", type: "bytes32" },
        { name: "absoluteResourceUriHash", type: "bytes32" },
        { name: "requestHash", type: "bytes32" },
        { name: "audienceHash", type: "bytes32" },
        { name: "nonce", type: "bytes32" },
        { name: "issuedAt", type: "uint64" },
        { name: "validBefore", type: "uint64" },
      ],
    },
    primaryType: "OrderActionAuthorizationV1",
    message: {
      orderIdHash: keccak256(stringToHex(ORDER)),
      actionHash: keccak256(stringToHex(action)),
      methodHash: keccak256(stringToHex("POST")),
      absoluteResourceUriHash: keccak256(stringToHex(authorization.absoluteResourceUri)),
      requestHash: canonicalHash(request),
      audienceHash: keccak256(stringToHex("https://gateway.example")),
      nonce: authorization.nonce,
      issuedAt: BigInt(authorization.issuedAt),
      validBefore: BigInt(authorization.validBefore),
    },
  });
  return { ...authorization, signature };
}

async function signedGrant(
  action: string,
  request: Record<string, unknown>,
  authorization: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const now = Math.floor(Date.now() / 1_000);
  const envelope = {
    artifactType: "ProviderLifecycleGrantV1",
    schemaVersion: 1,
    environment: "testnet",
    chainId: CHAIN_ID,
    audience: "https://provider.example",
    signerKeyId: "gateway-lifecycle",
    issuedAt: now,
    validBefore: now + 60,
    payload: {
      orderId: ORDER,
      providerTaskId: TASK,
      action,
      requestHash: canonicalHash(request),
      authorizationHash: canonicalHash(authorization),
      payer: payer.address,
    },
  };
  const signature = await gateway.signMessage({
    message: { raw: unsignedEnvelopeHash(envelope) },
  });
  return { ...envelope, signature };
}

async function performArgs(action: string, request: Record<string, unknown>) {
  const authorization = await signedAuthorization(action, request);
  return {
    orderId: ORDER,
    providerTaskId: TASK,
    action,
    request,
    authorization,
    grant: await signedGrant(action, request, authorization),
    payer: payer.address,
    gatewayAudience: "https://gateway.example",
  } as never;
}

type QueryResponse = { rows: unknown[]; rowCount: number };
const emptyResult: QueryResponse = { rows: [], rowCount: 0 };
type Route = [fragment: string, respond: (values: unknown[]) => QueryResponse];

function routePool(routes: Route[]): void {
  h.query.mockImplementation(async (sql: string, values?: unknown[]) => {
    const route = routes.find(([fragment]) => sql.includes(fragment));
    return route ? route[1](values ?? []) : emptyResult;
  });
}

const clientCalls: Array<{ sql: string; values: unknown[] }> = [];

function routeClients(routes: Route[]): void {
  h.connect.mockImplementation(async () => ({
    query: async (sql: string, values?: unknown[]) => {
      clientCalls.push({ sql, values: values ?? [] });
      const route = routes.find(([fragment]) => sql.includes(fragment));
      if (route) return route[1](values ?? []);
      if (sql.includes("standard_action_nonces") && sql.startsWith("INSERT")) {
        return { rows: [], rowCount: 1 };
      }
      return emptyResult;
    },
    release: () => undefined,
  }));
}

function poolQueries(fragment: string): unknown[][] {
  return h.query.mock.calls
    .filter((call) => String(call[0]).includes(fragment))
    .map((call) => (call[1] ?? []) as unknown[]);
}

function transactionCalls(fragment: string): Array<{ sql: string; values: unknown[] }> {
  return clientCalls.filter(({ sql }) => sql.includes(fragment));
}

// signedResult's one read of the task and its frozen terminal identity.
const FROZEN = "LEFT JOIN standard_terminal_results r";
const frozenRow = (status: string, frozen: boolean) => ({
  rows: [{
    status,
    frozen_state: frozen ? status : null,
    frozen_completed_at: frozen ? new Date() : null,
    frozen_result_hash: frozen ? Buffer.alloc(32, 9) : null,
    frozen_isolated: null,
  }],
  rowCount: 1,
});
const LOAD = "AND standard_payer IS NOT NULL";
const CLAIM = "SET version=version+1,updated_at=now()";
const PERSIST = "SET status=$2,updated_at=now(),version=version+1";

beforeEach(() => {
  for (const mock of Object.values(h)) mock.mockReset();
  clientCalls.length = 0;
  h.getServiceById.mockResolvedValue({ id: "svc-1", adapter_name: "adapter-1" });
  h.fetchStandardTaskResponse.mockResolvedValue({ state: "stable" });
  h.getTransactionById.mockResolvedValue({
    id: TASK, status: "canceled", standard_order_id: ORDER,
    standard_order_key: Buffer.alloc(32, 1),
  });
  routeClients([]);
});

describe("standard lifecycle mutation fencing", () => {
  it("claims the task before adapter.cancel and cancels from the claimed row", async () => {
    // The load-time snapshot predates the fulfillment claim; the claimed
    // row carries the durable supplier_mutation_started flag the adapter
    // must see instead of the stale copy.
    routePool([
      [LOAD, () => ({ rows: [taskRow()], rowCount: 1 })],
      [CLAIM, () => ({
        rows: [taskRow({ metadata: { supplier_mutation_started: true }, version: "4" })],
        rowCount: 1,
      })],
      [FROZEN, () => frozenRow("canceled", true)],
    ]);
    routeClients([[PERSIST, () => ({ rows: [], rowCount: 1 })]]);
    h.adapterCancel.mockResolvedValue(undefined);

    const result = await service.perform(await performArgs("cancel", {})) as {
      state: string;
      terminalAttestation?: unknown;
      signature: Hex;
    };

    expect(result.state).toBe("canceled");
    expect(result.terminalAttestation).toBeDefined();
    expect(result.signature).toMatch(/^0x[0-9a-f]{130}$/);

    const claims = poolQueries(CLAIM);
    expect(claims).toEqual([[TASK, ORDER, "working", "3"]]);
    expect(h.adapterCancel).toHaveBeenCalledTimes(1);
    expect(h.adapterCancel.mock.calls[0]![0]).toMatchObject({
      id: TASK,
      version: "4",
      supplierMutationStarted: true,
    });
    expect(h.query.mock.invocationCallOrder[1]!)
      .toBeLessThan(h.adapterCancel.mock.invocationCallOrder[0]!);

    const persisted = transactionCalls(PERSIST);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.sql).toContain("AND status=$6 AND version=$7");
    expect(persisted[0]!.values[1]).toBe("canceled");
    expect(persisted[0]!.values[5]).toBe("working");
    expect(persisted[0]!.values[6]).toBe("4");
    expect(h.enqueueReputationOutcome).toHaveBeenCalledTimes(1);
    // The cancellation freezes the terminal identity inside its transaction.
    expect(h.freezeTerminalResult).toHaveBeenCalledTimes(1);
  });

  it("refuses the cancel without touching the supplier when the claim is lost", async () => {
    routePool([
      [LOAD, () => ({ rows: [taskRow()], rowCount: 1 })],
      [CLAIM, () => emptyResult],
    ]);

    await expect(service.perform(await performArgs("cancel", {})))
      .rejects.toThrow("Task state changed while authorizing the lifecycle action");
    expect(h.adapterCancel).not.toHaveBeenCalled();
    expect(transactionCalls(PERSIST)).toHaveLength(0);
  });

  it("never overwrites a concurrent terminal state: the fenced persist fails instead", async () => {
    // A worker finalizes the task after the claim but before the terminal
    // write; the conditional update matches nothing and the whole persist
    // rolls back, leaving the worker's terminal state in place.
    routePool([
      [LOAD, () => ({ rows: [taskRow()], rowCount: 1 })],
      [CLAIM, () => ({ rows: [taskRow({ version: "4" })], rowCount: 1 })],
    ]);
    routeClients([[PERSIST, () => emptyResult]]);
    h.adapterCancel.mockResolvedValue(undefined);

    await expect(service.perform(await performArgs("cancel", {})))
      .rejects.toThrow("Standard task state update lost its fence");
    expect(h.enqueueReputationOutcome).not.toHaveBeenCalled();
    const persistTransaction = clientCalls.map(({ sql }) => sql);
    expect(persistTransaction.filter((sql) => sql === "ROLLBACK")).toHaveLength(1);
    expect(clientCalls.some(({ sql }) => sql.includes("standard_dispatch_claims"))).toBe(false);
  });

  it("rejects canceling a terminal task before any claim is attempted", async () => {
    routePool([
      [LOAD, () => ({ rows: [taskRow({ status: "completed" })], rowCount: 1 })],
    ]);

    await expect(service.perform(await performArgs("cancel", {})))
      .rejects.toThrow("Task cannot be canceled from its current state");
    expect(poolQueries(CLAIM)).toHaveLength(0);
    expect(h.adapterCancel).not.toHaveBeenCalled();
  });

  it("claims before adapter.handleInput and persists behind the finalized version", async () => {
    const request = { data: { itemId: "sample-item" }, inputText: "confirm" };
    h.decryptString.mockReturnValue(JSON.stringify({ itemId: "sample-item" }));
    routePool([
      [LOAD, () => ({
        rows: [taskRow({
          status: "input-required",
          metadata: { standard_request_encrypted: "daski:v1:test" },
          version: "5",
        })],
        rowCount: 1,
      })],
      [CLAIM, () => ({
        rows: [taskRow({
          status: "input-required",
          metadata: { standard_request_encrypted: "daski:v1:test" },
          version: "6",
        })],
        rowCount: 1,
      })],
      [FROZEN, () => frozenRow("completed", true)],
    ]);
    routeClients([[PERSIST, () => ({ rows: [], rowCount: 1 })]]);
    h.loadFrozenTerminalProjection.mockResolvedValue({ projection: { state: "stable" }, references: [] });
    h.adapterHandleInput.mockResolvedValue({ status: "completed" });
    h.processAdapterResult.mockResolvedValue({
      status: "completed",
      version: "9",
      completed_at: new Date(),
    });

    const result = await service.perform(await performArgs("input", request)) as {
      state: string;
    };

    expect(result.state).toBe("completed");
    expect(poolQueries(CLAIM)).toEqual([[TASK, ORDER, "input-required", "5"]]);
    expect(h.adapterHandleInput.mock.calls[0]![0]).toMatchObject({ version: "6" });
    expect(h.query.mock.invocationCallOrder[1]!)
      .toBeLessThan(h.adapterHandleInput.mock.invocationCallOrder[0]!);

    const persisted = transactionCalls(PERSIST);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.values[1]).toBe("completed");
    expect(persisted[0]!.values[5]).toBe("completed");
    expect(persisted[0]!.values[6]).toBe("9");
  });
});
