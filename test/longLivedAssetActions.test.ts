import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterResult } from "../src/core/serviceRegistry/types.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });
vi.mock("../src/core/db/pool.js", async () => (await import("./assetActionHarness.js")).poolModule());
vi.mock("../src/core/serviceRegistry/registry.js", async () => (await import("./assetActionHarness.js")).registryModule());
vi.mock("../src/core/engine/preExecuteRunner.js", () => ({
  consultPreExecuteAgent: async () => ({ action: "proceed" }),
  applyPreExecuteDecision: async () => ({ terminal: false }),
}));

const {
  ACTIONS, CHAIN_ID, assetWire, lower, payerA, signedAction, signedQuery, standard, startAssetHarness, wallet,
} = await import("./assetActionHarness.js");
const { ProviderAssetActionService } = await import("../src/core/standardRail/assetAction.js");
const { ProviderAssetQueryService } = await import("../src/core/standardRail/assetQuery.js");
const { AFTER_EXPIRY, restoreClock, setClock } = await import("./longLivedRailDates.js");

/*
 * Against PostgreSQL, with the real asset-action service: the harness's
 * servicing admission and action definitions are signed valid for one day
 * from now. Long after that day the provider still runs actions, stages and
 * confirms a destructive one, and lists assets; each deadline comes from the
 * action's own retention. The payer's and the gateway's short-lived
 * envelopes still expire.
 */
let harness: Awaited<ReturnType<typeof startAssetHarness>>;
const actions = () => new ProviderAssetActionService(standard, wallet, CHAIN_ID);
const executed: string[] = [];
let onExecute: () => Promise<AdapterResult> = async () => receipt("touched");

function receipt(value: string): AdapterResult {
  return { status: "completed", message: "Done.", artifacts: [{ name: "note_receipt", data: { receipt: value } }] };
}

assetWire.adapter = {
  execute: async (skillId) => {
    executed.push(skillId);
    return onExecute();
  },
  handleInput: async () => ({ status: "working" }),
  cancel: async () => undefined,
  quote: async () => ({ ok: true, amount: 1n, currency: "USDC" }),
};

const rows = async (sql: string, values: unknown[] = []) => (await harness.database.pool.query(sql, values)).rows;
const seconds = (value: Date | null) => (value === null ? null : Math.floor(value.getTime() / 1_000));

beforeAll(async () => {
  harness = await startAssetHarness("long_lived_asset_actions");
});

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.reset();
  executed.length = 0;
  onExecute = async () => receipt("touched");
  assetWire.assets = {
    assetIdentifierFromData: (_skillId, data) => (typeof data.note === "string" ? data.note : null),
  };
});

afterEach(restoreClock);

describe.each(AFTER_EXPIRY)("asset actions after the admission's and definitions' signed dates, at %s", (clock) => {
  it("runs an action and keeps its result for the action's own retention", async () => {
    const note = await harness.ownedNote(payerA, { identifier: "note-a" });
    const now = setClock(clock);
    expect(wallet.admission.validBefore).toBeLessThan(now);
    expect(ACTIONS.touch.validBefore).toBeLessThan(now);
    const answer = await actions().perform(await signedAction({
      action: ACTIONS.touch, providerAssetId: note, input: { note: "note-a" },
    }));
    expect(answer).toMatchObject({ payload: { status: "completed", result: { receipt: "touched" } } });
    const [row] = await rows("SELECT state,result_valid_before FROM standard_asset_action_executions");
    expect(row.state).toBe("completed");
    expect(seconds(row.result_valid_before)).toBe(now + ACTIONS.touch.retentionSeconds);
  });

  it("stages a destructive action for its own retention and confirms it after the delay", async () => {
    const note = await harness.ownedNote(payerA, { identifier: "note-gone" });
    const now = setClock(clock);
    const staged = await actions().perform(await signedAction({
      action: ACTIONS.remove, providerAssetId: note, input: { note: "note-gone" },
    })) as { payload: { status: string; actionExecutionId: string; confirmationHash: string; stageValidBefore: number } };
    expect(staged.payload.status).toBe("staged");
    expect(staged.payload.stageValidBefore).toBe(now + Math.min(86_400, ACTIONS.remove.retentionSeconds));
    vi.setSystemTime((now + 601) * 1_000);
    onExecute = async () => receipt("removed");
    await expect(actions().perform(await signedAction({
      action: ACTIONS.remove, providerAssetId: note,
      input: {
        operation: "confirm-destructive", actionExecutionId: staged.payload.actionExecutionId,
        confirmationHash: staged.payload.confirmationHash,
      },
    }))).resolves.toMatchObject({ payload: { status: "completed" } });
    expect(executed).toEqual(["remove-note"]);
  });

  it("lists the payer's assets", async () => {
    const note = await harness.ownedNote(payerA);
    setClock(clock);
    const answer = await new ProviderAssetQueryService(standard, wallet, CHAIN_ID)
      .query(await signedQuery({})) as { payload: { payer: string; assets: Array<{ providerAssetId: string }> } };
    expect(answer.payload.payer).toBe(lower(payerA));
    expect(answer.payload.assets.map((asset) => asset.providerAssetId)).toEqual([note]);
  });

  it("still refuses an expired grant and runs nothing", async () => {
    const note = await harness.ownedNote(payerA, { identifier: "note-a" });
    const now = setClock(clock);
    const body = await signedAction({ action: ACTIONS.touch, providerAssetId: note, input: { note: "note-a" } });
    vi.setSystemTime((now + 121) * 1_000);
    await expect(actions().perform(body)).rejects.toThrow("provider wallet grant denied");
    expect(executed).toEqual([]);
    expect(await rows("SELECT 1 FROM standard_asset_action_executions")).toEqual([]);
  });
});
