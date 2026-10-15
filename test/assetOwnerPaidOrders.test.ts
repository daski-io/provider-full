import { randomBytes, randomUUID } from "node:crypto";
import type { PrivateKeyAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterResult } from "../src/core/serviceRegistry/types.js";
import type { ProviderStandardRailConfig } from "../src/core/standardRail/config.js";
import type { FulfillmentJobLease } from "../src/core/standardRail/fulfillmentJobs.js";
import { SERVICE_SLUG } from "./standardRailFixture.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });
vi.mock("../src/core/db/pool.js", async () => (await import("./assetActionHarness.js")).poolModule());
vi.mock("../src/core/serviceRegistry/registry.js", async () => (await import("./assetActionHarness.js")).registryModule());
const review = vi.hoisted(() => ({ during: null as null | (() => Promise<void>) }));
vi.mock("../src/core/engine/preExecuteRunner.js", () => ({
  consultPreExecuteAgent: async () => {
    await review.during?.();
    return { action: "proceed" };
  },
}));

const { assetWire, lower, payerA, payerB, standard, startAssetHarness } = await import("./assetActionHarness.js");
const { fulfillAdmittedDispatch } = await import("../src/core/standardRail/dispatchExecution.js");
const { insertAdmittedFulfillmentJob } = await import("../src/core/standardRail/fulfillmentJobs.js");
const { getServiceById } = await import("../src/core/db/queries/services.js");
const { getSkillByServiceAndSkillId } = await import("../src/core/db/queries/skills.js");
const { applyLifecycleInput } = await import("../src/core/standardRail/lifecycleInput.js");
const { encryptString } = await import("../src/core/chain/encryption.js");
const { STANDARD_TASK_COLUMNS } = await import("../src/core/standardRail/lifecycleStore.js");

// F-T08 for owner-only paid orders against PostgreSQL: dispatch links the
// order to its asset under the asset owner fence only for the current
// owner, checks that owner again immediately before the supplier call, and
// withholds a deliverable whose owner went stale meanwhile. An owner check
// that reaches no decision never fails a funded order.
let harness: Awaited<ReturnType<typeof startAssetHarness>>;
let executed = 0;
let onExecute: () => Promise<AdapterResult> = async () => receipt();
let onInput: () => Promise<AdapterResult> = async () => ({ status: "working" });

function receipt(): AdapterResult {
  return { status: "completed", message: "Done.", artifacts: [{ name: "note_receipt", data: { receipt: "renewed" } }] };
}

assetWire.adapter = {
  execute: async () => {
    executed += 1;
    return onExecute();
  },
  handleInput: async () => onInput(),
  cancel: async () => undefined,
  quote: async () => ({ ok: true, amount: 1n, currency: "USDC" }),
};

const order = async (taskId: string) => (await harness.database.pool.query(
  `SELECT status,asset_id,admitted_owner,admitted_owner_version,metadata->>'standardFailureClass' AS failure,
          metadata->>'standard_start_refused' AS refused
     FROM transactions WHERE id=$1`, [taskId])).rows[0];

async function paidOrder(payer: PrivateKeyAccount, note: string) {
  const taskId = `task-${randomUUID()}`;
  const orderId = `0x${randomBytes(32).toString("hex")}`;
  const customer = (await harness.database.pool.query(
    "INSERT INTO customers(wallet_address) VALUES ($1) ON CONFLICT (wallet_address) DO UPDATE SET last_seen_at=now() RETURNING id",
    [lower(payer)],
  )).rows[0].id;
  await harness.database.pool.query(
    `INSERT INTO transactions (id,service_id,skill_id,status,customer_id,standard_order_id,standard_payer,
       standard_order_key,standard_token,standard_gross_amount,standard_provider_net_amount,
       standard_daski_commission_amount)
     VALUES ($1,$2,'touch-note','submitted',$3,$4,$5,$6,'0x7777777777777777777777777777777777777777',1000,950,50)`,
    [taskId, harness.serviceId, customer, orderId, lower(payer), randomBytes(32)],
  );
  // The order's fulfillment job, leased to this executor as admission leases it.
  const lease = await insertAdmittedFulfillmentJob(harness.database.pool, {
    taskId, orderId, gatewayAudience: standard.gatewayAudience, capability: null,
  });
  const service = (await getServiceById(harness.serviceId))!;
  const skill = (await getSkillByServiceAndSkillId(harness.serviceId, "touch-note"))!;
  /** One executor's attempt, under the lease it holds. */
  const runAs = (executor: FulfillmentJobLease) => fulfillAdmittedDispatch({
    taskId,
    order: { gatewayAudience: standard.gatewayAudience, orderId, payer: payer.address },
    request: { note }, skillId: "touch-note", service, skill, handler: assetWire.adapter,
    requiresOwnership: true, supplierCostCeiling: null, lease: executor,
  });
  return { taskId, lease, runAs, run: () => runAs(lease) };
}

beforeAll(async () => {
  harness = await startAssetHarness("asset_owner_paid_orders");
});

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.reset();
  executed = 0;
  onExecute = async () => receipt();
  onInput = async () => ({ status: "working" });
  review.during = null;
  assetWire.beforeQuery = null;
  assetWire.assets = {
    assetIdentifierFromData: (_skillId, data) => (typeof data.note === "string" ? data.note : null),
    assetOwnershipPolicy: () => "owner-only",
  };
});

describe("owner-only paid orders (F-T08)", () => {
  it("links an order to its asset for the current owner and records the version it was admitted under", async () => {
    const note = await harness.ownedNote(payerA, { identifier: "note-renew" });
    const { taskId, run } = await paidOrder(payerA, "note-renew");
    await run();
    expect(executed).toBe(1);
    expect(await order(taskId)).toMatchObject({
      status: "completed", asset_id: note, admitted_owner: lower(payerA), admitted_owner_version: 0,
    });
  });

  it("fails an order from a wallet that does not own the asset before any supplier work", async () => {
    await harness.ownedNote(payerA, { identifier: "note-foreign" });
    const { taskId, run } = await paidOrder(payerB, "note-foreign");
    await run();
    expect(executed).toBe(0);
    // Refused its start under the start fence, as never started.
    expect(await order(taskId)).toMatchObject({
      status: "failed", asset_id: null, failure: "AssetOwnerChangedError", refused: "pre_start_failure",
    });
  });

  it("fails an order whose owner changed before the supplier call, without supplier work", async () => {
    const note = await harness.ownedNote(payerA, { identifier: "note-moved" });
    const { taskId, run } = await paidOrder(payerA, "note-moved");
    review.during = () => harness.changeOwner(note, payerB, 1);
    await run();
    expect(executed).toBe(0);
    expect(await order(taskId)).toMatchObject({
      status: "failed", failure: "AssetOwnerChangedError", refused: "pre_start_failure",
    });
  });

  it("withholds the deliverable of an order whose owner changed during the supplier call", async () => {
    const note = await harness.ownedNote(payerA, { identifier: "note-raced" });
    const { taskId, run } = await paidOrder(payerA, "note-raced");
    onExecute = async () => {
      await harness.changeOwner(note, payerB, 1);
      return receipt();
    };
    await run();
    expect(executed).toBe(1);
    expect(await order(taskId)).toMatchObject({ status: "failed", admitted_owner_version: 0 });
    expect((await harness.database.pool.query(
      "SELECT 1 FROM events WHERE transaction_id=$1 AND type='transaction.artifact.created'", [taskId],
    )).rows).toHaveLength(0);
    expect((await harness.database.pool.query(
      "SELECT state FROM standard_terminal_results WHERE transaction_id=$1", [taskId],
    )).rows).toEqual([{ state: "failed" }]);
  });

  it("never lets an executor that lost the order move the owner its started call was admitted under", async () => {
    const note = await harness.ownedNote(payerA, { identifier: "note-late-executor" });
    const { taskId, lease, run, runAs } = await paidOrder(payerA, "note-late-executor");
    let late: unknown = null;
    onExecute = async () => {
      // The owner moves away and back during the started call, and an
      // executor whose lease was taken over reaches the order's admission.
      await harness.changeOwner(note, payerB, 1);
      await harness.changeOwner(note, payerA, 2);
      late = await runAs({ id: lease.id, leaseToken: randomUUID() }).catch((error: unknown) => error);
      return receipt();
    };
    await run();
    expect(executed).toBe(1);
    expect(late).toMatchObject({ name: "OwnerStepUndecidedError" });
    // The started call's admission stands, so its deliverable is withheld.
    expect(await order(taskId)).toMatchObject({ status: "failed", admitted_owner_version: 0 });
    expect((await harness.database.pool.query(
      "SELECT 1 FROM events WHERE transaction_id=$1 AND type='transaction.artifact.created'", [taskId],
    )).rows).toHaveLength(0);
  });

  it("leaves an order unstarted, never failed, when its asset lookup meets a transient fault", async () => {
    await harness.ownedNote(payerA, { identifier: "note-lookup-outage" });
    const { taskId, run } = await paidOrder(payerA, "note-lookup-outage");
    const fault = Object.assign(new TypeError("fetch failed"), { cause: { code: "EAI_AGAIN" } });
    assetWire.assets = {
      ...assetWire.assets,
      assetIdentifierFromData: async () => { throw fault; },
    };
    await expect(run()).rejects.toBe(fault);
    expect(executed).toBe(0);
    expect(await order(taskId)).toMatchObject({ status: "submitted", asset_id: null, refused: null });
  });

  it("leaves an order unstarted, never failed, when its owner admission reaches no decision", async () => {
    await harness.ownedNote(payerA, { identifier: "note-outage" });
    const { taskId, run } = await paidOrder(payerA, "note-outage");
    assetWire.beforeQuery = async (text) => {
      if (text.includes("SET asset_id=$2,admitted_owner=$3")) {
        assetWire.beforeQuery = null;
        throw Object.assign(new Error("Connection terminated unexpectedly"), { code: "08006" });
      }
    };
    await expect(run()).rejects.toMatchObject({ name: "OwnerStepUndecidedError" });
    expect(executed).toBe(0);
    expect(await order(taskId)).toMatchObject({
      status: "submitted", asset_id: null, admitted_owner: null, refused: null,
    });
  });
});

// Buyer input to owner-only work whose owner changes during the service call
// ends exactly as at dispatch: the deliverable is withheld, the order ends
// failed with asset_owner_changed, and that settled failure is the input's
// committed outcome, answered at once rather than as temporarily unavailable.
describe("owner-only buyer input (F-T08)", () => {
  const listing = `0x${"ab".repeat(32)}` as const;
  const config = {
    ...standard,
    gatewayOrigin: "https://gateway.example",
    outcomes: new Map([["touch-note", {
      outcomeId: "touch-note", serviceSlug: SERVICE_SLUG, skillId: "touch-note", listingManifestHash: listing,
      providerTerminalAttestationKey: payerB.address, dispatchDeadlineSeconds: 300,
    }]]),
  } as unknown as ProviderStandardRailConfig;

  it("commits the withheld failure as the input's outcome when the owner changed during the call", async () => {
    const note = await harness.ownedNote(payerA, { identifier: "note-input-raced" });
    const { taskId, run } = await paidOrder(payerA, "note-input-raced");
    onExecute = async () => ({ status: "input-required", message: "Which wording should the receipt use?" });
    await run();
    expect(await order(taskId)).toMatchObject({ status: "input-required", admitted_owner_version: 0 });
    const committed = encryptString(JSON.stringify({ note: "note-input-raced" }), {
      purpose: "standard-order-request", table: "transactions", recordId: taskId,
      field: "metadata.standard_request_encrypted", recordVersion: 1,
    });
    await harness.database.pool.query(
      `UPDATE transactions SET standard_listing_manifest_hash=$2,
         metadata=metadata || jsonb_build_object('standard_request_encrypted',$3::text) WHERE id=$1`,
      [taskId, Buffer.from(listing.slice(2), "hex"), committed],
    );
    const task = (await harness.database.pool.query(
      `SELECT ${STANDARD_TASK_COLUMNS} FROM transactions WHERE id=$1`, [taskId],
    )).rows[0];
    onInput = async () => {
      await harness.changeOwner(note, payerB, 1);
      return receipt();
    };
    await expect(applyLifecycleInput(config, task, {
      orderId: task.standard_order_id, providerTaskId: taskId, action: "input",
      request: { inputText: "Use the plain wording.", data: { note: "note-input-raced" } },
      payer: payerA.address, authorization: { form: "payer-signed", nonce: `0x${"01".repeat(32)}` },
    }, async () => "input-required")).resolves.toBeUndefined();
    expect(await order(taskId)).toMatchObject({ status: "failed", admitted_owner_version: 0 });
    expect((await harness.database.pool.query(
      "SELECT state,outcome_state FROM standard_lifecycle_actions WHERE transaction_id=$1", [taskId],
    )).rows).toEqual([{ state: "committed", outcome_state: "failed" }]);
    expect((await harness.database.pool.query(
      "SELECT 1 FROM events WHERE transaction_id=$1 AND type='transaction.artifact.created'", [taskId],
    )).rows).toHaveLength(0);
    expect((await harness.database.pool.query(
      "SELECT state FROM standard_terminal_results WHERE transaction_id=$1", [taskId],
    )).rows).toEqual([{ state: "failed" }]);
  });
});
