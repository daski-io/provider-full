import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterResult } from "../src/core/serviceRegistry/types.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });
vi.mock("../src/core/db/pool.js", async () => (await import("./assetActionHarness.js")).poolModule());
vi.mock("../src/core/serviceRegistry/registry.js", async () => (await import("./assetActionHarness.js")).registryModule());
const review = vi.hoisted(() => ({ during: null as null | (() => Promise<void>) }));
vi.mock("../src/core/engine/preExecuteRunner.js", () => ({
  consultPreExecuteAgent: async () => {
    await review.during?.();
    return { action: "proceed" };
  },
  applyPreExecuteDecision: async () => ({ terminal: false }),
}));

const {
  ACTIONS, CHAIN_ID, assetWire, lower, payerA, payerB, regrant, signedAction, standard, startAssetHarness, wallet,
} = await import("./assetActionHarness.js");
const { ProviderAssetActionService } = await import("../src/core/standardRail/assetAction.js");
const { AssetOwnerChangedError } = await import("../src/core/standardRail/assetOwnerFence.js");
const { admitPaidTaskForAsset } = await import("../src/core/standardRail/assetOwnerAdmission.js");
const { processAdapterResult } = await import("../src/core/engine/taskFinalization.js");
const { classifyProviderAssetError } = await import("../src/core/standardRail/routes.js");

// F-T08 against PostgreSQL: owner-only work resolves its owner through the
// one authority and is admitted under the asset owner fence with that
// owner's version; a wrong target, a stale owner version, a release racing
// an owner change and a replayed destructive request can neither expose nor
// mutate the asset. No owner-change path ships, so `changeOwner` writes the
// synthetic owner versions a fork's owner swap would, under the fence.
let harness: Awaited<ReturnType<typeof startAssetHarness>>;
const actions = () => new ProviderAssetActionService(standard, wallet, CHAIN_ID);
const executed: Array<{ skillId: string; assetId: string | undefined }> = [];
let onExecute: () => Promise<AdapterResult> = async () => receipt("touched");

function receipt(value: string): AdapterResult {
  return { status: "completed", message: "Done.", artifacts: [{ name: "note_receipt", data: { receipt: value } }] };
}

assetWire.adapter = {
  execute: async (skillId, _task, _data, asset) => {
    executed.push({ skillId, assetId: asset?.id });
    return onExecute();
  },
  handleInput: async () => ({ status: "working" }),
  cancel: async () => undefined,
  quote: async () => ({ ok: true, amount: 1n, currency: "USDC" }),
};

const rows = async (sql: string, values: unknown[] = []) => (await harness.database.pool.query(sql, values)).rows;
const count = async (table: string) => Number((await rows(`SELECT count(*)::int AS n FROM ${table}`))[0].n);
const executions = () => rows(
  `SELECT state,error_class,admitted_owner,admitted_owner_version,provider_asset_id
     FROM standard_asset_action_executions ORDER BY created_at`,
);
const actionTasks = () => rows(
  "SELECT status,admitted_owner,admitted_owner_version FROM transactions WHERE standard_action_execution_id IS NOT NULL",
);
const audits = async (type: string) => (await rows("SELECT payload FROM events WHERE type=$1", [type]))
  .map((row) => row.payload as Record<string, unknown>);

async function rejection(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the request to be refused");
}

beforeAll(async () => {
  harness = await startAssetHarness("asset_owner_authority");
});

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.reset();
  executed.length = 0;
  onExecute = async () => receipt("touched");
  review.during = null;
  assetWire.beforeQuery = null;
  assetWire.assets = {
    assetIdentifierFromData: (_skillId, data) => (typeof data.note === "string" ? data.note : null),
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("one owner authority with an admitted owner version", () => {
  it("resolves and lists assets by their current owner only", async () => {
    const { getCurrentAssetOwner, listAssetsForStandardPayer } = await import("../src/core/db/queries/assetOwnership.js");
    const kept = await harness.ownedNote(payerA);
    const moved = await harness.ownedNote(payerA);
    await harness.changeOwner(moved, payerB, 1);
    const listed = async (payer: typeof payerA) =>
      (await listAssetsForStandardPayer({ payer: lower(payer), limit: 10 })).assets.map((asset) => asset.id);
    expect(await listed(payerA)).toEqual([kept]);
    expect(await listed(payerB)).toEqual([moved]);
    expect(await getCurrentAssetOwner(kept)).toEqual({ payer: lower(payerA), version: 0 });
    expect(await getCurrentAssetOwner(moved)).toEqual({ payer: lower(payerB), version: 1 });
    const { createAsset } = await import("../src/core/db/queries/assets.js");
    const unowned = await createAsset({ service_id: harness.serviceId, type: "note", identifier: "note-unowned" });
    expect(await getCurrentAssetOwner(unowned.id)).toBeNull();
  });

  it("admits an action for the current owner and records the version it was admitted under", async () => {
    const note = await harness.ownedNote(payerA, { identifier: "note-a" });
    const answer = await actions().perform(await signedAction({
      action: ACTIONS.touch, providerAssetId: note, input: { note: "note-a" },
    })) as { payload: Record<string, unknown> };
    expect(answer.payload).toMatchObject({ status: "completed", result: { receipt: "touched" }, payer: lower(payerA) });
    expect(await executions()).toMatchObject([
      { state: "completed", admitted_owner: lower(payerA), admitted_owner_version: 0 },
    ]);
    expect(await actionTasks()).toMatchObject([
      { status: "completed", admitted_owner: lower(payerA), admitted_owner_version: 0 },
    ]);
    // The owner's later version is the one a later action is admitted under.
    await harness.changeOwner(note, payerA, 2);
    await actions().perform(await signedAction({ action: ACTIONS.touch, providerAssetId: note, input: {} }));
    expect((await executions()).map((row) => row.admitted_owner_version)).toEqual([0, 2]);
  });

  it("serves only the current owner after an owner change, consuming nothing for the previous one", async () => {
    const note = await harness.ownedNote(payerA);
    await harness.changeOwner(note, payerB, 1);
    const refused = await rejection(actions().perform(await signedAction({
      action: ACTIONS.touch, providerAssetId: note, input: {},
    })));
    expect(refused.message).toBe("asset action denied");
    expect(classifyProviderAssetError(refused).status).toBe(403);
    expect(await count("standard_wallet_action_nonces")).toBe(0);
    expect(await count("standard_provider_grant_nonces")).toBe(0);
    expect(executed).toHaveLength(0);
    const answer = await actions().perform(await signedAction({
      action: ACTIONS.touch, providerAssetId: note, input: {}, payer: payerB,
    })) as { payload: Record<string, unknown> };
    expect(answer.payload.status).toBe("completed");
    expect(await executions()).toMatchObject([{ admitted_owner: lower(payerB), admitted_owner_version: 1 }]);
  });
});

describe("wrong target (F-T08)", () => {
  it("never acts on another payer's asset, another type, another identifier or an ineligible state", async () => {
    const mine = await harness.ownedNote(payerA, { identifier: "note-mine" });
    const targets = [
      { providerAssetId: await harness.ownedNote(payerB), input: {} },
      { providerAssetId: await harness.ownedNote(payerA, { type: "folder" }), input: {} },
      { providerAssetId: await harness.ownedNote(payerA, { status: "deleted" }), input: {} },
      { providerAssetId: mine, input: { note: "note-someone-else" } },
      { providerAssetId: randomUUID(), input: {} },
    ];
    for (const target of targets) {
      const refused = await rejection(actions().perform(await signedAction({ action: ACTIONS.touch, ...target })));
      expect(refused.message).toBe("asset action denied");
      expect(classifyProviderAssetError(refused).status).toBe(403);
    }
    expect(await count("standard_wallet_action_nonces")).toBe(0);
    expect(await count("standard_asset_action_executions")).toBe(0);
    expect(executed).toHaveLength(0);
  });

  it("admits the lifecycle states the service declares for the action", async () => {
    const suspended = await harness.ownedNote(payerA, { status: "suspended" });
    const body = () => signedAction({ action: ACTIONS.touch, providerAssetId: suspended, input: {} });
    expect((await rejection(actions().perform(await body()))).message).toBe("asset action denied");
    assetWire.assets = { ...assetWire.assets, assetLookupStatuses: () => ["active", "suspended"] };
    expect(((await actions().perform(await body())) as { payload: { status: string } }).payload.status).toBe("completed");
  });

  it("fails an action definitively, without supplier work, when its asset stopped being eligible", async () => {
    const note = await harness.ownedNote(payerA);
    review.during = async () => {
      await harness.database.pool.query("UPDATE assets SET status='deleted' WHERE id=$1", [note]);
    };
    const answer = await actions().perform(await signedAction({
      action: ACTIONS.touch, providerAssetId: note, input: {},
    })) as { payload: Record<string, unknown> };
    expect(answer.payload).toMatchObject({ status: "failed", result: null, errorClass: "asset_unavailable" });
    expect(executed).toHaveLength(0);
    expect(await executions()).toMatchObject([{ state: "failed", error_class: "asset_unavailable" }]);
  });

  it("binds a destructive follow-up to the asset of its staged row", async () => {
    const staged = await harness.ownedNote(payerA, { identifier: "note-staged" });
    const other = await harness.ownedNote(payerA, { identifier: "note-other" });
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const stage = await actions().perform(await signedAction({
      action: ACTIONS.remove, providerAssetId: staged, input: { note: "note-staged" },
    })) as { payload: { status: string; actionExecutionId: string; confirmationHash: string } };
    expect(stage.payload.status).toBe("staged");
    vi.setSystemTime(Date.now() + 601_000);
    const confirm = (providerAssetId: string) => signedAction({
      action: ACTIONS.remove, providerAssetId,
      input: {
        operation: "confirm-destructive",
        actionExecutionId: stage.payload.actionExecutionId,
        confirmationHash: stage.payload.confirmationHash,
      },
    });
    const nonces = await count("standard_wallet_action_nonces");
    const refused = await rejection(actions().perform(await confirm(other)));
    expect(refused.message).toBe("staged action target mismatch");
    expect(classifyProviderAssetError(refused).status).toBe(403);
    expect(await count("standard_wallet_action_nonces")).toBe(nonces);
    expect(await count("standard_destructive_followup_executions")).toBe(0);
    expect(await executions()).toMatchObject([{ state: "staged", provider_asset_id: staged }]);
    expect(executed).toHaveLength(0);
    onExecute = async () => receipt("removed");
    const confirmed = await actions().perform(await confirm(staged)) as { payload: Record<string, unknown> };
    expect(confirmed.payload).toMatchObject({ status: "completed", result: { receipt: "removed" } });
    expect(executed).toEqual([{ skillId: "remove-note", assetId: staged }]);
  });
});

describe("stale owner version (F-T08)", () => {
  it("withholds an execution whose owner changed before the supplier call", async () => {
    const note = await harness.ownedNote(payerA);
    review.during = () => harness.changeOwner(note, payerB, 1);
    const refused = await rejection(actions().perform(await signedAction({
      action: ACTIONS.touch, providerAssetId: note, input: {},
    })));
    expect(refused).toBeInstanceOf(AssetOwnerChangedError);
    expect(classifyProviderAssetError(refused).status).toBe(403);
    expect(executed).toHaveLength(0);
    expect(await executions()).toMatchObject([{ state: "failed", error_class: "asset_owner_changed" }]);
    expect(await actionTasks()).toMatchObject([{ status: "failed" }]);
    expect(await audits("asset_owner.result_withheld")).toMatchObject([
      { phase: "execution", admittedVersion: 0, currentVersion: 1 },
    ]);
  });

  it("persists nothing of a result whose owner version changed during the supplier call", async () => {
    const note = await harness.ownedNote(payerA);
    onExecute = async () => {
      // The same wallet at a newer version: only the version decides.
      await harness.changeOwner(note, payerA, 1);
      return receipt("touched");
    };
    const refused = await rejection(actions().perform(await signedAction({
      action: ACTIONS.touch, providerAssetId: note, input: {},
    })));
    expect(refused).toBeInstanceOf(AssetOwnerChangedError);
    expect(executed).toHaveLength(1);
    expect(await count("standard_asset_action_recovery_results")).toBe(0);
    expect(await rows("SELECT 1 FROM events WHERE type='transaction.artifact.created'")).toHaveLength(0);
    expect(await executions()).toMatchObject([{ state: "failed", error_class: "asset_owner_changed" }]);
    expect(await actionTasks()).toMatchObject([{ status: "failed" }]);
    expect(await audits("asset_owner.result_withheld")).toMatchObject([{ phase: "persistence" }]);
  });

  it("never releases a stored result to another owner version, through replay or recovery", async () => {
    const note = await harness.ownedNote(payerA);
    const body = await signedAction({ action: ACTIONS.touch, providerAssetId: note, input: {} });
    const first = await actions().perform(body) as { payload: Record<string, unknown> };
    const replay = await actions().perform(await regrant(body)) as { payload: Record<string, unknown> };
    expect(replay.payload).toMatchObject({ status: "completed", result: first.payload.result });
    await harness.changeOwner(note, payerA, 1);
    const consumed = async () => [
      await count("standard_provider_grant_nonces"), await count("standard_wallet_action_nonces"),
      await count("standard_asset_action_recovery_executions"),
    ];
    const before = await consumed();
    const refused = await rejection(actions().perform(await regrant(body)));
    expect(refused).toBeInstanceOf(AssetOwnerChangedError);
    expect(classifyProviderAssetError(refused).status).toBe(403);
    const recovery = await rejection(actions().perform(await signedAction({
      action: ACTIONS.touch, providerAssetId: note,
      input: { operation: "recover-action", actionExecutionId: first.payload.actionExecutionId, originalInput: {} },
    })));
    expect(recovery).toBeInstanceOf(AssetOwnerChangedError);
    // Both definite refusals happen before anything is consumed.
    expect(await consumed()).toEqual(before);
    expect(executed).toHaveLength(1);
    expect(await executions()).toMatchObject([{ state: "completed" }]);
  });

  it("settles nothing of a result that does not match the response schema", async () => {
    const note = await harness.ownedNote(payerA);
    onExecute = async () => ({ status: "completed", artifacts: [{ name: "note_receipt", data: { receipt: 7 } }] });
    const refused = await rejection(actions().perform(await signedAction({
      action: ACTIONS.touch, providerAssetId: note, input: {},
    })));
    expect(refused.message).toBe("asset action unavailable");
    // Neither the task nor the execution settled: both wait for reconciliation.
    expect(await executions()).toMatchObject([{ state: "attention" }]);
    expect(await actionTasks()).toMatchObject([{ status: "working" }]);
    expect(await rows("SELECT 1 FROM events WHERE type='transaction.artifact.created'")).toHaveLength(0);
    expect(await count("standard_asset_action_recovery_results")).toBe(0);
  });

  it("compares an input identifier in the canonical form the asset is stored in", async () => {
    const { registerProtectedAssetIdentifier } = await import("../src/core/db/queries/assets.js");
    const { assertAssetActionTarget } = await import("../src/core/standardRail/assetActionTarget.js");
    registerProtectedAssetIdentifier("cased-note", {
      normalize: (identifier) => identifier.toLowerCase(),
      buildContext: (assetId) => ({ purpose: "asset-identifier", table: "assets", recordId: assetId, field: "identifier" }),
    });
    const target = (note: string) => assertAssetActionTarget({
      definition: { ...ACTIONS.touch, assetType: "cased-note" }, serviceId: harness.serviceId,
      asset: { service_id: harness.serviceId, type: "cased-note", identifier: "note-mixed", status: "active" },
      input: { note },
    });
    await expect(target("Note-MIXED")).resolves.toBeUndefined();
    await expect(target("note-other")).rejects.toThrow("asset action denied");
  });

  it("withholds an owner-only paid order's deliverable when its admitted owner went stale", async () => {
    const note = await harness.ownedNote(payerA);
    const taskId = `task-${randomUUID()}`;
    const customer = (await rows("SELECT id FROM customers WHERE wallet_address=$1", [lower(payerA)]))[0].id;
    await harness.database.pool.query(
      `INSERT INTO transactions (id,service_id,skill_id,status,customer_id,standard_order_id,standard_payer,
         standard_order_key,standard_token,standard_gross_amount,standard_provider_net_amount,
         standard_daski_commission_amount)
       VALUES ($1,$2,'touch-note','working',$3,$4,$5,$6,'0x7777777777777777777777777777777777777777',1000,950,50)`,
      [taskId, harness.serviceId, customer, `0x${randomBytes(32).toString("hex")}`, lower(payerA), randomBytes(32)],
    );
    await expect(admitPaidTaskForAsset({ taskId, assetId: note, payer: payerB.address }))
      .rejects.toBeInstanceOf(AssetOwnerChangedError);
    await admitPaidTaskForAsset({ taskId, assetId: note, payer: payerA.address });
    await harness.changeOwner(note, payerB, 1);
    await expect(processAdapterResult(taskId, receipt("report"), harness.serviceId))
      .rejects.toBeInstanceOf(AssetOwnerChangedError);
    expect(await rows("SELECT status,asset_id,admitted_owner_version FROM transactions WHERE id=$1", [taskId]))
      .toEqual([{ status: "failed", asset_id: note, admitted_owner_version: 0 }]);
    expect(await rows("SELECT 1 FROM events WHERE type='transaction.artifact.created'")).toHaveLength(0);
    // The order's terminal identity is the withheld failure, frozen with it.
    expect(await rows("SELECT state FROM standard_terminal_results WHERE transaction_id=$1", [taskId]))
      .toEqual([{ state: "failed" }]);
  });
});

describe("result-release race (F-T08)", () => {
  it("never signs a release across an owner change that holds the fence", async () => {
    const note = await harness.ownedNote(payerA);
    const body = await signedAction({ action: ACTIONS.touch, providerAssetId: note, input: {} });
    await actions().perform(body);
    const swap = await harness.database.pool.connect();
    try {
      await swap.query("BEGIN");
      await swap.query("SELECT pg_advisory_xact_lock(hashtextextended('asset-owner:' || $1::text, 0))", [note]);
      await swap.query("INSERT INTO asset_owner_overrides(asset_id,payer,version) VALUES ($1,$2,1)", [note, lower(payerB)]);
      let settled = false;
      const release = actions().perform(await regrant(body)).finally(() => { settled = true; });
      release.catch(() => undefined);
      await vi.waitFor(async () => {
        expect((await rows("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted")).length).toBeGreaterThan(0);
      });
      expect(settled).toBe(false);
      await swap.query("COMMIT");
      expect(await rejection(release)).toBeInstanceOf(AssetOwnerChangedError);
    } finally {
      swap.release();
    }
  });

  it("lets an owner change commit only after a release that already holds the fence has signed", async () => {
    const note = await harness.ownedNote(payerA);
    const body = await signedAction({ action: ACTIONS.touch, providerAssetId: note, input: {} });
    await actions().perform(body);
    let resume!: () => void;
    const held = new Promise<void>((resolve) => { resume = resolve; });
    let reached!: () => void;
    const atRelease = new Promise<void>((resolve) => { reached = resolve; });
    assetWire.beforeQuery = async (text) => {
      if (text.includes("FROM standard_asset_action_recovery_results")) {
        assetWire.beforeQuery = null;
        reached();
        await held;
      }
    };
    const release = actions().perform(await regrant(body)) as Promise<{ payload: Record<string, unknown> }>;
    await atRelease;
    let swapped = false;
    const swap = harness.changeOwner(note, payerB, 1).then(() => { swapped = true; });
    await vi.waitFor(async () => {
      expect((await rows("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted")).length).toBeGreaterThan(0);
    });
    expect(swapped).toBe(false);
    resume();
    expect((await release).payload).toMatchObject({ status: "completed", result: { receipt: "touched" } });
    await swap;
    expect(swapped).toBe(true);
  });
});

describe("replayed destructive request (F-T08)", () => {
  async function confirmedRemoval() {
    const note = await harness.ownedNote(payerA, { identifier: "note-gone" });
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const stage = await actions().perform(await signedAction({
      action: ACTIONS.remove, providerAssetId: note, input: { note: "note-gone" },
    })) as { payload: { actionExecutionId: string; confirmationHash: string } };
    vi.setSystemTime(Date.now() + 601_000);
    const followUp = (operation: string) => signedAction({
      action: ACTIONS.remove, providerAssetId: note,
      input: {
        operation, actionExecutionId: stage.payload.actionExecutionId, confirmationHash: stage.payload.confirmationHash,
      },
    });
    onExecute = async () => receipt("removed");
    const confirmBody = await followUp("confirm-destructive");
    const confirmed = await actions().perform(confirmBody) as { payload: Record<string, unknown> };
    return { note, confirmBody, confirmed, followUp };
  }

  it("answers a replayed confirmation from its stored outcome without executing again", async () => {
    const { confirmBody, confirmed, followUp } = await confirmedRemoval();
    const replayed = await actions().perform(await regrant(confirmBody)) as { payload: Record<string, unknown> };
    expect(replayed.payload).toMatchObject({
      status: "completed", actionExecutionId: confirmed.payload.actionExecutionId, result: { receipt: "removed" },
    });
    expect(executed).toHaveLength(1);
    // A second confirmation under a fresh payer authorization, a cancel after
    // the confirmation, or a replayed grant change nothing and run nothing.
    const nonces = await count("standard_wallet_action_nonces");
    for (const body of [await followUp("confirm-destructive"), await followUp("cancel-staged-action")]) {
      expect((await rejection(actions().perform(body))).message).toBe("staged action unavailable");
    }
    expect(await rejection(actions().perform(confirmBody))).toBeInstanceOf(Error);
    expect(await count("standard_wallet_action_nonces")).toBe(nonces);
    expect(executed).toHaveLength(1);
    expect(await executions()).toMatchObject([{ state: "completed" }]);
  });

  it("withholds a replayed confirmation's outcome from a later owner version", async () => {
    const { note, confirmBody } = await confirmedRemoval();
    await harness.changeOwner(note, payerA, 1);
    const grants = await count("standard_provider_grant_nonces");
    const refused = await rejection(actions().perform(await regrant(confirmBody)));
    expect(refused).toBeInstanceOf(AssetOwnerChangedError);
    expect(await count("standard_provider_grant_nonces")).toBe(grants);
    expect(executed).toHaveLength(1);
  });
});
