import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import type { ProviderWalletLaunchPolicy } from "../src/core/standardRail/launchPolicy.js";
import type { ProviderWalletConfig } from "../src/core/standardRail/walletConfig.js";

// The stuck read-only asset-action sweep against a disposable, fully migrated
// PostgreSQL database: an execution parked in attention whose authorization
// has long expired is closed with its task, and every execution something
// else may still own is left alone.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });
vi.mock("../src/core/db/pool.js", async () => (await import("./assetActionHarness.js")).poolModule());
vi.mock("../src/core/serviceRegistry/registry.js", async () => (await import("./assetActionHarness.js")).registryModule());

const { ACTIONS, lower, payerA, startAssetHarness, wallet } = await import("./assetActionHarness.js");
const { createEscalation } = await import("../src/core/db/queries/escalations.js");
const { claimAssetAction, transitionAssetAction } = await import("../src/core/standardRail/actionStore.js");
const { markAssetActionAttention } = await import("../src/core/standardRail/actionCompletion.js");
const {
  failStuckReadAssetActions,
  readOnlyActionDefinitionHashes,
  STUCK_READ_ACTION_REASON,
} = await import("../src/core/standardRail/actionAttentionSweep.js");

const unique = (): Hex => `0x${randomBytes(32).toString("hex")}`;
const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");
const NOW_S = Math.floor(Date.now() / 1_000);
const READ_DEFINITION = unique();
const MUTATE_DEFINITION = unique();
const RESUMED_DEFINITION = unique();
const READ_SET = [READ_DEFINITION];
const GATEWAY = `0x${"31".repeat(20)}` as Hex;

describe("readOnlyActionDefinitionHashes", () => {
  const action = (actionId: string, destructive: boolean, hash: Hex) => ({
    serviceSlug: "notes", actionId, destructive, actionDefinitionHash: hash,
  });
  const policy = (entries: Array<{ actionId: string; effect: string }>) => ({
    assetActions: entries.map(({ actionId, effect }) => ({ serviceSlug: "notes", actionId, effect })),
  }) as unknown as ProviderWalletLaunchPolicy;

  it("keeps only non-destructive catalog actions installed with the read effect", () => {
    const [peek, touch, remove, uninstalled] = [unique(), unique(), unique(), unique()];
    const config = {
      catalog: { actions: [
        action("peek-note", false, peek), action("touch-note", false, touch),
        action("remove-note", true, remove), action("unknown-note", false, uninstalled),
      ] },
    } as unknown as ProviderWalletConfig;
    expect(readOnlyActionDefinitionHashes(config, policy([
      { actionId: "peek-note", effect: "read" },
      { actionId: "touch-note", effect: "mutate" },
      { actionId: "remove-note", effect: "read" },
    ]))).toEqual([peek]);
  });
});

describe("stuck read-only asset actions against PostgreSQL", () => {
  let harness: Awaited<ReturnType<typeof startAssetHarness>>;

  beforeAll(async () => {
    harness = await startAssetHarness("stuck_read");
  });

  afterAll(async () => {
    await harness?.close();
  });

  /** An attention execution for an owned note, optionally aged past the grace window. */
  async function parked(options: {
    definition?: Hex;
    aged?: boolean;
    destructive?: boolean;
  } = {}): Promise<{ executionId: Hex; taskId: string }> {
    const assetId = await harness.ownedNote(payerA);
    const executionId = unique();
    const action = options.destructive ? ACTIONS.remove : ACTIONS.peek;
    const claim = await claimAssetAction({
      executionId, payer: lower(payerA), providerAssetId: assetId, serviceId: harness.serviceId,
      skillId: action.actionId, actionId: action.actionId,
      actionHash: unique(), requestHash: unique(), walletAuthorizationHash: unique(), walletNonce: unique(),
      grantHash: unique(), grantNonce: unique(), providerControlProfileHash: unique(),
      servicingAdmissionHash: unique(), actionCatalogHash: unique(), actionCatalogSchemaHash: unique(),
      actionCatalogEpoch: 7, actionDefinitionHash: options.definition ?? READ_DEFINITION,
      replayPolicy: "stable-result", resultValidBefore: NOW_S + 31_536_000,
      gatewaySigner: GATEWAY, abuse: wallet.abuse,
      ...(options.destructive ? { destructive: {
        input: { note: "remove" }, effectSummary: { effect: "permanent removal" }, confirmationHash: unique(),
        earliestExecutionAt: NOW_S - 60, stageValidBefore: NOW_S + 600,
      } } : {}),
    });
    if (options.destructive) {
      await harness.database.pool.query(
        "UPDATE standard_asset_action_executions SET state='attention' WHERE execution_id=$1",
        [bytes(executionId)],
      );
    } else {
      expect(await transitionAssetAction(executionId, "claimed", "executing", claim.taskId)).toBe(true);
      await markAssetActionAttention(executionId);
    }
    if (options.aged !== false) {
      await harness.database.pool.query(
        `UPDATE standard_asset_action_executions
            SET created_at=now()-interval '2 hours', updated_at=now()-interval '2 hours'
          WHERE execution_id=$1`,
        [bytes(executionId)],
      );
    }
    return { executionId, taskId: claim.taskId };
  }

  async function state(executionId: Hex, taskId: string) {
    const execution = await harness.database.pool.query<{ state: string; error_class: string | null }>(
      "SELECT state,error_class FROM standard_asset_action_executions WHERE execution_id=$1",
      [bytes(executionId)],
    );
    const task = await harness.database.pool.query<{ status: string; metadata: Record<string, unknown> }>(
      "SELECT status,metadata FROM transactions WHERE id=$1",
      [taskId],
    );
    return { ...execution.rows[0]!, task: task.rows[0]! };
  }

  it("fails only eligible stuck read actions, finalizes their tasks once, and leaves the rest", async () => {
    const stuck = await parked();
    const recent = await parked({ aged: false });
    const mutate = await parked({ definition: MUTATE_DEFINITION });
    const reviewed = await parked();
    await createEscalation({
      transaction_id: reviewed.taskId, question: "Review", source: "auto",
      status: "awaiting_human", assignee: "human", review_kind: "operational_review",
      dedupe_key: `operational_review:${reviewed.taskId}`, target_type: "transaction", target_id: reviewed.taskId,
    });
    const staged = await parked({ destructive: true });
    const journaled = await parked();
    await harness.database.pool.query(
      `INSERT INTO supplier_operations(service_id,transaction_id,op_key,kind,state)
       VALUES ($1,$2,'peek','read','ambiguous')`,
      [harness.serviceId, journaled.taskId],
    );

    await expect(failStuckReadAssetActions({ definitionHashes: READ_SET })).resolves.toBe(1);

    const closed = await state(stuck.executionId, stuck.taskId);
    expect(closed).toMatchObject({ state: "failed", error_class: "provider_failed" });
    expect(closed.task.status).toBe("failed");
    expect(closed.task.metadata).toMatchObject({
      asset_action_state: "failed",
      asset_action_terminal_reason: STUCK_READ_ACTION_REASON,
    });
    const audit = await harness.database.pool.query<{ type: string }>(
      "SELECT type FROM events WHERE transaction_id=$1 ORDER BY created_at",
      [stuck.taskId],
    );
    expect(audit.rows.map((row) => row.type)).toContain("asset_action.failed");

    for (const untouched of [recent, mutate, reviewed, staged, journaled]) {
      const row = await state(untouched.executionId, untouched.taskId);
      expect(row.state).toBe("attention");
      expect(row.error_class).toBeNull();
      expect(row.task.status).toBe("working");
    }

    // Idempotent: a second pass finds nothing to close and writes nothing.
    const count = async () => Number((await harness.database.pool.query(
      "SELECT count(*)::int AS n FROM events WHERE transaction_id=$1", [stuck.taskId],
    )).rows[0].n);
    const events = await count();
    await expect(failStuckReadAssetActions({ definitionHashes: READ_SET })).resolves.toBe(0);
    expect(await count()).toBe(events);
  });

  it("never shortens the grace window below an hour and does nothing without a configured set", async () => {
    const recentish = await parked({ aged: false });
    await harness.database.pool.query(
      `UPDATE standard_asset_action_executions
          SET created_at=now()-interval '20 minutes', updated_at=now()-interval '20 minutes'
        WHERE execution_id=$1`,
      [bytes(recentish.executionId)],
    );
    await expect(failStuckReadAssetActions({ definitionHashes: READ_SET, graceSeconds: 60 })).resolves.toBe(0);
    const aged = await parked();
    await expect(failStuckReadAssetActions()).resolves.toBe(0);
    expect((await state(aged.executionId, aged.taskId)).state).toBe("attention");
    expect((await state(recentish.executionId, recentish.taskId)).state).toBe("attention");
  });

  it("leaves an execution that left attention before the sweep locked it", async () => {
    const resumed = await parked({ definition: RESUMED_DEFINITION });
    // A Review resumption re-admits the execution before the sweep takes its locks.
    await harness.database.pool.query(
      "UPDATE standard_asset_action_executions SET state='executing' WHERE execution_id=$1",
      [bytes(resumed.executionId)],
    );
    await expect(failStuckReadAssetActions({ definitionHashes: [RESUMED_DEFINITION] })).resolves.toBe(0);
    expect((await state(resumed.executionId, resumed.taskId)).state).toBe("executing");
  });
});
