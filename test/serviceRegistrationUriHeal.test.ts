import { beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionReceiptNotFoundError } from "viem";

// Live-chain path of the registrar (CHAIN_MODE_MOCK=false): an on-chain
// entry whose identity matches but whose discovery URI predates the
// /agent-cards/<slug>.json layout must be healed in place via
// updateServiceURI; any identity/payout drift stays fail-closed.

const h = vi.hoisted(() => ({
  listServices: vi.fn(),
  setOnChainId: vi.fn(),
  readContract: vi.fn(),
  writeContract: vi.fn(),
  lease: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  finalizedBlock: vi.fn(async () => 100n),
  waitReceipt: vi.fn(async () => ({ status: "success" })),
  openWrites: vi.fn(),
  getReceipt: vi.fn(),
  nonceAt: vi.fn(),
  gapPass: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("../src/core/chain/client.js", () => ({
  CHAIN_MODE_MOCK: false,
  publicClient: {
    readContract: h.readContract,
    getTransactionReceipt: h.getReceipt,
    getTransactionCount: h.nonceAt,
  },
  walletClient: { writeContract: h.writeContract },
}));
vi.mock("../src/core/config.js", () => ({
  config: {
    PROVIDER_AGENT_ID: 1n,
    REGISTRATION_RECONCILE_MAX_AGE_SECONDS: 300,
    BASE_URL: "https://provider.example.test",
    SERVICE_REGISTRY_ADDRESS: "0x1234567890123456789012345678901234567890",
  },
}));
vi.mock("../src/core/db/queries/services.js", () => ({
  listActiveServices: h.listServices,
  setServiceOnChainId: h.setOnChainId,
}));
const events = vi.hoisted(() => ({ emitEvent: vi.fn() }));
vi.mock("../src/core/events/emitter.js", () => ({ emitEvent: events.emitEvent }));
vi.mock("../src/core/chain/signerLease.js", () => ({
  withProviderSignerLease: h.lease,
}));
vi.mock("../src/core/chain/providerWriteCoordinator.js", () => ({
  prepareAndBroadcastProviderWrite: vi.fn((args) =>
    h.lease(async () => ({
      id: "provider-write-1",
      hash: await h.writeContract({
        functionName: args.functionName,
        args: args.callArgs,
      }),
      intentHash: `0x${"33".repeat(32)}`,
      nonce: 7n,
    }))),
  confirmProviderWrite: h.confirm,
  revertProviderWrite: vi.fn(),
  rebroadcastProviderWrite: vi.fn(),
  replaceProviderWrite: vi.fn(),
  reconcileProviderNonceGap: h.gapPass,
  providerWriteScope: { chainId: 84532, walletAddress: "0x2222222222222222222222222222222222222222" },
}));
vi.mock("../src/core/db/queries/providerChainWrites.js", () => ({
  listOpenProviderWrites: h.openWrites,
}));
vi.mock("../src/core/chain/finality.js", () => ({
  BASE_BLOCK_TIME_MS: 2_000,
  finalityWaitBudgetMs: () => 84_000,
  finalizedReadBlockNumber: h.finalizedBlock,
  waitForCanonicalFinalReceipt: h.waitReceipt,
}));

import { reconcileServiceRegistrations } from "../src/core/chain/serviceRegistrar.js";

const SERVICE_ID = "0x" + "ab".repeat(32);
const ZERO_WALLET = "0x0000000000000000000000000000000000000000";
const LEGACY_URI = "https://provider.example.test/.well-known/agent-card.json";
const CANONICAL_URI = "https://provider.example.test/agent-cards/sample-secondary.json";

const service = {
  id: "service-1",
  slug: "sample-secondary",
  version: "1",
  service_wallet: null as string | null,
  on_chain_id: null as Buffer | null,
};

function chainEntry(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    providerAgentId: 1n,
    serviceId: SERVICE_ID,
    serviceSlug: "sample-secondary",
    version: "1",
    serviceURI: LEGACY_URI,
    serviceWallet: ZERO_WALLET,
    active: true,
    ...overrides,
  };
}

beforeEach(() => {
  h.listServices.mockReset();
  h.setOnChainId.mockReset();
  h.readContract.mockReset();
  h.writeContract.mockReset();
  h.lease.mockClear();
  service.on_chain_id = null;
  service.service_wallet = null;
  h.listServices.mockImplementation(async () => [service]);
  h.openWrites.mockReset();
  h.openWrites.mockResolvedValue([]);
  h.gapPass.mockReset();
  h.gapPass.mockResolvedValue("clear");
  h.confirm.mockReset();
  h.setOnChainId.mockImplementation(async (_id: string, value: Buffer) => {
    service.on_chain_id = value;
  });
});

function stubChain(entry: () => Record<string, unknown>) {
  h.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
    switch (functionName) {
      case "computeServiceId": return SERVICE_ID;
      case "exists": return true;
      case "getService": return entry();
      default: throw new Error(`unexpected read: ${functionName}`);
    }
  });
}

describe("service registry URI healing (live chain path)", () => {
  it("updates a stale discovery URI in place and verifies the healed entry", async () => {
    let uri = LEGACY_URI;
    stubChain(() => chainEntry({ serviceURI: uri }));
    h.writeContract.mockImplementation(async ({ functionName, args }: {
      functionName: string; args: [string, string];
    }) => {
      expect(functionName).toBe("updateServiceURI");
      expect(args[0]).toBe(SERVICE_ID);
      expect(args[1]).toBe(CANONICAL_URI);
      uri = args[1];
      return "0xtxhash";
    });

    await reconcileServiceRegistrations();

    expect(h.writeContract).toHaveBeenCalledTimes(1);
    expect(h.lease).toHaveBeenCalledTimes(1);
    // The heal's receipt wait is bounded by the finality budget.
    expect(h.waitReceipt).toHaveBeenCalledWith("0xtxhash", { timeoutMs: 84_000 });
    expect(uri).toBe(CANONICAL_URI);
  });

  it("resumes a journaled URI update instead of signing a duplicate", async () => {
    let uri = LEGACY_URI;
    stubChain(() => chainEntry({ serviceURI: uri }));
    const update = { id: "uri-write", status: "broadcast", transaction_hash: "0xuri", nonce: "9" };
    h.openWrites.mockImplementation(async (_scope: unknown, purpose: string) =>
      purpose === "service_uri_update" ? [update] : []);
    h.getReceipt.mockImplementation(async ({ hash }: { hash: `0x${string}` }) => {
      if (uri === LEGACY_URI) throw new TransactionReceiptNotFoundError({ hash });
      return { status: "success", blockNumber: 90n };
    });
    h.nonceAt.mockResolvedValue(9);
    h.gapPass.mockImplementation(async () => {
      // The pending update is mined, after a fee replacement if it needed one.
      uri = CANONICAL_URI;
      return "clear";
    });

    await reconcileServiceRegistrations();

    expect(h.writeContract).not.toHaveBeenCalled();
    expect(h.gapPass).toHaveBeenCalledOnce();
    expect(h.confirm).toHaveBeenCalledWith("uri-write");
  });

  it("leaves an already-canonical entry untouched", async () => {
    stubChain(() => chainEntry({ serviceURI: CANONICAL_URI }));
    await reconcileServiceRegistrations();
    expect(h.writeContract).not.toHaveBeenCalled();
  });

  it("audits a link once when it changes and writes no event for an unchanged verification", async () => {
    stubChain(() => chainEntry({ serviceURI: CANONICAL_URI }));
    events.emitEvent.mockClear();
    await reconcileServiceRegistrations();
    expect(events.emitEvent.mock.calls.map(([event]) => event.type)).toEqual(["chain.service_registered"]);
    expect(events.emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      source: "chain", payload: expect.objectContaining({ onChainId: SERVICE_ID, serviceURI: CANONICAL_URI }),
    }));
    events.emitEvent.mockClear();
    await reconcileServiceRegistrations();
    await reconcileServiceRegistrations();
    expect(events.emitEvent).not.toHaveBeenCalled();
  });

  it("refuses to heal when the payout wallet drifted", async () => {
    stubChain(() => chainEntry({
      serviceWallet: "0x1111111111111111111111111111111111111111",
    }));
    await expect(reconcileServiceRegistrations()).rejects.toThrow(
      /does not match local identity/,
    );
    expect(h.writeContract).not.toHaveBeenCalled();
  });

  it("refuses to heal an inactive entry", async () => {
    stubChain(() => chainEntry({ active: false }));
    await expect(reconcileServiceRegistrations()).rejects.toThrow(
      /does not match local identity/,
    );
    expect(h.writeContract).not.toHaveBeenCalled();
  });
});
