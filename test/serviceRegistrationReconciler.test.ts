import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  listServices: vi.fn(),
  setOnChainId: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("../src/core/chain/client.js", () => ({
  CHAIN_MODE_MOCK: true,
  publicClient: {},
  walletClient: {},
}));
vi.mock("../src/core/config.js", () => ({
  config: {
    PROVIDER_AGENT_ID: 1n,
    REGISTRATION_RECONCILE_MAX_AGE_SECONDS: 10,
    BASE_URL: "https://provider.example.test",
  },
}));
vi.mock("../src/core/db/queries/services.js", () => ({
  listActiveServices: h.listServices,
  setServiceOnChainId: h.setOnChainId,
}));
vi.mock("../src/core/events/emitter.js", () => ({ emitEvent: vi.fn() }));
vi.mock("../src/core/chain/signerLease.js", () => ({ withProviderSignerLease: vi.fn() }));
vi.mock("../src/core/chain/providerWriteCoordinator.js", () => ({
  prepareAndBroadcastProviderWrite: vi.fn(),
  confirmProviderWrite: vi.fn(),
  revertProviderWrite: vi.fn(),
}));
vi.mock("../src/core/chain/finality.js", () => ({
  finalizedReadBlockNumber: vi.fn(),
  waitForCanonicalFinalReceipt: vi.fn(),
}));
vi.mock("../src/core/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: h.logWarn,
  logError: vi.fn(),
}));

import { getRegistrationObservations } from "../src/core/chain/registrationObservability.js";
import {
  getServiceRegistrationAuthorization,
  getServiceRegistrationHealth,
  reconcileServiceRegistrations,
  startServiceRegistrationReconciler,
  stopServiceRegistrationReconciler,
} from "../src/core/chain/serviceRegistrar.js";

const service = {
  id: "service-1",
  slug: "sample-service",
  version: "1",
  on_chain_id: null as Buffer | null,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
  service.on_chain_id = null;
  h.listServices.mockReset();
  h.setOnChainId.mockReset();
  h.logWarn.mockReset();
  h.listServices.mockImplementation(async () => {
    await Promise.resolve();
    return [service];
  });
  h.setOnChainId.mockImplementation(async (_id: string, value: Buffer) => {
    service.on_chain_id = value;
  });
});

afterEach(() => {
  stopServiceRegistrationReconciler();
  vi.useRealTimers();
});

describe("service registration reconciliation", () => {
  it("coalesces concurrent replica-local attempts around one reconciliation", async () => {
    await Promise.all([reconcileServiceRegistrations(), reconcileServiceRegistrations()]);
    expect(h.listServices).toHaveBeenCalledTimes(1);
    expect(getServiceRegistrationAuthorization(service as never).ok).toBe(true);
  });

  it("applies freshness to mock registrations and refreshes them continuously", async () => {
    await reconcileServiceRegistrations();
    vi.setSystemTime(new Date("2026-07-10T12:00:11.000Z"));
    expect(getServiceRegistrationAuthorization(service as never)).toMatchObject({
      ok: false,
      reason: "service registration verification is stale",
    });

    startServiceRegistrationReconciler(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getServiceRegistrationAuthorization(service as never).ok).toBe(true);
  });

  it("invalidates authorization immediately when the payout destination changes", async () => {
    await reconcileServiceRegistrations();
    const changed = {
      ...service,
      service_wallet: "0x1111111111111111111111111111111111111111",
    };
    expect(getServiceRegistrationAuthorization(changed as never)).toMatchObject({
      ok: false,
      reason: "service payout destination changed after verification",
    });
  });

  // A hung cycle used to freeze reconciliationInFlight forever: every later
  // tick returned the same pending promise, checkedAt went stale, and both
  // readiness and paid-skill authorization failed closed with no log output
  // and no recovery short of a restart (observed live on v0.6.2, 2026-07-16).
  it("times out a hung cycle, records the failure, and frees the slot", async () => {
    let releaseFirst!: (rows: unknown[]) => void;
    h.listServices.mockImplementationOnce(
      () => new Promise<unknown[]>((resolve) => { releaseFirst = resolve; }),
    );
    const first = reconcileServiceRegistrations();
    const firstOutcome = expect(first).rejects.toThrow(/exceeded 45000ms/);
    await vi.advanceTimersByTimeAsync(45_000);
    await firstOutcome;
    expect(getServiceRegistrationHealth()).toMatchObject({
      ok: false,
      error: expect.stringContaining("exceeded 45000ms"),
    });
    expect(h.logWarn).toHaveBeenCalledWith(
      "Service registration reconcile failed",
      expect.objectContaining({ error: expect.stringContaining("exceeded") }),
    );

    // The in-flight slot is free: the next cycle runs for real and recovers.
    await reconcileServiceRegistrations();
    expect(getServiceRegistrationHealth()).toMatchObject({ ok: true });
    expect(getServiceRegistrationAuthorization(service as never).ok).toBe(true);
    releaseFirst([]);
  });

  it("logs a cycle that starts failing once, never each unchanged failure, and its recovery", async () => {
    h.listServices.mockRejectedValueOnce(new Error("pg connection refused"));
    await expect(reconcileServiceRegistrations()).rejects.toThrow("pg connection refused");
    expect(getServiceRegistrationHealth()).toMatchObject({
      ok: false,
      error: expect.stringContaining("pg connection refused"),
    });
    expect(h.logWarn).toHaveBeenCalledWith(
      "Service registration reconcile failed",
      expect.objectContaining({ error: expect.stringContaining("pg connection refused") }),
    );
    h.listServices.mockRejectedValueOnce(new Error("pg connection refused"));
    await expect(reconcileServiceRegistrations()).rejects.toThrow("pg connection refused");
    expect(h.logWarn.mock.calls.filter(([message]) => message === "Service registration reconcile failed"))
      .toHaveLength(1);
    // Health still reflects every cycle; only the log is a transition.
    await reconcileServiceRegistrations();
    expect(getServiceRegistrationHealth()).toMatchObject({ ok: true });
    expect(getRegistrationObservations()).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "cycle", error: null }),
    ]));
  });

  it("a superseded cycle's late failure cannot overwrite newer health", async () => {
    let rejectFirst!: (err: Error) => void;
    h.listServices.mockImplementationOnce(
      () => new Promise<unknown[]>((_, reject) => { rejectFirst = reject; }),
    );
    const first = reconcileServiceRegistrations();
    const firstOutcome = expect(first).rejects.toThrow(/exceeded/);
    await vi.advanceTimersByTimeAsync(45_000);
    await firstOutcome;

    await reconcileServiceRegistrations();
    expect(getServiceRegistrationHealth()).toMatchObject({ ok: true });

    rejectFirst(new Error("zombie cycle failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(getServiceRegistrationHealth()).toMatchObject({ ok: true });
    expect(h.logWarn).toHaveBeenCalledWith(
      "Timed-out service registration reconcile eventually failed",
      expect.objectContaining({ error: expect.stringContaining("zombie cycle failure") }),
    );
  });
});
