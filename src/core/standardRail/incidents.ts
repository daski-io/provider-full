import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { canonicalHash } from "./canonical.js";
import type { Hex } from "viem";

const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");

/**
 * Record one incident, deduplicated by kind and identity. With `reopen`, a
 * resolved incident of the same identity opens again instead of staying
 * closed: a condition that cleared and then returned is a new occurrence.
 */
export async function recordStandardSecurityIncident(args: {
  kind: string;
  gatewayAudience?: string;
  orderId?: string;
  identity: Record<string, unknown>;
  details?: Record<string, unknown>;
  reopen?: boolean;
}): Promise<void> {
  await pool.query(
    `INSERT INTO standard_security_incidents(
       incident_id,incident_kind,gateway_audience,order_id,fingerprint,details
     ) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (incident_kind,fingerprint) ${args.reopen
    ? "DO UPDATE SET resolved_at=NULL,detected_at=now(),details=EXCLUDED.details WHERE standard_security_incidents.resolved_at IS NOT NULL"
    : "DO NOTHING"}`,
    [randomUUID(), args.kind, args.gatewayAudience ?? null, args.orderId ?? null,
      bytes(canonicalHash(args.identity)), args.details ?? {}],
  );
}

/**
 * Resolve the open incidents of `kind` for the given tasks, and for every
 * task of that kind that has since become terminal. Returns the task ids
 * whose incident this resolved.
 */
export async function resolveTaskIncidents(kind: string, taskIds: readonly string[]): Promise<string[]> {
  const resolved = await pool.query<{ task_id: string }>(
    `UPDATE standard_security_incidents i SET resolved_at=now()
      WHERE i.incident_kind=$1 AND i.resolved_at IS NULL
        AND (i.details->>'taskId'=ANY($2::text[])
          OR EXISTS (SELECT 1 FROM transactions t
                      WHERE t.id=i.details->>'taskId' AND t.standard_order_id=i.order_id
                        AND t.status IN ('completed','failed','canceled')))
      RETURNING i.details->>'taskId' AS task_id`,
    [kind, [...taskIds]],
  );
  return resolved.rows.map((row) => row.task_id);
}
