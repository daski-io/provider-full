import type { Hex } from "viem";
import type { ProtectedArtifactReference } from "../a2a/responseBuilder.js";
import type { A2ATask } from "../a2a/responseTypes.js";
import { buildStandardTaskProjection } from "../a2a/taskHistory.js";
import { decryptString, encryptString } from "../chain/encryption.js";
import type { Queryable } from "../db/queryable.js";
import { logError } from "../logger.js";
import { canonicalHash } from "./canonical.js";
import { recordStandardSecurityIncident } from "./incidents.js";

export type TerminalState = "completed" | "failed" | "canceled";

export const TERMINAL_STATES: ReadonlySet<string> = new Set(["completed", "failed", "canceled"]);

export type TerminalProvenance = "terminal-transition" | "verified-attestation" | "unobserved-reconstruction";

/**
 * A terminal standard order whose identity is not frozen, or whose frozen
 * identity a conflicting historical identity isolated. No answer is signed
 * for it: guessing would contradict whatever the gateway retained.
 */
export class TerminalIdentityUnavailableError extends Error {
  constructor(readonly diagnostic: string) {
    super(`Standard terminal identity is unavailable: ${diagnostic}`);
    this.name = "TerminalIdentityUnavailableError";
  }
}

/** The identity every dispatch and lifecycle terminal attestation signs. */
export interface TerminalIdentity {
  state: TerminalState;
  resultHash: Hex;
  completedAt: number;
}

export const terminalProjectionContext = (transactionId: string) => ({
  purpose: "standard-terminal-result",
  table: "standard_terminal_results",
  recordId: transactionId,
  field: "projection_encrypted",
  service: "core",
  recordVersion: 1,
} as const);

/** Columns a signed answer's read selects from its LEFT JOINed frozen row `r`. */
export const FROZEN_TERMINAL_COLUMNS = `r.state AS frozen_state,r.completed_at AS frozen_completed_at,
  r.result_hash AS frozen_result_hash,r.isolated_diagnostic AS frozen_isolated`;

export interface FrozenTerminalColumns {
  frozen_state: string | null;
  frozen_completed_at: Date | null;
  frozen_result_hash: Buffer | null;
  frozen_isolated: string | null;
}

const seconds = (value: Date): number => Math.floor(value.getTime() / 1_000);

/**
 * The public terminal identity of a task, or null while it is nonterminal.
 * A frozen identity is published forever, even if the task row later moves
 * (an internal revival is not a public terminal change); a terminal task
 * without one is an unresolved legacy row and is never answered.
 */
export function publicTerminalIdentity(
  task: { status: string },
  frozen: FrozenTerminalColumns,
): TerminalIdentity | null {
  if (frozen.frozen_state) {
    if (frozen.frozen_isolated) throw new TerminalIdentityUnavailableError(frozen.frozen_isolated);
    if (!frozen.frozen_completed_at || !frozen.frozen_result_hash) {
      throw new TerminalIdentityUnavailableError("frozen_result_incomplete");
    }
    return {
      state: frozen.frozen_state as TerminalState,
      resultHash: `0x${frozen.frozen_result_hash.toString("hex")}`,
      completedAt: seconds(frozen.frozen_completed_at),
    };
  }
  if (TERMINAL_STATES.has(task.status)) throw new TerminalIdentityUnavailableError("legacy_identity_unverified");
  return null;
}

/** Protected artifact fields a projection may later reveal to an authorized read. */
export async function protectedArtifactReferences(
  db: Queryable,
  transactionId: string,
): Promise<ProtectedArtifactReference[]> {
  const rows = await db.query<{ artifact_name: string; field_path: string }>(
    `SELECT artifact_name,field_path FROM artifact_secrets
      WHERE transaction_id=$1 ORDER BY artifact_name,field_path`,
    [transactionId],
  );
  return rows.rows.map((row) => ({ artifactName: row.artifact_name, fieldPath: row.field_path }));
}

/** Insert one frozen identity; an existing one always wins. */
export async function insertFrozenTerminalResult(db: Queryable, args: {
  transactionId: string;
  state: TerminalState;
  completedAt: Date;
  resultHash: Hex;
  projection: A2ATask | null;
  references: ProtectedArtifactReference[];
  provenance: TerminalProvenance;
  evidenceId: string | null;
}): Promise<boolean> {
  if (args.projection && canonicalHash(args.projection) !== args.resultHash) {
    throw new Error("Frozen projection does not hash to its terminal identity");
  }
  const inserted = await db.query(
    `INSERT INTO standard_terminal_results
       (transaction_id,state,completed_at,result_hash,projection_encrypted,protected_references,provenance,evidence_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (transaction_id) DO NOTHING`,
    [
      args.transactionId, args.state, args.completedAt, Buffer.from(args.resultHash.slice(2), "hex"),
      args.projection
        ? encryptString(JSON.stringify(args.projection), terminalProjectionContext(args.transactionId))
        : null,
      JSON.stringify(args.references), args.provenance, args.evidenceId,
    ],
  );
  return inserted.rowCount === 1;
}

/**
 * The canonical hash of a projection, or null when its content (an unsafe
 * key, a lone surrogate, excessive nesting) has no canonical JSON form.
 */
export function projectionHash(projection: A2ATask): Hex | null {
  try {
    return canonicalHash(projection);
  } catch {
    return null;
  }
}

/**
 * Freeze a standard order's terminal identity inside the transaction that
 * first makes its task terminal, after every artifact and message of that
 * transition is written. Later transitions never replace it.
 *
 * Deliverables without a canonical form never block the terminal transition
 * itself: the order becomes terminal unfrozen, so no answer is signed for it
 * (it stays unavailable and is listed as unresolved), and an incident records
 * why. Failing the transition instead would keep a paid order from ever
 * completing, failing or being canceled.
 */
export async function freezeTerminalResult(db: Queryable, task: {
  id: string;
  status: string;
  completed_at: Date | null;
  standard_order_id?: string | null;
}): Promise<void> {
  if (!task.standard_order_id || !TERMINAL_STATES.has(task.status)) return;
  if (!task.completed_at) throw new Error("A terminal standard task has no completion time");
  const projection = await buildStandardTaskProjection({ id: task.id, status: task.status as TerminalState }, { db });
  const resultHash = projectionHash(projection);
  if (!resultHash) {
    logError("Standard terminal result has no canonical form and stays unfrozen", { state: task.status });
    await recordStandardSecurityIncident({
      kind: "noncanonical_terminal_result",
      orderId: task.standard_order_id,
      identity: { taskId: task.id, orderId: task.standard_order_id },
      details: { taskId: task.id, state: task.status },
    }).catch(() => undefined);
    return;
  }
  await insertFrozenTerminalResult(db, {
    transactionId: task.id,
    state: task.status as TerminalState,
    completedAt: task.completed_at,
    resultHash,
    projection,
    references: await protectedArtifactReferences(db, task.id),
    provenance: "terminal-transition",
    evidenceId: null,
  });
}

/**
 * The frozen unrevealed projection of a terminal order and its protected
 * references, or null when only its historical identity survives. The
 * decrypted bytes must still hash to the frozen identity.
 */
export async function loadFrozenTerminalProjection(
  db: Queryable,
  transactionId: string,
): Promise<{ projection: A2ATask; references: ProtectedArtifactReference[] } | null> {
  const row = (await db.query<{
    projection_encrypted: string | null;
    protected_references: ProtectedArtifactReference[];
    result_hash: Buffer;
  }>(
    `SELECT projection_encrypted,protected_references,result_hash
       FROM standard_terminal_results WHERE transaction_id=$1`,
    [transactionId],
  )).rows[0];
  if (!row) throw new TerminalIdentityUnavailableError("legacy_identity_unverified");
  if (!row.projection_encrypted) return null;
  let projection: A2ATask;
  try {
    projection = JSON.parse(decryptString(row.projection_encrypted, terminalProjectionContext(transactionId))) as A2ATask;
  } catch {
    throw new TerminalIdentityUnavailableError("frozen_projection_unreadable");
  }
  if (canonicalHash(projection) !== `0x${row.result_hash.toString("hex")}`) {
    throw new TerminalIdentityUnavailableError("frozen_projection_integrity");
  }
  return { projection, references: row.protected_references };
}
