import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { pool } from "../db/pool.js";
import { canonicalHash } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { observeOperations, type OrderOperations } from "./operations.js";
import { TERMINAL_STATES, terminalResultIdentity, type TerminalState } from "./terminalResult.js";

/** The task states the gateway accepts in a dispatch or status answer. */
export const DISPATCH_RESPONSE_STATES = [
  "dispatching", "submitted", "working", "input-required", "completed", "failed", "canceled",
] as const;

export type DispatchResponseState = typeof DISPATCH_RESPONSE_STATES[number];

export interface TerminalAttestationV1 {
  payload: {
    taskId: string;
    dispatchHash: Hex;
    state: TerminalState;
    resultHash: Hex;
    completedAt: number;
  };
  signature: Hex;
}

/** Exactly the keys the gateway accepts; the attestation only when terminal. */
export interface DispatchSnapshotV1 {
  taskId: string;
  dispatchHash: Hex;
  signature: Hex;
  state: DispatchResponseState;
  operations: OrderOperations;
  terminalAttestation?: TerminalAttestationV1;
}

export class DispatchSnapshotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchSnapshotUnavailableError";
  }
}

interface SnapshotRow {
  dispatch_hash: Buffer;
  transaction_id: string | null;
  claim_state: string;
  operations_revision: string;
  operations_projection: unknown;
  status: string | null;
  completed_at: Date | null;
  observed_at: string;
}

// One statement reads the task state, the persisted operations projection and
// the database clock, so the observation is consistent and never cached.
const SNAPSHOT_SQL = `
  SELECT c.dispatch_hash,c.transaction_id,c.state AS claim_state,
         c.operations_revision::text AS operations_revision,c.operations_projection,
         t.status,t.completed_at,
         floor(extract(epoch FROM now()))::bigint::text AS observed_at
    FROM standard_dispatch_claims c
    LEFT JOIN transactions t ON t.id=c.transaction_id AND t.standard_order_id=c.order_id
   WHERE c.gateway_audience=$1 AND c.order_id=$2`;

const isResponseState = (state: string): state is DispatchResponseState =>
  (DISPATCH_RESPONSE_STATES as readonly string[]).includes(state);

async function sign(privateKey: Hex, digest: Hex): Promise<Hex> {
  return privateKeyToAccount(privateKey).signMessage({ message: { raw: digest } });
}

/**
 * Build and sign the current answer for one admitted claim. The read writes
 * nothing, calls no product and replays no history for a pending task; each
 * call stamps the database time as `observedAt` and signs that observation.
 */
export async function signedDispatchSnapshot(
  config: ProviderStandardRailConfig,
  claim: { gatewayAudience: string; orderId: string; dispatchHash: Hex },
): Promise<DispatchSnapshotV1> {
  const row = (await pool.query<SnapshotRow>(SNAPSHOT_SQL, [claim.gatewayAudience, claim.orderId])).rows[0];
  if (!row?.transaction_id || `0x${row.dispatch_hash.toString("hex")}` !== claim.dispatchHash) {
    throw new DispatchSnapshotUnavailableError("Admitted claim is unavailable for this dispatch");
  }
  const state = row.status ?? row.claim_state;
  if (!isResponseState(state)) {
    throw new DispatchSnapshotUnavailableError("Task state cannot be published to the gateway");
  }
  const taskId = row.transaction_id;
  const dispatchHash = claim.dispatchHash;
  const operations = observeOperations({
    revision: row.operations_revision,
    projection: row.operations_projection,
    observedAt: row.observed_at,
  });
  const signature = await sign(
    config.providerAuthorityPrivateKey,
    canonicalHash({ taskId, dispatchHash, state, operations }),
  );
  if (!TERMINAL_STATES.has(state)) return { taskId, dispatchHash, signature, state, operations };
  if (!row.completed_at) throw new DispatchSnapshotUnavailableError("Terminal task completion time is missing");
  const identity = await terminalResultIdentity({
    id: taskId, status: state as TerminalState, completedAt: row.completed_at,
  });
  const payload = {
    taskId, dispatchHash, state: state as TerminalState,
    resultHash: identity.resultHash, completedAt: identity.completedAt,
  };
  return {
    taskId, dispatchHash, signature, state, operations,
    terminalAttestation: {
      payload,
      signature: await sign(config.terminalAttestationPrivateKey, canonicalHash(payload)),
    },
  };
}
