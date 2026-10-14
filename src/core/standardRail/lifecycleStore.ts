import { getAddress, type Hex } from "viem";
import { pool } from "../db/pool.js";
import type { TransactionStatus } from "../db/queries/transactions.js";
import type { LifecycleCall } from "./lifecycleAuthorization.js";
import { lifecycleRejected } from "./lifecycleErrors.js";

export interface StandardTaskRow {
  id: string;
  service_id: string;
  skill_id: string;
  status: TransactionStatus;
  standard_order_id: string;
  standard_payer: Hex;
  metadata: Record<string, unknown>;
  completed_at: Date | null;
  version: string;
}

export const STANDARD_TASK_COLUMNS =
  "id,service_id,skill_id,status,standard_order_id,standard_payer,metadata,completed_at,version";

/**
 * The standard task an authenticated call names. A task this provider does
 * not hold for that order, or one bound to another payer, is refused like
 * any other binding failure: an order id is never a credential.
 */
export async function loadLifecycleTask(call: LifecycleCall): Promise<StandardTaskRow> {
  const task = (await pool.query<StandardTaskRow>(
    `SELECT ${STANDARD_TASK_COLUMNS}
       FROM transactions WHERE id=$1 AND standard_order_id=$2 AND standard_payer IS NOT NULL`,
    [call.providerTaskId, call.orderId],
  )).rows[0];
  if (!task || getAddress(task.standard_payer) !== call.payer) {
    throw lifecycleRejected("Lifecycle call does not name this payer's standard task");
  }
  return task;
}

/**
 * Consume a payer-signed authorization's nonce, only after it verified. The
 * gateway consumed it too; a replay of the same authorization is refused,
 * while a fresh authorization for the same business action is deduplicated
 * by the action's own durable identity.
 */
export async function consumeLifecycleNonce(task: StandardTaskRow, call: LifecycleCall): Promise<void> {
  if (call.authorization.form !== "payer-signed") return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM standard_action_nonces WHERE consumed_at < now() - interval '10 minutes'");
    const inserted = await client.query(
      `INSERT INTO standard_action_nonces (payer,nonce,order_id,action)
       VALUES ($1,$2,$3,$4) ON CONFLICT (payer,nonce) DO NOTHING`,
      [task.standard_payer, Buffer.from(call.authorization.nonce.slice(2), "hex"), task.standard_order_id, call.action],
    );
    if (inserted.rowCount !== 1) throw lifecycleRejected("Lifecycle authorization replayed");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
