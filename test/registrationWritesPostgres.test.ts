import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// The registrar's journal lookup against PostgreSQL: only unsettled writes
// for the exact purpose and target, oldest nonce first.

const h = vi.hoisted(() => ({ db: null as import("pg").Pool | null }));

vi.mock("../src/core/db/pool.js", () => ({
  pool: {
    query: (...args: unknown[]) => (h.db as unknown as { query: (...a: unknown[]) => unknown }).query(...args),
    connect: () => h.db!.connect(),
  },
}));

import { listOpenProviderWrites } from "../src/core/db/queries/providerChainWrites.js";
import { createMigratedTestDatabase, type MigratedTestDatabase } from "./postgresTestDatabase.js";

const scope = { chainId: 84532, walletAddress: "0x2222222222222222222222222222222222222222" };
let database: MigratedTestDatabase;

async function journal(nonce: number, status: string, purpose: string, targetId: string): Promise<string> {
  const id = randomUUID();
  const hash = `0x${nonce.toString(16).padStart(64, "0")}`;
  await database.pool.query(
    `INSERT INTO provider_chain_writes
       (id,chain_id,wallet_address,nonce,purpose,target_type,target_id,
        intent_hash,transaction_hash,status)
     VALUES ($1,$2,$3,$4,$5,'service',$6,$7,$7,$8)`,
    [id, scope.chainId, scope.walletAddress, nonce, purpose, targetId, hash, status],
  );
  return id;
}

beforeAll(async () => {
  database = await createMigratedTestDatabase("daski_registration_writes");
  h.db = database.pool;
}, 120_000);

afterAll(async () => {
  await database?.drop();
});

describe("open provider writes for a target", { timeout: 30_000 }, () => {
  it("lists only unsettled writes of that purpose and target, oldest nonce first", async () => {
    const target = randomUUID();
    const later = await journal(12, "broadcast", "service_registration", target);
    const earlier = await journal(11, "prepared", "service_registration", target);
    const review = await journal(13, "attention", "service_registration", target);
    await journal(10, "confirmed", "service_registration", target);
    await journal(9, "replaced", "service_registration", target);
    await journal(14, "broadcast", "service_uri_update", target);
    await journal(15, "broadcast", "service_registration", randomUUID());

    const open = await listOpenProviderWrites(scope, "service_registration", {
      type: "service",
      id: target,
    });
    expect(open.map((row) => row.id)).toEqual([earlier, later, review]);
    expect(open.map((row) => row.status)).toEqual(["prepared", "broadcast", "attention"]);
  });
});
