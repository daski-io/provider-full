import { emitEvent } from "../events/emitter.js";
import { logInfo, logWarn } from "../logger.js";

/*
 * Operational observations of ServiceRegistry reconciliation: the latest
 * verdict per service and per cycle, for the operations summary, and one
 * log line and platform-log event when a verdict changes, never one per
 * unchanged cycle. Best effort: they never gate chain authorization, which
 * serviceRegistrar.ts keeps in its own verified state.
 */

interface Observation {
  scope: "service" | "cycle";
  serviceId?: string;
  slug?: string;
  version?: string;
  checkedAt: string;
  lastSuccessAt: string | null;
  error: string | null;
}

const MAX_OBSERVATIONS = 1_000;
const observations = new Map<string, Observation>();

/** Record one verdict; `error` null is a verified service or a clean cycle. */
export function observeRegistration(
  key: string,
  error: string | null,
  service?: { id: string; slug: string; version: string },
): void {
  const previous = observations.get(key);
  const now = new Date().toISOString();
  if (!previous && observations.size >= MAX_OBSERVATIONS) observations.delete(observations.keys().next().value!);
  observations.set(key, {
    scope: service ? "service" : "cycle",
    serviceId: service?.id, slug: service?.slug, version: service?.version,
    checkedAt: now,
    lastSuccessAt: error === null ? now : previous?.lastSuccessAt ?? null,
    error,
  });
  if (previous ? error === previous.error : error === null) return;
  if (error !== null) logWarn("Service registration reconcile failed", { error, scope: service ? "service" : "cycle" });
  else logInfo("Service registration reconcile recovered", { scope: service ? "service" : "cycle" });
  // source=system keeps these telemetry rows apart from mandatory chain
  // audit, and the write is not awaited: a hung insert never holds a cycle.
  void Promise.resolve().then(() => emitEvent({
    source: "system", severity: error === null ? "info" : "warn",
    serviceId: service?.id,
    type: error === null ? "system.service_registration_recovered" : "system.service_registration_failed",
    message: error === null ? "Service registration verification recovered." : "Service registration verification failed.",
    payload: { scope: service ? "service" : "cycle", slug: service?.slug, version: service?.version, reason: error },
  })).catch(() => logWarn("Service registration observation could not be recorded"));
}

/** The latest verdicts, with the age of each one's last success. */
export function getRegistrationObservations(now = Date.now()) {
  return [...observations.values()].map((row) => ({
    ...row,
    lastSuccessAgeSeconds: row.lastSuccessAt === null
      ? null : Math.max(0, Math.floor((now - Date.parse(row.lastSuccessAt)) / 1_000)),
  }));
}

/** Tests: forget every observation. */
export function resetRegistrationObservations(): void {
  observations.clear();
}
