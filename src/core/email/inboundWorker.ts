import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import {
  claimDurableJob,
  completeDurableJob,
  failDurableJob,
  renewDurableJobLease,
  type DurableJobClaim,
} from "../db/queries/durableJobs.js";
import {
  getInboundEmailById,
  updateInboundEmailClassification,
  updateInboundProcessing,
} from "../db/queries/emails.js";
import { emitEvent } from "../events/emitter.js";
import { getService } from "../serviceRegistry/registry.js";
import { redactSensitiveText } from "../security/redaction.js";
import { pool } from "../db/pool.js";
import { failWorker, heartbeatWorker, setWorkerStatus } from "../health.js";
import { logError, logInfo } from "../logger.js";
import { workerCycleFailed, workerCycleSucceeded } from "../observability/workerConditions.js";

export const EMAIL_INGRESS_QUEUE = "email-ingress";
const LEASE_SECONDS = 300;
const POLL_MS = 500;

let timer: NodeJS.Timeout | null = null;
let ticking = false;
let tickInFlight: Promise<void> | null = null;
let lastReconciledAt = 0;
const active = new Set<Promise<void>>();
const workerId = `email-${process.pid}-${randomUUID()}`;

export function startEmailIngressWorker(): void {
  if (timer) return;
  setWorkerStatus("email-ingress", false);
  const startTick = () => {
    if (tickInFlight) return;
    tickInFlight = tick()
      .then(() => {
        if (workerCycleSucceeded("email-ingress")) logInfo("email ingress worker recovered", {});
      })
      .catch((error) => {
        failWorker("email-ingress");
        if (workerCycleFailed("email-ingress", error)) {
          logError("email ingress worker failed", {
            error: (error as Error).message,
          });
        }
      })
      .finally(() => {
        tickInFlight = null;
      });
  };
  timer = setInterval(startTick, POLL_MS);
  timer.unref();
  startTick();
}

export async function stopEmailIngressWorker(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  if (tickInFlight) await tickInFlight;
  await Promise.allSettled([...active]);
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    if (Date.now() - lastReconciledAt >= 30_000) {
      await reconcileEmailIngressJobs();
      lastReconciledAt = Date.now();
    }
    while (active.size < config.EMAIL_AGENT_MAX_CONCURRENCY) {
      const job = await claimDurableJob({
        queue: EMAIL_INGRESS_QUEUE,
        workerId,
        leaseSeconds: LEASE_SECONDS,
      });
      if (!job) break;
      const work = processJob(job).finally(() => active.delete(work));
      active.add(work);
    }
    heartbeatWorker("email-ingress");
  } finally {
    ticking = false;
  }
}

async function reconcileEmailIngressJobs(): Promise<void> {
  // Close the crash window after job ack but before the email mirror update.
  await pool.query(
    `UPDATE emails_inbound e
        SET processing_status = 'completed', processed_at = COALESCE(processed_at, now()),
            processing_lease_owner = NULL, processing_lease_expires_at = NULL
      FROM durable_jobs j
      WHERE j.queue = $1 AND j.idempotency_key = e.id::text
        AND j.status = 'completed' AND e.processing_status <> 'completed'`,
    [EMAIL_INGRESS_QUEUE],
  );
  // Repair insert→enqueue crashes. Queue identity is the inbound row UUID,
  // so concurrent replicas race safely on the unique constraint.
  await pool.query(
    `INSERT INTO durable_jobs (queue, idempotency_key, payload, max_attempts)
     SELECT $1, e.id::text,
            jsonb_build_object(
              'inboundId', e.id::text,
              'mode', e.processing_mode,
              'serviceSlug', e.processing_service_slug
            ),
            8
       FROM emails_inbound e
      WHERE e.processing_mode IS NOT NULL
        AND e.processing_status IN ('queued','retry','running')
        AND NOT EXISTS (
          SELECT 1 FROM durable_jobs j
           WHERE j.queue = $1 AND j.idempotency_key = e.id::text
        )
     ON CONFLICT (queue, idempotency_key) DO NOTHING`,
    [EMAIL_INGRESS_QUEUE],
  );
}

async function processJob(job: DurableJobClaim): Promise<void> {
  const inboundId = typeof job.payload.inboundId === "string"
    ? job.payload.inboundId
    : "";
  if (!inboundId) {
    await failJob(job, "email job has no inboundId");
    return;
  }
  await updateInboundProcessing({
    id: inboundId,
    status: "running",
    workerId,
    leaseExpiresAt: new Date(Date.now() + LEASE_SECONDS * 1_000),
  });
  let leaseLost = false;
  let renewalRunning = false;
  const heartbeat = setInterval(() => {
    if (renewalRunning) return;
    renewalRunning = true;
    void renewDurableJobLease({
      id: job.id,
      workerId,
      leaseToken: job.lease_token,
      leaseSeconds: LEASE_SECONDS,
    })
      .then((renewed) => {
        if (!renewed) leaseLost = true;
      })
      .catch(() => {
        leaseLost = true;
      })
      .finally(() => {
        renewalRunning = false;
      });
  }, 60_000);
  heartbeat.unref();
  try {
    const row = await getInboundEmailById(inboundId);
    if (!row) throw new Error("inbound email no longer exists");
    const mode = job.payload.mode;
    if (mode === "interceptor") {
      const serviceSlug = typeof job.payload.serviceSlug === "string"
        ? job.payload.serviceSlug
        : "";
      const module = getService(serviceSlug);
      if (!module?.protocol.inboundEmail) {
        throw new Error("email interceptor is unavailable");
      }
      await module.protocol.inboundEmail.handle(row);
    } else if (mode === "email-agent") {
      const { processInboundEmail } = await import("../agents/emailAgent/index.js");
      await processInboundEmail(row.id);
    } else {
      throw new Error("email job mode is invalid");
    }
    if (leaseLost) throw new Error("email job lease was lost during processing");
    const completed = await completeDurableJob({
      id: job.id,
      workerId,
      leaseToken: job.lease_token,
    });
    if (!completed) throw new Error("email job lease was lost before completion");
    await updateInboundProcessing({ id: inboundId, status: "completed" });
  } catch (error) {
    await failJob(job, (error as Error).message, inboundId);
  } finally {
    clearInterval(heartbeat);
  }
}

async function failJob(
  job: DurableJobClaim,
  rawError: string,
  inboundId?: string,
): Promise<void> {
  const error = redactSensitiveText(rawError).slice(0, 1_000);
  const delayMs = Math.min(15 * 60_000, 5_000 * (2 ** Math.min(job.attempts, 8)));
  const status = await failDurableJob({
    id: job.id,
    workerId,
    leaseToken: job.lease_token,
    error,
    retryAt: new Date(Date.now() + delayMs),
  });
  if (!status || !inboundId) return;
  const processingStatus = status === "dead_letter" ? "dead_letter" : "retry";
  await updateInboundProcessing({ id: inboundId, status: processingStatus, error });
  if (status === "dead_letter") {
    await updateInboundEmailClassification({
      id: inboundId,
      classification: "unknown",
      reason: "processing failed after the retry budget",
    });
    await emitEvent({
      source: "email",
      severity: "error",
      type: "email.dead_letter",
      message: "Inbound email exhausted its processing retry budget.",
      payload: { inboundId, attempts: job.attempts },
    });
  }
}
