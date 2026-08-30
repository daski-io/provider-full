import { Router } from "express";
import { checkDatabase } from "./db/pool.js";
import { CHAIN_MODE_MOCK, publicClient } from "./chain/client.js";
import { config } from "./config.js";
import { listAllServices } from "./db/queries/services.js";
import { getDurableQueueMetrics } from "./db/queries/durableJobs.js";
import { getAllServices } from "./serviceRegistry/registry.js";
import type { ServiceModule } from "./serviceRegistry/types.js";
import type { ServiceRow } from "./db/queries/services.js";
import { logInfo, logWarn } from "./logger.js";
import { getScreeningExtension } from "./screening/registry.js";
import {
  getProviderIdentityAuthorization,
  recordProviderIdentityVerification,
} from "./chain/providerIdentity.js";
import { serviceInvariantFailures } from "./serviceRegistry/readiness.js";
import {
  getServiceRegistrationAuthorization,
  getServiceRegistrationHealth,
} from "./chain/serviceRegistrar.js";

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
  "operator-escalation",
] as const;
let readinessCache: { expiresAt: number; result: ReadinessResult } | null = null;
let readinessInFlight: Promise<ReadinessResult> | null = null;
let lastReportedReady: boolean | null = null;

export interface ReadinessGateSnapshot {
  database: boolean;
  serviceCatalog: boolean;
  chainReachable: boolean;
  chainFresh: boolean;
  providerIdentity: boolean;
  services: boolean;
  serviceRegistration: boolean;
  registrationError: string | null;
  workers: boolean;
  staleWorkers: string[];
  liveModeInvariants: boolean;
  /** Per-service fail-closed invariants (ServiceModule.operations.readiness). */
  serviceInvariants: boolean;
  serviceInvariantFailures: Record<string, string[]>;
}

/// Compact one-line summary of the failing readiness gates, for the
/// transition log. The public /health/ready body deliberately hides gate
/// detail; this is the operator-facing view of WHY readiness is off.
export function readinessFailureSummary(
  snapshot: ReadinessGateSnapshot,
): Record<string, string> {
  const failing = [
    ...(snapshot.database ? [] : ["database"]),
    ...(snapshot.serviceCatalog ? [] : ["serviceCatalog"]),
    ...(snapshot.chainReachable ? [] : ["chain.reachable"]),
    ...(snapshot.chainFresh ? [] : ["chain.fresh"]),
    ...(snapshot.providerIdentity ? [] : ["providerIdentity"]),
    ...(snapshot.services ? [] : ["services"]),
    ...(snapshot.serviceRegistration ? [] : ["serviceRegistration"]),
    ...(snapshot.workers ? [] : ["workers"]),
    ...(snapshot.liveModeInvariants ? [] : ["liveModeInvariants"]),
    ...(snapshot.serviceInvariants ? [] : ["serviceInvariants"]),
  ];
  const summary: Record<string, string> = { failing: failing.join(",") };
  if (!snapshot.serviceRegistration && snapshot.registrationError) {
    summary.registrationError = snapshot.registrationError;
  }
  if (!snapshot.workers && snapshot.staleWorkers.length > 0) {
    summary.staleWorkers = snapshot.staleWorkers.join(",");
  }
  if (!snapshot.serviceInvariants) {
    summary.serviceInvariantFailures = Object.entries(snapshot.serviceInvariantFailures)
      .map(([slug, reasons]) => `${slug}: ${reasons.join("; ")}`)
      .join(" | ");
  }
  return summary;
}

export function setServiceStatuses(statuses: Record<string, ServiceHealthStatus>): void {
  serviceStatuses = statuses;
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
  ready: boolean;
  checkedAt: string;
  database: boolean;
  serviceCatalog: boolean;
  chain: { reachable: boolean; fresh: boolean; latestBlock: string | null };
  providerIdentity: boolean;
  services: Record<string, ServiceHealthStatus>;
  workers: Record<string, { ready: boolean; lastSuccessAt: string | null }>;
  /** Durable queue depth/age/dead-letter diagnostics (never gates ready). */
  queues: Record<
    string,
    { depth: number; running: number; deadLetter: number; oldestQueuedSeconds: number }
  >;
  liveModeInvariants: boolean;
  /** Per-service fail-closed invariants (ServiceModule.operations.readiness). */
  serviceInvariants: boolean;
  serviceInvariantFailures: Record<string, string[]>;
  serviceRegistration: boolean;
}

export const healthRouter = Router();

// Liveness is deliberately dependency-free so probes cannot amplify DB/RPC load.
healthRouter.get("/", (_req, res) => {
  res.status(200).json({
    status: "alive",
    timestamp: new Date().toISOString(),
    commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) ?? "unknown",
  });
});

healthRouter.get("/live", (_req, res) => {
  res.status(200).json({ status: "alive", timestamp: new Date().toISOString() });
});

healthRouter.get("/ready", async (_req, res) => {
  const result = await readiness();
  res.status(result.ready ? 200 : 503).json({
    status: result.ready ? "ready" : "not_ready",
    checkedAt: result.checkedAt,
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

async function computeReadiness(now: number): Promise<ReadinessResult> {
  const [database, chain, serviceCatalog, queueMetrics] = await Promise.all([
    checkDatabase(),
    checkChain(),
    loadServiceCatalog(),
    getDurableQueueMetrics().catch(() => []),
  ]);
  const serviceInvariantFailures = serviceCatalog.healthy
    ? await checkServiceInvariants(serviceCatalog.rows)
    : {};
  const serviceInvariants = serviceCatalog.healthy
    && Object.keys(serviceInvariantFailures).length === 0;
  const requiredWorkers = requiredWorkerNames(
    serviceCatalog.rows,
    getAllServices(),
    serviceCatalog.healthy,
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
  const result: ReadinessResult = {
    ready: database
      && serviceCatalog.healthy
      && chain.reachable
      && chain.fresh
      && providerIdentityVerified
      && servicesReady
      && serviceRegistration
      && workersReady
      && liveModeInvariants
      && serviceInvariants,
    checkedAt: new Date().toISOString(),
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
    liveModeInvariants,
    serviceInvariants,
    serviceInvariantFailures,
    serviceRegistration,
  };
  if (result.ready !== lastReportedReady) {
    if (result.ready) {
      logInfo("Readiness transitioned to ready", {});
    } else {
      const staleWorkers = workersReady ? [] : [...requiredWorkers].filter((name) => {
        const status = workerStatuses.get(name);
        return !(status?.ready && status.lastSuccessAt >= now - status.maxAgeMs);
      });
      logWarn("Readiness transitioned to not_ready", readinessFailureSummary({
        database,
        serviceCatalog: serviceCatalog.healthy,
        chainReachable: chain.reachable,
        chainFresh: chain.fresh,
        providerIdentity: providerIdentityVerified,
        services: servicesReady,
        serviceRegistration,
        registrationError: registration.error,
        workers: workersReady,
        staleWorkers,
        liveModeInvariants,
        serviceInvariants,
        serviceInvariantFailures,
      }));
    }
    lastReportedReady = result.ready;
  }
  readinessCache = { expiresAt: now + config.HEALTH_READINESS_CACHE_MS, result };
  return result;
}

export function requiredWorkerNames(
  services: ServiceRow[],
  modules: ServiceModule[] = getAllServices(),
  serviceCatalogHealthy = true,
): Set<string> {
  const required = new Set<string>(CORE_REQUIRED_WORKERS);
  if (CHAIN_MODE_MOCK) required.delete("provider-write-reconciler");
  const active = new Set(
    services.filter((service) => service.is_active).map((service) => service.slug),
  );
  for (const module of modules) {
    if (serviceCatalogHealthy && !active.has(module.manifest.slug)) continue;
    for (const worker of module.operations?.readiness?.requiredWorkers ?? []) {
      required.add(worker);
    }
  }
  if (modules.some((module) =>
    (!serviceCatalogHealthy || active.has(module.manifest.slug))
    && (module.screening?.requiredScopes.length ?? 0) > 0)) {
    for (const worker of getScreeningExtension()?.readiness?.requiredWorkers ?? []) {
      required.add(worker);
    }
  }
  return required;
}

export async function loadServiceCatalog(
  load: () => Promise<ServiceRow[]> = listAllServices,
): Promise<{ healthy: boolean; rows: ServiceRow[] }> {
  try {
    return { healthy: true, rows: await load() };
  } catch {
    return { healthy: false, rows: [] };
  }
}

export function workersAreReady(
  required: Set<string>,
  statuses: Map<string, { ready: boolean; lastSuccessAt: number; maxAgeMs: number }>,
  now: number,
): boolean {
  return [...required].every((name) => {
    const status = statuses.get(name);
    return Boolean(status?.ready && status.lastSuccessAt >= now - status.maxAgeMs);
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
  if (config.CHAIN_MODE === "mock") return { reachable: true, fresh: true, latestBlock: null };
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
