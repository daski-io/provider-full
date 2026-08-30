import { createHash } from "node:crypto";
import { pool } from "../db/pool.js";
import type { Queryable } from "../db/queryable.js";
import { withSessionAdvisoryLock } from "../db/sessionAdvisoryLock.js";
import { redactSensitiveValue } from "../security/redaction.js";
import { SupplierOutcomeAmbiguousError } from "./errorClassifier.js";

export { SupplierOutcomeAmbiguousError } from "./errorClassifier.js";

// The platform-wide contract for AMBIGUOUS EXTERNAL RESULTS (audit 1.0).
//
// Every supplier mutation that must happen at most once logically journals
// an intent row BEFORE the call. The lifecycle:
//
//   intent     — claimed; the supplier call is about to run / running.
//   ambiguous  — the call's outcome is unknown (timeout, crash, transport
//                error after the request may have landed). Retries MUST
//                reconcile from authoritative supplier state before doing
//                anything else; blind re-posting is forbidden.
//   confirmed  — the mutation definitively happened; `result` holds what
//                the caller needs to resume idempotently.
//   failed     — the mutation definitively did NOT happen; safe to retry
//                with a fresh operation.
//
// `runSupplierOperation` packages the discipline: begin (conditional claim
// on (service_id, op_key)) → execute or reconcile → confirm/fail/ambiguous.
// Service pipelines use it instead of inventing per-service journals.

export type SupplierOperationState = "intent" | "ambiguous" | "confirmed" | "failed";
type SupplierOperationErrorPhase =
  | "execute"
  | "reconcile"
  | "confirmation"
  | "operator";
type SupplierOperationErrorReason =
  | "transport"
  | "validation"
  | "auth"
  | "conflict"
  | "rate_limited"
  | "server"
  | "unexpected"
  | "rejected"
  | "ambiguous"
  | "not_applied";
export type SupplierOperationErrorCode =
  `${SupplierOperationErrorPhase}.${SupplierOperationErrorReason}`;

export interface SupplierOperationRow {
  id: string;
  service_id: string;
  transaction_id: string | null;
  op_key: string;
  kind: string;
  state: SupplierOperationState;
  request_fingerprint: string | null;
  result: Record<string, unknown> | null;
  error_code: string | null;
  attempts: number;
  created_at: Date;
  updated_at: Date;
}

export function fingerprintRequest(request: unknown): string {
  return createHash("sha256").update(JSON.stringify(request ?? null)).digest("hex");
}

/// Claim (or re-find) the operation. The UNIQUE (service_id, op_key)
/// constraint makes the claim conditional across replicas: exactly one
/// caller inserts; everyone else observes the existing row and must act on
/// its state instead of re-posting.
export async function beginSupplierOperation(args: {
  serviceId: string;
  transactionId?: string | null;
  opKey: string;
  kind: string;
  requestFingerprint?: string | null;
  db?: Queryable;
}): Promise<{ op: SupplierOperationRow; fresh: boolean }> {
  const db = args.db ?? pool;
  const inserted = await db.query<SupplierOperationRow>(
    `INSERT INTO supplier_operations
       (service_id, transaction_id, op_key, kind, request_fingerprint)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (service_id, op_key) DO NOTHING
     RETURNING *`,
    [
      args.serviceId,
      args.transactionId ?? null,
      args.opKey,
      args.kind,
      args.requestFingerprint ?? null,
    ],
  );
  if (inserted.rows[0]) return { op: inserted.rows[0], fresh: true };
  const existing = await db.query<SupplierOperationRow>(
    `SELECT * FROM supplier_operations WHERE service_id = $1 AND op_key = $2`,
    [args.serviceId, args.opKey],
  );
  const op = existing.rows[0];
  if (!op) throw new Error("supplier operation vanished after its claim");
  if (op.kind !== args.kind) {
    throw new Error("supplier operation exists for a DIFFERENT kind");
  }
  if (op.request_fingerprint !== (args.requestFingerprint ?? null)) {
    throw new Error("supplier operation exists for a DIFFERENT request");
  }
  return { op, fresh: false };
}

export async function getSupplierOperation(
  serviceId: string,
  opKey: string,
  db: Queryable = pool,
): Promise<SupplierOperationRow | null> {
  const result = await db.query<SupplierOperationRow>(
    `SELECT * FROM supplier_operations WHERE service_id = $1 AND op_key = $2`,
    [serviceId, opKey],
  );
  return result.rows[0] ?? null;
}

export async function confirmSupplierOperation(
  id: string,
  result: Record<string, unknown> | null,
  db: Queryable = pool,
): Promise<void> {
  const updated = await db.query(
    `UPDATE supplier_operations
        SET state = 'confirmed',
            result = $2,
            error_code = NULL,
            updated_at = now()
      WHERE id = $1 AND state IN ('intent','ambiguous')`,
    [id, result === null ? null : JSON.stringify(redactSensitiveValue(result))],
  );
  if (updated.rowCount !== 1) {
    throw new Error(`supplier operation '${id}' was not durably confirmed`);
  }
}

export async function failSupplierOperation(
  id: string,
  errorCode: SupplierOperationErrorCode,
  db: Queryable = pool,
): Promise<void> {
  assertSupplierErrorCode(errorCode);
  const updated = await db.query(
    `UPDATE supplier_operations
        SET state = 'failed', error_code = $2, updated_at = now()
      WHERE id = $1 AND state IN ('intent','ambiguous')`,
    [id, errorCode],
  );
  if (updated.rowCount !== 1) {
    throw new Error(`supplier operation '${id}' was not durably failed`);
  }
}

export async function markSupplierOperationAmbiguous(
  id: string,
  errorCode: SupplierOperationErrorCode,
  db: Queryable = pool,
): Promise<void> {
  assertSupplierErrorCode(errorCode);
  const updated = await db.query(
    `UPDATE supplier_operations
        SET state = 'ambiguous', error_code = $2,
            attempts = attempts + 1, updated_at = now()
      WHERE id = $1 AND state IN ('intent','ambiguous')`,
    [id, errorCode],
  );
  if (updated.rowCount !== 1) {
    throw new Error(`supplier operation '${id}' was not durably marked ambiguous`);
  }
}

const SUPPLIER_ERROR_CODE =
  /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/;

function assertSupplierErrorCode(errorCode: SupplierOperationErrorCode): void {
  if (
    errorCode.length < 3 ||
    errorCode.length > 64 ||
    !SUPPLIER_ERROR_CODE.test(errorCode)
  ) {
    throw new Error("invalid supplier operation error code");
  }
}

type OperationPhase = "execute" | "reconcile" | "confirmation";

function operationErrorCode(
  phase: OperationPhase,
  error: unknown,
): SupplierOperationErrorCode {
  if (error instanceof SupplierOutcomeAmbiguousError) {
    return `${phase}.ambiguous`;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "category" in error &&
    typeof error.category === "string" &&
    [
      "transport",
      "validation",
      "auth",
      "conflict",
      "rate_limited",
      "server",
      "unexpected",
      "rejected",
    ].includes(error.category)
  ) {
    return `${phase}.${error.category as SupplierOperationErrorReason}`;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    if (error.status === 401 || error.status === 403) {
      return `${phase}.auth`;
    }
    if (error.status === 408) return `${phase}.transport`;
    if (error.status === 409) return `${phase}.conflict`;
    if (error.status === 429) return `${phase}.rate_limited`;
    if (error.status >= 500) return `${phase}.server`;
    if (error.status >= 400) return `${phase}.rejected`;
  }
  return `${phase}.unexpected`;
}

export interface SupplierOperationArgs<T extends Record<string, unknown>> {
  serviceId: string;
  transactionId?: string | null;
  /** Logical identity of the mutation, e.g. `renew:asset-1:2027`. */
  opKey: string;
  /** Machine-readable operation kind, e.g. `namecom.renew`. */
  kind: string;
  /** The exact request payload the intent covers (fingerprinted). */
  request?: unknown;
  /**
   * Read-only authorization immediately before the supplier mutation.
   * Rejections prove that execute was not called, so they propagate without
   * marking the operation ambiguous.
   */
  authorizeMutation?: () => Promise<void>;
  /** Perform the supplier mutation; return what a resume needs. */
  execute: () => Promise<T>;
  /**
   * Derive the DEFINITIVE outcome from authoritative supplier state after
   * an ambiguous attempt (or when adopting a dangling intent). Return the
   * confirmed result, null when the mutation definitively did NOT happen
   * (the operation is retried via execute), or throw
   * SupplierOutcomeAmbiguousError to stay parked.
   */
  reconcile: () => Promise<T | null>;
}

/// Run a supplier mutation exactly-once logically. Confirmed operations
/// short-circuit to their stored result; dangling intents and ambiguous
/// outcomes reconcile from supplier state; only a definitive "did not
/// happen" re-executes. Throws SupplierOutcomeAmbiguousError while the
/// outcome cannot be proven either way — callers park/retry, never refund.
export async function runSupplierOperation<T extends Record<string, unknown>>(
  args: SupplierOperationArgs<T>,
): Promise<T> {
  const result = await withSessionAdvisoryLock({
    connect: async () => {
      try {
        return await pool.connect();
      } catch {
        throw new SupplierOutcomeAmbiguousError(
          "Supplier operation journal is unavailable.",
        );
      }
    },
    async acquire(client) {
      try {
        await client.query(
          "SELECT pg_advisory_lock(hashtext($1), hashtext($2))",
          [args.serviceId, args.opKey],
        );
        return { status: "acquired" };
      } catch {
        throw new SupplierOutcomeAmbiguousError(
          "Supplier operation journal lock is unavailable.",
        );
      }
    },
    async unlock(client) {
      const unlocked = await client.query<{ unlocked: boolean }>(
        "SELECT pg_advisory_unlock(hashtext($1), hashtext($2)) AS unlocked",
        [args.serviceId, args.opKey],
      );
      return unlocked.rows[0]?.unlocked === true;
    },
    work: (client) => runSupplierOperationLocked(args, client),
  });
  if (result.status === "busy") {
    throw new SupplierOutcomeAmbiguousError(
      "Supplier operation journal lock unexpectedly reported busy.",
    );
  }
  return result.value;
}

async function runSupplierOperationLocked<T extends Record<string, unknown>>(
  args: SupplierOperationArgs<T>,
  db: Queryable,
): Promise<T> {
  const fingerprint = args.request !== undefined ? fingerprintRequest(args.request) : null;
  let claimed: { op: SupplierOperationRow; fresh: boolean };
  try {
    claimed = await beginSupplierOperation({
      serviceId: args.serviceId,
      transactionId: args.transactionId,
      opKey: args.opKey,
      kind: args.kind,
      requestFingerprint: fingerprint,
      db,
    });
  } catch {
    throw new SupplierOutcomeAmbiguousError(
      "Supplier operation intent could not be established.",
    );
  }
  const { op, fresh } = claimed;

  if (op.state === "confirmed") return (op.result ?? {}) as T;
  if (op.state === "failed" && !fresh) {
    // A definitively-failed operation is terminal under this key; the
    // caller decides whether to mint a NEW operation (fresh key) or fail.
    throw new Error("supplier operation already failed definitively");
  }

  if (!fresh) {
    // Dangling intent or ambiguous outcome from an earlier attempt:
    // reconcile from supplier truth before anything else.
    let reconciled: T | null;
    try {
      reconciled = await args.reconcile();
    } catch (err) {
      try {
        await markSupplierOperationAmbiguous(
          op.id,
          operationErrorCode("reconcile", err),
          db,
        );
      } catch {
        throw new SupplierOutcomeAmbiguousError(
          "Supplier reconciliation could not be journaled.",
        );
      }
      throw new SupplierOutcomeAmbiguousError(
        "Supplier reconciliation could not prove the operation outcome.",
      );
    }
    if (reconciled !== null) {
      try {
        await confirmSupplierOperation(op.id, reconciled, db);
        return reconciled;
      } catch (error) {
        try {
          await markSupplierOperationAmbiguous(
            op.id,
            operationErrorCode("confirmation", error),
            db,
          );
        } catch {
          // The typed error below keeps fulfillment parked even when the
          // journal connection is unavailable for the follow-up write.
        }
        throw new SupplierOutcomeAmbiguousError(
          "Reconciled supplier operation could not be durably confirmed.",
        );
      }
    }
    // Definitively did not happen — fall through to execute.
  }

  let result: T;
  await args.authorizeMutation?.();
  try {
    result = await args.execute();
  } catch (err) {
    // The attempt's outcome is unknown until reconciliation proves it:
    // park ambiguous. (A caller with a supplier error that PROVES
    // non-execution can resolve it in reconcile() on the next pass.)
    try {
      await markSupplierOperationAmbiguous(
        op.id,
        operationErrorCode("execute", err),
        db,
      );
    } catch {
      throw new SupplierOutcomeAmbiguousError(
        "Supplier operation outcome could not be journaled.",
      );
    }
    throw new SupplierOutcomeAmbiguousError(
      "Supplier operation outcome is unknown.",
    );
  }
  try {
    await confirmSupplierOperation(op.id, result, db);
    return result;
  } catch (error) {
    try {
      await markSupplierOperationAmbiguous(
        op.id,
        operationErrorCode("confirmation", error),
        db,
      );
    } catch {
      throw new SupplierOutcomeAmbiguousError(
        "Supplier operation result could not be journaled.",
      );
    }
    throw new SupplierOutcomeAmbiguousError(
      "Supplier operation result could not be durably confirmed.",
    );
  }
}
