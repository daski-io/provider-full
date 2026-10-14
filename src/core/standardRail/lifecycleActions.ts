import { pool } from "../db/pool.js";
import { inTransaction, type Queryable } from "../db/queryable.js";
import { canonicalHash } from "./canonical.js";
import type { LifecycleCall } from "./lifecycleAuthorization.js";
import { actionConflict, lifecycleUnavailable } from "./lifecycleErrors.js";
import type { StandardTaskRow } from "./lifecycleStore.js";

/** How long one attempt owns an unresolved action before another may resume it. */
export const LIFECYCLE_ACTION_LEASE_SECONDS = 300;

export type LifecycleActionKind = "input" | "cancel";

/** A durable action identity this attempt owns until it commits, releases or abandons it. */
export interface LifecycleActionClaim {
  transactionId: string;
  action: LifecycleActionKind;
  identity: Buffer;
  /** An earlier attempt left this identity with an uncertain outcome. */
  resumed: boolean;
}

interface ActionRow {
  action: LifecycleActionKind;
  identity_hash: Buffer;
  request_hash: Buffer;
  state: "claimed" | "committed";
  live: boolean;
}

const bytes = (hex: string): Buffer => Buffer.from(hex.slice(2), "hex");

/**
 * The protocol has no business request id for input or cancellation, so the
 * admitted task and the request identify the action: a cancellation once per
 * order, an input by its request hash.
 */
function actionIdentity(call: LifecycleCall): { identity: Buffer; requestHash: Buffer } {
  const requestHash = bytes(canonicalHash(call.request));
  return { identity: call.action === "cancel" ? bytes(canonicalHash("cancel")) : requestHash, requestHash };
}

/**
 * Claim the call's action identity, or report that it already committed. A
 * committed identity bound to the same content is replayed without effect and
 * one bound to other content is a conflict; an identity another attempt holds
 * under a live lease is unavailable, and an expired one is resumed. A second
 * input with different content cannot start while one is unresolved, and no
 * action starts while another kind is running.
 */
export async function claimLifecycleAction(
  task: StandardTaskRow,
  call: LifecycleCall,
): Promise<{ kind: "replay" } | { kind: "claimed"; claim: LifecycleActionClaim }> {
  const action = call.action as LifecycleActionKind;
  const { identity, requestHash } = actionIdentity(call);
  return inTransaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`standard-lifecycle-action:${task.id}`]);
    const rows = (await db.query<ActionRow>(
      `SELECT action,identity_hash,request_hash,state,COALESCE(lease_expires_at > now(),false) AS live
         FROM standard_lifecycle_actions WHERE transaction_id=$1`,
      [task.id],
    )).rows;
    const own = rows.find((row) => row.action === action && row.identity_hash.equals(identity));
    if (own) {
      if (!own.request_hash.equals(requestHash)) throw actionConflict("The action already bound different content");
      if (own.state === "committed") return { kind: "replay" as const };
      if (own.live) throw lifecycleUnavailable("Another attempt of this action is in progress");
      await db.query(
        `UPDATE standard_lifecycle_actions
            SET attempts=attempts+1,lease_expires_at=now() + ($4 * interval '1 second')
          WHERE transaction_id=$1 AND action=$2 AND identity_hash=$3`,
        [task.id, action, identity, LIFECYCLE_ACTION_LEASE_SECONDS],
      );
      return { kind: "claimed" as const, claim: { transactionId: task.id, action, identity, resumed: true } };
    }
    const unresolved = rows.filter((row) => row.state === "claimed");
    if (action === "input" && unresolved.some((row) => row.action === "input")) {
      throw actionConflict("The order's pending input is bound to different content");
    }
    if (unresolved.some((row) => row.live || (action === "input" && row.action === "cancel"))) {
      throw lifecycleUnavailable("Another action on this order is unresolved");
    }
    await db.query(
      `INSERT INTO standard_lifecycle_actions (transaction_id,action,identity_hash,request_hash,state,lease_expires_at)
       VALUES ($1,$2,$3,$4,'claimed',now() + ($5 * interval '1 second'))`,
      [task.id, action, identity, requestHash, LIFECYCLE_ACTION_LEASE_SECONDS],
    );
    return { kind: "claimed" as const, claim: { transactionId: task.id, action, identity, resumed: false } };
  });
}

const CLAIMED = "transaction_id=$1 AND action=$2 AND identity_hash=$3 AND state='claimed'";

/** Commit the action with the task state it produced, inside that transaction. */
export async function commitLifecycleAction(db: Queryable, claim: LifecycleActionClaim, outcomeState: string): Promise<void> {
  const committed = await db.query(
    `UPDATE standard_lifecycle_actions
        SET state='committed',outcome_state=$4,committed_at=now(),lease_expires_at=NULL
      WHERE ${CLAIMED}`,
    [claim.transactionId, claim.action, claim.identity, outcomeState],
  );
  if (committed.rowCount !== 1) throw new Error("Lifecycle action claim was lost before commit");
}

/** The attempt failed before any effect: the identity is free again. */
export async function releaseLifecycleAction(claim: LifecycleActionClaim): Promise<void> {
  await pool.query(`DELETE FROM standard_lifecycle_actions WHERE ${CLAIMED}`,
    [claim.transactionId, claim.action, claim.identity]);
}

/** The outcome is uncertain: keep the identity bound and let the next attempt reconcile it now. */
export async function abandonLifecycleAction(claim: LifecycleActionClaim): Promise<void> {
  await pool.query(`UPDATE standard_lifecycle_actions SET lease_expires_at=now() WHERE ${CLAIMED}`,
    [claim.transactionId, claim.action, claim.identity]);
}
