import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";

/// Unit coverage for the standard-rail action store at the database
/// boundary (actionStore, actionStaged, actionCompletion): a fake pool
/// captures every statement (whitespace-normalized)
/// with its bound parameters and answers from per-test seed state the way
/// RETURNING * / FOR UPDATE would. Encryption, customer upsert, and the
/// endpoint rate limiter run for real so the captured parameters are the
/// actual wire values. Assertions pin the writes to the shape migration
/// 043 (hardened by 044) enforces on standard_asset_action_executions:
/// terminal completed rows carry error_class NULL and sanitized_result
/// NULL (results live only in the encrypted recovery table), failed rows
/// carry error_class and never a result, and non-terminal rows carry
/// neither.
const harness = vi.hoisted(() => {
  const calls: { text: string; values: unknown[] }[] = [];
  const customerId = "33333333-3333-4333-8333-333333333333";
  const defaults = () => ({
    executionRow: null as Record<string, any> | null,
    followupRow: null as Record<string, any> | null,
    taskRow: null as Record<string, any> | null,
    transactionRows: new Map<string, Record<string, any>>(),
    payloadRow: null as { encrypted_input: string; expires_at: Date } | null,
    recoveryRow: null as { encrypted_result: string; expires_at: Date } | null,
    stagedCounts: { payer_count: "0", provider_count: "0" },
    /** What the single owner authority answers for the asset. */
    owner: { payer: `0x${"aa".repeat(20)}`, version: 0 } as { payer: string; version: number } | null,
    rateCount: 1,
    transitionRowCount: 1,
    attentionRowCount: 1,
    completeUpdateRowCount: 1,
    expiredRows: [] as { execution_id: Buffer }[],
    overdueRows: [] as { execution_id: Buffer }[],
    actionStateRows: [] as { task_id: string; state: string }[],
    failFragment: null as string | null,
    failRollback: false,
    releases: 0,
  });
  const state = defaults();
  const toDate = (seconds: unknown): Date | null =>
    seconds == null ? null : new Date((seconds as number) * 1_000);
  /// The row the executions INSERT ... RETURNING * hands back, with the
  /// epoch-second bindings converted the way to_timestamp() converts them.
  const rowFromInsert = (v: unknown[]) => ({
    execution_id: v[0], payer: v[1], provider_asset_id: v[2], action_hash: v[3],
    request_hash: v[4], wallet_authorization_hash: v[5], grant_hash: v[6],
    provider_control_profile_hash: v[7], servicing_admission_hash: v[8],
    action_catalog_hash: v[9], action_catalog_schema_hash: v[10],
    action_catalog_epoch: String(v[11]), action_definition_hash: v[12],
    state: v[13], effect_summary: v[14], replay_policy: v[15], confirmation_hash: v[16],
    earliest_execution_at: toDate(v[17]), stage_valid_before: toDate(v[18]),
    result_valid_before: toDate(v[19]),
    result_redacted_at: null, sanitized_result: null, error_class: null,
    admitted_owner: v[20], admitted_owner_version: v[21],
  });
  async function query(rawText: string, values: unknown[] = []) {
    const text = rawText.replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    if (state.failRollback && text === "ROLLBACK") throw new Error("rollback connection lost");
    if (state.failFragment && text.includes(state.failFragment)) {
      throw new Error("simulated statement failure");
    }
    const rows = (list: unknown[]) => ({ rows: list, rowCount: list.length });
    const one = (row: unknown) => rows(row ? [row] : []);
    const ok = (rowCount: number) => ({ rows: [], rowCount });
    if (text.startsWith("BEGIN") || text === "COMMIT" || text === "ROLLBACK") return ok(0);
    if (text.includes("pg_advisory_xact_lock")) return ok(0);
    if (text.includes("FROM asset_owner_overrides aoo") && text.includes("FROM assets a WHERE a.id = $1::uuid")) {
      return one(state.owner);
    }
    if (text.startsWith("SELECT provider_asset_id FROM standard_asset_action_executions")) {
      return one(state.executionRow && { provider_asset_id: state.executionRow.provider_asset_id });
    }
    if (text.startsWith("UPDATE transactions SET admitted_owner=$2,admitted_owner_version=$3")) return ok(1);
    if (text.includes("SET state='failed',error_class=$2,sanitized_result=NULL")) return ok(1);
    if (text.includes("INSERT INTO standard_asset_rate_buckets")) {
      return rows([{ request_count: state.rateCount }]);
    }
    if (text.includes("count(*) FILTER")) return rows([state.stagedCounts]);
    if (text.includes("INSERT INTO customers")) {
      return rows([{
        id: customerId, wallet_address: values[0],
        first_seen_at: new Date(), last_seen_at: new Date(), last_known_email: null,
      }]);
    }
    if (text.includes("INSERT INTO standard_wallet_action_nonces")) return ok(1);
    if (text.includes("INSERT INTO standard_provider_grant_nonces")) return ok(1);
    if (text.includes("INSERT INTO transactions")) return ok(1);
    if (text.includes("INSERT INTO standard_asset_action_executions")) {
      return rows([rowFromInsert(values)]);
    }
    if (text.includes("INSERT INTO standard_destructive_action_payloads")) return ok(1);
    if (text.includes("INSERT INTO standard_destructive_followup_executions")) return ok(1);
    if (text.includes("INSERT INTO standard_asset_action_recovery_results")) return ok(1);
    if (text.includes("INSERT INTO events")) return ok(1);
    if (text === "SELECT * FROM transactions WHERE id = $1") {
      return one(state.transactionRows.get(String(values[0])));
    }
    if (text.includes("SET metadata = metadata || $2::jsonb")) {
      const transaction = state.transactionRows.get(String(values[0]));
      if (!transaction) return one(null);
      transaction.metadata = {
        ...transaction.metadata,
        ...JSON.parse(String(values[1])),
      };
      transaction.updated_at = new Date();
      return one({ ...transaction });
    }
    if (text.startsWith("UPDATE transactions SET status = $2")) {
      const transaction = state.transactionRows.get(String(values[0]));
      if (
        !transaction ||
        (values[3] !== null && transaction.status !== values[3]) ||
        (values[4] !== null && String(transaction.version) !== String(values[4]))
      ) return one(null);
      transaction.status = values[1];
      transaction.updated_at = new Date();
      transaction.version = String(BigInt(transaction.version) + 1n);
      if (values[2] === true) {
        transaction.completed_at ??= new Date();
      }
      return one({ ...transaction });
    }
    if (text.startsWith("SELECT") && text.includes("FROM standard_destructive_action_payloads")) {
      return one(state.payloadRow);
    }
    if (text.startsWith("SELECT") && text.includes("FROM standard_asset_action_recovery_results")) {
      return one(state.recoveryRow);
    }
    if (text.includes("FROM standard_destructive_followup_executions")) {
      return one(state.followupRow);
    }
    if (text.includes("WHERE t.id=ANY($1::text[])")) return rows(state.actionStateRows);
    if (text.includes("JOIN transactions t ON")) return one(state.taskRow);
    if (text.includes("SELECT * FROM standard_asset_action_executions")) {
      return one(state.executionRow);
    }
    if (text.includes("SET state='expired'")) return rows(state.expiredRows);
    if (text.includes("WHERE state='executing' AND result_valid_before<=now()")) {
      return rows(state.overdueRows);
    }
    if (text.includes("result_redacted_at=COALESCE(result_redacted_at,now())")) return ok(0);
    if (text.includes("sanitized_result=NULL,error_class=$3")) {
      return ok(state.completeUpdateRowCount);
    }
    if (text.includes("reconciliation_identity=CASE")) return ok(1);
    if (text.includes("COALESCE(reconciliation_identity,$4)")) return ok(state.transitionRowCount);
    if (text.includes("SET state='attention'")) return ok(state.attentionRowCount);
    if (text.includes("UPDATE standard_destructive_action_payloads SET expires_at=$2")) return ok(1);
    if (text.includes("DELETE FROM standard_destructive_action_payloads")) return ok(0);
    if (text.includes("DELETE FROM artifact_secrets")) return ok(1);
    if (text.includes("DELETE FROM standard_asset_action_recovery_results")) return ok(0);
    if (text.includes("DELETE FROM standard_wallet_action_nonces")) return ok(0);
    if (text.includes("DELETE FROM standard_provider_grant_nonces")) return ok(0);
    if (text.includes("DELETE FROM standard_asset_rate_buckets")) return ok(0);
    throw new Error(`unexpected SQL in standard action store test: ${text}`);
  }
  const pool = {
    query,
    async connect() {
      return { query, release: () => { state.releases += 1; } };
    },
  };
  return {
    calls, state, pool, customerId,
    reset() {
      calls.length = 0;
      Object.assign(state, defaults());
    },
  };
});

vi.mock("../src/core/db/pool.js", () => ({ pool: harness.pool }));

import {
  claimAssetAction,
  loadAssetActionExecution,
  loadAssetActionForTask,
  loadAssetActionStatesForTasks,
  loadAssetActionRecoveryResult,
  transitionAssetAction,
  type AssetActionExecutionRow,
} from "../src/core/standardRail/actionStore.js";
import { authorizeStagedAction, loadDestructiveInput } from "../src/core/standardRail/actionStaged.js";
import {
  completeAssetAction,
  expireDestructiveAssetActions,
  markAssetActionAttention,
} from "../src/core/standardRail/actionCompletion.js";
import { decryptString, encryptString } from "../src/core/chain/encryption.js";
import { AssetOwnerChangedError } from "../src/core/standardRail/assetOwnerFence.js";

/// node-pg's own wire serializer: what a JSONB binding actually becomes.
const requireCjs = createRequire(import.meta.url);
const { prepareValue } = requireCjs("pg/lib/utils") as {
  prepareValue: (value: unknown) => unknown;
};

const h32 = (pair: string): Hex => `0x${pair.repeat(32)}` as Hex;
const buf32 = (pair: string): Buffer => Buffer.from(pair.repeat(32), "hex");
const future = (ms = 3_600_000): Date => new Date(Date.now() + ms);
const past = (ms = 60_000): Date => new Date(Date.now() - ms);

const EXECUTION_ID = h32("e1");
const TASK_ID = `asset-action-${"e1".repeat(32)}`;
const PAYER = `0x${"aa".repeat(20)}` as Hex;
const GATEWAY_SIGNER = `0x${"bb".repeat(20)}` as Address;
const ASSET_ID = "44444444-4444-4444-8444-444444444444";
const SERVICE_ID = "11111111-1111-4111-8111-111111111111";
const NOW_S = Math.floor(Date.now() / 1_000);

/// The reviewed launch abuse profile walletConfig pins.
const ABUSE = {
  requestsPerGatewaySignerPerMinute: 120,
  requestsPerPayerPerMinute: 30,
  requestsPerActionPerMinute: 120,
  requestsGlobalPerMinute: 300,
  destructiveOutstandingPerPayer: 5,
  destructiveOutstandingPerProvider: 100,
  destructiveOutstandingGlobal: 1_000,
};

type ClaimArgs = Parameters<typeof claimAssetAction>[0];
type AuthorizeArgs = Parameters<typeof authorizeStagedAction>[0];

function claimArgs(overrides: Partial<ClaimArgs> = {}): ClaimArgs {
  return {
    executionId: EXECUTION_ID,
    payer: PAYER,
    providerAssetId: ASSET_ID,
    serviceId: SERVICE_ID,
    skillId: "update-item",
    actionId: "update-item",
    actionHash: h32("a1"),
    requestHash: h32("b1"),
    walletAuthorizationHash: h32("c1"),
    walletNonce: h32("11"),
    grantHash: h32("d1"),
    grantNonce: h32("12"),
    providerControlProfileHash: h32("f1"),
    servicingAdmissionHash: h32("a2"),
    actionCatalogHash: h32("b2"),
    actionCatalogSchemaHash: h32("c2"),
    actionCatalogEpoch: 7,
    actionDefinitionHash: h32("d2"),
    replayPolicy: "stable-result",
    resultValidBefore: NOW_S + 3_600,
    gatewaySigner: GATEWAY_SIGNER,
    abuse: ABUSE,
    ...overrides,
  };
}

function authorizeArgs(overrides: Partial<AuthorizeArgs> = {}): AuthorizeArgs {
  return {
    followupExecutionId: h32("90"),
    executionId: EXECUTION_ID,
    payer: PAYER,
    providerAssetId: ASSET_ID,
    confirmationHash: h32("77"),
    operation: "confirm",
    actionId: "delete-item",
    actionHash: h32("a1"),
    requestHash: h32("92"),
    walletAuthorizationHash: h32("91"),
    walletNonce: h32("13"),
    grantHash: h32("d3"),
    grantNonce: h32("14"),
    providerControlProfileHash: h32("f1"),
    servicingAdmissionHash: h32("a2"),
    actionCatalogHash: h32("b2"),
    actionCatalogSchemaHash: h32("c2"),
    actionCatalogEpoch: 7,
    actionDefinitionHash: h32("d2"),
    gatewaySigner: GATEWAY_SIGNER,
    abuse: ABUSE,
    ...overrides,
  };
}

/// A stored execution whose hashes line up with claimArgs/authorizeArgs.
function seededRow(overrides: Partial<AssetActionExecutionRow> = {}): AssetActionExecutionRow {
  return {
    execution_id: buf32("e1"),
    payer: PAYER,
    provider_asset_id: ASSET_ID,
    action_hash: buf32("a1"),
    request_hash: buf32("b1"),
    wallet_authorization_hash: buf32("c1"),
    grant_hash: buf32("d1"),
    provider_control_profile_hash: buf32("f1"),
    servicing_admission_hash: buf32("a2"),
    action_catalog_hash: buf32("b2"),
    action_catalog_schema_hash: buf32("c2"),
    action_catalog_epoch: "7",
    action_definition_hash: buf32("d2"),
    replay_policy: "stable-result",
    state: "claimed",
    effect_summary: null,
    confirmation_hash: null,
    earliest_execution_at: null,
    stage_valid_before: null,
    result_valid_before: future(),
    result_redacted_at: null,
    sanitized_result: null,
    error_class: null,
    admitted_owner: PAYER,
    admitted_owner_version: 0,
    ...overrides,
  };
}

const stagedRow = (overrides: Partial<AssetActionExecutionRow> = {}): AssetActionExecutionRow =>
  seededRow({
    state: "staged",
    confirmation_hash: buf32("77"),
    earliest_execution_at: past(),
    stage_valid_before: future(),
    ...overrides,
  });

function transactionRow(
  id = TASK_ID,
  overrides: Record<string, unknown> = {},
): Record<string, any> {
  const createdAt = new Date(Date.now() - 60_000);
  return {
    id,
    customer_id: harness.customerId,
    standard_payer: PAYER,
    asset_id: ASSET_ID,
    service_id: SERVICE_ID,
    skill_id: "delete-item",
    service_ref: null,
    status: "working",
    contact_email: null,
    metadata: {},
    created_at: createdAt,
    updated_at: createdAt,
    completed_at: null,
    version: "1",
    ...overrides,
  };
}

/// Mirrors the store's private encryption-context builders. If the store's
/// context drifts, the round-trip decrypt assertions fail — that record
/// binding is the fixture's point.
const payloadContext = (executionId: Hex) => ({
  purpose: "destructive-asset-action",
  table: "standard_destructive_action_payloads",
  recordId: executionId,
  field: "encrypted_input",
  recordVersion: 1,
} as const);

const recoveryContext = (row: AssetActionExecutionRow) => ({
  purpose: "asset-action-recovery-result",
  table: "standard_asset_action_recovery_results",
  recordId: `0x${row.execution_id.toString("hex")}:${row.payer}:${row.provider_asset_id}` +
    `:0x${row.action_hash.toString("hex")}`,
  field: "encrypted_result",
  recordVersion: 1,
} as const);

const issued = (fragment: string) =>
  harness.calls.filter((call) => call.text.includes(fragment));

function only(fragment: string) {
  const matches = issued(fragment);
  expect(matches, `expected exactly one statement matching: ${fragment}`).toHaveLength(1);
  return matches[0]!;
}

const statements = (): string[] => harness.calls.map((call) => call.text);

beforeEach(() => {
  harness.reset();
});

describe("standard asset action store", () => {
  describe("claimAssetAction", () => {
    it("claims a fresh non-destructive action under the asset owner fence in one transaction", async () => {
      const result = await claimAssetAction(claimArgs());

      expect(result.replayed).toBe(false);
      expect(result.taskId).toBe(TASK_ID);
      expect(result.row.state).toBe("claimed");
      expect(result.row.execution_id).toEqual(buf32("e1"));
      expect(result.row.result_valid_before).toEqual(new Date((NOW_S + 3_600) * 1_000));

      const texts = statements();
      // Read committed: the owner read after the fence sees what committed
      // before the fence was granted.
      expect(texts[0]).toBe("BEGIN");
      expect(texts.at(-1)).toBe("COMMIT");
      expect(texts).not.toContain("ROLLBACK");
      expect(harness.state.releases).toBe(1);
      // The execution's own lock, then the asset owner fence.
      expect(issued("pg_advisory_xact_lock").map((call) => call.values[0])).toEqual([TASK_ID, ASSET_ID]);
      expect(issued("asset-owner:")).toHaveLength(1);
      expect(issued("INSERT INTO standard_asset_rate_buckets")).toHaveLength(4);
      expect(only("INSERT INTO customers").values).toEqual([PAYER]);
      expect(only("INSERT INTO standard_wallet_action_nonces").values).toEqual([
        PAYER, buf32("11"), buf32("a1"), buf32("b1"), buf32("c1"),
      ]);
      expect(only("INSERT INTO standard_provider_grant_nonces").values).toEqual([
        buf32("12"), buf32("d1"), PAYER,
      ]);
      const transaction = only("INSERT INTO transactions");
      expect(transaction.text).toContain("'working'");
      expect(transaction.values).toEqual([
        TASK_ID, harness.customerId, ASSET_ID, SERVICE_ID, "update-item",
        buf32("b1"), PAYER, buf32("e1"), PAYER, 0,
      ]);
      // Non-terminal insert: neither sanitized_result nor error_class may
      // appear (043/044 constraint branch for states outside completed/failed).
      const insert = only("INSERT INTO standard_asset_action_executions");
      expect(insert.text).not.toContain("sanitized_result");
      expect(insert.text).not.toContain("error_class");
      expect(insert.values).toEqual([
        buf32("e1"), PAYER, ASSET_ID, buf32("a1"), buf32("b1"), buf32("c1"), buf32("d1"),
        buf32("f1"), buf32("a2"), buf32("b2"), buf32("c2"), 7, buf32("d2"),
        "claimed", null, "stable-result", null, null, null, NOW_S + 3_600, PAYER, 0,
      ]);
      expect(issued("count(*) FILTER")).toHaveLength(0);
      expect(issued("standard_destructive_action_payloads")).toHaveLength(0);
    });

    it("stages a destructive action with caps, encrypted payload, and effect summary", async () => {
      const destructive = {
        input: { itemId: "sample-item", confirm: true },
        effectSummary: { actionId: "delete-item", itemId: "sample-item" },
        confirmationHash: h32("77"),
        earliestExecutionAt: NOW_S + 600,
        stageValidBefore: NOW_S + 1_200,
      };
      const result = await claimAssetAction(claimArgs({ actionId: "delete-item", destructive }));

      expect(result.row.state).toBe("staged");
      expect(issued("pg_advisory_xact_lock").map((call) => call.values[0])).toEqual([
        TASK_ID, "provider:destructive-stage-cap", ASSET_ID,
      ]);
      expect(only("count(*) FILTER").values).toEqual([PAYER]);
      const insert = only("INSERT INTO standard_asset_action_executions");
      expect(insert.values[13]).toBe("staged");
      expect(insert.values[16]).toEqual(buf32("77"));
      expect(insert.values[17]).toBe(NOW_S + 600);
      expect(insert.values[18]).toBe(NOW_S + 1_200);
      // JSONB effect_summary must reach the wire as JSON text, never a
      // Postgres array literal (the escalation JSONB defect class).
      expect(JSON.parse(String(prepareValue(insert.values[14])))).toEqual(destructive.effectSummary);
      const payload = only("INSERT INTO standard_destructive_action_payloads");
      expect(payload.values[0]).toEqual(buf32("e1"));
      expect(String(payload.values[1])).toMatch(/^daski:v1:/);
      expect(JSON.parse(decryptString(payload.values[1] as string, payloadContext(EXECUTION_ID))))
        .toEqual(destructive.input);
      expect(payload.values[2]).toBe(NOW_S + 1_200);
    });

    it("replays an identical claim consuming only the grant nonce", async () => {
      harness.state.executionRow = seededRow();
      const result = await claimAssetAction(claimArgs());

      expect(result.replayed).toBe(true);
      expect(result.row).toBe(harness.state.executionRow);
      expect(result.taskId).toBe(TASK_ID);
      expect(issued("INSERT INTO standard_asset_action_executions")).toHaveLength(0);
      expect(issued("INSERT INTO standard_wallet_action_nonces")).toHaveLength(0);
      expect(issued("INSERT INTO transactions")).toHaveLength(0);
      expect(only("INSERT INTO standard_provider_grant_nonces").values).toEqual([
        buf32("12"), buf32("d1"), PAYER,
      ]);
      expect(statements().at(-1)).toBe("COMMIT");
    });

    it("rejects a replay whose envelope differs from the stored execution", async () => {
      harness.state.executionRow = seededRow({ request_hash: buf32("ff") });
      await expect(claimAssetAction(claimArgs())).rejects.toThrow("asset action replay mismatch");
      expect(statements().at(-1)).toBe("ROLLBACK");
      expect(issued("INSERT INTO standard_provider_grant_nonces")).toHaveLength(0);
      expect(harness.state.releases).toBe(1);
    });

    it("refuses a claim whose payer is not the asset's current owner, consuming nothing", async () => {
      harness.state.owner = { payer: `0x${"cd".repeat(20)}`, version: 1 };
      await expect(claimAssetAction(claimArgs())).rejects.toBeInstanceOf(AssetOwnerChangedError);
      expect(statements().at(-1)).toBe("ROLLBACK");
      expect(issued("INSERT INTO standard_wallet_action_nonces")).toHaveLength(0);
      expect(issued("INSERT INTO standard_provider_grant_nonces")).toHaveLength(0);
      expect(issued("INSERT INTO standard_asset_action_executions")).toHaveLength(0);
    });

    it("records the current owner version an execution is admitted under", async () => {
      harness.state.owner = { payer: PAYER, version: 3 };
      const result = await claimAssetAction(claimArgs());
      expect(result.row).toMatchObject({ admitted_owner: PAYER, admitted_owner_version: 3 });
      expect(only("INSERT INTO transactions").values.slice(-2)).toEqual([PAYER, 3]);
    });

    it("refuses to stage past the outstanding destructive caps", async () => {
      harness.state.stagedCounts = { payer_count: "5", provider_count: "5" };
      await expect(claimAssetAction(claimArgs({
        destructive: {
          input: {}, effectSummary: {}, confirmationHash: h32("77"),
          earliestExecutionAt: NOW_S + 600, stageValidBefore: NOW_S + 1_200,
        },
      }))).rejects.toThrow("destructive action capacity exceeded");
      expect(statements().at(-1)).toBe("ROLLBACK");
      expect(issued("INSERT INTO customers")).toHaveLength(0);
    });

    it("propagates the endpoint rate limit before reading execution state", async () => {
      harness.state.rateCount = 999;
      await expect(claimAssetAction(claimArgs())).rejects.toThrow(
        "provider asset rate limit exceeded",
      );
      expect(issued("SELECT * FROM standard_asset_action_executions")).toHaveLength(0);
      expect(statements().at(-1)).toBe("ROLLBACK");
    });
  });

  describe("loadDestructiveInput", () => {
    it("decrypts a staged payload bound to its execution id", async () => {
      harness.state.payloadRow = {
        encrypted_input: encryptString(
          JSON.stringify({ itemId: "sample-item" }), payloadContext(EXECUTION_ID),
        ),
        expires_at: future(),
      };
      await expect(loadDestructiveInput(EXECUTION_ID)).resolves.toEqual({
        itemId: "sample-item",
      });
      expect(only("SELECT encrypted_input,expires_at").values).toEqual([buf32("e1")]);
    });

    it("treats a missing or lapsed payload as expired", async () => {
      await expect(loadDestructiveInput(EXECUTION_ID)).rejects.toThrow("staged action expired");
      harness.state.payloadRow = { encrypted_input: "unused", expires_at: past() };
      await expect(loadDestructiveInput(EXECUTION_ID)).rejects.toThrow("staged action expired");
    });

    it("rejects a staged payload that is not a JSON object", async () => {
      harness.state.payloadRow = {
        encrypted_input: encryptString(
          JSON.stringify(["not", "an", "object"]), payloadContext(EXECUTION_ID),
        ),
        expires_at: future(),
      };
      await expect(loadDestructiveInput(EXECUTION_ID)).rejects.toThrow("staged input invalid");
    });
  });

  describe("authorizeStagedAction", () => {
    it("confirms a staged action into executing and extends the payload window", async () => {
      const row = stagedRow();
      harness.state.executionRow = row;
      const result = await authorizeStagedAction(authorizeArgs());

      expect(result).toEqual({ row, taskId: TASK_ID, replayed: false });
      expect(row.state).toBe("executing");
      expect(only("INSERT INTO standard_wallet_action_nonces").values).toEqual([
        PAYER, buf32("13"), buf32("a1"), buf32("92"), buf32("91"),
      ]);
      expect(only("INSERT INTO standard_destructive_followup_executions").values).toEqual([
        buf32("90"), buf32("e1"), PAYER, "confirm", buf32("77"), buf32("91"), buf32("92"),
      ]);
      // Confirmation re-admits the work under the fence for the current owner.
      expect(only("reconciliation_identity=CASE").values).toEqual([
        buf32("e1"), "executing", TASK_ID, PAYER, 0,
      ]);
      expect(only("UPDATE transactions SET admitted_owner=$2").values).toEqual([TASK_ID, PAYER, 0]);
      const locks = issued("pg_advisory_xact_lock").map((call) => call.values[0]);
      expect(locks).toEqual([TASK_ID, ASSET_ID, ASSET_ID]);
      expect(statements().findIndex((text) => text.includes("asset-owner:")))
        .toBeLessThan(statements().findIndex((text) => text.includes("FOR UPDATE")));
      expect(only("UPDATE standard_destructive_action_payloads SET expires_at=$2").values)
        .toEqual([buf32("e1"), row.result_valid_before]);
      expect(issued("DELETE FROM standard_destructive_action_payloads")).toHaveLength(0);
      expect(statements().at(-1)).toBe("COMMIT");
    });

    it("cancels a staged action and drops its encrypted payload", async () => {
      harness.state.executionRow = stagedRow();
      const transaction = transactionRow();
      harness.state.transactionRows.set(TASK_ID, transaction);
      const result = await authorizeStagedAction(authorizeArgs({ operation: "cancel" }));

      expect(result.row.state).toBe("canceled");
      expect(only("reconciliation_identity=CASE").values).toEqual([
        buf32("e1"), "canceled", TASK_ID, PAYER, 0,
      ]);
      expect(issued("UPDATE transactions SET admitted_owner=$2")).toHaveLength(0);
      expect(only("DELETE FROM standard_destructive_action_payloads").values).toEqual([buf32("e1")]);
      expect(issued("UPDATE standard_destructive_action_payloads SET expires_at=$2")).toHaveLength(0);
      expect(transaction.status).toBe("canceled");
      expect(transaction.version).toBe("2");
      expect(transaction.completed_at).toBeInstanceOf(Date);
      expect(transaction.metadata).toMatchObject({
        asset_action_state: "canceled",
        asset_action_terminal_reason: "wallet_canceled",
      });
      expect(only("UPDATE transactions SET status = $2").values).toEqual([
        TASK_ID, "canceled", true, "working", "1",
      ]);
      const audit = only("INSERT INTO events");
      expect(audit.values[1]).toBe(TASK_ID);
      expect(audit.values[6]).toBe("asset_action.canceled");
      expect(JSON.parse(String(audit.values[8]))).toMatchObject({
        actionState: "canceled",
        reason: "wallet_canceled",
        transactionStatus: "canceled",
      });
      expect(statements().at(-1)).toBe("COMMIT");
    });

    it("replays a canceled follow-up without duplicating its transaction transition", async () => {
      harness.state.executionRow = seededRow({
        state: "canceled",
        confirmation_hash: buf32("77"),
      });
      harness.state.followupRow = {
        followup_execution_id: buf32("90"), action_execution_id: buf32("e1"), payer: PAYER,
        operation: "cancel", confirmation_hash: buf32("77"),
        wallet_authorization_hash: buf32("91"), request_hash: buf32("92"),
      };
      harness.state.transactionRows.set(TASK_ID, transactionRow(TASK_ID, {
        status: "canceled",
        completed_at: new Date(),
        version: "2",
      }));

      const result = await authorizeStagedAction(authorizeArgs({ operation: "cancel" }));

      expect(result.replayed).toBe(true);
      expect(issued("UPDATE transactions SET status = $2")).toHaveLength(0);
      expect(issued("INSERT INTO events")).toHaveLength(0);
      expect(statements().at(-1)).toBe("COMMIT");
    });

    it("rolls back cancellation when the linked transaction is already completed", async () => {
      harness.state.executionRow = stagedRow();
      harness.state.transactionRows.set(TASK_ID, transactionRow(TASK_ID, {
        status: "completed",
        completed_at: new Date(),
      }));

      await expect(
        authorizeStagedAction(authorizeArgs({ operation: "cancel" })),
      ).rejects.toThrow(`Asset action transaction ${TASK_ID} cannot be canceled from completed`);

      expect(issued("UPDATE transactions SET status = $2")).toHaveLength(0);
      expect(issued("INSERT INTO events")).toHaveLength(0);
      expect(statements().at(-1)).toBe("ROLLBACK");
    });

    it("replays a recorded follow-up without new writes or a state change", async () => {
      harness.state.executionRow = seededRow({ state: "completed", confirmation_hash: buf32("77") });
      harness.state.followupRow = {
        followup_execution_id: buf32("90"), action_execution_id: buf32("e1"), payer: PAYER,
        operation: "confirm", confirmation_hash: buf32("77"),
        wallet_authorization_hash: buf32("91"), request_hash: buf32("92"),
      };
      const result = await authorizeStagedAction(authorizeArgs());

      expect(result.replayed).toBe(true);
      expect(result.row.state).toBe("completed");
      expect(issued("INSERT INTO standard_wallet_action_nonces")).toHaveLength(0);
      expect(issued("INSERT INTO standard_destructive_followup_executions")).toHaveLength(0);
      expect(issued("reconciliation_identity=CASE")).toHaveLength(0);
      expect(only("INSERT INTO standard_provider_grant_nonces").values).toEqual([
        buf32("14"), buf32("d3"), PAYER,
      ]);
      expect(statements().at(-1)).toBe("COMMIT");
    });

    it("rejects a follow-up replay whose envelope differs", async () => {
      harness.state.executionRow = seededRow({ state: "canceled", confirmation_hash: buf32("77") });
      harness.state.followupRow = {
        followup_execution_id: buf32("90"), action_execution_id: buf32("e1"), payer: PAYER,
        operation: "cancel", confirmation_hash: buf32("77"),
        wallet_authorization_hash: buf32("91"), request_hash: buf32("92"),
      };
      await expect(authorizeStagedAction(authorizeArgs())).rejects.toThrow(
        "staged action replay mismatch",
      );
      expect(statements().at(-1)).toBe("ROLLBACK");
    });

    it("refuses a follow-up whose request names another asset than its staged row", async () => {
      harness.state.executionRow = stagedRow();
      await expect(authorizeStagedAction(authorizeArgs({
        providerAssetId: "55555555-5555-4555-8555-555555555555",
      }))).rejects.toThrow("staged action target mismatch");
      expect(issued("INSERT INTO standard_wallet_action_nonces")).toHaveLength(0);
      expect(issued("INSERT INTO standard_destructive_followup_executions")).toHaveLength(0);
      expect(issued("INSERT INTO standard_provider_grant_nonces")).toHaveLength(0);
      expect(statements().at(-1)).toBe("ROLLBACK");
    });

    it("refuses a confirmation from a wallet that no longer owns the asset", async () => {
      harness.state.executionRow = stagedRow();
      harness.state.owner = { payer: `0x${"cd".repeat(20)}`, version: 1 };
      await expect(authorizeStagedAction(authorizeArgs())).rejects.toBeInstanceOf(AssetOwnerChangedError);
      expect(issued("reconciliation_identity=CASE")).toHaveLength(0);
      expect(statements().at(-1)).toBe("ROLLBACK");
    });

    it.each([
      ["the execution is unknown",
        () => { harness.state.executionRow = null; }],
      ["the stage window has lapsed",
        () => { harness.state.executionRow = stagedRow({ stage_valid_before: past() }); }],
      ["confirmation arrives before the delay elapses",
        () => { harness.state.executionRow = stagedRow({ earliest_execution_at: future() }); }],
      ["the confirmation hash does not match",
        () => { harness.state.executionRow = stagedRow({ confirmation_hash: buf32("78") }); }],
    ])("refuses when %s", async (_name, seed) => {
      seed();
      await expect(authorizeStagedAction(authorizeArgs())).rejects.toThrow(
        "staged action unavailable",
      );
      expect(statements().at(-1)).toBe("ROLLBACK");
      expect(harness.state.releases).toBe(1);
    });
  });

  describe("transitionAssetAction", () => {
    it("advances a guarded state transition and reports success", async () => {
      await expect(
        transitionAssetAction(EXECUTION_ID, "claimed", "executing", "worker-7"),
      ).resolves.toBe(true);
      expect(only("COALESCE(reconciliation_identity,$4)").values).toEqual([
        buf32("e1"), "claimed", "executing", "worker-7",
      ]);
      expect(issued("DELETE FROM standard_destructive_action_payloads")).toHaveLength(0);
    });

    it("drops the staged payload when the transition reaches a terminal state", async () => {
      await expect(transitionAssetAction(EXECUTION_ID, "executing", "completed")).resolves.toBe(true);
      expect(only("COALESCE(reconciliation_identity,$4)").values[3]).toBeNull();
      expect(only("DELETE FROM standard_destructive_action_payloads").values).toEqual([buf32("e1")]);
    });

    it("reports a lost transition race instead of throwing", async () => {
      harness.state.transitionRowCount = 0;
      await expect(transitionAssetAction(EXECUTION_ID, "claimed", "expired")).resolves.toBe(false);
    });
  });

  describe("execution reads", () => {
    it("loads an execution by id and throws when it is unknown", async () => {
      const row = seededRow();
      harness.state.executionRow = row;
      await expect(loadAssetActionExecution(EXECUTION_ID)).resolves.toBe(row);
      expect(only("SELECT * FROM standard_asset_action_executions").values).toEqual([buf32("e1")]);
      harness.state.executionRow = null;
      await expect(loadAssetActionExecution(EXECUTION_ID)).rejects.toThrow(
        "asset action unavailable",
      );
    });

    it("loads the execution behind a task id and returns null when absent", async () => {
      const row = seededRow();
      harness.state.taskRow = row;
      await expect(loadAssetActionForTask(TASK_ID)).resolves.toBe(row);
      expect(only("JOIN transactions t ON").values).toEqual([TASK_ID]);
      harness.state.taskRow = null;
      await expect(loadAssetActionForTask(TASK_ID)).resolves.toBeNull();
    });

    it("loads asset-action substates for operator transaction batches in one query", async () => {
      const stagedTaskId = `asset-action-${"31".repeat(32)}`;
      harness.state.actionStateRows = [
        { task_id: TASK_ID, state: "canceled" },
        { task_id: stagedTaskId, state: "staged" },
      ];

      const states = await loadAssetActionStatesForTasks([TASK_ID, stagedTaskId]);

      expect(states).toEqual(new Map([
        [TASK_ID, "canceled"],
        [stagedTaskId, "staged"],
      ]));
      expect(only("WHERE t.id=ANY($1::text[])").values).toEqual([[TASK_ID, stagedTaskId]]);
      const callCount = harness.calls.length;
      await expect(loadAssetActionStatesForTasks([])).resolves.toEqual(new Map());
      expect(harness.calls).toHaveLength(callCount);
    });
  });

  describe("markAssetActionAttention", () => {
    it("marks a live execution for attention only from claimable states", async () => {
      await markAssetActionAttention(EXECUTION_ID);
      const update = only("SET state='attention'");
      expect(update.text).toContain(
        "WHERE execution_id=$1 AND state IN ('claimed','executing','attention')",
      );
      expect(update.values).toEqual([buf32("e1")]);
    });

    it("throws when the attention transition lost its claim", async () => {
      harness.state.attentionRowCount = 0;
      await expect(markAssetActionAttention(EXECUTION_ID)).rejects.toThrow(
        "asset action attention transition lost its claim",
      );
    });
  });

  describe("completeAssetAction", () => {
    it("completes a stable-result action into the encrypted recovery table", async () => {
      const row = seededRow({ state: "executing" });
      harness.state.executionRow = row;
      await completeAssetAction({
        executionId: EXECUTION_ID, status: "completed",
        result: { receipt: "result-1" }, errorClass: null,
      });

      const recovery = only("INSERT INTO standard_asset_action_recovery_results");
      expect(recovery.values[0]).toEqual(buf32("e1"));
      expect(String(recovery.values[1])).toMatch(/^daski:v1:/);
      expect(JSON.parse(decryptString(recovery.values[1] as string, recoveryContext(row))))
        .toEqual({ receipt: "result-1" });
      expect(recovery.values[2]).toBe(row.result_valid_before);
      // 044 completed branch: sanitized_result pinned NULL in the statement,
      // error_class bound NULL — the result exists only encrypted.
      const update = only("sanitized_result=NULL,error_class=$3");
      expect(update.values).toEqual([buf32("e1"), "completed", null]);
      expect(update.text).toContain("state IN ('claimed','executing','attention')");
      only("DELETE FROM standard_destructive_action_payloads");
      expect(issued("DELETE FROM artifact_secrets")).toHaveLength(0);
      expect(statements().at(-1)).toBe("COMMIT");
    });

    it("completes a regenerate-ephemeral action without persisting any result", async () => {
      harness.state.executionRow = seededRow({
        state: "claimed", replay_policy: "regenerate-ephemeral",
      });
      await completeAssetAction({
        executionId: EXECUTION_ID, status: "completed", result: null, errorClass: null,
      });
      expect(issued("INSERT INTO standard_asset_action_recovery_results")).toHaveLength(0);
      expect(only("sanitized_result=NULL,error_class=$3").values).toEqual([
        buf32("e1"), "completed", null,
      ]);
    });

    it("completes a redacted-after-window action and purges its artifact secrets", async () => {
      harness.state.executionRow = seededRow({
        state: "executing", replay_policy: "redacted-after-window",
      });
      await completeAssetAction({
        executionId: EXECUTION_ID, status: "completed",
        result: { password: "rotated" }, errorClass: null,
      });
      only("INSERT INTO standard_asset_action_recovery_results");
      expect(only("DELETE FROM artifact_secrets").values).toEqual([TASK_ID]);
    });

    it("withholds a result admitted under a stale owner version and records the failure", async () => {
      harness.state.executionRow = seededRow({ state: "executing" });
      harness.state.owner = { payer: PAYER, version: 1 };
      const transaction = transactionRow();
      harness.state.transactionRows.set(TASK_ID, transaction);
      await expect(completeAssetAction({
        executionId: EXECUTION_ID, status: "completed", result: { receipt: "result-1" }, errorClass: null,
      })).rejects.toBeInstanceOf(AssetOwnerChangedError);

      expect(issued("INSERT INTO standard_asset_action_recovery_results")).toHaveLength(0);
      expect(issued("sanitized_result=NULL,error_class=$3")).toHaveLength(0);
      expect(only("SET state='failed',error_class=$2,sanitized_result=NULL").values)
        .toEqual([buf32("e1"), "asset_owner_changed"]);
      expect(only("DELETE FROM artifact_secrets").values).toEqual([TASK_ID]);
      expect(transaction.status).toBe("failed");
      const audits = issued("INSERT INTO events").map((call) => call.values[6]);
      expect(audits).toContain("asset_owner.result_withheld");
      expect(statements().at(-1)).toBe("COMMIT");
    });

    it("refuses to complete a recoverable action without its result", async () => {
      harness.state.executionRow = seededRow({ state: "executing" });
      await expect(completeAssetAction({
        executionId: EXECUTION_ID, status: "completed", result: null, errorClass: null,
      })).rejects.toThrow("recoverable action result is missing");
      expect(issued("INSERT INTO standard_asset_action_recovery_results")).toHaveLength(0);
      expect(issued("sanitized_result=NULL,error_class=$3")).toHaveLength(0);
      expect(statements().at(-1)).toBe("ROLLBACK");
    });

    it("fails an action with its error class and never a stored result", async () => {
      harness.state.executionRow = seededRow({ state: "attention" });
      await completeAssetAction({
        executionId: EXECUTION_ID, status: "failed",
        result: { partial: true }, errorClass: "supplier_unreachable",
      });
      expect(issued("INSERT INTO standard_asset_action_recovery_results")).toHaveLength(0);
      // 044 failed branch: error_class carried, sanitized_result pinned NULL.
      expect(only("sanitized_result=NULL,error_class=$3").values).toEqual([
        buf32("e1"), "failed", "supplier_unreachable",
      ]);
      expect(issued("DELETE FROM artifact_secrets")).toHaveLength(0);
    });

    it("throws when the completion select finds no live claim, even if rollback fails", async () => {
      harness.state.failRollback = true;
      await expect(completeAssetAction({
        executionId: EXECUTION_ID, status: "completed", result: { ok: 1 }, errorClass: null,
      })).rejects.toThrow("asset action completion lost its claim");
      expect(statements().at(-1)).toBe("ROLLBACK");
      expect(harness.state.releases).toBe(1);
    });

    it("throws when the guarded update loses a concurrent race", async () => {
      harness.state.executionRow = seededRow({
        state: "executing", replay_policy: "regenerate-ephemeral",
      });
      harness.state.completeUpdateRowCount = 0;
      await expect(completeAssetAction({
        executionId: EXECUTION_ID, status: "completed", result: null, errorClass: null,
      })).rejects.toThrow("asset action completion lost its claim");
      expect(statements().at(-1)).toBe("ROLLBACK");
    });
  });

  describe("loadAssetActionRecoveryResult", () => {
    it("decrypts the recovery result under the row-bound context", async () => {
      const row = seededRow();
      harness.state.recoveryRow = {
        encrypted_result: encryptString(JSON.stringify({ receipt: "result-1" }), recoveryContext(row)),
        expires_at: future(),
      };
      await expect(loadAssetActionRecoveryResult(row)).resolves.toEqual({ receipt: "result-1" });
      expect(only("SELECT encrypted_result,expires_at").values).toEqual([row.execution_id]);
    });

    it("refuses once the result window passed, without touching the database", async () => {
      await expect(loadAssetActionRecoveryResult(seededRow({ result_valid_before: past() })))
        .rejects.toThrow("asset action recovery expired");
      expect(harness.calls).toHaveLength(0);
    });

    it("treats a missing or expired recovery row as unavailable", async () => {
      const row = seededRow();
      await expect(loadAssetActionRecoveryResult(row)).rejects.toThrow(
        "asset action recovery unavailable",
      );
      harness.state.recoveryRow = { encrypted_result: "unused", expires_at: past() };
      await expect(loadAssetActionRecoveryResult(row)).rejects.toThrow(
        "asset action recovery unavailable",
      );
    });

    it("rejects a recovery payload that is not a JSON object", async () => {
      const row = seededRow();
      harness.state.recoveryRow = {
        encrypted_result: encryptString(JSON.stringify(7), recoveryContext(row)),
        expires_at: future(),
      };
      await expect(loadAssetActionRecoveryResult(row)).rejects.toThrow(
        "asset action recovery result invalid",
      );
    });
  });

  describe("expireDestructiveAssetActions", () => {
    it("expires staged actions, flags overdue executions, and redacts lapsed results", async () => {
      harness.state.expiredRows = [{ execution_id: buf32("31") }];
      harness.state.overdueRows = [{ execution_id: buf32("32") }];
      const expiredTaskId = `asset-action-${"31".repeat(32)}`;
      const transaction = transactionRow(expiredTaskId);
      harness.state.transactionRows.set(expiredTaskId, transaction);
      await expect(expireDestructiveAssetActions()).resolves.toEqual({ expired: 1, attention: 1 });

      expect(only("SET state='expired'").text).toContain(
        "WHERE state='staged' AND stage_valid_before<=now()",
      );
      const overdue = only("WHERE state='executing' AND result_valid_before<=now()");
      expect(overdue.text).toContain("error_class=NULL,sanitized_result=NULL");
      // Redaction keeps completed rows constraint-clean: sanitized_result
      // NULL with result_redacted_at stamped exactly once.
      const redaction = only("result_redacted_at=COALESCE(result_redacted_at,now())");
      expect(redaction.text).toContain("sanitized_result=NULL");
      expect(redaction.text).toContain(
        "WHERE state='completed' AND result_redacted_at IS NULL AND result_valid_before<=now()",
      );
      expect(only("ANY($1::bytea[])").values).toEqual([[buf32("31"), buf32("32")]]);
      expect(transaction.status).toBe("canceled");
      expect(transaction.version).toBe("2");
      expect(transaction.metadata).toMatchObject({
        asset_action_state: "expired",
        asset_action_terminal_reason: "confirmation_expired",
      });
      expect(only("UPDATE transactions SET status = $2").values).toEqual([
        expiredTaskId, "canceled", true, "working", "1",
      ]);
      const audit = only("INSERT INTO events");
      expect(audit.values[1]).toBe(expiredTaskId);
      expect(audit.values[6]).toBe("asset_action.expired");
      only("DELETE FROM standard_asset_action_recovery_results");
      only("DELETE FROM standard_wallet_action_nonces");
      only("DELETE FROM standard_provider_grant_nonces");
      only("DELETE FROM standard_asset_rate_buckets");
      expect(statements().at(-1)).toBe("COMMIT");
    });

    it("sweeps cleanly when nothing is due", async () => {
      await expect(expireDestructiveAssetActions()).resolves.toEqual({ expired: 0, attention: 0 });
      expect(issued("ANY($1::bytea[])")).toHaveLength(0);
      expect(statements().at(-1)).toBe("COMMIT");
    });

    it("rethrows the sweep failure even when the rollback itself fails", async () => {
      harness.state.failFragment = "DELETE FROM standard_asset_action_recovery_results";
      harness.state.failRollback = true;
      await expect(expireDestructiveAssetActions()).rejects.toThrow("simulated statement failure");
      expect(statements().at(-1)).toBe("ROLLBACK");
      expect(harness.state.releases).toBe(1);
    });
  });
});
