import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type {
  FakeChain,
  FakeGateway,
  FakeWriteCoordinator,
} from "./gatewayRegistrationHarness.js";

// Registration against PostgreSQL with an offline gateway and chain: a
// reused listing keeps its admitted commitment, identity drift is refused,
// and verification names what mismatched. Nothing here signs a real
// transaction or reaches a network.

const h = vi.hoisted(() => ({
  db: null as pg.Pool | null,
  chain: null as FakeChain | null,
  coordinator: null as FakeWriteCoordinator | null,
  logs: [] as Array<{ level: string; message: string; extra?: unknown }>,
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
vi.mock("../src/core/chain/providerWriteCoordinator.js", () => ({
  prepareAndBroadcastProviderWrite: (args: never) => h.coordinator!.prepareAndBroadcastProviderWrite(args),
  loadProviderWrite: (id: string) => h.coordinator!.loadProviderWrite(id),
  rebroadcastProviderWrite: (id: string) => h.coordinator!.rebroadcastProviderWrite(id),
  confirmProviderWrite: (id: string) => h.coordinator!.confirmProviderWrite(id),
  revertProviderWrite: (id: string) => h.coordinator!.revertProviderWrite(id),
}));
vi.mock("../src/core/gatewayRegistration/wire.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/gatewayRegistration/wire.js")>();
  return { ...actual, signProviderEnvelope: vi.fn(actual.signProviderEnvelope) };
});
vi.mock("../src/core/logger.js", () => {
  const capture = (level: string) => (message: string, extra?: unknown) => {
    h.logs.push({ level, message, extra });
  };
  return {
    logInfo: capture("info"),
    logWarn: capture("warn"),
    logError: capture("error"),
    errorExtra: (error: unknown) => ({ error: String(error) }),
  };
});

import { getAddress } from "viem";
import { registerServiceWithGateway } from "../src/core/gatewayRegistration/client.js";
import {
  buildRuntimeListingCommitment,
  runtimeCommitmentHash,
} from "../src/core/gatewayRegistration/runtimeCommitment.js";
import { signProviderEnvelope } from "../src/core/gatewayRegistration/wire.js";
import type { ServiceRow } from "../src/core/db/queries/services.js";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import {
  CHAIN_ID,
  COMMISSION_RECEIVER,
  FakeChain as Chain,
  FakeGateway as Gateway,
  FakeWriteCoordinator as Coordinator,
  GATEWAY,
  PROVIDER_AGENT_ID,
  SERVICE_ID,
  SPLITTER_FACTORY,
  USDC,
  defaultSkills,
  registrationPolicy,
} from "./gatewayRegistrationHarness.js";
import { createMigratedTestDatabase, type MigratedTestDatabase } from "./postgresTestDatabase.js";
import { testGatewaySigner } from "./runtimeCatalogFixture.js";

let database: MigratedTestDatabase;
let gateway: FakeGateway;

beforeAll(async () => {
  database = await createMigratedTestDatabase("daski_registration_recovery");
  h.db = database.pool;
}, 120_000);

afterAll(async () => {
  await database?.drop();
});

beforeEach(async () => {
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
  h.logs.length = 0;
  vi.mocked(signProviderEnvelope).mockClear();
  vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => gateway.fetch(input, init));
  vi.stubEnv("STANDARD_RAIL_GATEWAY_SIGNER", testGatewaySigner);
  vi.stubEnv("REGISTRATION_ACTIVATION_POLL_MS", "1000");
  vi.stubEnv("REGISTRATION_ACTIVATION_REKICK_MS", "1000");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function service(): Promise<ServiceRow> {
  const result = await database.pool.query<ServiceRow>("SELECT * FROM services LIMIT 1");
  return result.rows[0]!;
}

// The CLI order: every service broadcasts first, then each one activates.
async function register() {
  await registerServiceWithGateway(GATEWAY, await service(), 1, "broadcast");
  return registerServiceWithGateway(GATEWAY, await service());
}

async function localRow() {
  const result = await database.pool.query("SELECT * FROM provider_gateway_registrations");
  return result.rows[0];
}

async function versions() {
  const result = await database.pool.query(
    `SELECT id,skill_id,listing_id,runtime_commitment_hash,runtime_commitment,
            superseded_at,promoted_at
       FROM provider_runtime_listing_versions ORDER BY skill_id,promoted_at`,
  );
  return result.rows;
}

async function heads() {
  return new Map((await versions())
    .filter((row) => row.superseded_at === null)
    .map((row) => [row.skill_id as string, row]));
}

function changePaidSkill(): void {
  gateway.skills = defaultSkills().map((skill) =>
    skill.skillId === "reserve-orbit" ? { ...skill, revision: 2 } : skill);
}

function bytesHex(value: Buffer): string {
  return `0x${value.toString("hex")}`;
}

describe("reused listings", { timeout: 30_000 }, () => {
  it("keep their admitted commitment when another skill is re-registered", async () => {
    await expect(register()).resolves.toMatchObject({ state: "ACTIVE" });
    const first = await heads();
    const firstIntentHash = canonicalHash((await localRow()).canonical_intent);
    expect([...first.keys()]).toEqual(["move-orbit", "reserve-orbit", "track-orbit"]);

    changePaidSkill();
    const second = await register();
    expect(second).toMatchObject({ state: "ACTIVE" });
    const secondIntentHash = canonicalHash((await localRow()).canonical_intent);
    expect(secondIntentHash).not.toBe(firstIntentHash);

    const reregistered = gateway.registrations.get(second.registrationId)!;
    const reused = reregistered.prepared.listings.filter((listing) => listing.reused);
    expect(reused.map((listing) => listing.skillId).sort()).toEqual(["move-orbit", "track-orbit"]);

    const now = await heads();
    for (const skillId of ["move-orbit", "track-orbit"]) {
      // The same promoted row: never rotated, never rewritten.
      expect(now.get(skillId)!.id).toBe(first.get(skillId)!.id);
      expect(now.get(skillId)!.runtime_commitment.providerIntentHash).toBe(firstIntentHash);
    }
    expect(now.get("reserve-orbit")!.id).not.toBe(first.get("reserve-orbit")!.id);
    expect(now.get("reserve-orbit")!.runtime_commitment).toMatchObject({
      providerIntentHash: secondIntentHash,
      listingEpoch: "2",
    });
    expect((await versions()).filter((row) => row.superseded_at !== null)
      .map((row) => row.skill_id)).toEqual(["reserve-orbit"]);

    // What the gateway reported is the original commitment; rebuilding the
    // free listing under the new intent, as the previous client did, rotates it.
    const track = reregistered.prepared.listings.find((listing) => listing.skillId === "track-orbit")!;
    const reported = gateway.view(reregistered).runtimeCommitments as Array<{
      listingId: string; runtimeCommitmentHash: string;
    }>;
    expect(reported.find((entry) => entry.listingId === track.listingId)!.runtimeCommitmentHash)
      .toBe(bytesHex(first.get("track-orbit")!.runtime_commitment_hash));
    const naive = runtimeCommitmentHash(buildRuntimeListingCommitment({
      environment: registrationPolicy.environment,
      chainId: CHAIN_ID,
      gatewayAudience: GATEWAY,
      providerAgentId: PROVIDER_AGENT_ID.toString(),
      serviceId: SERVICE_ID,
      currentProviderIntentHash: secondIntentHash,
      currentProviderPayee: getAddress(reregistered.prepared.providerPayee as string),
      policy: {
        canonicalToken: USDC,
        daskiCommissionReceiver: COMMISSION_RECEIVER,
        commissionBps: registrationPolicy.commissionBps,
        policyVersionHash: registrationPolicy.railPolicyHash,
        splitterFactory: SPLITTER_FACTORY,
      },
      listing: {
        listingId: track.listingId,
        listingKey: track.listingKey,
        skillId: track.skillId,
        skillContractHash: track.skillContractHash,
        paymentRequired: false,
        splitterAddress: null,
        preparation: null,
        controlProfile: null,
      },
    }));
    expect(naive).not.toBe(bytesHex(first.get("track-orbit")!.runtime_commitment_hash));
    // One splitter per paid admission, none for the reused listings.
    expect(h.coordinator!.prepared).toHaveLength(2);
  });

  it("refuse identity drift instead of adopting a changed listing under a reused id", async () => {
    await register();
    const before = await versions();
    const drifted = "0x9999999999999999999999999999999999999999" as const;
    h.chain!.agentWallet = drifted;
    gateway.payee = drifted;
    gateway.reuseAcrossPayees = true;
    changePaidSkill();

    const failure = await register().then(() => null, (error: Error) => error);
    expect(failure?.message).toMatch(
      /move-orbit was reused under listing [0-9a-f-]{36} but no longer reproduces its promoted commitment \(differs in: providerPayee\)/,
    );
    expect(await localRow()).toMatchObject({
      state: "ATTENTION",
      last_error_code: "reused_listing_drift",
    });
    expect(await versions()).toEqual(before);
  });
});

describe("verification diagnostics", { timeout: 30_000 }, () => {
  it("name the mismatched prepared fields without exposing signed bodies", async () => {
    gateway.payee = "0x9999999999999999999999999999999999999999";
    const failure = await register().then(() => null, (error: Error) => error);
    expect(failure?.message).toMatch(
      /gateway prepared the wrong service registration [0-9a-f-]{36} \(mismatched: providerPayee\)/,
    );
    expect(failure?.message).not.toMatch(/signature|0x[0-9a-f]{130}/);
    expect(h.coordinator!.prepared).toEqual([]);
  });
});
