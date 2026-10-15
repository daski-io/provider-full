import type { Hex } from "viem";
import type { Queryable } from "../db/queryable.js";

/*
 * What each promoted paid listing version still owes, derived only from
 * durable local state. Execution obligations (pending orders, unfinished
 * jobs, unresolved supplier operations, reviews, reputation writes and
 * lifecycle actions) need the version's handler; terminal orders need only
 * its signing key and frozen results, forever. Any provider quote of the
 * version may still be paid and dispatched, even after an order was
 * admitted with it (an identical request quoted in the same second shares a
 * quote): only the gateway can prove no more dispatches will come, so
 * quotes keep the version's dispatch support until it is retired.
 */

export interface VersionObligations {
  versionId: string;
  serviceId: Hex;
  skillId: string;
  listingManifestHash: Hex;
  head: boolean;
  retired: boolean;
  pendingTasks: number;
  terminalTasks: number;
  durableJobs: number;
  supplierOperations: number;
  openReviews: number;
  pendingReputation: number;
  unresolvedLifecycleActions: number;
  unexpiredQuotes: number;
  quotes: number;
}

/** Counts that block ending a version's dispatch and execution support. */
export const EXECUTION_OBLIGATIONS = [
  "pendingTasks", "durableJobs", "supplierOperations", "openReviews",
  "pendingReputation", "unresolvedLifecycleActions", "unexpiredQuotes",
] as const satisfies ReadonlyArray<keyof VersionObligations>;

interface ObligationRow {
  id: string;
  service_id: Buffer;
  skill_id: string;
  runtime_commitment_hash: Buffer;
  head: boolean;
  retired: boolean;
  pending_tasks: number;
  terminal_tasks: number;
  durable_jobs: number;
  supplier_operations: number;
  open_reviews: number;
  pending_reputation: number;
  unresolved_lifecycle_actions: number;
  unexpired_quotes: number;
  quotes: number;
}

const hex = (value: Buffer): Hex => `0x${value.toString("hex")}`;

const OBLIGATIONS_SQL = `
  SELECT v.id,v.service_id,v.skill_id,v.runtime_commitment_hash,
         v.superseded_at IS NULL AS head,v.retired_at IS NOT NULL AS retired,
         tasks.pending_tasks,tasks.terminal_tasks,
         (SELECT count(*)::int FROM durable_jobs j
           WHERE j.status<>'completed' AND EXISTS (
             SELECT 1 FROM transactions t
              WHERE t.id=COALESCE(j.payload->>'taskId',j.payload->>'transactionId',j.payload->>'transaction_id')
                AND t.standard_listing_manifest_hash=v.runtime_commitment_hash)) AS durable_jobs,
         (SELECT count(*)::int FROM supplier_operations o JOIN transactions t ON t.id=o.transaction_id
           WHERE t.standard_listing_manifest_hash=v.runtime_commitment_hash
             AND o.state IN ('intent','ambiguous')) AS supplier_operations,
         (SELECT count(*)::int FROM escalations e JOIN transactions t ON t.id=e.transaction_id
           WHERE t.standard_listing_manifest_hash=v.runtime_commitment_hash
             AND e.status NOT IN ('resolved','rejected','approved','edited')) AS open_reviews,
         (SELECT count(*)::int FROM standard_reputation_outcomes r JOIN transactions t ON t.id=r.transaction_id
           WHERE t.standard_listing_manifest_hash=v.runtime_commitment_hash
             AND r.state IN ('pending','broadcast','operator_attention')) AS pending_reputation,
         (SELECT count(*)::int FROM standard_lifecycle_actions a JOIN transactions t ON t.id=a.transaction_id
           WHERE t.standard_listing_manifest_hash=v.runtime_commitment_hash
             AND a.state='claimed') AS unresolved_lifecycle_actions,
         (SELECT count(*)::int FROM standard_provider_quotes q
           WHERE q.listing_manifest_hash=v.runtime_commitment_hash AND q.valid_before>now()) AS unexpired_quotes,
         (SELECT count(*)::int FROM standard_provider_quotes q
           WHERE q.listing_manifest_hash=v.runtime_commitment_hash) AS quotes
    FROM provider_runtime_listing_versions v
   CROSS JOIN LATERAL (
     SELECT count(*) FILTER (WHERE t.status IN ('submitted','working','input-required'))::int AS pending_tasks,
            count(*) FILTER (WHERE t.status IN ('completed','failed','canceled'))::int AS terminal_tasks
       FROM transactions t WHERE t.standard_listing_manifest_hash=v.runtime_commitment_hash
   ) tasks
   WHERE v.gateway_origin=$1 AND v.payment_required
     AND ($2::bytea[] IS NULL OR v.runtime_commitment_hash=ANY($2::bytea[]))
     AND ($3::bytea IS NULL OR v.service_id=$3)
   ORDER BY v.service_id,v.skill_id,v.promoted_at,v.id`;

/**
 * The obligations of this gateway's paid versions, optionally narrowed to
 * some commitment hashes or one service. Run inside the caller's
 * transaction after it locked the versions it decides on.
 */
export async function loadVersionObligations(db: Queryable, args: {
  gatewayOrigin: string;
  listingManifestHashes?: readonly Hex[];
  serviceId?: Hex;
}): Promise<VersionObligations[]> {
  const rows = (await db.query<ObligationRow>(OBLIGATIONS_SQL, [
    args.gatewayOrigin,
    args.listingManifestHashes?.map((hash) => Buffer.from(hash.slice(2), "hex")) ?? null,
    args.serviceId ? Buffer.from(args.serviceId.slice(2), "hex") : null,
  ])).rows;
  return rows.map((row) => ({
    versionId: row.id,
    serviceId: hex(row.service_id),
    skillId: row.skill_id,
    listingManifestHash: hex(row.runtime_commitment_hash),
    head: row.head,
    retired: row.retired,
    pendingTasks: row.pending_tasks,
    terminalTasks: row.terminal_tasks,
    durableJobs: row.durable_jobs,
    supplierOperations: row.supplier_operations,
    openReviews: row.open_reviews,
    pendingReputation: row.pending_reputation,
    unresolvedLifecycleActions: row.unresolved_lifecycle_actions,
    unexpiredQuotes: row.unexpired_quotes,
    quotes: row.quotes,
  }));
}

/** The execution obligations of one version that are still open. */
export function openExecutionObligations(obligations: VersionObligations): Record<string, number> {
  return Object.fromEntries(EXECUTION_OBLIGATIONS
    .filter((name) => obligations[name] !== 0)
    .map((name) => [name, obligations[name]]));
}
