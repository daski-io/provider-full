import { randomUUID } from "node:crypto";
import type { Hex } from "viem";
import type { Queryable } from "../db/queryable.js";
import {
  completeDurableJob,
  failDurableJob,
  insertLeasedDurableJob,
  renewDurableJobLease,
} from "../db/queries/durableJobs.js";
import { logWarn } from "../logger.js";

/*
 * Every admitted paid order owns one durable fulfillment job, created in the
 * admission transaction and leased to the request that admitted it, which
 * fulfils the order inline. If that request dies before the order started,
 * the lease expires and a paid-fulfillment worker resumes the order; a
 * worker never repeats a started call (paidFulfillmentWorker.ts).
 */

export const PAID_FULFILLMENT_QUEUE = "standard-paid-fulfillment";
export const FULFILLMENT_LEASE_SECONDS = 300;
/** After an inline attempt failed, the worker retries this soon instead of after the lease. */
const FAILED_ATTEMPT_RETRY_MS = 30_000;
export const fulfillmentWorkerId = `standard-fulfillment:${process.pid}:${randomUUID()}`;

export interface FulfillmentJobLease {
  id: string;
  leaseToken: string;
}

/** Inside the admission transaction: the order's job, leased to this request. */
export async function insertAdmittedFulfillmentJob(db: Queryable, args: {
  taskId: string;
  orderId: string;
  gatewayAudience: string;
  /** The executable definition hash a resuming worker must be able to run. */
  capability: Hex | null;
}): Promise<FulfillmentJobLease> {
  const job = await insertLeasedDurableJob(db, {
    queue: PAID_FULFILLMENT_QUEUE,
    idempotencyKey: args.taskId,
    payload: { taskId: args.taskId, orderId: args.orderId, gatewayAudience: args.gatewayAudience },
    workerId: fulfillmentWorkerId,
    leaseSeconds: FULFILLMENT_LEASE_SECONDS,
    requiredCapability: args.capability,
  });
  if (!job) throw new Error("The admitted order already has a fulfillment job");
  return job;
}

/**
 * Fulfil inline while renewing the job's lease, then complete the job. A
 * failed attempt hands the job back for a prompt resume; a lost lease or
 * completion is only logged, since the resuming worker finds the order's
 * real state and acts on that.
 */
export async function underFulfillmentLease<T>(lease: FulfillmentJobLease, work: () => Promise<T>): Promise<T> {
  const claim = { id: lease.id, workerId: fulfillmentWorkerId, leaseToken: lease.leaseToken };
  const renewal = setInterval(() => {
    void renewDurableJobLease({ ...claim, leaseSeconds: FULFILLMENT_LEASE_SECONDS }).catch(() => undefined);
  }, Math.floor(FULFILLMENT_LEASE_SECONDS * 1_000 / 3));
  renewal.unref();
  let result: T;
  try {
    result = await work();
  } catch (error) {
    clearInterval(renewal);
    await failDurableJob({
      ...claim, error: "inline fulfillment attempt failed", retryAt: new Date(Date.now() + FAILED_ATTEMPT_RETRY_MS),
    }).catch(() => undefined);
    throw error;
  }
  clearInterval(renewal);
  const completed = await completeDurableJob(claim).catch(() => false);
  if (!completed) {
    logWarn("Fulfillment job was not completed by its inline attempt", { jobId: lease.id });
  }
  return result;
}
