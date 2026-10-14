import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { pool } from "../db/pool.js";
import type { Queryable } from "../db/queryable.js";
import { canonicalHash } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { orderKeys } from "./dispatchResponse.js";
import { lifecycleUnavailable } from "./lifecycleErrors.js";
import { observeOperations, type OrderOperations } from "./operations.js";
import {
  FROZEN_TERMINAL_COLUMNS,
  publicTerminalIdentity,
  type FrozenTerminalColumns,
  type TerminalIdentity,
} from "./terminalResult.js";

const LIFECYCLE_STATES = new Set(["submitted", "working", "input-required", "completed", "failed", "canceled"]);

/** Exactly the keys the gateway accepts; result and attestation only where allowed. */
export interface LifecycleAnswerV1 {
  orderId: string;
  taskId: string;
  state: string;
  operations: OrderOperations;
  result?: unknown;
  terminalAttestation?: {
    payload: { orderId: string; taskId: string; state: string; resultHash: Hex; completedAt: number };
    signature: Hex;
  };
  signature: Hex;
}

interface AnswerRow extends FrozenTerminalColumns {
  status: string;
  listing_manifest_hash: Buffer | null;
  operations_revision: string;
  operations_projection: unknown;
  observed_at: string;
}

// One statement reads the task state, its frozen terminal identity, the
// claim's persisted operations projection and the database clock.
const ANSWER_SQL = `
  SELECT t.status,t.standard_listing_manifest_hash AS listing_manifest_hash,${FROZEN_TERMINAL_COLUMNS},
         c.operations_revision::text AS operations_revision,c.operations_projection,
         floor(extract(epoch FROM now()))::bigint::text AS observed_at
    FROM transactions t
    JOIN standard_dispatch_claims c
      ON c.transaction_id=t.id AND c.order_id=t.standard_order_id AND c.gateway_audience=$3
    LEFT JOIN standard_terminal_results r ON r.transaction_id=t.id
   WHERE t.id=$1 AND t.standard_order_id=$2`;

/** The current public state and terminal identity of one standard task. */
export async function readLifecycleState(
  config: ProviderStandardRailConfig,
  task: { orderId: string; taskId: string },
  db: Queryable = pool,
): Promise<{
  state: string;
  identity: TerminalIdentity | null;
  operations: OrderOperations;
  listingManifestHash: Buffer | null;
}> {
  const row = (await db.query<AnswerRow>(ANSWER_SQL, [task.taskId, task.orderId, config.gatewayAudience])).rows[0];
  if (!row) throw lifecycleUnavailable("Standard task has no claim to answer for");
  const identity = publicTerminalIdentity(row, row);
  const state = identity?.state ?? row.status;
  if (!LIFECYCLE_STATES.has(state)) throw lifecycleUnavailable("Task state cannot be published to the gateway");
  const operations = observeOperations({
    revision: row.operations_revision, projection: row.operations_projection, observedAt: row.observed_at,
  });
  return { state, identity, operations, listingManifestHash: row.listing_manifest_hash };
}

async function sign(privateKey: Hex, value: unknown): Promise<Hex> {
  return privateKeyToAccount(privateKey).signMessage({ message: { raw: canonicalHash(value) } });
}

/**
 * Build and sign one lifecycle answer from a fresh read: the public state,
 * a freshly stamped operations observation, the lifecycle attestation of the
 * frozen terminal identity when terminal, and an optional result. Nothing is
 * cached; every call signs its own observation.
 */
export async function signedLifecycleAnswer(
  config: ProviderStandardRailConfig,
  task: { orderId: string; taskId: string },
  options: { result?: unknown; db?: Queryable } = {},
): Promise<LifecycleAnswerV1> {
  const { state, identity, operations, listingManifestHash } = await readLifecycleState(config, task, options.db);
  // Signed with the keys of the version the order was sold under, forever.
  const keys = await orderKeys(config, listingManifestHash);
  if (!keys) throw lifecycleUnavailable("The order's listing version or its signing key is unavailable");
  const unsigned: Omit<LifecycleAnswerV1, "signature"> = {
    orderId: task.orderId, taskId: task.taskId, state, operations,
    ...(options.result === undefined ? {} : { result: options.result }),
  };
  if (identity) {
    const payload = {
      orderId: task.orderId, taskId: task.taskId, state: identity.state,
      resultHash: identity.resultHash, completedAt: identity.completedAt,
    };
    unsigned.terminalAttestation = { payload, signature: await sign(keys.terminalPrivateKey, payload) };
  }
  return { ...unsigned, signature: await sign(keys.authorityPrivateKey, unsigned) };
}
