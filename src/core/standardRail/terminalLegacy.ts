import { randomUUID } from "node:crypto";
import { getAddress, recoverMessageAddress, type Hex } from "viem";
import { buildStandardTaskProjection } from "../a2a/taskHistory.js";
import { pool } from "../db/pool.js";
import { inTransaction, type Queryable } from "../db/queryable.js";
import { recordMandatoryAudit } from "../events/emitter.js";
import { canonicalHash } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import {
  insertFrozenTerminalResult,
  projectionHash,
  protectedArtifactReferences,
  TERMINAL_STATES,
  type TerminalIdentity,
  type TerminalState,
} from "./terminalResult.js";

/*
 * Legacy terminal rows became terminal before this release froze results at
 * the transition; earlier releases re-hashed a projection rebuilt from
 * mutable events on every read. They are classified only from recorded
 * evidence, never from a first observation:
 *
 *   - a frozen record exists: serve it;
 *   - a verified attestation the gateway retained, and a reconstruction whose
 *     bytes hash to it: freeze those bytes;
 *   - a verified attestation but no matching bytes: freeze the identity alone
 *     (status keeps its evidence, artifact reads are unavailable);
 *   - an operator's record of the gateway handoff that no identity was
 *     admitted: freeze the deterministic reconstruction;
 *   - otherwise isolate the row with a stable diagnostic.
 */
export type LegacyDiagnostic =
  | "legacy_identity_unverified"
  | "legacy_evidence_conflict"
  | "legacy_evidence_mismatch"
  | "legacy_projection_noncanonical";

export type ReconcileOutcome =
  | { status: "frozen"; provenance: "verified-attestation" | "unobserved-reconstruction"; bytes: boolean }
  | { status: "already_frozen" }
  | { status: "unresolved" | "isolated"; diagnostic: LegacyDiagnostic };

interface LegacyTaskRow {
  id: string;
  status: string;
  completed_at: Date | null;
  standard_order_id: string;
  dispatch_hash: Buffer | null;
}

interface EvidenceRow {
  id: string;
  kind: "attestation" | "unobserved";
  state: string | null;
  completed_at_seconds: string | null;
  result_hash: Buffer | null;
}

const HASH = /^0x[0-9a-f]{64}$/;
const DISPATCH_FORM = "completedAt,dispatchHash,resultHash,state,taskId";
const LIFECYCLE_FORM = "completedAt,orderId,resultHash,state,taskId";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const seconds = (value: Date): number => Math.floor(value.getTime() / 1_000);

/**
 * A provider terminal attestation in its dispatch or lifecycle form, bound to
 * this task and order and signed by this provider's terminal attestation key.
 */
export async function verifyRetainedAttestation(
  config: ProviderStandardRailConfig,
  task: LegacyTaskRow,
  attestation: unknown,
): Promise<TerminalIdentity> {
  if (!isRecord(attestation) || Object.keys(attestation).sort().join() !== "payload,signature" ||
      !isRecord(attestation.payload) || typeof attestation.signature !== "string") {
    throw new Error("terminal attestation shape is invalid");
  }
  const payload = attestation.payload;
  const form = Object.keys(payload).sort().join();
  const bound = form === DISPATCH_FORM
    ? !!task.dispatch_hash && payload.dispatchHash === `0x${task.dispatch_hash.toString("hex")}`
    : form === LIFECYCLE_FORM && payload.orderId === task.standard_order_id;
  if (
    !bound || payload.taskId !== task.id || typeof payload.state !== "string" ||
    !TERMINAL_STATES.has(payload.state) || typeof payload.resultHash !== "string" ||
    !HASH.test(payload.resultHash) || !Number.isSafeInteger(payload.completedAt) ||
    (payload.completedAt as number) <= 0
  ) throw new Error("terminal attestation does not bind this task");
  const signer = await recoverMessageAddress({
    message: { raw: canonicalHash(payload) }, signature: attestation.signature as Hex,
  }).catch(() => null);
  if (!signer || getAddress(signer) !== getAddress(config.terminalAttestationKey)) {
    throw new Error("terminal attestation is not signed by this provider");
  }
  return {
    state: payload.state as TerminalState,
    resultHash: payload.resultHash as Hex,
    completedAt: payload.completedAt as number,
  };
}

type Classification =
  | { kind: "attested"; identity: TerminalIdentity; evidenceId: string }
  | { kind: "unobserved"; evidenceId: string }
  | { kind: "diagnostic"; diagnostic: LegacyDiagnostic };

function identityOf(row: EvidenceRow): TerminalIdentity {
  return {
    state: row.state as TerminalState,
    resultHash: `0x${row.result_hash!.toString("hex")}`,
    completedAt: Number(row.completed_at_seconds),
  };
}

/** Classify a legacy row from its recorded evidence alone. */
export function classifyLegacyEvidence(task: Pick<LegacyTaskRow, "status" | "completed_at">, evidence: EvidenceRow[]): Classification {
  const attestations = evidence.filter((row) => row.kind === "attestation");
  const unobserved = evidence.filter((row) => row.kind === "unobserved");
  if (attestations.length === 0 && unobserved.length === 0) return { kind: "diagnostic", diagnostic: "legacy_identity_unverified" };
  if (attestations.length > 0 && unobserved.length > 0) return { kind: "diagnostic", diagnostic: "legacy_evidence_conflict" };
  if (attestations.length === 0) return { kind: "unobserved", evidenceId: unobserved[0]!.id };
  const identities = new Set(attestations.map((row) => canonicalHash(identityOf(row))));
  if (identities.size > 1) return { kind: "diagnostic", diagnostic: "legacy_evidence_conflict" };
  const identity = identityOf(attestations[0]!);
  if (identity.state !== task.status || !task.completed_at || identity.completedAt !== seconds(task.completed_at)) {
    return { kind: "diagnostic", diagnostic: "legacy_evidence_mismatch" };
  }
  return { kind: "attested", identity, evidenceId: attestations[0]!.id };
}

async function loadEvidence(db: Queryable, transactionId: string): Promise<EvidenceRow[]> {
  return (await db.query<EvidenceRow>(
    `SELECT id,kind,state,completed_at_seconds::text AS completed_at_seconds,result_hash
       FROM standard_terminal_evidence WHERE transaction_id=$1 ORDER BY recorded_at,id`,
    [transactionId],
  )).rows;
}

async function lockLegacyTask(db: Queryable, transactionId: string): Promise<LegacyTaskRow> {
  const task = (await db.query<LegacyTaskRow>(
    `SELECT t.id,t.status,t.completed_at,t.standard_order_id,c.dispatch_hash
       FROM transactions t
       LEFT JOIN standard_dispatch_claims c ON c.transaction_id=t.id AND c.order_id=t.standard_order_id
      WHERE t.id=$1 AND t.standard_order_id IS NOT NULL FOR UPDATE OF t`,
    [transactionId],
  )).rows[0];
  if (!task) throw new Error("standard order task not found");
  return task;
}

/** Reconcile one legacy row from its evidence, inside the caller's transaction. */
export async function reconcileLegacyTerminalResult(db: Queryable, transactionId: string): Promise<ReconcileOutcome> {
  const task = await lockLegacyTask(db, transactionId);
  const evidence = await loadEvidence(db, transactionId);
  const frozen = (await db.query<{ state: string; completed_at: Date; result_hash: Buffer; isolated_diagnostic: string | null }>(
    "SELECT state,completed_at,result_hash,isolated_diagnostic FROM standard_terminal_results WHERE transaction_id=$1",
    [transactionId],
  )).rows[0];
  if (frozen) {
    if (frozen.isolated_diagnostic) return { status: "isolated", diagnostic: frozen.isolated_diagnostic as LegacyDiagnostic };
    const identity = canonicalHash({
      state: frozen.state, resultHash: `0x${frozen.result_hash.toString("hex")}`, completedAt: seconds(frozen.completed_at),
    });
    // A retained identity that differs from what was frozen proves an
    // earlier provider signed something else: never keep serving a guess.
    const conflicting = evidence.some((row) => row.kind === "attestation" && canonicalHash(identityOf(row)) !== identity);
    if (!conflicting) return { status: "already_frozen" };
    await db.query("UPDATE standard_terminal_results SET isolated_diagnostic=$2 WHERE transaction_id=$1",
      [transactionId, "legacy_evidence_conflict"]);
    return { status: "isolated", diagnostic: "legacy_evidence_conflict" };
  }
  if (!TERMINAL_STATES.has(task.status) || !task.completed_at) throw new Error("only a terminal standard order can be reconciled");
  const classified = classifyLegacyEvidence(task, evidence);
  if (classified.kind === "diagnostic") return { status: "unresolved", diagnostic: classified.diagnostic };
  const state = task.status as TerminalState;
  const references = await protectedArtifactReferences(db, task.id);
  const current = await buildStandardTaskProjection({ id: task.id, status: state }, { db });
  if (classified.kind === "unobserved") {
    const resultHash = projectionHash(current);
    // Deliverables without a canonical form have no identity to freeze.
    if (!resultHash) return { status: "unresolved", diagnostic: "legacy_projection_noncanonical" };
    await insertFrozenTerminalResult(db, {
      transactionId: task.id, state, completedAt: task.completed_at, resultHash,
      projection: current, references, provenance: "unobserved-reconstruction", evidenceId: classified.evidenceId,
    });
    return { status: "frozen", provenance: "unobserved-reconstruction", bytes: true };
  }
  // Earlier releases hashed support messages into the projection; either
  // reconstruction may be the one the attestation names.
  const legacy = await buildStandardTaskProjection({ id: task.id, status: state }, { db, includeSupport: true });
  const matching = [current, legacy].find((candidate) => projectionHash(candidate) === classified.identity.resultHash) ?? null;
  await insertFrozenTerminalResult(db, {
    transactionId: task.id, state, completedAt: task.completed_at, resultHash: classified.identity.resultHash,
    projection: matching, references: matching ? references : [], provenance: "verified-attestation",
    evidenceId: classified.evidenceId,
  });
  return { status: "frozen", provenance: "verified-attestation", bytes: matching !== null };
}

/** Record one piece of verified legacy evidence and reconcile the row with it. */
export async function recordLegacyTerminalEvidence(config: ProviderStandardRailConfig, args: {
  transactionId: string;
  kind: "attestation" | "unobserved";
  attestation?: unknown;
  reference: string;
  actor: string;
}): Promise<ReconcileOutcome> {
  return inTransaction(pool, async (db) => {
    const task = await lockLegacyTask(db, args.transactionId);
    const identity = args.kind === "attestation"
      ? await verifyRetainedAttestation(config, task, args.attestation)
      : null;
    const id = randomUUID();
    await db.query(
      `INSERT INTO standard_terminal_evidence
         (id,transaction_id,kind,attestation,state,completed_at_seconds,result_hash,reference,recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id, task.id, args.kind, identity ? JSON.stringify(args.attestation) : null, identity?.state ?? null,
        identity?.completedAt ?? null, identity ? Buffer.from(identity.resultHash.slice(2), "hex") : null,
        args.reference, args.actor,
      ],
    );
    const outcome = await reconcileLegacyTerminalResult(db, task.id);
    await recordMandatoryAudit(db, {
      transactionId: task.id, source: "admin", actor: args.actor, severity: "warn",
      type: "standard.terminal.legacy_evidence_recorded",
      message: "An operator recorded legacy terminal evidence for a standard order.",
      payload: { evidenceId: id, kind: args.kind, outcome },
    });
    return outcome;
  });
}

/** Read-only: terminal standard orders the provider will not answer, with a stable diagnostic. */
export async function listUnresolvedLegacyTerminalResults(limit = 100): Promise<Array<{
  transactionId: string;
  orderId: string;
  state: string;
  completedAt: string | null;
  diagnostic: string;
}>> {
  const rows = (await pool.query<{
    id: string; standard_order_id: string; status: string; completed_at: Date | null;
    isolated_diagnostic: string | null; evidence: EvidenceRow[];
  }>(
    `SELECT t.id,t.standard_order_id,t.status,t.completed_at,r.isolated_diagnostic,
            COALESCE((SELECT json_agg(json_build_object('id',e.id,'kind',e.kind,'state',e.state,
                        'completed_at_seconds',e.completed_at_seconds::text,'result_hash',
                        CASE WHEN e.result_hash IS NULL THEN NULL ELSE encode(e.result_hash,'hex') END)
                        ORDER BY e.recorded_at,e.id)
                        FROM standard_terminal_evidence e WHERE e.transaction_id=t.id),'[]'::json) AS evidence
       FROM transactions t
       LEFT JOIN standard_terminal_results r ON r.transaction_id=t.id
      WHERE t.standard_order_id IS NOT NULL
        AND ((r.transaction_id IS NULL AND t.status IN ('completed','failed','canceled'))
          OR r.isolated_diagnostic IS NOT NULL)
      ORDER BY t.completed_at NULLS FIRST,t.id LIMIT $1`,
    [Math.min(Math.max(limit, 1), 1_000)],
  )).rows;
  return rows.map((row) => {
    const evidence = row.evidence.map((item) => ({
      ...item, result_hash: item.result_hash ? Buffer.from(item.result_hash as unknown as string, "hex") : null,
    }));
    const classified = classifyLegacyEvidence(row, evidence);
    return {
      transactionId: row.id,
      orderId: row.standard_order_id,
      state: row.status,
      completedAt: row.completed_at?.toISOString() ?? null,
      diagnostic: row.isolated_diagnostic ??
        (classified.kind === "diagnostic" ? classified.diagnostic : "legacy_reconciliation_pending"),
    };
  });
}
