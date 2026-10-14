import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import type {
  FakeChain,
  FakeGateway,
  FakeWriteCoordinator,
} from "./gatewayRegistrationHarness.js";

// The read-only `--check-only` forecast: the same reads and recovery decision
// as a registration run, and no signature, chain write, gateway mutation or
// database write. The database side is enforced, not just observed: the
// forecast runs on sessions that refuse every write.

const h = vi.hoisted(() => ({
  db: null as import("pg").Pool | null,
  chain: null as FakeChain | null,
  coordinator: null as FakeWriteCoordinator | null,
  coordinatorCalls: [] as string[],
}));

vi.mock("../src/core/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/config.js")>();
  return {
    ...actual,
    config: {
      ...actual.config,
      BASE_URL: "https://provider.example",
      PROVIDER_AGENT_ID: 42n,
      CHAIN_ID: 84532,
      SERVICE_REGISTRY_ADDRESS: "0x3333333333333333333333333333333333333333",
      IDENTITY_REGISTRY_ADDRESS: "0x4444444444444444444444444444444444444444",
      USDC_ADDRESS: "0x6666666666666666666666666666666666666666",
      CHAIN_WRITE_FINALITY_CONFIRMATIONS: 12,
    },
  };
});
vi.mock("../src/core/db/pool.js", () => ({
  pool: {
    query: (...args: unknown[]) => (h.db as unknown as { query: (...a: unknown[]) => unknown }).query(...args),
    connect: () => h.db!.connect(),
  },
}));
vi.mock("../src/core/chain/client.js", async () => {
  const { privateKeyToAccount } = await import("viem/accounts");
  return {
    CHAIN_MODE_MOCK: false,
    walletClient: {},
    providerAddress: privateKeyToAccount(`0x${"1".repeat(64)}`).address,
    publicClient: new Proxy({}, {
      get: (_target, key) => (...args: unknown[]) =>
        (h.chain as unknown as Record<string, (...a: unknown[]) => unknown>)[key as string]!(...args),
    }),
  };
});
vi.mock("../src/core/chain/providerWriteCoordinator.js", () => {
  const call = (name: string, run: () => unknown) => {
    h.coordinatorCalls.push(name);
    return run();
  };
  return {
    prepareAndBroadcastProviderWrite: (args: never) =>
      call("prepare", () => h.coordinator!.prepareAndBroadcastProviderWrite(args)),
    loadProviderWrite: (id: string) => call("load", () => h.coordinator!.loadProviderWrite(id)),
    rebroadcastProviderWrite: (id: string) => call("rebroadcast", () => h.coordinator!.rebroadcastProviderWrite(id)),
    confirmProviderWrite: (id: string) => call("confirm", () => h.coordinator!.confirmProviderWrite(id)),
    revertProviderWrite: (id: string) => call("revert", () => h.coordinator!.revertProviderWrite(id)),
  };
});
vi.mock("../src/core/gatewayRegistration/wire.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/gatewayRegistration/wire.js")>();
  return { ...actual, signProviderEnvelope: vi.fn(actual.signProviderEnvelope) };
});
vi.mock("../src/core/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  errorExtra: (error: unknown) => ({ error: String(error) }),
}));

import { registerServiceWithGateway } from "../src/core/gatewayRegistration/client.js";
import {
  checkServiceRegistration,
  forecastFails,
} from "../src/core/gatewayRegistration/forecast.js";
import { signProviderEnvelope } from "../src/core/gatewayRegistration/wire.js";
import {
  assertReadOnlySessions,
  enforceReadOnlySessions,
} from "../src/core/db/readOnlySessions.js";
import type { ServiceRow } from "../src/core/db/queries/services.js";
import {
  FakeChain as Chain,
  FakeGateway as Gateway,
  FakeWriteCoordinator as Coordinator,
  GATEWAY,
  SERVICE_ID,
  defaultSkills,
} from "./gatewayRegistrationHarness.js";
import { createMigratedTestDatabase, type MigratedTestDatabase } from "./postgresTestDatabase.js";
import { testGatewaySigner } from "./runtimeCatalogFixture.js";

let database: MigratedTestDatabase;
let readOnly: pg.Pool;
let gateway: FakeGateway;

const STATE_TABLES = [
  "services",
  "provider_gateway_registrations",
  "provider_gateway_splitter_writes",
  "provider_runtime_listing_versions",
  "provider_chain_writes",
  "events",
];

beforeAll(async () => {
  database = await createMigratedTestDatabase("daski_registration_forecast");
  readOnly = new pg.Pool({ connectionString: database.connectionString, max: 2 });
  enforceReadOnlySessions(readOnly);
}, 120_000);

afterAll(async () => {
  await readOnly?.end();
  await database?.drop();
});

beforeEach(async () => {
  h.db = database.pool;
  for (const table of [
    "provider_runtime_listing_versions",
    "provider_gateway_splitter_writes",
    "provider_gateway_registrations",
    "provider_chain_writes",
    "services",
  ]) await database.pool.query(`DELETE FROM ${table}`);
  await database.pool.query(
    `INSERT INTO services
       (name,slug,version,category_family,service_type,jurisdictions,
        service_description,adapter_name,on_chain_id)
     VALUES ('Orbital Logistics','orbital-logistics','1','space-operations',
             'orbital-logistics','["LEO"]','Orbital logistics','dummy',$1)`,
    [Buffer.from(SERVICE_ID.slice(2), "hex")],
  );
  gateway = new Gateway();
  h.chain = new Chain();
  h.coordinator = new Coordinator(() => database.pool);
  vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => gateway.fetch(input, init));
  vi.stubEnv("STANDARD_RAIL_GATEWAY_SIGNER", testGatewaySigner);
  vi.stubEnv("REGISTRATION_ACTIVATION_POLL_MS", "1000");
  vi.stubEnv("REGISTRATION_ACTIVATION_REKICK_MS", "1000");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function service(): Promise<ServiceRow> {
  return (await database.pool.query<ServiceRow>("SELECT * FROM services LIMIT 1")).rows[0]!;
}

async function register() {
  await registerServiceWithGateway(GATEWAY, await service(), 1, "broadcast");
  return registerServiceWithGateway(GATEWAY, await service());
}

function changePaidSkill(): void {
  gateway.skills = defaultSkills().map((skill) =>
    skill.skillId === "reserve-orbit" ? { ...skill, revision: 2 } : skill);
}

async function snapshot(): Promise<Record<string, unknown[]>> {
  const tables: Record<string, unknown[]> = {};
  for (const table of STATE_TABLES) {
    tables[table] = (await database.pool.query(`SELECT * FROM ${table} ORDER BY 1`)).rows;
  }
  return tables;
}

/** Run the forecast on read-only sessions and prove it wrote and sent nothing. */
async function forecastWithoutEffects() {
  const before = await snapshot();
  const service0 = await service();
  const signatures = vi.mocked(signProviderEnvelope).mock.calls.length;
  gateway.requests.length = 0;
  h.coordinatorCalls.length = 0;
  h.db = readOnly;
  let forecast;
  try {
    forecast = await checkServiceRegistration(GATEWAY, service0);
  } finally {
    h.db = database.pool;
  }
  expect(vi.mocked(signProviderEnvelope).mock.calls.length).toBe(signatures);
  expect(h.coordinatorCalls).toEqual([]);
  expect(gateway.requests.length).toBeGreaterThan(0);
  expect(gateway.requests.filter((request) => request.method !== "GET")).toEqual([]);
  expect(await snapshot()).toEqual(before);
  return forecast;
}

describe("read-only registration forecast", { timeout: 30_000 }, () => {
  it("runs on database sessions that refuse writes", async () => {
    await expect(assertReadOnlySessions(readOnly)).resolves.toBeUndefined();
    await expect(assertReadOnlySessions(database.pool)).rejects.toThrow(/not read-only/);
    await expect(readOnly.query("UPDATE services SET name='changed'"))
      .rejects.toMatchObject({ code: "25006" });
    await expect(readOnly.query("SELECT count(*) FROM services")).resolves.toBeTruthy();
  });

  it("forecasts the resume of an activated registration left in ATTENTION, then the run agrees", async () => {
    await register();
    const trackListing = (await database.pool.query(
      "SELECT listing_id FROM provider_runtime_listing_versions WHERE skill_id='track-orbit'",
    )).rows[0]!.listing_id as string;
    changePaidSkill();
    gateway.corruptCommitmentFor = trackListing;
    await expect(register()).rejects.toThrow(/exact runtime commitment set/);

    const failing = await forecastWithoutEffects();
    expect(failing).toMatchObject({
      state: "RESUME",
      action: "promote",
      crossCheck: { ok: false, matched: 2, total: 3, reused: 2 },
    });
    expect(failing.crossCheck!.detail).toContain(`track-orbit (${trackListing}, reused)`);
    expect(forecastFails(failing)).toBe(true);

    gateway.corruptCommitmentFor = null;
    const passing = await forecastWithoutEffects();
    expect(passing).toMatchObject({
      state: "RESUME",
      action: "promote",
      crossCheck: { ok: true, matched: 3, total: 3, reused: 2, detail: "" },
    });
    expect(forecastFails(passing)).toBe(false);
    await expect(registerServiceWithGateway(GATEWAY, await service()))
      .resolves.toMatchObject({ state: "ACTIVE", registrationId: passing.registrationId });
  });

  it("forecasts an exact evidence replay for a registration the gateway is verifying", async () => {
    gateway.activation = "manual";
    gateway.unavailablePendingReads = 1;
    await expect(register()).rejects.toThrow(/did not return JSON/);

    expect(await forecastWithoutEffects()).toMatchObject({
      state: "IN_PROGRESS",
      action: "replay-accepted-evidence",
      gatewayState: "EVIDENCE_PENDING",
      splitters: { required: 1, journaled: 1, confirmed: 1 },
    });

    changePaidSkill();
    const blocked = await forecastWithoutEffects();
    expect(blocked).toMatchObject({ state: "BLOCKED", action: "card_changed_during_registration" });
    expect(forecastFails(blocked)).toBe(true);
  });

  it("forecasts first admission, an unchanged registration and a changed card", async () => {
    expect(await forecastWithoutEffects()).toMatchObject({
      state: "RE-REGISTER",
      action: "sign-new-intent",
      changedSkills: ["move-orbit", "reserve-orbit", "track-orbit"],
    });
    await register();
    expect(await forecastWithoutEffects()).toMatchObject({ state: "ACTIVE", action: "none" });
    changePaidSkill();
    expect(await forecastWithoutEffects()).toMatchObject({
      state: "RE-REGISTER",
      changedSkills: ["reserve-orbit"],
    });
  });
});
