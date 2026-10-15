import { getAddress, type Hex } from "viem";
import { decryptString } from "../chain/encryption.js";
import { pool } from "../db/pool.js";
import {
  claimDurableJob,
  completeDurableJob,
  deferDurableJob,
  enqueueDurableJob,
  failDurableJob,
  withDurableJobLease,
} from "../db/queries/durableJobs.js";
import { getServiceById } from "../db/queries/services.js";
import { getSkillByServiceAndSkillId } from "../db/queries/skills.js";
import { failWorker, heartbeatWorker, setWorkerStatus } from "../health.js";
import { errorExtra, logError, logInfo } from "../logger.js";
import { executableDefinitionHash } from "../serviceRegistry/executableContracts.js";
import { serviceInvariantFailures } from "../serviceRegistry/readiness.js";
import { getAdapter, getService } from "../serviceRegistry/registry.js";
import { contractHandler, registeredExecutableHashes } from "../serviceRegistry/retainedHandlers.js";
import { admittedSupplierCostCeiling } from "../serviceRegistry/supplierCostCeiling.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { fulfillAdmittedDispatch } from "./dispatchExecution.js";
import {
  FULFILLMENT_LEASE_SECONDS,
  PAID_FULFILLMENT_QUEUE,
  fulfillmentWorkerId,
  type FulfillmentJobLease,
} from "./fulfillmentJobs.js";
import { admittedOwnership, listingVersion } from "./listingVersions.js";
import { completeRefusedStart, parkForReconciliation, refuseStart, startRefusal } from "./orderStart.js";

/*
 * Resume admitted paid orders whose admitting request ended before the
 * order started. Each decision is taken from the order's durable state:
 * a never-started order runs now under its admitted version's handler (or
 * fails as never started once its admitted fulfillment deadline passed);
 * a started call whose answer was never persisted is ambiguous and is
 * parked for reconciliation, never repeated; anything else already has an
 * owner. A worker only claims jobs whose contract its build can run, and
 * waits while the service declares an outage or a buyer's lifecycle action
 * holds the order.
 */

export const PAID_FULFILLMENT_WORKER = "standard-paid-fulfillment";
const POLL_MS = 5_000;
const SWEEP_EVERY_POLLS = 12;
const DEFER_MS = 60_000;

interface ResumableRow {
  status: string;
  metadata: Record<string, unknown>;
  service_id: string;
  skill_id: string;
  standard_payer: string;
  standard_listing_manifest_hash: Buffer | null;
  gateway_audience: string;
  order_id: string;
  claim_state: string;
  answered: boolean;
  fulfillment_expired: boolean;
}

const hex = (value: Buffer): Hex => `0x${value.toString("hex")}`;

/** Take the next step for one admitted order under the job lease held; "defer" when it cannot run now. */
export async function resumeAdmittedOrder(
  config: ProviderStandardRailConfig,
  taskId: string,
  lease: FulfillmentJobLease,
): Promise<"done" | "defer"> {
  const row = (await pool.query<ResumableRow>(
    `SELECT t.status,t.metadata,t.service_id,t.skill_id,t.standard_payer,t.standard_listing_manifest_hash,
            c.gateway_audience,c.order_id,c.state AS claim_state,c.response_hash IS NOT NULL AS answered,
            COALESCE(c.claimed_at + c.admitted_fulfillment_seconds * interval '1 second' <= now(), false)
              AS fulfillment_expired
       FROM transactions t
       JOIN standard_dispatch_claims c ON c.transaction_id=t.id AND c.order_id=t.standard_order_id
      WHERE t.id=$1`,
    [taskId],
  )).rows[0];
  if (!row) return "done";
  const order = { gatewayAudience: row.gateway_audience, orderId: row.order_id, payer: getAddress(row.standard_payer) };
  if (row.status === "working") {
    const refusal = startRefusal(row.metadata.standard_start_refused);
    if (refusal) await completeRefusedStart(taskId, row.service_id, order, refusal);
    // Started, and the service's answer was never persisted: it may have acted.
    else if (row.metadata.supplier_mutation_started === true && !row.answered && row.claim_state === "dispatching") {
      await parkForReconciliation(taskId, order);
    }
    return "done";
  }
  if (row.status !== "submitted") return "done";
  if (row.fulfillment_expired) {
    const fence = await refuseStart({
      taskId, serviceId: row.service_id, order, lease, refusal: "fulfillment_deadline",
    });
    return fence === "busy" ? "defer" : "done";
  }
  const version = row.standard_listing_manifest_hash
    ? await listingVersion(config, hex(row.standard_listing_manifest_hash))
    : null;
  const choice = version ? contractHandler(version.serviceSlug, version.skillId, version.contract) : null;
  if (!version || !choice) return "defer";
  // During a declared outage running now would sign a terminal failure the
  // order need not take, so it waits, as admission refuses meanwhile.
  const module = getService(version.serviceSlug);
  if (module && (await serviceInvariantFailures(module)).length > 0) return "defer";
  const [service, skill] = await Promise.all([
    getServiceById(row.service_id), getSkillByServiceAndSkillId(row.service_id, row.skill_id),
  ]);
  const encrypted = row.metadata.standard_request_encrypted;
  if (!service || !skill || typeof encrypted !== "string") return "defer";
  const request = JSON.parse(decryptString(encrypted, {
    purpose: "standard-order-request", table: "transactions", recordId: taskId,
    field: "metadata.standard_request_encrypted", recordVersion: 1,
  })) as Record<string, unknown>;
  const step = await fulfillAdmittedDispatch({
    taskId, order, request, skillId: row.skill_id, service, skill, lease,
    handler: choice.kind === "retained" ? choice.adapter : getAdapter(service.adapter_name),
    requiresOwnership: admittedOwnership(version, skill),
    supplierCostCeiling: admittedSupplierCostCeiling(row.metadata) ?? null,
  });
  return step === "busy" ? "defer" : "done";
}

/**
 * Admitted orders that never started and have no fulfillment job, such as
 * those admitted by an earlier release, get one. Admission creates its job
 * in the same transaction, so this never races a live admission.
 */
export async function enqueueUnqueuedAdmissions(config: ProviderStandardRailConfig, limit = 100): Promise<number> {
  const rows = (await pool.query<{ id: string; order_id: string; gateway_audience: string; listing: Buffer | null }>(
    `SELECT t.id,c.order_id,c.gateway_audience,t.standard_listing_manifest_hash AS listing
       FROM transactions t
       JOIN standard_dispatch_claims c ON c.transaction_id=t.id AND c.order_id=t.standard_order_id
      WHERE t.status='submitted' AND NOT (t.metadata ? 'supplier_mutation_started')
        AND NOT EXISTS (SELECT 1 FROM durable_jobs j WHERE j.queue=$1 AND j.idempotency_key=t.id)
      ORDER BY t.created_at LIMIT $2`,
    [PAID_FULFILLMENT_QUEUE, limit],
  )).rows;
  for (const row of rows) {
    const version = row.listing ? await listingVersion(config, hex(row.listing)).catch(() => null) : null;
    let capability: Hex | null = null;
    try {
      capability = version?.contract
        ? executableDefinitionHash(version.serviceSlug, version.skillId, version.contract)
        : null;
    } catch {
      capability = null;
    }
    await enqueueDurableJob({
      queue: PAID_FULFILLMENT_QUEUE, idempotencyKey: row.id, requiredCapability: capability,
      payload: { taskId: row.id, orderId: row.order_id, gatewayAudience: row.gateway_audience },
    });
  }
  if (rows.length > 0) logInfo("Queued fulfillment for admitted orders without a job", { count: rows.length });
  return rows.length;
}

/** One worker cycle: optionally queue unqueued admissions, then resume every due job this build can run. */
export async function runPaidFulfillmentCycle(config: ProviderStandardRailConfig, sweep: boolean): Promise<void> {
  if (sweep) await enqueueUnqueuedAdmissions(config);
  const capabilities = [...registeredExecutableHashes()];
  for (;;) {
    const job = await claimDurableJob({
      queue: PAID_FULFILLMENT_QUEUE, workerId: fulfillmentWorkerId,
      leaseSeconds: FULFILLMENT_LEASE_SECONDS, capabilities,
    });
    if (!job) return;
    const claim = { id: job.id, workerId: fulfillmentWorkerId, leaseToken: job.lease_token };
    try {
      const outcome = await withDurableJobLease({
        ...claim, leaseSeconds: FULFILLMENT_LEASE_SECONDS,
        work: () => resumeAdmittedOrder(config, String(job.payload.taskId ?? ""), {
          id: job.id, leaseToken: job.lease_token,
        }),
      });
      if (outcome === "defer") await deferDurableJob({ ...claim, retryAt: new Date(Date.now() + DEFER_MS) });
      else await completeDurableJob(claim);
    } catch (error) {
      await failDurableJob({
        ...claim, error: error instanceof Error ? error.name : "UnknownError",
        retryAt: new Date(Date.now() + Math.min(3_600, 15 * 2 ** Math.min(job.attempts, 8)) * 1_000),
      }).catch(() => undefined);
      logError("Paid fulfillment resume failed", errorExtra(error, { jobId: job.id }));
    }
    // A loop that keeps finishing jobs is healthy, however long one took.
    heartbeatWorker(PAID_FULFILLMENT_WORKER);
  }
}

export function startPaidFulfillmentWorker(config: ProviderStandardRailConfig): () => Promise<void> {
  let stopping = false;
  let polls = 0;
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  setWorkerStatus(PAID_FULFILLMENT_WORKER, false);
  const tick = async () => {
    try {
      await runPaidFulfillmentCycle(config, polls % SWEEP_EVERY_POLLS === 0);
      heartbeatWorker(PAID_FULFILLMENT_WORKER);
    } catch (error) {
      failWorker(PAID_FULFILLMENT_WORKER);
      logError("Paid fulfillment worker failed", errorExtra(error));
    } finally {
      polls += 1;
      running = null;
      if (!stopping) {
        timer = setTimeout(start, POLL_MS);
        timer.unref();
      }
    }
  };
  const start = () => { if (!running && !stopping) running = tick(); };
  start();
  return async () => {
    stopping = true;
    if (timer) clearTimeout(timer);
    if (running) await running;
  };
}
