import { Router } from "express";
import { buildIdentity, publicRevision } from "./buildIdentity.js";
import { checkDatabase, pool } from "./db/pool.js";
import { CHAIN_MODE_MOCK, publicClient } from "./chain/client.js";
import { config } from "./config.js";
import { getDurableQueueMetrics } from "./db/queries/durableJobs.js";
import { listInactiveServicesOwingWork } from "./db/queries/services.js";
import { runtimeEpochAdmitted } from "./db/runtimeEpoch.js";
import { getAllServices } from "./serviceRegistry/registry.js";
import type { ServiceModule } from "./serviceRegistry/types.js";
import type { ServiceRow } from "./db/queries/services.js";
import { logInfo, logWarn } from "./logger.js";
import {
  getProviderIdentityAuthorization,
  recordProviderIdentityVerification,
} from "./chain/providerIdentity.js";
import { serviceInvariantFailures } from "./serviceRegistry/readiness.js";
import {
  getServiceRegistrationAuthorization,
  getServiceRegistrationHealth,
} from "./chain/serviceRegistrar.js";
import {
  healthReportOf,
  loadServiceCatalog,
  readinessFailureSummary,
  requiredWorkerNames as requiredWorkersOf,
  workersAreReady,
  type HealthReport,
  type ReadinessGateSnapshot,
} from "./healthReport.js";

export {
  loadServiceCatalog,
  readinessFailureSummary,
  workersAreReady,
  type HealthReport,
  type ReadinessGateSnapshot,
} from "./healthReport.js";

export interface ServiceHealthStatus {
  active: boolean;
  tokenId: string;
  registrationVerified: boolean;
  reconciledAt?: string;
  standardRailVerified?: boolean;
  standardRailVerifiedAt?: string;
}

let serviceStatuses: Record<string, ServiceHealthStatus> = {};
const workerStatuses = new Map<string, {
  ready: boolean;
  lastSuccessAt: number;
  maxAgeMs: number;
}>();
const CORE_REQUIRED_WORKERS = [
  "email-ingress",
  "auth-cleanup",
  "retention",
  "standard-rail-evidence",
  "standard-task-watchdog",
  "provider-write-reconciler",
  "standard-reputation-outcome",
  "standard-review-resolution",
  "standard-paid-fulfillment",
  "operator-escalation",
] as const;
/** New sales may follow an admission verdict at most this old; reads never wait on one. */
const ADMISSION_MAX_AGE_MS = 30_000;
/** Whether this build serves every retained obligation; null until first checked. */
let retainedServicing: { ok: boolean; gaps: string[] } | null = null;
let readinessCache: { expiresAt: number; result: ReadinessResult } | null = null;
let readinessInFlight: Promise<ReadinessResult> | null = null;
let lastComputed: { at: number; result: ReadinessResult } | null = null;
let lastReportedState: string | null = null;

/**
 * The workers readiness requires: core's, and those of every service that is
 * active or still owes work while paused or inactive (healthReport.ts).
 */
export function requiredWorkerNames(
  services: ServiceRow[],
  modules: ServiceModule[] = getAllServices(),
  serviceCatalogHealthy = true,
  owing: ReadonlySet<string> | null = new Set(),
): Set<string> {
  return requiredWorkersOf(services, modules, serviceCatalogHealthy, owing, CORE_REQUIRED_WORKERS);
}

export function setServiceStatuses(statuses: Record<string, ServiceHealthStatus>): void {
  serviceStatuses = statuses;
  readinessCache = null;
}

/** Publish the latest retained-servicing compatibility check (compatibility/servicingMonitor.ts). */
export function setRetainedServicing(state: { ok: boolean; gaps: string[] }): void {
  retainedServicing = { ok: state.ok, gaps: [...state.gaps] };
  readinessCache = null;
}

export function setProviderIdentityVerified(
  verified: boolean,
  checkedAt = new Date(),
): void {
  recordProviderIdentityVerification(verified, checkedAt);
  readinessCache = null;
}

export function setWorkerStatus(
  worker: string,
  ready: boolean,
  maxAgeSeconds = config.WORKER_HEARTBEAT_MAX_AGE_SECONDS,
): void {
  workerStatuses.set(worker, {
    ready,
    lastSuccessAt: ready ? Date.now() : 0,
    maxAgeMs: maxAgeSeconds * 1_000,
  });
  readinessCache = null;
}

export function heartbeatWorker(
  worker: string,
  maxAgeSeconds = config.WORKER_HEARTBEAT_MAX_AGE_SECONDS,
): void {
  workerStatuses.set(worker, {
    ready: true,
    lastSuccessAt: Date.now(),
    maxAgeMs: maxAgeSeconds * 1_000,
  });
  readinessCache = null;
}

export function failWorker(worker: string): void {
  const previous = workerStatuses.get(worker);
  workerStatuses.set(worker, {
    ready: false,
    lastSuccessAt: previous?.lastSuccessAt ?? 0,
    maxAgeMs: previous?.maxAgeMs
      ?? config.WORKER_HEARTBEAT_MAX_AGE_SECONDS * 1_000,
  });
  readinessCache = null;
}

export function isWorkerReady(worker: string, now = Date.now()): boolean {
  const status = workerStatuses.get(worker);
  return Boolean(status?.ready && status.lastSuccessAt >= now - status.maxAgeMs);
}

interface ReadinessResult {
  checkedAt: string;
  report: HealthReport;
  database: boolean;
  serviceCatalog: boolean;
  chain: { reachable: boolean; fresh: boolean; latestBlock: string | null };
  providerIdentity: boolean;
  services: Record<string, ServiceHealthStatus>;
  workers: Record<string, { ready: boolean; lastSuccessAt: string | null }>;
  /** Durable queue depth/age/dead-letter diagnostics (never gates anything). */
  queues: Record<
    string,
    { depth: number; running: number; deadLetter: number; oldestQueuedSeconds: number }
  >;
}

export const healthRouter = Router();

// Liveness is deliberately dependency-free so probes cannot amplify DB/RPC load.
healthRouter.get("/", (_req, res) => {
  // The artifact's own embedded identity; hosting metadata only supplements.
  res.status(200).json({
    status: "alive",
    timestamp: new Date().toISOString(),
    commit: publicRevision(),
    sourceDigest: buildIdentity().sourceDigest,
  });
});

healthRouter.get("/live", (_req, res) => {
  res.status(200).json({ status: "alive", timestamp: new Date().toISOString() });
});

// The status code is routing readiness: whether this process can serve
// funded orders' persisted status and artifact reads. Admission and
// servicing are reported beside it and never change it (healthReport.ts).
healthRouter.get("/ready", async (_req, res) => {
  const result = await readiness();
  const ready = result.report.reads.status === "ok";
  res.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "not_ready",
    checkedAt: result.checkedAt,
    ...result.report,
  });
});

// For a load balancer that routes new sales separately from reads: 200
// only while this process takes new quotes.
healthRouter.get("/admission", async (_req, res) => {
  const result = await readiness();
  const open = result.report.admission.status === "open";
  res.status(open ? 200 : 503).json({
    status: open ? "open" : "stopped",
    checkedAt: result.checkedAt,
    codes: result.report.admission.codes,
  });
});

async function readiness(): Promise<ReadinessResult> {
  const now = Date.now();
  if (readinessCache && readinessCache.expiresAt > now) return readinessCache.result;
  if (readinessInFlight) return readinessInFlight;
  readinessInFlight = computeReadiness(now).finally(() => {
    readinessInFlight = null;
  });
  return readinessInFlight;
}

/**
 * Whether new sales may be admitted: the latest admission verdict while it
 * is recent, otherwise a fresh one. Only new quotes ask; a funded dispatch,
 * a lifecycle call or a read never does.
 */
export async function salesAdmission(now = Date.now()): Promise<HealthReport["admission"]> {
  if (lastComputed && now - lastComputed.at <= ADMISSION_MAX_AGE_MS) return lastComputed.result.report.admission;
  return (await readiness()).report.admission;
}

async function computeReadiness(now: number): Promise<ReadinessResult> {
  const [database, chain, serviceCatalog, queueMetrics] = await Promise.all([
    checkDatabase(),
    checkChain(),
    loadServiceCatalog(),
    getDurableQueueMetrics().catch(() => []),
  ]);
  const [schemaEpoch, owing] = database
    ? await Promise.all([
        runtimeEpochAdmitted(pool).catch(() => false),
        listInactiveServicesOwingWork().catch(() => null),
      ])
    : [false, null];
  const serviceInvariantFailures = serviceCatalog.healthy
    ? await checkServiceInvariants(serviceCatalog.rows)
    : {};
  const serviceInvariants = serviceCatalog.healthy
    && Object.keys(serviceInvariantFailures).length === 0;
  const requiredWorkers = requiredWorkerNames(
    serviceCatalog.rows,
    getAllServices(),
    serviceCatalog.healthy,
    owing,
  );
  const workers = Object.fromEntries([...requiredWorkers].map((name) => {
    const status = workerStatuses.get(name);
    return [name, {
      ready: status?.ready ?? false,
      lastSuccessAt: status?.lastSuccessAt
        ? new Date(status.lastSuccessAt).toISOString()
        : null,
    }];
  }));
  const providerIdentityVerified =
    getProviderIdentityAuthorization(now).ok;
  const registration = getServiceRegistrationHealth();
  const registrationCutoff = now - config.REGISTRATION_RECONCILE_MAX_AGE_SECONDS * 1_000;
  const serviceRegistration = registration.ok
    && registration.checkedAt !== null
    && registration.checkedAt.getTime() >= registrationCutoff;
  const currentServiceStatuses = serviceCatalog.healthy
    ? Object.fromEntries(serviceCatalog.rows.map((service) => [
        `${service.slug}@${service.version}`,
        {
          active: service.is_active,
          tokenId: config.PROVIDER_AGENT_ID.toString(),
          registrationVerified: getServiceRegistrationAuthorization(service).ok,
          standardRailVerified: serviceStatuses[service.slug]?.standardRailVerified === true,
          standardRailVerifiedAt: serviceStatuses[service.slug]?.standardRailVerifiedAt,
        },
      ]))
    : serviceStatuses;
  const servicesReady = serviceCatalog.healthy
    && Object.keys(currentServiceStatuses).length > 0
    && Object.values(currentServiceStatuses).every(
      (service) => !service.active || (
        service.standardRailVerified === true
        && service.registrationVerified
      ),
    );
  const workersReady = workersAreReady(requiredWorkers, workerStatuses, now);
  const liveModeInvariants = !(
    (config.NODE_ENV === "production" || config.CHAIN_ID === 8453)
    && config.CHAIN_MODE === "mock"
  );
  const snapshot: ReadinessGateSnapshot = {
    database,
    schemaEpoch,
    serviceCatalog: serviceCatalog.healthy,
    chainReachable: chain.reachable,
    chainFresh: chain.fresh,
    providerIdentity: providerIdentityVerified,
    services: servicesReady,
    serviceRegistration,
    registrationError: registration.error,
    workers: workersReady,
    staleWorkers: workersReady ? [] : [...requiredWorkers].filter((name) => !isWorkerReady(name, now)),
    liveModeInvariants,
    serviceInvariants,
    serviceInvariantFailures,
    retainedServicing: retainedServicing?.ok === true,
    retainedServicingGaps: retainedServicing?.gaps ?? ["unchecked"],
  };
  const result: ReadinessResult = {
    checkedAt: new Date().toISOString(),
    report: healthReportOf(snapshot),
    database,
    serviceCatalog: serviceCatalog.healthy,
    chain,
    providerIdentity: providerIdentityVerified,
    services: currentServiceStatuses,
    workers,
    queues: Object.fromEntries(queueMetrics.map((metric) => [
      metric.queue,
      {
        depth: metric.depth,
        running: metric.running,
        deadLetter: metric.deadLetter,
        oldestQueuedSeconds: metric.oldestQueuedSeconds,
      },
    ])),
  };
  reportTransition(result.report, snapshot);
  readinessCache = { expiresAt: now + config.HEALTH_READINESS_CACHE_MS, result };
  lastComputed = { at: now, result };
  return result;
}

/** Log a change of any part of readiness once, never an unchanged verdict. */
function reportTransition(report: HealthReport, snapshot: ReadinessGateSnapshot): void {
  const state = [
    report.reads.status, report.admission.status, report.servicing.status, report.admission.codes.join(","),
  ].join("|");
  if (state === lastReportedState) return;
  lastReportedState = state;
  if (report.admission.status === "open") {
    logInfo("Readiness transitioned to ready", {});
    return;
  }
  logWarn("Readiness transitioned", {
    reads: report.reads.status,
    admission: report.admission.status,
    servicing: report.servicing.status,
    ...readinessFailureSummary(snapshot),
  });
}

/// Run every ACTIVE service's fail-closed invariant check
/// (ServiceModule.operations.readiness.checkInvariants) and collect violations by
/// slug. A check that throws counts as a violation — never as a pass.
async function checkServiceInvariants(
  services: ServiceRow[],
): Promise<Record<string, string[]>> {
  const active = new Set(
    services.filter((service) => service.is_active).map((service) => service.slug),
  );
  const failures: Record<string, string[]> = {};
  await Promise.all(getAllServices().map(async (module) => {
    if (!active.has(module.manifest.slug)) return;
    const reasons = await serviceInvariantFailures(module);
    if (reasons.length > 0) failures[module.manifest.slug] = reasons;
  }));
  return failures;
}

async function checkChain(): Promise<{ reachable: boolean; fresh: boolean; latestBlock: string | null }> {
  if (CHAIN_MODE_MOCK) return { reachable: true, fresh: true, latestBlock: null };
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      (async () => {
        const block = await publicClient.getBlockNumber();
        const blockNumber = BigInt(block);
        const blockData = await publicClient.getBlock({ blockNumber });
        const ageSeconds = Math.max(0, Date.now() / 1_000 - Number(blockData.timestamp));
        return {
          reachable: true,
          fresh: ageSeconds <= config.READINESS_CHAIN_MAX_AGE_SECONDS,
          latestBlock: blockNumber.toString(),
        };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("chain readiness timeout")), 3_000);
        timer.unref();
      }),
    ]);
  } catch {
    return { reachable: false, fresh: false, latestBlock: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Tests: forget cached readiness verdicts. */
export function resetReadinessForTests(): void {
  readinessCache = null;
  readinessInFlight = null;
  lastComputed = null;
  lastReportedState = null;
}

