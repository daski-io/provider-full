import { beforeEach, describe, expect, it, vi } from "vitest";

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
}));

vi.mock("../src/core/chain/client.js", () => ({
  CHAIN_MODE_MOCK: false,
  publicClient: { readContract: h.readContract },
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
vi.mock("../src/core/events/emitter.js", () => ({ emitEvent: vi.fn() }));
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
  confirmProviderWrite: vi.fn(),
  revertProviderWrite: vi.fn(),
}));
vi.mock("../src/core/chain/finality.js", () => ({
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

  it("leaves an already-canonical entry untouched", async () => {
    stubChain(() => chainEntry({ serviceURI: CANONICAL_URI }));
    await reconcileServiceRegistrations();
    expect(h.writeContract).not.toHaveBeenCalled();
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
