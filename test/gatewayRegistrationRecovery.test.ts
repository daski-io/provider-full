import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type {
  FakeChain,
  FakeGateway,
  FakeWriteCoordinator,
} from "./gatewayRegistrationHarness.js";

// Registration recovery against PostgreSQL with an offline gateway and chain:
// a reused listing keeps its admitted commitment, an activated registration
// left in ATTENTION resumes promotion, accepted evidence replays unchanged
// after expiry, and unaccepted evidence is refreshed without touching the
// splitter transactions. Nothing here signs a real transaction or reaches a
// network.

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

import { randomUUID } from "node:crypto";
import { getAddress } from "viem";
import { registerServiceWithGateway } from "../src/core/gatewayRegistration/client.js";
import {
  buildRuntimeListingCommitment,
  runtimeCommitmentHash,
} from "../src/core/gatewayRegistration/runtimeCommitment.js";
import { claimSplitterProviderWrite, ensureSplitterPreparations } from "../src/core/gatewayRegistration/splitterRows.js";
import {
  beginGatewayRegistration,
  markGatewayRegistrationActive,
  markGatewayRegistrationAttention,
  markRegistrationBroadcast,
  resumeGatewayRegistration,
  saveRegistrationEvidence,
  savePreparedRegistration,
  type GatewayRegistrationRow,
} from "../src/core/gatewayRegistration/store.js";
import type { GatewayRegistrationView } from "../src/core/gatewayRegistration/types.js";
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

async function splitterWrites() {
  return (await database.pool.query(
    "SELECT * FROM provider_gateway_splitter_writes ORDER BY listing_id",
  )).rows;
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

describe("activated registrations left in ATTENTION", { timeout: 30_000 }, () => {
  it("resume promotion with the persisted intent, preparation and evidence", async () => {
    await register();
    const trackListing = (await heads()).get("track-orbit")!.listing_id as string;
    changePaidSkill();
    gateway.corruptCommitmentFor = trackListing;

    const refused = await register().then(() => null, (error: Error) => error);
    // The refusal names the disagreement, never a signed body or secret.
    expect(refused?.message).toMatch(new RegExp(
      `track-orbit \\(${trackListing}, reused\\): expected 0x[0-9a-f]{64}, reported 0x${"e".repeat(64)}`,
    ));
    expect(refused?.message).not.toMatch(/signature|privateKey|"payload"/);
    const attention = await localRow();
    expect(attention).toMatchObject({
      state: "ATTENTION",
      last_error_code: "runtime_commitment_mismatch",
    });
    expect(gateway.registrations.get(attention.gateway_registration_id)!.state).toBe("ACTIVE");
    const writesBefore = await splitterWrites();
    const signaturesBefore = vi.mocked(signProviderEnvelope).mock.calls.length;
    const preparedBefore = h.coordinator!.prepared.length;

    gateway.corruptCommitmentFor = null;
    gateway.requests.length = 0;
    const resumed = await register();

    expect(resumed).toMatchObject({
      state: "ACTIVE",
      registrationId: attention.gateway_registration_id,
    });
    const after = await localRow();
    expect(after).toMatchObject({
      state: "ACTIVE",
      id: attention.id,
      gateway_registration_id: attention.gateway_registration_id,
      idempotency_key: attention.idempotency_key,
    });
    expect(after.canonical_intent).toEqual(attention.canonical_intent);
    expect(after.prepared_response).toEqual(attention.prepared_response);
    expect(after.canonical_evidence).toEqual(attention.canonical_evidence);
    expect(await splitterWrites()).toEqual(writesBefore);
    // No new intent, no evidence, no transaction, no gateway mutation.
    expect(vi.mocked(signProviderEnvelope).mock.calls.length).toBe(signaturesBefore);
    expect(h.coordinator!.prepared.length).toBe(preparedBefore);
    expect(h.coordinator!.rebroadcast).toEqual([]);
    expect(gateway.requests.every((request) => request.method === "GET")).toBe(true);
    const promoted = await heads();
    expect(promoted.get("reserve-orbit")!.runtime_commitment.providerIntentHash)
      .toBe(canonicalHash(after.canonical_intent));
    expect(promoted.get("track-orbit")!.listing_id).toBe(trackListing);
  });

  it("restart with a fresh intent once the gateway ended the persisted registration", async () => {
    await register();
    changePaidSkill();
    gateway.activation = "manual";
    gateway.unavailablePendingReads = 1;
    await expect(register()).rejects.toThrow(/did not return JSON/);
    const pending = await localRow();
    expect(pending.state).toBe("EVIDENCE_SUBMITTED");
    gateway.registrations.get(pending.gateway_registration_id)!.state = "REJECTED";
    gateway.activation = "on-evidence";

    const restarted = await register();
    expect(restarted).toMatchObject({ state: "ACTIVE" });
    expect(restarted.registrationId).not.toBe(pending.gateway_registration_id);
    const after = await localRow();
    expect(after.id).toBe(pending.id);
    expect(canonicalHash(after.canonical_intent)).not.toBe(canonicalHash(pending.canonical_intent));
    expect(h.logs).toContainEqual(expect.objectContaining({
      message: "Gateway registration restarts with a new intent",
      extra: expect.objectContaining({
        reason: "gateway-terminal",
        priorRegistrationId: pending.gateway_registration_id,
        priorErrorCode: "gateway_registration_rejected",
      }),
    }));
  });
});

describe("activation evidence recovery", { timeout: 30_000 }, () => {
  it("replays the exact accepted envelope after its expiry, even from ATTENTION", async () => {
    gateway.activation = "manual";
    gateway.unavailablePendingReads = 1;
    await expect(register()).rejects.toThrow(/did not return JSON/);
    const pending = await localRow();
    const accepted = pending.canonical_evidence;
    expect(gateway.registrations.get(pending.gateway_registration_id)!.state).toBe("EVIDENCE_PENDING");
    // A record parked in ATTENTION while the gateway still verifies.
    await database.pool.query(
      "UPDATE provider_gateway_registrations SET state='ATTENTION',last_error_code='operator_hold'",
    );
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    vi.setSystemTime((accepted.validBefore + 120) * 1_000);
    gateway.activation = "on-evidence";
    gateway.requests.length = 0;
    const signaturesBefore = vi.mocked(signProviderEnvelope).mock.calls.length;
    const preparedBefore = h.coordinator!.prepared.length;

    await expect(registerServiceWithGateway(GATEWAY, await service()))
      .resolves.toMatchObject({ state: "ACTIVE", registrationId: pending.gateway_registration_id });

    const posted = gateway.requests.filter((request) => request.method === "POST");
    expect(posted).toHaveLength(1);
    expect(posted[0]!.path).toMatch(/\/evidence$/);
    expect(posted[0]!.body).toEqual(accepted);
    expect(vi.mocked(signProviderEnvelope).mock.calls.length).toBe(signaturesBefore);
    expect(h.coordinator!.prepared.length).toBe(preparedBefore);
    expect(h.coordinator!.rebroadcast).toEqual([]);
    const after = await localRow();
    expect(after.canonical_evidence).toEqual(accepted);
    expect(after.canonical_intent).toEqual(pending.canonical_intent);
    expect(after.state).toBe("ACTIVE");
  });

  it("never re-signs accepted evidence that the gateway refuses to replay", async () => {
    gateway.activation = "manual";
    gateway.unavailablePendingReads = 1;
    await expect(register()).rejects.toThrow(/did not return JSON/);
    const accepted = (await localRow()).canonical_evidence;
    gateway.refuseReplays = 1;
    const signaturesBefore = vi.mocked(signProviderEnvelope).mock.calls.length;

    await expect(registerServiceWithGateway(GATEWAY, await service()))
      .rejects.toThrow(/EVIDENCE_AUTH_INVALID/);
    expect(vi.mocked(signProviderEnvelope).mock.calls.length).toBe(signaturesBefore);
    expect((await localRow()).canonical_evidence).toEqual(accepted);
  });

  it("refreshes expired unaccepted evidence over the original splitter hashes before posting", async () => {
    gateway.unavailableEvidencePosts = 1;
    await expect(register()).rejects.toThrow(/did not return JSON/);
    const stale = (await localRow()).canonical_evidence;
    const pending = await localRow();
    expect(gateway.registrations.get(pending.gateway_registration_id)!.state).toBe("PREPARED");
    expect(stale.payload.splitterTransactionHashes).toHaveLength(1);
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    vi.setSystemTime((stale.validBefore + 120) * 1_000);
    const persistedAtPost: unknown[] = [];
    gateway.onEvidence = async () => {
      persistedAtPost.push((await localRow()).canonical_evidence);
    };
    const preparedBefore = h.coordinator!.prepared.length;

    await expect(registerServiceWithGateway(GATEWAY, await service()))
      .resolves.toMatchObject({ state: "ACTIVE" });

    const posted = gateway.requests.filter((request) =>
      request.method === "POST" && request.path.endsWith("/evidence")).at(-1)!.body as typeof stale;
    expect(posted.payload).toEqual({
      ...stale.payload,
      evidenceNonce: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    });
    expect(posted.payload.evidenceNonce).not.toBe(stale.payload.evidenceNonce);
    expect(posted.payload.expectedState).toBe("PREPARED");
    expect(posted.validBefore).toBeGreaterThan(Math.floor(Date.now() / 1_000));
    // Persisted before it was posted, and the splitters were not touched.
    expect(persistedAtPost).toEqual([posted]);
    expect(h.coordinator!.prepared.length).toBe(preparedBefore);
    expect(h.coordinator!.rebroadcast).toEqual([]);
    expect((await localRow()).canonical_evidence).toEqual(posted);
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

describe("concurrent registration runs", { timeout: 30_000 }, () => {
  async function pendingRejected(): Promise<GatewayRegistrationRow> {
    await register();
    changePaidSkill();
    gateway.activation = "manual";
    gateway.unavailablePendingReads = 1;
    await expect(register()).rejects.toThrow(/did not return JSON/);
    const pending = await localRow() as GatewayRegistrationRow;
    gateway.registrations.get(pending.gateway_registration_id!)!.state = "REJECTED";
    gateway.activation = "on-evidence";
    return pending;
  }

  it("never park or replace a record another run re-registered from a stale plan", async () => {
    const pending = await pendingRejected();
    // Run B reads the record, then its live read of the ended registration
    // stalls while run A restarts and completes the registration.
    let releaseB!: () => void;
    const held = new Promise<void>((resolve) => { releaseB = resolve; });
    let parked = false;
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      if (!parked && (init?.method ?? "GET") === "GET" &&
        String(input).endsWith(`/v1/service-registrations/${pending.gateway_registration_id}`)) {
        parked = true;
        await held;
      }
      return gateway.fetch(input, init);
    });
    const runB = registerServiceWithGateway(GATEWAY, await service())
      .then(() => null, (error: Error) => error);
    await vi.waitFor(() => expect(parked).toBe(true));
    const runA = await register();
    const completed = await localRow();
    expect(completed).toMatchObject({ state: "ACTIVE", gateway_registration_id: runA.registrationId });

    releaseB();
    expect((await runB)?.message).toMatch(/another registration run replaced the gateway record/);
    const after = await localRow();
    expect(after).toMatchObject({
      state: "ACTIVE",
      idempotency_key: completed.idempotency_key,
      gateway_registration_id: runA.registrationId,
      last_error_code: null,
    });
    expect(after.canonical_intent).toEqual(completed.canonical_intent);
    gateway.requests.length = 0;
    await expect(registerServiceWithGateway(GATEWAY, await service()))
      .resolves.toMatchObject({ state: "ACTIVE", registrationId: runA.registrationId });
    expect(gateway.requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("write nothing for an intent another run replaced", async () => {
    const pending = await pendingRejected();
    const stale = { id: pending.id, idempotency_key: pending.idempotency_key };
    const parked = (await markGatewayRegistrationAttention(stale, "gateway_registration_rejected"))!;
    const replacement = await beginGatewayRegistration({
      gatewayOrigin: GATEWAY,
      serviceRowId: (await service()).id,
      serviceId: SERVICE_ID,
      cardContractHash: bytesHex(pending.card_contract_hash) as `0x${string}`,
      idempotencyKey: "svc-replacement-intent",
      intent: pending.canonical_intent,
      replacing: parked,
    });
    const view = pending.prepared_response!;

    expect(await markGatewayRegistrationAttention(stale, "late_stale_attention")).toBeNull();
    await expect(resumeGatewayRegistration(stale)).rejects.toThrow(/left ATTENTION/);
    await expect(savePreparedRegistration(stale, view)).rejects.toThrow(/preparation changed/);
    await expect(ensureSplitterPreparations(stale, view)).rejects.toThrow(/record changed/);
    await markRegistrationBroadcast(stale);
    await expect(saveRegistrationEvidence(stale, pending.canonical_evidence!, null))
      .rejects.toThrow(/evidence persistence claim was lost/);
    await expect(markGatewayRegistrationActive(stale, pending.gateway_registration_id!))
      .rejects.toThrow(/did not activate/);
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      const listing = (await splitterWrites())[0]!;
      await client.query("UPDATE provider_gateway_splitter_writes SET provider_write_id=NULL WHERE listing_id=$1", [listing.listing_id]);
      await expect(claimSplitterProviderWrite(stale, listing.listing_id, {
        id: randomUUID(),
        hash: `0x${"ab".repeat(32)}`,
      } as never, client)).resolves.toBe(false);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(await localRow()).toEqual(replacement);
  });

  it("store the preparation and its splitter rows in one transaction", async () => {
    const begun = await beginGatewayRegistration({
      gatewayOrigin: GATEWAY,
      serviceRowId: (await service()).id,
      serviceId: SERVICE_ID,
      cardContractHash: `0x${"12".repeat(32)}`,
      idempotencyKey: "svc-atomic-preparation",
      intent: { payload: {} } as never,
      replacing: null,
    });
    const listing = (splitterAddress: string) => ({
      listingId: randomUUID(),
      deploymentRequired: true,
      splitterAddress,
      transaction: { kind: "splitter-deployment" },
    });
    const view = {
      registrationId: randomUUID(),
      prepared: { listings: [listing(`0x${"ab".repeat(20)}`), listing("0xnot-an-address")] },
    } as unknown as GatewayRegistrationView;

    await expect(savePreparedRegistration(begun, view)).rejects.toThrow();
    expect(await localRow()).toMatchObject({
      state: "INTENT_READY",
      gateway_registration_id: null,
      prepared_response: null,
    });
    expect(await splitterWrites()).toEqual([]);
  });

  it("restore splitter rows a persisted preparation lacks before deploying", async () => {
    vi.spyOn(h.coordinator!, "prepareAndBroadcastProviderWrite")
      .mockRejectedValueOnce(new Error("provider wallet RPC unavailable"));
    await expect(registerServiceWithGateway(GATEWAY, await service(), 1, "broadcast"))
      .rejects.toThrow(/RPC unavailable/);
    expect((await localRow()).state).toBe("PREPARED");
    // A record saved before preparation and splitter rows were one
    // transaction, interrupted between the two.
    await database.pool.query("DELETE FROM provider_gateway_splitter_writes");

    await expect(register()).resolves.toMatchObject({ state: "ACTIVE" });
    const rows = await splitterWrites();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "CONFIRMED", provider_write_id: expect.any(String) });
  });
});
