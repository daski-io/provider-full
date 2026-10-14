import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A first boot registers every service on the ServiceRegistry, and each
// receipt waits CHAIN_WRITE_FINALITY_CONFIRMATIONS blocks. Raced against a
// fixed 45-second deadline, several first-time registrations could never
// finish and boot failed while a detached continuation registered them
// anyway. The deadline now pauses while a broadcast is awaited: 45 seconds
// bound the reads, the lease and the local writes, every receipt wait is
// bounded on its own, and a failure is still an explicit unhealthy verdict.

const h = vi.hoisted(() => ({
  listServices: vi.fn(),
  setOnChainId: vi.fn(),
  readContract: vi.fn(),
  getBlockNumber: vi.fn(),
  finalizedBlock: vi.fn(),
  broadcast: vi.fn(),
  waitReceipt: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("../src/core/chain/client.js", () => ({
  CHAIN_MODE_MOCK: false,
  publicClient: { readContract: h.readContract, getBlockNumber: h.getBlockNumber },
  walletClient: {},
}));
vi.mock("../src/core/config.js", () => ({
  config: {
    PROVIDER_AGENT_ID: 1n,
    SERVICE_REGISTRY_ADDRESS: "0x3333333333333333333333333333333333333333",
    REGISTRATION_RECONCILE_MAX_AGE_SECONDS: 300,
    CHAIN_WRITE_FINALITY_CONFIRMATIONS: 12,
    BASE_URL: "https://provider.example.test",
  },
}));
vi.mock("../src/core/db/queries/services.js", () => ({
  listActiveServices: h.listServices,
  setServiceOnChainId: h.setOnChainId,
}));
vi.mock("../src/core/events/emitter.js", () => ({ emitEvent: vi.fn(async () => undefined) }));
vi.mock("../src/core/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: h.logWarn,
  logError: vi.fn(),
}));
vi.mock("../src/core/chain/providerWriteCoordinator.js", () => ({
  prepareAndBroadcastProviderWrite: h.broadcast,
  confirmProviderWrite: vi.fn(),
  revertProviderWrite: vi.fn(),
}));
vi.mock("../src/core/chain/finality.js", () => ({
  finalityWaitBudgetMs: () => 84_000,
  finalizedReadBlockNumber: h.finalizedBlock,
  waitForCanonicalFinalReceipt: h.waitReceipt,
}));

import {
  getServiceRegistrationHealth,
  reconcileServiceRegistrations,
} from "../src/core/chain/serviceRegistrar.js";
import { RegistrationCycleBudget } from "../src/core/chain/registrationCycleBudget.js";
import { isServiceAlreadyRegisteredRevert } from "../src/core/chain/registrationReverts.js";
import { enforceInitialChainReadiness } from "../src/core/startupChainGate.js";

const RECEIPT_WAIT_MS = 30_000;
const slugs = ["sample-alpha", "sample-beta", "sample-gamma"];
const serviceId = (slug: string) => `0x${slugs.indexOf(slug).toString().repeat(64)}`;
const ZERO = "0x0000000000000000000000000000000000000000";

function services() {
  return slugs.map((slug, index) => ({
    id: `service-${index}`,
    slug,
    version: "1",
    service_wallet: null,
    on_chain_id: null as Buffer | null,
  }));
}

function record(id: string) {
  const slug = slugs[Number(id[2])]!;
  return {
    providerAgentId: 1n,
    serviceId: id,
    serviceSlug: slug,
    version: "1",
    serviceURI: `https://provider.example.test/agent-cards/${slug}.json`,
    serviceWallet: ZERO,
    active: true,
  };
}

/** An unregistered chain: every id is absent until its receipt lands. */
function unregisteredChain() {
  const registered = new Set<string>();
  h.readContract.mockImplementation(async ({ functionName, args }: {
    functionName: string; args: unknown[];
  }) => {
    switch (functionName) {
      case "computeServiceId": return serviceId(args[1] as string);
      case "exists": return registered.has(args[0] as string);
      case "getService": return record(args[0] as string);
      default: throw new Error(`unexpected read ${functionName}`);
    }
  });
  h.broadcast.mockImplementation(async (write: { callArgs: unknown[] }) => {
    registered.add(serviceId(write.callArgs[1] as string));
    return { id: "write", hash: `0x${"aa".repeat(32)}` };
  });
  h.waitReceipt.mockImplementation(() => new Promise((resolve) => {
    setTimeout(() => resolve({ status: "success" }), RECEIPT_WAIT_MS);
  }));
}

function track<T>(promise: Promise<T>) {
  const outcome: { settled: boolean; value?: T; error?: Error } = { settled: false };
  promise.then(
    (value) => { outcome.settled = true; outcome.value = value; },
    (error: Error) => { outcome.settled = true; outcome.error = error; },
  );
  return outcome;
}

function startupGate() {
  return enforceInitialChainReadiness({
    verifyChainTrust: async () => undefined,
    verifyIdentity: async () => true,
    markIdentityVerified: () => undefined,
    reconcileRegistrations: reconcileServiceRegistrations,
    registrationHealth: getServiceRegistrationHealth,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-14T20:00:00.000Z"));
  for (const mock of Object.values(h)) mock.mockReset();
  h.listServices.mockImplementation(async () => services());
  h.setOnChainId.mockResolvedValue(undefined);
  h.finalizedBlock.mockResolvedValue(100n);
  h.getBlockNumber.mockResolvedValue(111n);
  unregisteredChain();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("first-time registration budget", () => {
  it("lets the startup gate pass three registrations whose receipt waits exceed 45 seconds together", async () => {
    const gate = track(startupGate());

    await vi.advanceTimersByTimeAsync(50_000);
    expect(gate.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(slugs.length * RECEIPT_WAIT_MS - 50_000);
    expect(gate.error).toBeUndefined();
    expect(gate.value).toMatchObject({ reconciliation: { registered: 3, already_on_chain: 0 } });
    expect(h.broadcast).toHaveBeenCalledTimes(3);
    // Each receipt wait is bounded by the finality budget, never open-ended.
    expect(h.waitReceipt).toHaveBeenCalledWith(expect.any(String), { timeoutMs: 84_000 });
    expect(h.setOnChainId).toHaveBeenCalledTimes(3);
    expect(getServiceRegistrationHealth()).toMatchObject({ ok: true, error: null });
  });

  it("charges reads after a receipt against the same 45 seconds and fails the gate explicitly", async () => {
    let receiptLanded = false;
    h.waitReceipt.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => {
        receiptLanded = true;
        resolve({ status: "success" });
      }, RECEIPT_WAIT_MS);
    }));
    h.finalizedBlock.mockImplementation(() =>
      receiptLanded ? new Promise<bigint>(() => undefined) : Promise.resolve(100n));

    const gate = track(startupGate());
    await vi.advanceTimersByTimeAsync(RECEIPT_WAIT_MS + 45_000 - 1);
    expect(gate.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(gate.error?.message).toMatch(/exceeded 45000ms/);
    expect(getServiceRegistrationHealth()).toMatchObject({
      ok: false,
      error: expect.stringContaining("exceeded 45000ms"),
    });
  });

  it("keeps the 45-second cap for a cycle that broadcasts nothing and frees the slot", async () => {
    h.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === "computeServiceId") return serviceId("sample-alpha");
      if (functionName === "exists") return true;
      return new Promise(() => undefined); // getService hangs
    });

    const hung = track(reconcileServiceRegistrations());
    await vi.advanceTimersByTimeAsync(45_000 - 1);
    expect(hung.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(hung.error?.message).toMatch(/exceeded 45000ms/);
    expect(h.broadcast).not.toHaveBeenCalled();

    unregisteredChain();
    const next = track(reconcileServiceRegistrations());
    await vi.advanceTimersByTimeAsync(slugs.length * RECEIPT_WAIT_MS);
    expect(next.value).toMatchObject({ registered: 3 });
    expect(getServiceRegistrationHealth()).toMatchObject({ ok: true });
  });

  it("never broadcasts from a cycle its budget abandoned", async () => {
    let releaseExists!: (value: boolean) => void;
    h.readContract.mockImplementation(async ({ functionName, args }: {
      functionName: string; args: unknown[];
    }) => {
      if (functionName === "computeServiceId") return serviceId(args[1] as string);
      if (functionName === "exists") {
        return new Promise<boolean>((resolve) => { releaseExists = resolve; });
      }
      throw new Error(`unexpected read ${functionName}`);
    });
    const sent: string[] = [];
    h.broadcast.mockImplementation(async (write: {
      callArgs: unknown[]; preflight?: () => Promise<void>;
    }) => {
      await write.preflight?.();
      sent.push(write.callArgs[1] as string);
      return { id: "write", hash: `0x${"aa".repeat(32)}` };
    });

    const abandoned = track(reconcileServiceRegistrations());
    await vi.advanceTimersByTimeAsync(45_000);
    expect(abandoned.error?.message).toMatch(/exceeded 45000ms/);

    // The hung read answers late; the detached work reaches the signer lease
    // and refuses to send.
    releaseExists(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.broadcast).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
    expect(h.setOnChainId).not.toHaveBeenCalled();
  });

  it("never lets an abandoned cycle's late success overwrite a newer failure", async () => {
    let releaseServices!: (rows: unknown[]) => void;
    h.listServices.mockImplementationOnce(
      () => new Promise<unknown[]>((resolve) => { releaseServices = resolve; }),
    );
    const abandoned = track(reconcileServiceRegistrations());
    await vi.advanceTimersByTimeAsync(45_000);
    expect(abandoned.error?.message).toMatch(/exceeded/);

    h.readContract.mockRejectedValue(new Error("ServiceRegistry read refused"));
    await expect(reconcileServiceRegistrations()).rejects.toThrow("ServiceRegistry read refused");
    expect(getServiceRegistrationHealth()).toMatchObject({ ok: false });

    // The first cycle's listing finally answers; it must stop, not report ok.
    unregisteredChain();
    releaseServices(services());
    await vi.advanceTimersByTimeAsync(slugs.length * RECEIPT_WAIT_MS);
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(getServiceRegistrationHealth()).toMatchObject({
      ok: false,
      error: expect.stringContaining("ServiceRegistry read refused"),
    });
  });
});

/** viem's shape for a gas-estimation revert of a duplicate registration. */
function alreadyRegisteredRevert(): Error {
  const reverted = Object.assign(
    new Error("Execution reverted with reason: service already registered."),
    { name: "ExecutionRevertedError" },
  );
  const estimate = Object.assign(new Error("Estimate gas failed."), {
    name: "EstimateGasExecutionError",
    shortMessage: "Execution reverted with reason: service already registered.",
    cause: reverted,
  });
  return Object.assign(new Error("Execution reverted with reason: service already registered."), {
    name: "TransactionExecutionError",
    cause: estimate,
  });
}

describe("adopting a registration the chain already has", () => {
  beforeEach(() => {
    h.listServices.mockImplementation(async () => services().slice(0, 1));
  });

  it("adopts an entry visible at the latest block when the broadcast reverts as already registered", async () => {
    // Mined at 105: invisible at the finalized depth (100), visible at latest (111).
    h.readContract.mockImplementation(async ({ functionName, args, blockNumber }: {
      functionName: string; args: unknown[]; blockNumber: bigint;
    }) => {
      const visible = blockNumber >= 105n;
      switch (functionName) {
        case "computeServiceId": return serviceId("sample-alpha");
        case "exists": return visible;
        case "getService":
          if (!visible) throw new Error("read before the registration was visible");
          return record(args[0] as string);
        default: throw new Error(`unexpected read ${functionName}`);
      }
    });
    h.broadcast.mockRejectedValue(alreadyRegisteredRevert());

    await expect(reconcileServiceRegistrations()).resolves.toMatchObject({ registered: 1 });
    expect(h.setOnChainId).toHaveBeenCalledWith(
      "service-0",
      Buffer.from(serviceId("sample-alpha").slice(2), "hex"),
    );
    const latestReads = h.readContract.mock.calls
      .map(([args]) => args as { functionName: string; blockNumber: bigint })
      .filter((args) => args.blockNumber === 111n)
      .map((args) => args.functionName);
    expect(latestReads).toEqual(["exists", "getService"]);
    expect(getServiceRegistrationHealth()).toMatchObject({ ok: true, error: null });
  });

  it("propagates the revert when the latest block does not hold the registration either", async () => {
    h.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === "computeServiceId") return serviceId("sample-alpha");
      if (functionName === "exists") return false;
      throw new Error(`unexpected read ${functionName}`);
    });
    h.broadcast.mockRejectedValue(alreadyRegisteredRevert());

    await expect(reconcileServiceRegistrations()).rejects.toThrow(/service already registered/);
    expect(h.setOnChainId).not.toHaveBeenCalled();
    expect(getServiceRegistrationHealth()).toMatchObject({ ok: false });
  });

  it("does not re-read the chain for any other broadcast failure", async () => {
    h.broadcast.mockRejectedValue(Object.assign(new Error("insufficient funds for gas"), {
      name: "TransactionExecutionError",
    }));
    await expect(reconcileServiceRegistrations()).rejects.toThrow("insufficient funds");
    expect(h.getBlockNumber).not.toHaveBeenCalled();
  });

  it("recognises the duplicate-id reason anywhere in the cause chain", () => {
    expect(isServiceAlreadyRegisteredRevert(alreadyRegisteredRevert())).toBe(true);
    expect(isServiceAlreadyRegisteredRevert(Object.assign(new Error("reverted"), {
      name: "ContractFunctionRevertedError",
      reason: "service already registered",
    }))).toBe(true);
    expect(isServiceAlreadyRegisteredRevert(new Error("nonce too low"))).toBe(false);
    expect(isServiceAlreadyRegisteredRevert(null)).toBe(false);
    const loop: { message: string; cause?: unknown } = { message: "loop" };
    loop.cause = loop;
    expect(isServiceAlreadyRegisteredRevert(loop)).toBe(false);
  });
});

describe("RegistrationCycleBudget", () => {
  function budget(totalMs: number) {
    let expiredCount = 0;
    const instance = new RegistrationCycleBudget(totalMs, () => { expiredCount += 1; });
    const outcome = track(instance.expired);
    return { instance, outcome, expired: () => expiredCount };
  }

  it("pauses while a broadcast is awaited and resumes with the remaining time", async () => {
    const { instance, outcome } = budget(10_000);
    await vi.advanceTimersByTimeAsync(4_000);
    const wait = instance.awaitBroadcast(() => new Promise<string>((resolve) => {
      setTimeout(() => resolve("receipt"), 30_000);
    }));
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(wait).resolves.toBe("receipt");
    expect(outcome.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(5_999);
    expect(outcome.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome.error?.message).toMatch(/exceeded 10000ms/);
  });

  it("resumes only when every overlapping wait has settled, and never expires once cancelled", async () => {
    const { instance, outcome, expired } = budget(10_000);
    const first = instance.awaitBroadcast(() => new Promise<void>((resolve) => {
      setTimeout(resolve, 20_000);
    }));
    const second = instance.awaitBroadcast(() => new Promise<void>((resolve) => {
      setTimeout(resolve, 40_000);
    }));
    await vi.advanceTimersByTimeAsync(40_000);
    await Promise.all([first, second]);
    expect(outcome.settled).toBe(false);
    instance.cancel();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(outcome.settled).toBe(false);
    expect(expired()).toBe(0);
  });
});
