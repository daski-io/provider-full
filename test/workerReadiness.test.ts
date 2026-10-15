import { describe, expect, it } from "vitest";
import {
  loadServiceCatalog,
  readinessFailureSummary,
  requiredWorkerNames,
  workersAreReady,
} from "../src/core/health.js";
import { healthReportOf } from "../src/core/healthReport.js";
import type { ServiceRow } from "../src/core/db/queries/services.js";
import type { ServiceModule } from "../src/core/serviceRegistry/types.js";

describe("required worker readiness", () => {
  it("fails closed when a required worker never registered", () => {
    const required = requiredWorkerNames([]);
    const now = Date.now();
    const statuses = new Map([...required].slice(1).map((name) => [name, {
      ready: true,
      lastSuccessAt: now,
      maxAgeMs: 60_000,
    }]));
    expect(workersAreReady(required, statuses, now)).toBe(false);
  });

  // Slug→worker mapping is data the modules declare (ServiceModule.
  // readiness.requiredWorkers); core unions those of ACTIVE services and of
  // paused or inactive ones that still owe work. Each real service asserts
  // its own declaration in its co-located tests.
  it("requires the declared workers of active services, and not of idle inactive ones", () => {
    const modules = [
      {
        manifest: { slug: "svc-a" },
        operations: { readiness: { requiredWorkers: ["svc-a-lifecycle"] } },
      },
      {
        manifest: { slug: "svc-b" },
        operations: {
          readiness: { requiredWorkers: ["svc-b-poller", "svc-b-sweep"] },
        },
      },
      { manifest: { slug: "svc-c" } },
    ] as ServiceModule[];
    const services = [
      { slug: "svc-a", is_active: true },
      { slug: "svc-b", is_active: false },
      { slug: "svc-c", is_active: true },
    ] as ServiceRow[];
    const required = requiredWorkerNames(services, modules);
    expect(required.has("svc-a-lifecycle")).toBe(true);
    expect(required.has("svc-b-poller")).toBe(false);
    expect(required.has("svc-b-sweep")).toBe(false);
  });

  it("keeps requiring the workers of a paused service while it still owes work", () => {
    const modules = [
      { manifest: { slug: "svc-a" }, operations: { readiness: { requiredWorkers: ["svc-a-lifecycle"] } } },
      { manifest: { slug: "svc-b" }, operations: { readiness: { requiredWorkers: ["svc-b-poller"] } } },
    ] as ServiceModule[];
    const services = [
      { slug: "svc-a", is_active: false },
      { slug: "svc-b", is_active: false },
    ] as ServiceRow[];
    const owing = requiredWorkerNames(services, modules, true, new Set(["svc-b"]));
    expect(owing.has("svc-b-poller")).toBe(true);
    expect(owing.has("svc-a-lifecycle")).toBe(false);
    // An unreadable owed-work inventory requires every installed worker.
    const unknown = requiredWorkerNames(services, modules, true, null);
    expect(unknown.has("svc-a-lifecycle") && unknown.has("svc-b-poller")).toBe(true);
  });

  it("requires every installed service worker when the catalog is unavailable", () => {
    const modules = [
      {
        manifest: { slug: "svc-a" },
        operations: { readiness: { requiredWorkers: ["svc-a-lifecycle"] } },
      },
      {
        manifest: { slug: "svc-b" },
        operations: { readiness: { requiredWorkers: ["svc-b-poller"] } },
      },
    ] as ServiceModule[];
    const required = requiredWorkerNames([], modules, false);
    expect(required.has("svc-a-lifecycle")).toBe(true);
    expect(required.has("svc-b-poller")).toBe(true);
  });

  it("marks a failed service catalog query unhealthy", async () => {
    const result = await loadServiceCatalog(async () => {
      throw new Error("database unavailable");
    });
    expect(result).toEqual({ healthy: false, rows: [] });
  });

  it("does not require the retired reputation worker", () => {
    const required = requiredWorkerNames([]);
    expect(required.has("reputation-submission")).toBe(false);
  });

  it("requires the registry-only provider-write reconciler", () => {
    const required = requiredWorkerNames([]);
    expect(required.has("provider-write-reconciler")).toBe(true);
  });
});

// The public /health/ready body hides gate detail by design; the transition
// log line built from this summary is the only operator-visible statement of
// WHY readiness is off. The 2026-07-16 not_ready incident was undiagnosable
// from outside precisely because no such line existed.
describe("readiness failure summary", () => {
  const allPassing = {
    database: true,
    serviceCatalog: true,
    chainReachable: true,
    chainFresh: true,
    providerIdentity: true,
    services: true,
    serviceRegistration: true,
    registrationError: null,
    workers: true,
    staleWorkers: [] as string[],
    liveModeInvariants: true,
    serviceInvariants: true,
    serviceInvariantFailures: {} as Record<string, string[]>,
  };

  it("names only the failing gates and attaches their detail", () => {
    expect(readinessFailureSummary({
      ...allPassing,
      chainFresh: false,
      serviceRegistration: false,
      registrationError: "service registration reconcile exceeded 45000ms",
      workers: false,
      staleWorkers: ["email-ingress", "settlement-reconciler"],
    })).toEqual({
      failing: "chain.fresh,serviceRegistration,workers",
      registrationError: "service registration reconcile exceeded 45000ms",
      staleWorkers: "email-ingress,settlement-reconciler",
    });
  });

  it("names retained-servicing gaps, the build's missing handlers and keys (F-T05)", () => {
    expect(readinessFailureSummary({
      ...allPassing,
      retainedServicing: false,
      retainedServicingGaps: ["handler:notes/write:0xabc", "signing_key:notes/write:0xabc"],
    })).toEqual({
      failing: "retainedServicing",
      retainedServicingGaps: "handler:notes/write:0xabc,signing_key:notes/write:0xabc",
    });
    expect(readinessFailureSummary({ ...allPassing, retainedServicing: true })).toEqual({ failing: "" });
  });

  it("requires the paid-fulfillment worker that resumes admitted orders", () => {
    expect(requiredWorkerNames([]).has("standard-paid-fulfillment")).toBe(true);
  });

  it("omits detail fields for gates that pass", () => {
    expect(readinessFailureSummary({ ...allPassing, database: false })).toEqual({
      failing: "database",
    });
  });

  it("names each failing service invariant with its reasons", () => {
    expect(readinessFailureSummary({
      ...allPassing,
      serviceInvariants: false,
      serviceInvariantFailures: {
        "svc-a": ["supplier sandbox mode on mainnet"],
        "svc-b": ["credentials missing", "governance approval stale"],
      },
    })).toEqual({
      failing: "serviceInvariants",
      serviceInvariantFailures:
        "svc-a: supplier sandbox mode on mainnet | svc-b: credentials missing; governance approval stale",
    });
  });
});

// C05: read serviceability alone decides routing; dependency, identity and
// worker trouble stop new sales and degrade servicing, never reads.
describe("readiness in three parts (C05)", () => {
  const healthy = {
    database: true, schemaEpoch: true, serviceCatalog: true, chainReachable: true, chainFresh: true,
    providerIdentity: true, services: true, serviceRegistration: true, registrationError: null,
    workers: true, staleWorkers: [] as string[], liveModeInvariants: true, serviceInvariants: true,
    serviceInvariantFailures: {} as Record<string, string[]>, retainedServicing: true,
  };

  it("is open and serviceable when every gate passes", () => {
    expect(healthReportOf(healthy)).toEqual({
      reads: { status: "ok", codes: [] },
      admission: { status: "open", codes: [] },
      servicing: { status: "ok", codes: [] },
    });
  });

  it("keeps reads routable while a dead worker degrades servicing and stops new sales", () => {
    expect(healthReportOf({ ...healthy, workers: false, staleWorkers: ["standard-paid-fulfillment"] })).toEqual({
      reads: { status: "ok", codes: [] },
      admission: { status: "stopped", codes: ["worker_stale"] },
      servicing: { status: "degraded", codes: ["worker_stale"] },
    });
  });

  it("stops only new sales for chain, identity, registration and service trouble", () => {
    const report = healthReportOf({
      ...healthy, chainReachable: false, chainFresh: false, providerIdentity: false,
      serviceRegistration: false, serviceInvariants: false, serviceInvariantFailures: { svc: ["outage"] },
    });
    expect(report.reads.status).toBe("ok");
    expect(report.servicing.status).toBe("ok");
    expect(report.admission).toEqual({
      status: "stopped",
      codes: ["chain_unreachable", "identity_unverified", "registration_unverified", "service_invariant"],
    });
    expect(healthReportOf({ ...healthy, chainFresh: false }).admission.codes).toEqual(["chain_stale"]);
    expect(healthReportOf({ ...healthy, retainedServicing: false })).toMatchObject({
      reads: { status: "ok" }, servicing: { codes: ["retained_servicing_gap"] }, admission: { status: "stopped" },
    });
  });

  it("takes reads off the network only when the database or its schema epoch cannot serve them", () => {
    expect(healthReportOf({ ...healthy, database: false }).reads).toEqual({
      status: "unavailable", codes: ["database_unavailable"],
    });
    expect(healthReportOf({ ...healthy, schemaEpoch: false }).reads).toEqual({
      status: "unavailable", codes: ["schema_epoch_unsupported"],
    });
  });
});
