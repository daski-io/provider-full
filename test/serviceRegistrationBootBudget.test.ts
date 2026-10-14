import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionReceiptNotFoundError } from "viem";

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
  getReceipt: vi.fn(),
  finalizedBlock: vi.fn(),
  broadcast: vi.fn(),
  rebroadcast: vi.fn(),
  confirm: vi.fn(),
  revert: vi.fn(),
  openWrites: vi.fn(),
  waitReceipt: vi.fn(),
  logWarn: vi.fn(),
  nonceAt: vi.fn(),
  gapPass: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("../src/core/chain/client.js", () => ({
  CHAIN_MODE_MOCK: false,
  publicClient: {
    readContract: h.readContract,
    getBlockNumber: h.getBlockNumber,
    getTransactionReceipt: h.getReceipt,
    getTransactionCount: h.nonceAt,
  },
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
  rebroadcastProviderWrite: h.rebroadcast,
  confirmProviderWrite: h.confirm,
  revertProviderWrite: h.revert,
  replaceProviderWrite: h.replace,
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
  h.openWrites.mockResolvedValue([]);
  h.gapPass.mockResolvedValue("clear");
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

  /** Registration mined at 105 by a peer; the finalized depth reaches it at `finalAt`. */
  function peerRegisteredChain(finalAt: number | null) {
    const startedAt = Date.now();
    h.finalizedBlock.mockImplementation(async () =>
      finalAt !== null && Date.now() - startedAt >= finalAt ? 106n : 100n);
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
  }

  function readsAt(blockNumber: bigint): string[] {
    return h.readContract.mock.calls
      .map(([args]) => args as { functionName: string; blockNumber: bigint })
      .filter((args) => args.blockNumber === blockNumber)
      .map((args) => args.functionName);
  }

  it("adopts an entry refused as already registered only once it is final", async () => {
    peerRegisteredChain(6_000);
    h.broadcast.mockRejectedValue(alreadyRegisteredRevert());

    const cycle = track(reconcileServiceRegistrations());
    await vi.advanceTimersByTimeAsync(4_000);
    expect(cycle.settled).toBe(false);
    expect(h.setOnChainId).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_000);

    expect(cycle.value).toMatchObject({ registered: 1 });
    expect(h.setOnChainId).toHaveBeenCalledWith(
      "service-0",
      Buffer.from(serviceId("sample-alpha").slice(2), "hex"),
    );
    // The latest block only shows the entry exists; identity is verified at
    // the finalized depth, as for this provider's own registrations.
    expect(readsAt(111n)).toEqual(["exists"]);
    expect(readsAt(106n)).toEqual(["exists", "getService"]);
    expect(getServiceRegistrationHealth()).toMatchObject({ ok: true, error: null });
  });

  it("fails explicitly when an adopted entry never reaches finality", async () => {
    peerRegisteredChain(null);
    h.broadcast.mockRejectedValue(alreadyRegisteredRevert());

    const cycle = track(reconcileServiceRegistrations());
    await vi.advanceTimersByTimeAsync(84_000 + 2_000);
    expect(cycle.error?.message).toMatch(/did not reach finality within 84000ms/);
    expect(h.setOnChainId).not.toHaveBeenCalled();
    expect(readsAt(111n)).toEqual(["exists"]);
    expect(getServiceRegistrationHealth()).toMatchObject({ ok: false });
  });

  it("adopts a peer's registration after this replica's duplicate reverts on chain", async () => {
    peerRegisteredChain(0);
    h.finalizedBlock.mockResolvedValueOnce(100n).mockResolvedValueOnce(100n);
    h.broadcast.mockImplementation(async (write: { preflight?: () => Promise<void> }) => {
      await write.preflight?.();
      return { id: "duplicate-write", hash: `0x${"bb".repeat(32)}` };
    });
    h.waitReceipt.mockResolvedValue({ status: "reverted" });

    await expect(reconcileServiceRegistrations()).resolves.toMatchObject({ registered: 1 });
    expect(h.revert).toHaveBeenCalledWith("duplicate-write", "canonical_receipt_reverted");
    expect(h.confirm).not.toHaveBeenCalled();
    expect(readsAt(106n)).toEqual(["exists", "getService"]);
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

describe("journaled registration writes", () => {
  const pendingHash = `0x${"cc".repeat(32)}` as const;
  const journaled = (status: string, id = "journaled-write", hash: string = pendingHash) =>
    ({ id, status, transaction_hash: hash, nonce: "7" });
  const notFound = (hash: string) =>
    new TransactionReceiptNotFoundError({ hash: hash as `0x${string}` });

  /** A journal holding `rows` for registrations; settled rows leave it. */
  function journal(rows: Array<ReturnType<typeof journaled>>) {
    let open = rows;
    const close = async (id: string) => { open = open.filter((row) => row.id !== id); };
    h.openWrites.mockImplementation(async (_scope: unknown, purpose: string) =>
      purpose === "service_registration" ? open : []);
    h.confirm.mockImplementation(close);
    h.revert.mockImplementation(close);
    h.replace.mockImplementation(close);
  }

  /** The registry holds the service once `mined()` says so. */
  function chainOnceMined(mined: () => boolean) {
    h.readContract.mockImplementation(async ({ functionName, args }: {
      functionName: string; args: unknown[];
    }) => {
      if (functionName === "computeServiceId") return serviceId("sample-alpha");
      if (functionName === "exists") return mined();
      if (functionName === "getService") return record(args[0] as string);
      throw new Error(`unexpected read ${functionName}`);
    });
  }

  beforeEach(() => {
    h.listServices.mockImplementation(async () => services().slice(0, 1));
    // The wallet's finalized nonce: the journaled nonce 7 is still unused.
    h.nonceAt.mockResolvedValue(7);
  });

  it("resumes a pending registration write instead of signing another", async () => {
    let mined = false;
    chainOnceMined(() => mined);
    journal([journaled("broadcast")]);
    h.getReceipt.mockImplementation(async ({ hash }: { hash: string }) => {
      if (!mined) throw notFound(hash);
      return { status: "success", blockNumber: 90n };
    });
    h.gapPass.mockImplementation(async () => {
      mined = true;
      return "clear";
    });

    await expect(reconcileServiceRegistrations()).resolves.toMatchObject({ registered: 1 });
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.rebroadcast).not.toHaveBeenCalled();
    expect(h.confirm).toHaveBeenCalledWith("journaled-write");
    expect(h.openWrites).toHaveBeenCalledWith(
      expect.anything(),
      "service_registration",
      { type: "service", id: "service-0" },
    );
  });

  it("resends a write that never reached the network with its original signed bytes", async () => {
    let mined = false;
    chainOnceMined(() => mined);
    journal([journaled("prepared")]);
    h.getReceipt.mockImplementation(async ({ hash }: { hash: string }) => {
      if (!mined) throw notFound(hash);
      return { status: "success", blockNumber: 90n };
    });
    h.rebroadcast.mockImplementation(async () => { mined = true; });

    await expect(reconcileServiceRegistrations()).resolves.toMatchObject({ registered: 1 });
    expect(h.rebroadcast).toHaveBeenCalledWith("journaled-write");
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("fee-replaces a stuck registration from the boot cycle instead of waiting on it forever", async () => {
    // The write never mines (underpriced or dropped), and boot runs before
    // the provider-write reconciler starts.
    let mined = false;
    chainOnceMined(() => mined);
    journal([journaled("broadcast")]);
    h.getReceipt.mockImplementation(async ({ hash }: { hash: string }) => {
      throw notFound(hash);
    });
    h.gapPass.mockImplementation(async () => {
      // The same-nonce fee replacement is mined.
      mined = true;
      return "replacement_broadcast";
    });

    await expect(reconcileServiceRegistrations()).resolves.toMatchObject({ registered: 1 });
    expect(h.gapPass).toHaveBeenCalledOnce();
    expect(h.waitReceipt).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it("replaces a write whose nonce another transaction used, then registers anew", async () => {
    let registered = false;
    chainOnceMined(() => registered);
    journal([journaled("prepared")]);
    h.getReceipt.mockImplementation(async ({ hash }: { hash: string }) => {
      throw notFound(hash);
    });
    // The identity helper, sharing the wallet, used nonce 7 at finalized depth.
    h.nonceAt.mockResolvedValue(8);
    h.broadcast.mockImplementation(async () => {
      registered = true;
      return { id: "fresh-write", hash: `0x${"aa".repeat(32)}` };
    });
    h.waitReceipt.mockResolvedValue({ status: "success" });

    await expect(reconcileServiceRegistrations()).resolves.toMatchObject({ registered: 1 });
    expect(h.replace).toHaveBeenCalledWith("journaled-write", null, "nonce_consumed");
    expect(h.rebroadcast).not.toHaveBeenCalled();
    expect(h.broadcast).toHaveBeenCalledOnce();
    expect(h.confirm).toHaveBeenCalledWith("fresh-write");
  });

  it("resumes a registration another registrar journaled while it waited for the signer lease", async () => {
    let mined = false;
    chainOnceMined(() => mined);
    let calls = 0;
    const peer = journaled("broadcast", "peer-write", `0x${"dd".repeat(32)}`);
    h.openWrites.mockImplementation(async (_scope: unknown, purpose: string) => {
      if (purpose !== "service_registration") return [];
      calls += 1;
      // Empty at settlement and before signing; the peer's write is
      // journaled by the time the signer lease is held.
      return calls <= 2 || mined ? [] : [peer];
    });
    h.getReceipt.mockImplementation(async ({ hash }: { hash: string }) => {
      if (!mined) throw notFound(hash);
      return { status: "success", blockNumber: 90n };
    });
    const signed: string[] = [];
    h.broadcast.mockImplementation(async (write: {
      callArgs: unknown[]; preflight?: () => Promise<void>;
    }) => {
      await write.preflight?.();
      signed.push(write.callArgs[1] as string);
      return { id: "duplicate", hash: `0x${"aa".repeat(32)}` };
    });
    h.gapPass.mockImplementation(async () => {
      mined = true;
      return "clear";
    });

    await expect(reconcileServiceRegistrations()).resolves.toMatchObject({ registered: 1 });
    expect(signed).toEqual([]);
    expect(h.gapPass).toHaveBeenCalledOnce();
  });

  it("leaves a write under nonce review to its review instead of signing over it", async () => {
    journal([journaled("attention")]);
    await expect(reconcileServiceRegistrations()).rejects.toThrow(/awaits review of its blocked nonce/);
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.waitReceipt).not.toHaveBeenCalled();
  });

  it("settles journaled writes whose receipts are final once the service exists", async () => {
    chainOnceMined(() => true);
    journal([
      journaled("broadcast", "mined-write", `0x${"01".repeat(32)}`),
      journaled("broadcast", "reverted-duplicate", `0x${"02".repeat(32)}`),
      journaled("broadcast", "not-final", `0x${"03".repeat(32)}`),
      journaled("broadcast", "still-pending", `0x${"04".repeat(32)}`),
    ]);
    h.getReceipt.mockImplementation(async ({ hash }: { hash: string }) => {
      if (hash === `0x${"01".repeat(32)}`) return { status: "success", blockNumber: 90n };
      if (hash === `0x${"02".repeat(32)}`) return { status: "reverted", blockNumber: 95n };
      if (hash === `0x${"03".repeat(32)}`) return { status: "success", blockNumber: 105n };
      throw new Error("RPC unavailable");
    });

    await expect(reconcileServiceRegistrations()).resolves.toMatchObject({ registered: 1 });
    expect(h.confirm.mock.calls).toEqual([["mined-write"]]);
    expect(h.revert.mock.calls).toEqual([["reverted-duplicate", "canonical_receipt_reverted"]]);
    // A receipt that cannot be read says nothing about the nonce.
    expect(h.replace).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it("never persists or broadcasts a registration signed after its cycle was abandoned", async () => {
    let releaseSigning!: () => void;
    const sent: string[] = [];
    h.broadcast.mockImplementation(async (write: {
      callArgs: unknown[];
      preflight?: () => Promise<void>;
      persist: () => Promise<boolean | void>;
    }) => {
      await write.preflight?.();
      // Nonce reads, gas estimation and signing outlast the budget.
      await new Promise<void>((resolve) => { releaseSigning = resolve; });
      if (await write.persist() === false) {
        throw new Error("Provider write lost its domain-state persistence claim");
      }
      sent.push(write.callArgs[1] as string);
      return { id: "write", hash: `0x${"aa".repeat(32)}` };
    });

    const abandoned = track(reconcileServiceRegistrations());
    await vi.advanceTimersByTimeAsync(45_000);
    expect(abandoned.error?.message).toMatch(/exceeded 45000ms/);
    releaseSigning();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([]);
    expect(h.waitReceipt).not.toHaveBeenCalled();
    expect(h.setOnChainId).not.toHaveBeenCalled();
  });
});
