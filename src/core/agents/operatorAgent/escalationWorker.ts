import { randomUUID } from "node:crypto";
import {
  claimDurableJob,
  completeDurableJob,
  failDurableJob,
  renewDurableJobLease,
} from "../../db/queries/durableJobs.js";
import {
  markEscalationAwaitingHuman,
  OPERATOR_ESCALATION_QUEUE,
} from "../../db/queries/escalations.js";
import { failWorker, heartbeatWorker, setWorkerStatus } from "../../health.js";
import { logError, logInfo } from "../../logger.js";
import { workerCycleFailed, workerCycleSucceeded } from "../../observability/workerConditions.js";
import { redactSensitiveText } from "../../security/redaction.js";
import { processEscalation } from "./escalationRunner.js";
import { reconcileStalledAutomationReviews } from "../../operations/stalledAutomationReviews.js";

const workerId = `operator-escalation:${process.pid}:${randomUUID()}`;
const LEASE_SECONDS = 300;
let timer: NodeJS.Timeout | null = null;
let running: Promise<void> | null = null;
let stopping = false;

export async function runOperatorEscalationOnce(): Promise<boolean> {
  const job = await claimDurableJob({
    queue: OPERATOR_ESCALATION_QUEUE,
    workerId,
    leaseSeconds: LEASE_SECONDS,
  });
  if (!job) return false;
  const escalationId = typeof job.payload.escalationId === "string"
    ? job.payload.escalationId
    : "";
  let leaseLost = false;
  const heartbeat = setInterval(() => {
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
      });
  }, 60_000);
  heartbeat.unref();
  try {
    if (!escalationId) throw new Error("operator escalation job has no escalationId");
    await processEscalation(escalationId);
    if (leaseLost || !await completeDurableJob({
      id: job.id,
      workerId,
      leaseToken: job.lease_token,
    })) {
      throw new Error("operator escalation job lease was lost");
    }
  } catch (error) {
    const safeError = redactSensitiveText((error as Error).message).slice(0, 1_000);
    const status = await failDurableJob({
      id: job.id,
      workerId,
      leaseToken: job.lease_token,
      error: safeError,
      retryAt: new Date(Date.now() + Math.min(15 * 60_000, 5_000 * 2 ** job.attempts)),
    });
    if (status === "dead_letter" && escalationId) {
      await markEscalationAwaitingHuman({
        id: escalationId,
        agent_recommendation: "Automated triage exhausted its retry budget. Human review is required.",
      });
    }
    logError("operator escalation attempt failed", {
      jobId: job.id,
      escalationId,
      error: safeError,
    });
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}

async function tick(): Promise<void> {
  try {
    while (!stopping && await runOperatorEscalationOnce()) {
      // Drain available work serially to bound LLM and tool concurrency.
    }
    await reconcileStalledAutomationReviews();
    heartbeatWorker("operator-escalation");
    if (workerCycleSucceeded("operator-escalation")) logInfo("operator escalation worker recovered", {});
  } catch (error) {
    failWorker("operator-escalation");
    if (workerCycleFailed("operator-escalation", error)) {
      logError("operator escalation worker failed", {
        error: redactSensitiveText((error as Error).message).slice(0, 1_000),
      });
    }
  } finally {
    running = null;
    if (!stopping) {
      timer = setTimeout(() => startTick(), 1_000);
      timer.unref();
    }
  }
}

function startTick(): void {
  if (!running && !stopping) running = tick();
}

export function startOperatorEscalationWorker(): void {
  stopping = false;
  setWorkerStatus("operator-escalation", false);
  startTick();
}

export async function stopOperatorEscalationWorker(): Promise<void> {
  stopping = true;
  if (timer) clearTimeout(timer);
  timer = null;
  if (running) await running;
}
