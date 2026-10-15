import { purgeExpiredAuthState } from "../db/queries/authSecurity.js";
import { purgeExpiredSessions } from "../db/queries/sessions.js";
import { logError, logInfo } from "../logger.js";
import { workerCycleFailed, workerCycleSucceeded } from "../observability/workerConditions.js";
import { failWorker, heartbeatWorker, setWorkerStatus } from "../health.js";
import { classifyStaleConfirmationExecutions } from "../db/queries/confirmationIntents.js";
import { expireDestructiveAssetActions } from "../standardRail/actionCompletion.js";

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<Record<string, number>> | null = null;

export async function runAuthSecurityCleanup(): Promise<Record<string, number>> {
  const staleConfirmationExecutions = await classifyStaleConfirmationExecutions();
  const [sessions, auth, destructive] = await Promise.all([
    purgeExpiredSessions(),
    purgeExpiredAuthState(),
    expireDestructiveAssetActions(),
  ]);
  return {
    sessions,
    siweNonces: auth.siweNonces,
    rateBuckets: auth.rateBuckets,
    confirmationIntents: auth.confirmationIntents,
    staleConfirmationExecutions,
    destructiveActionsExpired: destructive.expired,
    destructiveActionsAttention: destructive.attention,
  };
}

export function startAuthSecurityCleanup(): void {
  if (timer) return;
  setWorkerStatus("auth-cleanup", false);
  const run = () => {
    if (inFlight) return;
    inFlight = runAuthSecurityCleanup();
    void inFlight
      .then(() => {
        heartbeatWorker("auth-cleanup");
        if (workerCycleSucceeded("auth-cleanup")) logInfo("authentication security cleanup recovered", {});
      })
      .catch((error) => {
        failWorker("auth-cleanup");
        if (workerCycleFailed("auth-cleanup", error)) {
          logError("authentication security cleanup failed", {
            error: (error as Error).message,
          });
        }
      })
      .finally(() => {
        inFlight = null;
      });
  };
  run();
  timer = setInterval(run, CLEANUP_INTERVAL_MS);
  timer.unref();
}

export async function stopAuthSecurityCleanup(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  if (inFlight) await inFlight.catch(() => undefined);
}
