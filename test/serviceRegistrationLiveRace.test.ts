import { describe, expect, it, vi } from "vitest";

const expectedId = `0x${"11".repeat(32)}`;
const h = vi.hoisted(() => ({
  listServices: vi.fn(),
  setOnChainId: vi.fn(),
  readContract: vi.fn(),
  writeContract: vi.fn(),
  signerLease: vi.fn(),
  finalizedBlock: vi.fn(),
}));

vi.mock("../src/core/chain/client.js", () => ({
  CHAIN_MODE_MOCK: false,
  publicClient: { readContract: h.readContract },
  walletClient: { writeContract: h.writeContract },
}));
vi.mock("../src/core/config.js", () => ({
  config: {
    PROVIDER_AGENT_ID: 1n,
    PROVIDER_WALLET_ADDRESS: "0x2222222222222222222222222222222222222222",
    SERVICE_REGISTRY_ADDRESS: "0x3333333333333333333333333333333333333333",
    REGISTRATION_RECONCILE_MAX_AGE_SECONDS: 300,
    BASE_URL: "https://provider.example.test",
  },
}));
vi.mock("../src/core/db/queries/services.js", () => ({
  listActiveServices: h.listServices,
  setServiceOnChainId: h.setOnChainId,
}));
vi.mock("../src/core/events/emitter.js", () => ({ emitEvent: vi.fn() }));
vi.mock("../src/core/chain/signerLease.js", () => ({
  withProviderSignerLease: h.signerLease,
}));
vi.mock("../src/core/chain/providerWriteCoordinator.js", () => ({
  prepareAndBroadcastProviderWrite: vi.fn((args) =>
    h.signerLease(async () => {
      await args.preflight?.();
      return {
        id: "provider-write-1",
        hash: "0xtxhash",
        intentHash: `0x${"33".repeat(32)}`,
        nonce: 7n,
      };
    })),
  confirmProviderWrite: vi.fn(),
  revertProviderWrite: vi.fn(),
  rebroadcastProviderWrite: vi.fn(),
  providerWriteScope: { chainId: 84532, walletAddress: "0x2222222222222222222222222222222222222222" },
}));
vi.mock("../src/core/db/queries/providerChainWrites.js", () => ({
  listOpenProviderWrites: vi.fn(async () => []),
}));
vi.mock("../src/core/chain/finality.js", () => ({
  finalityWaitBudgetMs: () => 84_000,
  finalizedReadBlockNumber: h.finalizedBlock,
  waitForCanonicalFinalReceipt: vi.fn(),
}));

import { reconcileServiceRegistrations } from "../src/core/chain/serviceRegistrar.js";

describe("live service registration replica race", () => {
  it("rechecks under the signer lease and adopts a peer registration", async () => {
    const service = {
      id: "service-1",
      slug: "sample-service",
      version: "1",
      on_chain_id: null,
      service_wallet: null,
    };
    h.listServices.mockResolvedValue([service]);
    h.finalizedBlock.mockResolvedValue(100n);
    h.signerLease.mockImplementation(async (work) => work());
    let existsReads = 0;
    h.readContract.mockImplementation(async ({ functionName }) => {
      if (functionName === "computeServiceId") return expectedId;
      if (functionName === "exists") return ++existsReads > 1;
      if (functionName === "getService") {
        return {
          providerAgentId: 1n,
          serviceId: expectedId,
          serviceSlug: "sample-service",
          version: "1",
          serviceURI: "https://provider.example.test/agent-cards/sample-service.json",
          serviceWallet: "0x0000000000000000000000000000000000000000",
          active: true,
        };
      }
      throw new Error(`unexpected read ${functionName}`);
    });

    await expect(reconcileServiceRegistrations()).resolves.toMatchObject({ registered: 1 });
    expect(existsReads).toBe(2);
    expect(h.writeContract).not.toHaveBeenCalled();
    expect(h.setOnChainId).toHaveBeenCalledWith(
      "service-1",
      Buffer.from(expectedId.slice(2), "hex"),
    );
  });
});
