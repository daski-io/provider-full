import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { pool } from "../db/pool.js";
import { canonicalHash } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { listingVersion } from "./listingVersions.js";
import { observeOperations, type OrderOperations } from "./operations.js";
import { orderSigningKeys, type OrderSigningKeys } from "./signingKeys.js";
import {
  FROZEN_TERMINAL_COLUMNS,
  publicTerminalIdentity,
  TerminalIdentityUnavailableError,
  type FrozenTerminalColumns,
  type TerminalState,
} from "./terminalResult.js";

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

interface SnapshotRow extends FrozenTerminalColumns {
  dispatch_hash: Buffer;
  transaction_id: string | null;
  listing_manifest_hash: Buffer | null;
  claim_state: string;
  operations_revision: string;
  operations_projection: unknown;
  status: string | null;
  observed_at: string;
}

// One statement reads the task state, its frozen terminal identity, the
// persisted operations projection and the database clock, so the
// observation is consistent and never cached.
const SNAPSHOT_SQL = `
  SELECT c.dispatch_hash,c.transaction_id,t.standard_listing_manifest_hash AS listing_manifest_hash,
         c.state AS claim_state,
         c.operations_revision::text AS operations_revision,c.operations_projection,
         t.status,${FROZEN_TERMINAL_COLUMNS},
         floor(extract(epoch FROM now()))::bigint::text AS observed_at
    FROM standard_dispatch_claims c
    LEFT JOIN transactions t ON t.id=c.transaction_id AND t.standard_order_id=c.order_id
    LEFT JOIN standard_terminal_results r ON r.transaction_id=t.id
   WHERE c.gateway_audience=$1 AND c.order_id=$2`;

const isResponseState = (state: string): state is DispatchResponseState =>
  (DISPATCH_RESPONSE_STATES as readonly string[]).includes(state);

async function sign(privateKey: Hex, digest: Hex): Promise<Hex> {
  return privateKeyToAccount(privateKey).signMessage({ message: { raw: digest } });
}

/**
 * The keys of the listing version the order was sold under. An order whose
 * version or key this deployment cannot resolve gets no answer at all
 * rather than one signed with another key.
 */
export async function orderKeys(
  config: ProviderStandardRailConfig,
  listingManifestHash: Buffer | null,
): Promise<OrderSigningKeys | null> {
  if (!listingManifestHash) return null;
  const version = await listingVersion(config, `0x${listingManifestHash.toString("hex")}`);
  if (!version) return null;
  try {
    return orderSigningKeys(config, version.signingKey);
  } catch {
    return null;
  }
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
  let identity: ReturnType<typeof publicTerminalIdentity>;
  try {
    identity = publicTerminalIdentity({ status: row.status ?? row.claim_state }, row);
  } catch (error) {
    if (error instanceof TerminalIdentityUnavailableError) throw new DispatchSnapshotUnavailableError(error.message);
    throw error;
  }
  const state = identity?.state ?? row.status ?? row.claim_state;
  if (!isResponseState(state)) {
    throw new DispatchSnapshotUnavailableError("Task state cannot be published to the gateway");
  }
  const keys = await orderKeys(config, row.listing_manifest_hash);
  if (!keys) throw new DispatchSnapshotUnavailableError("The order's listing version or its signing key is unavailable");
  const taskId = row.transaction_id;
  const dispatchHash = claim.dispatchHash;
  const operations = observeOperations({
    revision: row.operations_revision,
    projection: row.operations_projection,
    observedAt: row.observed_at,
  });
  const signature = await sign(
    keys.authorityPrivateKey,
    canonicalHash({ taskId, dispatchHash, state, operations }),
  );
  if (!identity) return { taskId, dispatchHash, signature, state, operations };
  const payload = {
    taskId, dispatchHash, state: identity.state,
    resultHash: identity.resultHash, completedAt: identity.completedAt,
  };
  return {
    taskId, dispatchHash, signature, state, operations,
    terminalAttestation: {
      payload,
      signature: await sign(keys.terminalPrivateKey, canonicalHash(payload)),
    },
  };
}
