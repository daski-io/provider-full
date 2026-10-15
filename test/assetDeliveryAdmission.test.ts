import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RUNTIME_EPOCH_OPTION } from "./postgresHarness.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });
vi.mock("../src/core/db/pool.js", async () => (await import("./assetActionHarness.js")).poolModule());
vi.mock("../src/core/serviceRegistry/registry.js", async () => (await import("./assetActionHarness.js")).registryModule());
const postmark = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../src/core/security/outboundHttp.js", () => ({
  boundedFetch: async () => {
    postmark.calls += 1;
    const text = JSON.stringify({ MessageID: `postmark-${postmark.calls}`, ErrorCode: 0 });
    return { status: 200, ok: true, headers: new Headers({ "content-type": "application/json" }), text: () => text };
  },
}));

const { assetWire, lower, payerA, payerB, startAssetHarness } = await import("./assetActionHarness.js");
const delivery = await import("../src/core/standardRail/assetDeliveryAdmission.js");
const { sendEmail } = await import("../src/core/email/postmarkOutbound.js");
const { AssetOwnerChangedError } = await import("../src/core/standardRail/assetOwnerFence.js");

// F-T08 stale delivery admission against PostgreSQL: a delivery of asset
// information is admitted under the asset owner fence for the owner it
// addresses, sent outside every lock, and renewed under the fence as the
// last step before the outbound call. An owner change or a revocation in
// between is an explicit, terminal refusal that never reaches Postmark; an
// infrastructure failure of that check leaves the send retryable, and the
// retry validates again.
let harness: Awaited<ReturnType<typeof startAssetHarness>>;
const rows = async (sql: string, values: unknown[] = []) => (await harness.database.pool.query(sql, values)).rows;
const outbound = () => rows("SELECT delivery_status,delivery_payload,message_id FROM emails_outbound");
const admissions = () => rows("SELECT admitted_owner,admitted_owner_version,outcome FROM asset_delivery_admissions ORDER BY admitted_at");
const notice = (idempotencyKey: string) => ({
  to: "owner@example.com", subject: "Your note changed", bodyText: "Your note was updated.",
  sentBy: "system" as const, fromAddress: "notes@example.com", idempotencyKey,
});

async function rejection(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the delivery to be refused");
}

function deliverNotice(assetId: string, key: string, before?: () => Promise<void>) {
  return delivery.deliverAssetInformation({
    assetId,
    purpose: "note.changed",
    send: async ({ beforeSend }) => {
      await before?.();
      return sendEmail(notice(key), { beforeSend });
    },
  });
}

async function inFence<T>(assetId: string, work: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await harness.database.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('asset-owner:' || $1::text, 0))", [assetId]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  harness = await startAssetHarness("asset_delivery_admission");
});

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.reset();
  postmark.calls = 0;
  assetWire.beforeQuery = null;
});

describe("asset delivery admission (F-T08)", () => {
  it("admits a delivery for the current owner, resolves its recipient under the fence and closes it", async () => {
    const note = await harness.ownedNote(payerA);
    const sent = await delivery.deliverAssetInformation({
      assetId: note,
      purpose: "note.changed",
      owner: payerA.address,
      prepare: async (db, owner) => (await db.query<{ wallet_address: string }>(
        "SELECT wallet_address FROM customers WHERE wallet_address=$1", [owner.payer],
      )).rows[0]?.wallet_address,
      send: async ({ owner, prepared, beforeSend }) => {
        expect(owner).toEqual({ payer: lower(payerA), version: 0 });
        expect(prepared).toBe(lower(payerA));
        return sendEmail(notice("notice-1"), { beforeSend });
      },
    });
    expect(sent.message_id).toBe("postmark-1");
    expect(await admissions()).toEqual([{ admitted_owner: lower(payerA), admitted_owner_version: 0, outcome: "delivered" }]);
    expect((await rows("SELECT renewed_at >= admitted_at AS renewed FROM asset_delivery_admissions"))[0].renewed).toBe(true);
  });

  it("refuses to admit a delivery to a wallet that is not the asset's owner", async () => {
    const note = await harness.ownedNote(payerA);
    await expect(delivery.admitAssetDelivery({ assetId: note, purpose: "note.changed", owner: payerB.address }))
      .rejects.toBeInstanceOf(AssetOwnerChangedError);
    await expect(delivery.admitAssetDelivery({ assetId: note, purpose: "Not A Purpose" }))
      .rejects.toThrow("asset delivery purpose is invalid");
    expect(await admissions()).toEqual([]);
  });

  it("refuses, terminally and without calling Postmark, a delivery whose owner changed after admission", async () => {
    const note = await harness.ownedNote(payerA);
    // The send runs outside every lock, so the owner change commits meanwhile.
    const refused = await rejection(deliverNotice(note, "notice-2", () => harness.changeOwner(note, payerB, 1)));
    expect(refused).toMatchObject({ name: "OutboundEmailError", outcome: "skipped" });
    expect(postmark.calls).toBe(0);
    expect(await outbound()).toMatchObject([{ delivery_status: "send_skipped", message_id: null }]);
    expect(await admissions()).toMatchObject([{ outcome: "refused" }]);
    // The same logical send is refused again without running any check.
    let checked = 0;
    await expect(sendEmail(notice("notice-2"), { beforeSend: async () => { checked += 1; } }))
      .rejects.toMatchObject({ outcome: "skipped" });
    expect(checked).toBe(0);
    expect(postmark.calls).toBe(0);
  });

  it("refuses a revoked admission and counts a live admission as active work only within its bound", async () => {
    const note = await harness.ownedNote(payerA);
    const { admission } = await delivery.admitAssetDelivery({ assetId: note, purpose: "note.changed" });
    expect(await inFence(note, (db) => delivery.countLiveAssetDeliveryAdmissions(db, note))).toBe(1);
    await harness.database.pool.query(
      "UPDATE asset_delivery_admissions SET renewed_at = now() - interval '11 minutes' WHERE id=$1", [admission.id],
    );
    expect(await inFence(note, (db) => delivery.countLiveAssetDeliveryAdmissions(db, note))).toBe(0);
    expect(await inFence(note, (db) => delivery.revokeAssetDeliveryAdmissions(db, note))).toBe(1);
    await expect(delivery.renewAssetDeliveryAdmission(admission)).rejects.toBeInstanceOf(delivery.AssetDeliveryRefusedError);
  });

  it("keeps a send retryable when its last check fails for infrastructure, and validates the retry again", async () => {
    const note = await harness.ownedNote(payerA);
    assetWire.beforeQuery = async (text) => {
      if (text.includes("UPDATE asset_delivery_admissions SET renewed_at")) {
        assetWire.beforeQuery = null;
        throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
      }
    };
    expect(await rejection(deliverNotice(note, "notice-3"))).toMatchObject({ outcome: "retryable" });
    expect(postmark.calls).toBe(0);
    const [deferred] = await outbound();
    expect(deferred).toMatchObject({ delivery_status: "send_retryable", message_id: null });
    expect(deferred.delivery_payload.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(await admissions()).toMatchObject([{ outcome: "failed" }]);
    // Within its cooldown the same send is not retried.
    expect(await rejection(deliverNotice(note, "notice-3"))).toMatchObject({ outcome: "retryable" });
    expect(postmark.calls).toBe(0);
    await harness.database.pool.query(
      "UPDATE emails_outbound SET delivery_payload = jsonb_set(delivery_payload, '{retryAfter}', '0')",
    );
    let validated = 0;
    const sent = await delivery.deliverAssetInformation({
      assetId: note,
      purpose: "note.changed",
      send: ({ beforeSend }) => sendEmail(notice("notice-3"), {
        beforeSend: async () => { validated += 1; await beforeSend(); },
      }),
    });
    expect(validated).toBe(1);
    expect(postmark.calls).toBe(1);
    expect(sent.message_id).toBe("postmark-1");
    expect((await admissions()).map((row) => row.outcome)).toEqual(["failed", "failed", "delivered"]);
  });

  it("refuses a retry whose content changed, for review", async () => {
    const note = await harness.ownedNote(payerA);
    assetWire.beforeQuery = async (text) => {
      if (text.includes("UPDATE asset_delivery_admissions SET renewed_at")) {
        assetWire.beforeQuery = null;
        throw new Error("Connection terminated unexpectedly");
      }
    };
    await rejection(deliverNotice(note, "notice-4"));
    await harness.database.pool.query(
      "UPDATE emails_outbound SET delivery_payload = jsonb_set(delivery_payload, '{retryAfter}', '0')",
    );
    const changed = await rejection(delivery.deliverAssetInformation({
      assetId: note, purpose: "note.changed",
      send: ({ beforeSend }) => sendEmail({ ...notice("notice-4"), bodyText: "Different text." }, { beforeSend }),
    }));
    expect(changed).toMatchObject({ outcome: "unknown" });
    expect(postmark.calls).toBe(0);
  });

  it("never needs a second connection while it holds the fence", async () => {
    const note = await harness.ownedNote(payerA);
    // A provider session declares this release's runtime epoch (core migration 011).
    const single = new pg.Pool({ connectionString: harness.database.url, max: 1, options: RUNTIME_EPOCH_OPTION });
    const shared = assetWire.pool;
    assetWire.pool = single;
    try {
      const sent = await delivery.deliverAssetInformation({
        assetId: note,
        purpose: "note.changed",
        prepare: async (db, owner) => (await db.query("SELECT $1::text AS payer", [owner.payer])).rows[0].payer,
        send: ({ beforeSend }) => sendEmail(notice("notice-5"), { beforeSend }),
      });
      expect(sent.message_id).toBe("postmark-1");
    } finally {
      assetWire.pool = shared;
      await single.end();
    }
  });
});
