import { CHAIN_MODE_MOCK } from "./chain/client.js";
import { listAllServices, type ServiceRow } from "./db/queries/services.js";
import { getScreeningExtension } from "./screening/registry.js";
import { getAllServices } from "./serviceRegistry/registry.js";
import type { ServiceModule } from "./serviceRegistry/types.js";

/*
 * `/health/ready` in three parts (C05). Read serviceability decides routing:
 * a process that can still answer funded orders' persisted status and
 * artifact reads stays routable. Admission says whether new sales (quotes)
 * are taken; any dependency, identity, catalog, invariant or servicing
 * trouble stops them in-process (standardRail/quote.ts) without taking reads
 * off the network. Servicing is the workers' and the retained-contract
 * check's view of owed work: a dead worker degrades it and stops new sales,
 * but never routing, and a slow upstream job is never a reason to restart.
 */

/** Why persisted status and artifact reads cannot be served: routing stops (503). */
export type ReadCode = "database_unavailable" | "schema_epoch_unsupported";

/** Why the servicing of owed work is degraded. */
export type ServicingCode = "worker_stale" | "retained_servicing_gap";

/** Why new sales stop; funded orders and their reads continue. */
export type AdmissionCode =
  | ReadCode
  | ServicingCode
  | "service_catalog_unavailable"
  | "chain_unreachable"
  | "chain_stale"
  | "identity_unverified"
  | "services_unverified"
  | "registration_unverified"
  | "live_mode_invariant"
  | "service_invariant";

export interface HealthReport {
  reads: { status: "ok" | "unavailable"; codes: ReadCode[] };
  admission: { status: "open" | "stopped"; codes: AdmissionCode[] };
  servicing: { status: "ok" | "degraded"; codes: ServicingCode[] };
}

export interface ReadinessGateSnapshot {
  database: boolean;
  /** The schema's minimum runtime epoch admits this build. */
  schemaEpoch?: boolean;
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
  /** This build serves every retained listing version and admitted action. */
  retainedServicing?: boolean;
  retainedServicingGaps?: string[];
}

/** The three-part report the gates describe. */
export function healthReportOf(snapshot: ReadinessGateSnapshot): HealthReport {
  const reads: ReadCode[] = [
    ...(snapshot.database ? [] : ["database_unavailable" as const]),
    ...(snapshot.database && snapshot.schemaEpoch === false ? ["schema_epoch_unsupported" as const] : []),
  ];
  const servicing: ServicingCode[] = [
    ...(snapshot.workers ? [] : ["worker_stale" as const]),
    ...(snapshot.retainedServicing === false ? ["retained_servicing_gap" as const] : []),
  ];
  const admission: AdmissionCode[] = [
    ...reads,
    ...(snapshot.serviceCatalog ? [] : ["service_catalog_unavailable" as const]),
    ...(snapshot.chainReachable ? [] : ["chain_unreachable" as const]),
    ...(snapshot.chainReachable && !snapshot.chainFresh ? ["chain_stale" as const] : []),
    ...(snapshot.providerIdentity ? [] : ["identity_unverified" as const]),
    ...(snapshot.services ? [] : ["services_unverified" as const]),
    ...(snapshot.serviceRegistration ? [] : ["registration_unverified" as const]),
    ...(snapshot.liveModeInvariants ? [] : ["live_mode_invariant" as const]),
    ...(snapshot.serviceInvariants ? [] : ["service_invariant" as const]),
    ...servicing,
  ];
  return {
    reads: { status: reads.length === 0 ? "ok" : "unavailable", codes: reads },
    admission: { status: admission.length === 0 ? "open" : "stopped", codes: admission },
    servicing: { status: servicing.length === 0 ? "ok" : "degraded", codes: servicing },
  };
}

/// Compact one-line summary of the failing readiness gates, for the
/// transition log. The public /health/ready body names only stable codes;
/// this is the operator-facing view of WHY a part of readiness is off.
export function readinessFailureSummary(
  snapshot: ReadinessGateSnapshot,
): Record<string, string> {
  const failing = [
    ...(snapshot.database ? [] : ["database"]),
    ...(snapshot.schemaEpoch === false ? ["schemaEpoch"] : []),
    ...(snapshot.serviceCatalog ? [] : ["serviceCatalog"]),
    ...(snapshot.chainReachable ? [] : ["chain.reachable"]),
    ...(snapshot.chainFresh ? [] : ["chain.fresh"]),
    ...(snapshot.providerIdentity ? [] : ["providerIdentity"]),
    ...(snapshot.services ? [] : ["services"]),
    ...(snapshot.serviceRegistration ? [] : ["serviceRegistration"]),
    ...(snapshot.workers ? [] : ["workers"]),
    ...(snapshot.liveModeInvariants ? [] : ["liveModeInvariants"]),
    ...(snapshot.serviceInvariants ? [] : ["serviceInvariants"]),
    ...(snapshot.retainedServicing === false ? ["retainedServicing"] : []),
  ];
  const summary: Record<string, string> = { failing: failing.join(",") };
  if (!snapshot.serviceRegistration && snapshot.registrationError) {
    summary.registrationError = snapshot.registrationError;
  }
  if (!snapshot.workers && snapshot.staleWorkers.length > 0) {
    summary.staleWorkers = snapshot.staleWorkers.join(",");
  }
  if (snapshot.retainedServicing === false && snapshot.retainedServicingGaps?.length) {
    summary.retainedServicingGaps = snapshot.retainedServicingGaps.join(",");
  }
  if (!snapshot.serviceInvariants) {
    summary.serviceInvariantFailures = Object.entries(snapshot.serviceInvariantFailures)
      .map(([slug, reasons]) => `${slug}: ${reasons.join("; ")}`)
      .join(" | ");
  }
  return summary;
}

/**
 * The workers readiness requires: core's, and those of every service that is
 * active or, paused or inactive, still owes work (`owing`: slugs with
 * nonterminal tasks or unresolved supplier operations). Without a readable
 * catalog or owed-work inventory every installed service's workers count.
 */
export function requiredWorkerNames(
  services: ServiceRow[],
  modules: ServiceModule[] = getAllServices(),
  serviceCatalogHealthy = true,
  owing: ReadonlySet<string> | null = new Set(),
  coreWorkers: readonly string[] = [],
): Set<string> {
  const required = new Set<string>(coreWorkers);
  if (CHAIN_MODE_MOCK) required.delete("provider-write-reconciler");
  const active = new Set(
    services.filter((service) => service.is_active).map((service) => service.slug),
  );
  const needed = (module: ServiceModule) =>
    !serviceCatalogHealthy || owing === null || active.has(module.manifest.slug) || owing.has(module.manifest.slug);
  for (const module of modules) {
    if (!needed(module)) continue;
    for (const worker of module.operations?.readiness?.requiredWorkers ?? []) {
      required.add(worker);
    }
  }
  if (modules.some((module) => needed(module) && (module.screening?.requiredScopes.length ?? 0) > 0)) {
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
