import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/// Everything the reputation outcome worker touches sits behind four module
/// boundaries: the pg pool, the provider write coordinator, the chain client,
/// and finality. Each is faked the way the suite already fakes it
/// (durableJobLease.test.ts, mainnetReadinessContract.test.ts): capture the
/// SQL and bound parameters that would go on the wire and script the rows the
/// driver would return — no live Postgres, no RPC.
const h = vi.hoisted(() => ({
  query: vi.fn(),
  getTransactionReceipt: vi.fn(),
  readContract: vi.fn(),
  assertCanonicalFinalReceipt: vi.fn(),
  loadProviderWrite: vi.fn(),
  updateProviderWriteStatus: vi.fn(),
  prepareAndBroadcastProviderWrite: vi.fn(),
  logWarn: vi.fn(),
  setWorkerStatus: vi.fn(),
  heartbeatWorker: vi.fn(),
  failWorker: vi.fn(),
  reconcileReputationOutcomeReviews: vi.fn(),
  surfaceReputationOutcomeReview: vi.fn(),
}));

vi.mock("../src/core/db/pool.js", () => ({ pool: { query: h.query } }));
vi.mock("../src/core/chain/client.js", () => ({
  providerAddress: "0x1111111111111111111111111111111111111111",
  publicClient: {
    getTransactionReceipt: h.getTransactionReceipt,
    readContract: h.readContract,
  },
}));
vi.mock("../src/core/chain/finality.js", () => ({
  assertCanonicalFinalReceipt: h.assertCanonicalFinalReceipt,
}));
vi.mock("../src/core/chain/providerWriteCoordinator.js", () => ({
  loadProviderWrite: h.loadProviderWrite,
  prepareAndBroadcastProviderWrite: h.prepareAndBroadcastProviderWrite,
}));
vi.mock("../src/core/db/queries/providerChainWrites.js", () => ({
  updateProviderWriteStatus: h.updateProviderWriteStatus,
}));
vi.mock("../src/core/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: h.logWarn,
  logError: vi.fn(),
  errorExtra: vi.fn(),
}));
vi.mock("../src/core/health.js", () => ({
  setWorkerStatus: h.setWorkerStatus,
  heartbeatWorker: h.heartbeatWorker,
  failWorker: h.failWorker,
}));
vi.mock("../src/core/standardRail/reputationOutcomeReviews.js", () => ({
  reconcileReputationOutcomeReviews: h.reconcileReputationOutcomeReviews,
  surfaceReputationOutcomeReview: h.surfaceReputationOutcomeReview,
}));


import {
  abortReputationOutcome,
  getReputationOutcomeOperationalSummary,
  reconcileReputationOutcome,
  retryReputationOutcomeOnce,
  startReputationOutcomeWorker,
} from "../src/core/standardRail/reputationOutcome.js";
import { loadProviderStandardRailConfig } from "../src/core/standardRail/config.js";
import {
  buildGlobalPolicyFixture,
  buildRuntimeHeadFixture,
  encodeGlobalPolicy,
  testGatewaySigner,
} from "./runtimeCatalogFixture.js";

const providerWalletKey = `0x${"44".repeat(32)}` as Hex;
const providerWallet = privateKeyToAccount(providerWalletKey).address;
const hash = (byte: string) => `0x${byte.repeat(64)}`;
const outcomeLaunchPolicy = {
  paidSkills: [
    { serviceSlug: "catalog-a", skillId: "paid-alpha" },
    { serviceSlug: "catalog-b", skillId: "paid-beta" },
    { serviceSlug: "catalog-c", skillId: "paid-gamma" },
  ],
} as const;

const globalPolicy = await buildGlobalPolicyFixture();
const fixtureHeads = () => outcomeLaunchPolicy.paidSkills.map((skill) =>
  buildRuntimeHeadFixture({
    globalPolicy,
    serviceSlug: skill.serviceSlug,
    skillId: skill.skillId,
    agentWallet: providerWallet,
  }));

/// Same fixture as standardRailConfig.test.ts: the real loader turns it into
/// the ProviderStandardRailConfig the worker consumes, so the reviewed retry
/// schedule [5,60,3000,30000], easAddress and schema UID come from the same
/// validation path production goes through.
function environment(): NodeJS.ProcessEnv {
  return {
    PROVIDER_WALLET_PRIVATE_KEY: providerWalletKey,
    BASE_RPC_URL: "https://rpc.example",
    CHAIN_ID: "84532",
    USDC_ADDRESS: "0x6666666666666666666666666666666666666666",
    SANCTIONS_ORACLE_ADDRESS: "0x5555555555555555555555555555555555555555",
    REPUTATION_STORAGE_ADDRESS: "0x4545454545454545454545454545454545454545",
    EAS_ADDRESS: "0x4646464646464646464646464646464646464646",
    EAS_RUNTIME_CODE_HASH: hash("f"),
    EAS_OUTCOME_SCHEMA_UID: hash("e"),
    STANDARD_RAIL_ENVIRONMENT: "testnet",
    STANDARD_RAIL_GATEWAY_AUDIENCE: "https://gateway.example",
    STANDARD_RAIL_GATEWAY_ORIGIN: "https://gateway.example",
    STANDARD_RAIL_PROVIDER_AUDIENCE: "https://provider.example",
    STANDARD_RAIL_GATEWAY_SIGNER: testGatewaySigner,
    STANDARD_RAIL_PROVIDER_CONTROL_PROFILE_HASH: hash("3"),
    STANDARD_RAIL_GLOBAL_POLICY_JSON: encodeGlobalPolicy(globalPolicy),
  };
}

const maybeConfig = await loadProviderStandardRailConfig(
  outcomeLaunchPolicy,
  environment(),
  { headsOverride: fixtureHeads() },
);
if (!maybeConfig) throw new Error("standard rail test environment did not produce a config");
const railConfig = maybeConfig;

const WORKER = "standard-reputation-outcome";
const PROVIDER = "0x1111111111111111111111111111111111111111";
const WRITE_ID = "write-1";
const ORDER_KEY = `0x${"ab".repeat(32)}` as Hex;
const ORDER_KEY_BUFFER = Buffer.from("ab".repeat(32), "hex");
const TX_HASH = `0x${"cd".repeat(32)}` as Hex;
const BLOCK_HASH = `0x${"ef".repeat(32)}` as Hex;
const DETAIL_SELECT = "SELECT * FROM standard_reputation_outcomes WHERE order_key=$1";

interface OutcomeRowFixture {
  order_key: Buffer;
  transaction_id: string;
  outcome: number;
  state: string;
  provider_write_id: string | null;
  attempt_count: number;
  retry_once_used: boolean;
}

function outcomeRow(overrides: Partial<OutcomeRowFixture> = {}): OutcomeRowFixture {
  return {
    order_key: ORDER_KEY_BUFFER,
    transaction_id: "standard-tx-1",
    outcome: 1,
    state: "pending",
    provider_write_id: null,
    attempt_count: 0,
    retry_once_used: false,
    ...overrides,
  };
}

type QueryResponse = { rows: unknown[]; rowCount: number };
const emptyResult: QueryResponse = { rows: [], rowCount: 0 };

/// Routes each pool.query to the first matching SQL fragment; anything
/// unrouted behaves like a statement that matched no rows.
function routeQueries(
  routes: Array<[fragment: string, respond: (values: unknown[]) => QueryResponse]>,
): void {
  h.query.mockImplementation(async (sql: string, values?: unknown[]) => {
    const route = routes.find(([fragment]) => sql.includes(fragment));
    return route ? route[1](values ?? []) : emptyResult;
  });
}

function queriesMatching(fragment: string): unknown[][] {
  return h.query.mock.calls
    .filter((call) => String(call[0]).includes(fragment))
    .map((call) => (call[1] ?? []) as unknown[]);
}

interface PreparedWriteFixture {
  id: string;
  hash: Hex;
  intentHash: Hex;
  nonce: bigint;
}

const PREPARED: PreparedWriteFixture = {
  id: WRITE_ID,
  hash: TX_HASH,
  intentHash: `0x${"99".repeat(32)}` as Hex,
  nonce: 7n,
};

const UID = `0x${"5a".repeat(32)}` as Hex;
const UID_BUFFER = Buffer.from("5a".repeat(32), "hex");
const attestedAbi = parseAbi([
  "event Attested(address indexed recipient,address indexed attester,bytes32 uid,bytes32 indexed schemaUID)",
]);

/// A receipt log carrying the canonical EAS Attested event for the reviewed
/// schema, attested by and to the provider wallet.
function attestedLog(overrides: {
  address?: string;
  recipient?: Hex;
  attester?: Hex;
  schemaUID?: Hex;
  uid?: Hex;
} = {}) {
  return {
    address: overrides.address ?? railConfig.easAddress,
    topics: encodeEventTopics({
      abi: attestedAbi,
      eventName: "Attested",
      args: {
        recipient: overrides.recipient ?? (PROVIDER as Hex),
        attester: overrides.attester ?? (PROVIDER as Hex),
        schemaUID: overrides.schemaUID ?? railConfig.reputationOutcomeSchemaUid,
      },
    }),
    data: encodeAbiParameters([{ type: "bytes32" }], [overrides.uid ?? UID]),
    blockNumber: 555n,
    transactionIndex: 0,
    logIndex: 0,
    transactionHash: TX_HASH,
    blockHash: BLOCK_HASH,
    removed: false,
  };
}

function canonicalAttestation(overrides: Record<string, unknown> = {}) {
  return {
    uid: UID,
    schema: railConfig.reputationOutcomeSchemaUid,
    time: 1n,
    expirationTime: 0n,
    revocationTime: 0n,
    refUID: `0x${"00".repeat(32)}` as Hex,
    recipient: PROVIDER as Hex,
    attester: PROVIDER as Hex,
    revocable: false,
    data: encodeAbiParameters([{ type: "bytes32" }, { type: "uint8" }], [ORDER_KEY, 1]),
    ...overrides,
  };
}

function finalizableReceipt(logs: unknown[] = [attestedLog()]) {
  return { status: "success", blockNumber: 555n, blockHash: BLOCK_HASH, logs };
}

interface AttestationRequest {
  schema: Hex;
  data: {
    recipient: string;
    expirationTime: bigint;
    revocable: boolean;
    refUID: Hex;
    data: Hex;
    value: bigint;
  };
}

interface BroadcastArgs {
  purpose: string;
  target: { type: string; id: string };
  address: string;
  abi: readonly unknown[];
  functionName: string;
  callArgs: readonly unknown[];
  persist: (
    prepared: PreparedWriteFixture,
    db: { query: (sql: string, values: unknown[]) => Promise<QueryResponse> },
  ) => Promise<boolean | void>;
}

/// run() heartbeats last, so resolving on the next heartbeat is the signal
/// that one full worker pass has settled — no fake timers needed.
function heartbeatOnce(): Promise<void> {
  return new Promise((resolve) => {
    h.heartbeatWorker.mockImplementationOnce(() => {
      resolve();
    });
  });
}

const stops: Array<() => void> = [];

function startWorker(): void {
  stops.push(startReputationOutcomeWorker(railConfig));
}

async function startIdleWorker(): Promise<void> {
  const settled = heartbeatOnce();
  startWorker();
  await settled;
}

beforeEach(() => {
  for (const mock of Object.values(h)) mock.mockReset();
  h.query.mockResolvedValue(emptyResult);
  h.reconcileReputationOutcomeReviews.mockResolvedValue({ opened: 0, closed: 0 });
  h.surfaceReputationOutcomeReview.mockResolvedValue(undefined);
});

afterEach(() => {
  while (stops.length > 0) stops.pop()!();
  vi.useRealTimers();
});

describe("standard reputation outcome recovery", () => {
  describe("configuration guards", () => {
    it("rejects malformed schema uids at load", async () => {
      const badUid = environment();
      badUid.EAS_OUTCOME_SCHEMA_UID = "0x1234";
      await expect(loadProviderStandardRailConfig(outcomeLaunchPolicy, badUid, { headsOverride: [] }))
        .rejects.toThrow("EAS_OUTCOME_SCHEMA_UID must be bytes32");
    });
  });

  describe("worker loop", () => {
    it("boots not ready and heartbeats when nothing is due", async () => {
      await startIdleWorker();
      expect(h.setWorkerStatus).toHaveBeenCalledWith(WORKER, false);
      expect(h.prepareAndBroadcastProviderWrite).not.toHaveBeenCalled();
      expect(h.heartbeatWorker).toHaveBeenCalledWith(WORKER);
      expect(h.reconcileReputationOutcomeReviews).toHaveBeenCalledOnce();
    });

    it("broadcasts the EAS attestation for a due pending outcome", async () => {
      routeQueries([
        ["next_attempt_at<=now()", () => ({ rows: [outcomeRow()], rowCount: 1 })],
      ]);
      const persistCalls: Array<{ sql: string; values: unknown[] }> = [];
      let persisted: boolean | void | undefined = undefined;
      h.prepareAndBroadcastProviderWrite.mockImplementation(async (args: BroadcastArgs) => {
        persisted = await args.persist(PREPARED, {
          query: async (sql: string, values: unknown[]) => {
            persistCalls.push({ sql, values });
            return { rows: [], rowCount: 1 };
          },
        });
        return PREPARED;
      });

      const settled = heartbeatOnce();
      startWorker();
      await settled;

      expect(h.prepareAndBroadcastProviderWrite).toHaveBeenCalledTimes(1);
      const args = h.prepareAndBroadcastProviderWrite.mock.calls[0]![0] as BroadcastArgs;
      expect(args.purpose).toBe("standard_reputation_outcome");
      expect(args.target).toEqual({ type: "standard_reputation_outcome", id: ORDER_KEY });
      expect(args.address).toBe(railConfig.easAddress);
      expect(args.functionName).toBe("attest");
      expect((args.abi[0] as { name?: string }).name).toBe("attest");

      const request = args.callArgs[0] as AttestationRequest;
      expect(request.schema).toBe(railConfig.reputationOutcomeSchemaUid);
      expect(request.data.recipient).toBe(PROVIDER);
      expect(request.data.expirationTime).toBe(0n);
      expect(request.data.revocable).toBe(false);
      expect(request.data.refUID).toBe(`0x${"00".repeat(32)}`);
      expect(request.data.value).toBe(0n);
      expect(request.data.data).toBe(
        encodeAbiParameters([{ type: "bytes32" }, { type: "uint8" }], [ORDER_KEY, 1]),
      );

      expect(persisted).toBe(true);
      expect(persistCalls).toHaveLength(1);
      expect(persistCalls[0]!.sql).toContain("SET state='broadcast'");
      expect(persistCalls[0]!.values).toEqual([ORDER_KEY_BUFFER, WRITE_ID, TX_HASH]);

      // Losing the persist race reports false so the coordinator can abort.
      await expect(args.persist(PREPARED, {
        query: async () => ({ rows: [], rowCount: 0 }),
      })).resolves.toBe(false);
    });

    it("schedules the first reviewed retry delay when broadcast fails before persist", async () => {
      routeQueries([
        ["next_attempt_at<=now()", () => ({ rows: [outcomeRow()], rowCount: 1 })],
        [DETAIL_SELECT, () => ({ rows: [outcomeRow()], rowCount: 1 })],
      ]);
      h.prepareAndBroadcastProviderWrite.mockRejectedValue(new Error("nonce too low"));

      const settled = heartbeatOnce();
      startWorker();
      await settled;

      const scheduled = queriesMatching("' seconds')::interval");
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]).toEqual([
        ORDER_KEY_BUFFER, 1, railConfig.reputationRetryDelaysSeconds[0], "nonce_conflict",
      ]);
    });

    it("parks a fifth failed attempt for the operator instead of retrying", async () => {
      routeQueries([
        ["next_attempt_at<=now()", () => ({ rows: [outcomeRow({ attempt_count: 4 })], rowCount: 1 })],
        [DETAIL_SELECT, () => ({ rows: [outcomeRow({ attempt_count: 4 })], rowCount: 1 })],
        ["state='operator_attention',attempt_count=$2", () => ({ rows: [], rowCount: 1 })],
      ]);
      h.prepareAndBroadcastProviderWrite.mockRejectedValue(new Error("execution reverted"));

      const settled = heartbeatOnce();
      startWorker();
      await settled;

      const parked = queriesMatching("state='operator_attention',attempt_count=$2");
      expect(parked).toHaveLength(1);
      expect(parked[0]).toEqual([ORDER_KEY_BUFFER, 5, "contract_rejection"]);
      expect(queriesMatching("' seconds')::interval")).toHaveLength(0);
      expect(h.surfaceReputationOutcomeReview).toHaveBeenCalledWith({
        row: expect.objectContaining({
          transaction_id: "standard-tx-1",
          attempt_count: 5,
        }),
        reason: "contract_rejection",
      });
      expect(h.logWarn).toHaveBeenCalledWith(
        "Standard reputation outcome requires provider attention",
        { transactionId: "standard-tx-1", attemptCount: 5, reason: "contract_rejection" },
      );
    });

    it("leaves the row alone when the write persisted despite the thrown broadcast", async () => {
      routeQueries([
        ["next_attempt_at<=now()", () => ({ rows: [outcomeRow()], rowCount: 1 })],
        [DETAIL_SELECT, () => ({
          rows: [outcomeRow({ state: "broadcast", provider_write_id: WRITE_ID })],
          rowCount: 1,
        })],
      ]);
      h.prepareAndBroadcastProviderWrite.mockRejectedValue(new Error("socket hang up"));

      const settled = heartbeatOnce();
      startWorker();
      await settled;

      expect(queriesMatching("UPDATE standard_reputation_outcomes")).toHaveLength(0);
    });

    it("keeps polling on the interval and stops failing after teardown", async () => {
      vi.useFakeTimers();
      h.query.mockRejectedValue(new Error("database offline"));

      startWorker();
      await vi.waitFor(() => expect(h.failWorker).toHaveBeenCalledTimes(1));
      expect(h.failWorker).toHaveBeenCalledWith(WORKER);

      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(h.failWorker).toHaveBeenCalledTimes(2));

      stops.pop()!();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(h.failWorker).toHaveBeenCalledTimes(2);
      expect(h.heartbeatWorker).not.toHaveBeenCalled();
    });
  });

  describe("reconciliation", () => {
    it("refuses to reconcile a broadcast row while recovery is not running", async () => {
      routeQueries([
        [DETAIL_SELECT, () => ({
          rows: [outcomeRow({ state: "broadcast", provider_write_id: WRITE_ID })],
          rowCount: 1,
        })],
      ]);
      await expect(reconcileReputationOutcome(ORDER_KEY))
        .rejects.toThrow("Provider reputation recovery is not running");
    });

    it("returns the stored state for a row that never broadcast", async () => {
      routeQueries([
        [DETAIL_SELECT, () => ({ rows: [outcomeRow()], rowCount: 1 })],
      ]);
      await expect(reconcileReputationOutcome(ORDER_KEY)).resolves.toBe("pending");
      expect(h.loadProviderWrite).not.toHaveBeenCalled();
    });

    it("rejects an unknown order key after binding it as bytes", async () => {
      await expect(reconcileReputationOutcome(ORDER_KEY)).rejects.toThrow("Outcome not found");
      const lookups = queriesMatching(DETAIL_SELECT);
      expect(lookups).toHaveLength(1);
      expect(lookups[0]).toEqual([ORDER_KEY_BUFFER]);
    });

    it("parks the outcome for the operator when its provider write vanished", async () => {
      await startIdleWorker();
      const row = outcomeRow({ state: "broadcast", provider_write_id: WRITE_ID });
      routeQueries([
        [DETAIL_SELECT, () => ({ rows: [row], rowCount: 1 })],
        ["last_error_class='application_fault'", () => ({ rows: [], rowCount: 1 })],
      ]);
      h.loadProviderWrite.mockResolvedValue(null);

      await expect(reconcileReputationOutcome(ORDER_KEY)).resolves.toBe("waiting");
      expect(h.loadProviderWrite).toHaveBeenCalledWith(WRITE_ID);
      const parked = queriesMatching("last_error_class='application_fault'");
      expect(parked).toHaveLength(1);
      expect(parked[0]).toEqual([ORDER_KEY_BUFFER, WRITE_ID]);
      expect(h.logWarn).toHaveBeenCalledWith(
        "Standard reputation outcome requires provider attention",
        { transactionId: "standard-tx-1", reason: "application_fault" },
      );

      // A concurrent transition means no row matched, and nothing is logged.
      h.logWarn.mockClear();
      routeQueries([
        [DETAIL_SELECT, () => ({ rows: [row], rowCount: 1 })],
        ["last_error_class='application_fault'", () => ({ rows: [], rowCount: 0 })],
      ]);
      await expect(reconcileReputationOutcome(ORDER_KEY)).resolves.toBe("waiting");
      expect(h.logWarn).not.toHaveBeenCalled();
    });

    it("waits while the confirmed receipt is unfetchable or not yet final", async () => {
      await startIdleWorker();
      routeQueries([
        [DETAIL_SELECT, () => ({
          rows: [outcomeRow({ state: "broadcast", provider_write_id: WRITE_ID })],
          rowCount: 1,
        })],
      ]);
      h.loadProviderWrite.mockResolvedValue({
        status: "confirmed", transaction_hash: TX_HASH, last_error_code: null,
      });

      h.getTransactionReceipt.mockRejectedValueOnce(new Error("rpc unreachable"));
      await expect(reconcileReputationOutcome(ORDER_KEY)).resolves.toBe("waiting");

      h.getTransactionReceipt.mockResolvedValue({ blockNumber: 555n, blockHash: BLOCK_HASH });
      h.assertCanonicalFinalReceipt.mockRejectedValueOnce(new Error("not yet final"));
      await expect(reconcileReputationOutcome(ORDER_KEY)).resolves.toBe("waiting");

      expect(queriesMatching("SET state='final'")).toHaveLength(0);
    });

    it("finalizes the outcome once the attestation is verified against EAS state", async () => {
      await startIdleWorker();
      routeQueries([
        [DETAIL_SELECT, () => ({
          rows: [outcomeRow({ state: "broadcast", provider_write_id: WRITE_ID })],
          rowCount: 1,
        })],
        ["SET state='final'", () => ({ rows: [], rowCount: 1 })],
      ]);
      h.loadProviderWrite.mockResolvedValue({
        status: "confirmed", transaction_hash: TX_HASH, last_error_code: null,
      });
      const receipt = finalizableReceipt();
      h.getTransactionReceipt.mockResolvedValue(receipt);
      h.assertCanonicalFinalReceipt.mockResolvedValue(undefined);
      h.readContract.mockResolvedValue(canonicalAttestation());

      await expect(reconcileReputationOutcome(ORDER_KEY)).resolves.toBe("final");
      expect(h.getTransactionReceipt).toHaveBeenCalledWith({ hash: TX_HASH });
      expect(h.assertCanonicalFinalReceipt).toHaveBeenCalledWith(receipt, TX_HASH);
      expect(h.readContract).toHaveBeenCalledWith(expect.objectContaining({
        address: railConfig.easAddress,
        functionName: "getAttestation",
        args: [UID],
      }));
      const finals = queriesMatching("SET state='final'");
      expect(finals).toHaveLength(1);
      expect(finals[0]).toEqual([ORDER_KEY_BUFFER, WRITE_ID, "555", BLOCK_HASH, UID_BUFFER]);
      const [finalSql] = h.query.mock.calls
        .find((call) => String(call[0]).includes("SET state='final'"))!;
      expect(String(finalSql)).toContain("attestation_uid=$5");
    });

    it("parks a successful receipt that carries no matching Attested event", async () => {
      await startIdleWorker();
      routeQueries([
        [DETAIL_SELECT, () => ({
          rows: [outcomeRow({ state: "broadcast", provider_write_id: WRITE_ID })],
          rowCount: 1,
        })],
        ["last_error_class='contract_rejection'", () => ({ rows: [], rowCount: 1 })],
      ]);
      h.loadProviderWrite.mockResolvedValue({
        status: "confirmed", transaction_hash: TX_HASH, last_error_code: null,
      });
      h.assertCanonicalFinalReceipt.mockResolvedValue(undefined);

      for (const logs of [
        [],
        [attestedLog({ schemaUID: hash("9") as Hex })],
        [attestedLog({ address: "0x9999999999999999999999999999999999999999" })],
        [attestedLog({ attester: "0x2222222222222222222222222222222222222222" })],
        [attestedLog(), attestedLog({ uid: hash("1") as Hex })],
      ]) {
        h.getTransactionReceipt.mockResolvedValueOnce(finalizableReceipt(logs));
        await expect(reconcileReputationOutcome(ORDER_KEY)).resolves.toBe("waiting");
      }
      expect(h.readContract).not.toHaveBeenCalled();
      expect(queriesMatching("SET state='final'")).toHaveLength(0);
      expect(queriesMatching("last_error_class='contract_rejection'")).toHaveLength(5);
      expect(h.logWarn).toHaveBeenCalledWith(
        "Standard reputation outcome requires provider attention",
        { transactionId: "standard-tx-1", reason: "unverified_attestation" },
      );
    });

    it("parks the outcome when canonical EAS state contradicts the receipt", async () => {
      await startIdleWorker();
      routeQueries([
        [DETAIL_SELECT, () => ({
          rows: [outcomeRow({ state: "broadcast", provider_write_id: WRITE_ID })],
          rowCount: 1,
        })],
        ["last_error_class='contract_rejection'", () => ({ rows: [], rowCount: 1 })],
      ]);
      h.loadProviderWrite.mockResolvedValue({
        status: "confirmed", transaction_hash: TX_HASH, last_error_code: null,
      });
      h.getTransactionReceipt.mockResolvedValue(finalizableReceipt());
      h.assertCanonicalFinalReceipt.mockResolvedValue(undefined);

      for (const attestation of [
        canonicalAttestation({ uid: hash("0") }),
        canonicalAttestation({ schema: hash("9") }),
        canonicalAttestation({ recipient: "0x2222222222222222222222222222222222222222" }),
        canonicalAttestation({
          data: encodeAbiParameters([{ type: "bytes32" }, { type: "uint8" }], [ORDER_KEY, 2]),
        }),
      ]) {
        h.readContract.mockResolvedValueOnce(attestation);
        await expect(reconcileReputationOutcome(ORDER_KEY)).resolves.toBe("waiting");
      }
      expect(queriesMatching("SET state='final'")).toHaveLength(0);
      expect(queriesMatching("last_error_class='contract_rejection'")).toHaveLength(4);
    });

    it("retries later when the canonical attestation read is unavailable", async () => {
      await startIdleWorker();
      routeQueries([
        [DETAIL_SELECT, () => ({
          rows: [outcomeRow({ state: "broadcast", provider_write_id: WRITE_ID })],
          rowCount: 1,
        })],
      ]);
      h.loadProviderWrite.mockResolvedValue({
        status: "confirmed", transaction_hash: TX_HASH, last_error_code: null,
      });
      h.getTransactionReceipt.mockResolvedValue(finalizableReceipt());
      h.assertCanonicalFinalReceipt.mockResolvedValue(undefined);
      h.readContract.mockRejectedValue(new Error("rpc unreachable"));

      await expect(reconcileReputationOutcome(ORDER_KEY)).resolves.toBe("waiting");
      expect(queriesMatching("SET state='final'")).toHaveLength(0);
      expect(queriesMatching("last_error_class='contract_rejection'")).toHaveLength(0);
    });

    it("reconciles a canonical broadcast receipt and marks its write confirmed", async () => {
      await startIdleWorker();
      routeQueries([
        [DETAIL_SELECT, () => ({
          rows: [outcomeRow({ state: "broadcast", provider_write_id: WRITE_ID })],
          rowCount: 1,
        })],
        ["SET state='final'", () => ({ rows: [], rowCount: 1 })],
      ]);
      h.loadProviderWrite.mockResolvedValue({
        id: WRITE_ID, status: "broadcast", transaction_hash: TX_HASH, last_error_code: null,
      });
      h.getTransactionReceipt.mockResolvedValue(finalizableReceipt());
      h.assertCanonicalFinalReceipt.mockResolvedValue(undefined);
      h.readContract.mockResolvedValue(canonicalAttestation());

      await expect(reconcileReputationOutcome(ORDER_KEY)).resolves.toBe("final");
      expect(h.updateProviderWriteStatus).toHaveBeenCalledWith(WRITE_ID, "confirmed");
      expect(queriesMatching("SET state='final'")).toHaveLength(1);
    });

    it("keeps waiting while an unmined write is still in flight or replaced", async () => {
      await startIdleWorker();
      routeQueries([
        [DETAIL_SELECT, () => ({
          rows: [outcomeRow({ state: "broadcast", provider_write_id: WRITE_ID })],
          rowCount: 1,
        })],
      ]);
      h.getTransactionReceipt.mockRejectedValue(new Error("receipt unavailable"));
      for (const status of ["prepared", "broadcast", "replaced"]) {
        h.loadProviderWrite.mockResolvedValueOnce({
          id: WRITE_ID, status, transaction_hash: TX_HASH, last_error_code: null,
        });
        await expect(reconcileReputationOutcome(ORDER_KEY)).resolves.toBe("waiting");
      }
      expect(queriesMatching("UPDATE standard_reputation_outcomes")).toHaveLength(0);
    });

    it("classifies coordinator attention codes into operator-facing causes", async () => {
      await startIdleWorker();
      const cases: Array<[string | null, string]> = [
        ["insufficient funds for gas * price + value", "balance_fee"],
        ["replacement transaction underpriced", "balance_fee"],
        ["nonce too low", "nonce_conflict"],
        ["execution reverted", "contract_rejection"],
        ["rpc socket closed mid-request", "rpc_finality"],
        ["something unrecognizable", "application_fault"],
        [null, "application_fault"],
      ];
      routeQueries([
        [DETAIL_SELECT, () => ({
          rows: [outcomeRow({ state: "broadcast", provider_write_id: WRITE_ID })],
          rowCount: 1,
        })],
        ["last_error_class=$3", () => ({ rows: [], rowCount: 1 })],
      ]);
      for (const [code] of cases) {
        h.loadProviderWrite.mockResolvedValueOnce({
          status: "attention", transaction_hash: TX_HASH, last_error_code: code,
        });
        await expect(reconcileReputationOutcome(ORDER_KEY)).resolves.toBe("waiting");
      }
      const reasons = queriesMatching("last_error_class=$3").map((values) => values[2]);
      expect(reasons).toEqual(cases.map(([, reason]) => reason));
      expect(h.logWarn).toHaveBeenCalledTimes(cases.length);
    });

    it("returns a failed write to the queue on the reviewed backoff", async () => {
      await startIdleWorker();
      routeQueries([
        [DETAIL_SELECT, () => ({
          rows: [outcomeRow({ state: "broadcast", provider_write_id: WRITE_ID, attempt_count: 2 })],
          rowCount: 1,
        })],
      ]);
      h.loadProviderWrite.mockResolvedValue({
        status: "failed", transaction_hash: TX_HASH, last_error_code: "fetch failed",
      });

      await expect(reconcileReputationOutcome(ORDER_KEY)).resolves.toBe("waiting");
      const reset = queriesMatching("SET state='pending',provider_write_id=NULL");
      expect(reset).toHaveLength(1);
      expect(reset[0]).toEqual([ORDER_KEY_BUFFER, WRITE_ID]);
      const rescheduled = queriesMatching("' seconds')::interval");
      expect(rescheduled).toHaveLength(1);
      expect(rescheduled[0]).toEqual([
        ORDER_KEY_BUFFER, 3, railConfig.reputationRetryDelaysSeconds[2], "rpc_finality",
      ]);
    });
  });

  describe("operator controls", () => {
    it("aggregates the operational summary with per-cause counts", async () => {
      routeQueries([
        ["FILTER (WHERE state='operator_attention')", () => ({
          rows: [{
            pending: 2, attention: 1, aborted: 1,
            exhausted_attempts: 1, oldest_pending_seconds: 77,
          }],
          rowCount: 1,
        })],
        ["GROUP BY last_error_class", () => ({
          rows: [
            { last_error_class: "rpc_finality", count: 2 },
            { last_error_class: "balance_fee", count: 1 },
          ],
          rowCount: 2,
        })],
      ]);
      await expect(getReputationOutcomeOperationalSummary()).resolves.toEqual({
        pending: 2,
        attention: 1,
        aborted: 1,
        exhaustedAttempts: 1,
        oldestPendingSeconds: 77,
        causes: { rpc_finality: 2, balance_fee: 1 },
      });
    });

    it("aborts only an unreconciled operator_attention outcome", async () => {
      routeQueries([
        ["SET state='aborted_unattested'", () => ({ rows: [], rowCount: 1 })],
      ]);
      await expect(abortReputationOutcome(ORDER_KEY)).resolves.toBeUndefined();
      const aborts = queriesMatching("SET state='aborted_unattested'");
      expect(aborts).toHaveLength(1);
      expect(aborts[0]).toEqual([ORDER_KEY_BUFFER]);
      const [abortSql] = h.query.mock.calls[0]!;
      expect(String(abortSql)).toContain("state='operator_attention' AND provider_write_id IS NULL");
    });

    it("refuses to abort anything not parked for the operator", async () => {
      await expect(abortReputationOutcome(ORDER_KEY))
        .rejects.toThrow("Outcome cannot be aborted before reconciliation");
    });

    it("arms exactly one operator retry at the final attempt", async () => {
      routeQueries([
        ["retry_once_used=true", () => ({ rows: [], rowCount: 1 })],
      ]);
      await expect(retryReputationOutcomeOnce(ORDER_KEY)).resolves.toBeUndefined();
      const [retrySql, retryValues] = h.query.mock.calls[0]!;
      expect(String(retrySql)).toContain("attempt_count=4");
      expect(String(retrySql)).toContain("retry_once_used=false");
      expect(retryValues).toEqual([ORDER_KEY_BUFFER]);
    });

    it("refuses a second retry-once", async () => {
      await expect(retryReputationOutcomeOnce(ORDER_KEY))
        .rejects.toThrow("Outcome is not eligible for retry-once");
    });
  });
});
