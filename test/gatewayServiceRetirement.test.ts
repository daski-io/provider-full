import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("../src/core/db/pool.js", () => ({
  pool: { connect: vi.fn(async () => ({ query: h.query, release: h.release })) },
}));
vi.mock("../src/core/events/emitter.js", () => ({
  recordMandatoryAudit: h.audit,
}));

import {
  retireGatewayService,
  ServiceRetirementBlockedError,
} from "../src/core/gatewayRegistration/retirement.js";

const gateway = "https://gateway.example";
const serviceId = `0x${"11".repeat(32)}` as const;
const service = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "example",
  version: "1",
  is_active: true,
};
const zero = {
  open_transactions: 0,
  live_assets: 0,
  open_escalations: 0,
  open_asset_actions: 0,
  open_supplier_operations: 0,
  pending_standard_reputation: 0,
  pending_gateway_registration: 0,
  pending_splitter_writes: 0,
  pending_chain_writes: 0,
  other_gateway_registrations: 0,
};

function arrange(args: {
  active?: boolean;
  blockers?: Partial<typeof zero>;
  heads?: Array<{ listing_id: string; skill_id: string }>;
} = {}) {
  const heads = args.heads ?? [];
  h.query.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (sql.startsWith("BEGIN")) return { rows: [] };
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("FROM services") && sql.includes("FOR UPDATE")) {
      return { rows: [{ ...service, is_active: args.active ?? true }] };
    }
    if (sql.includes("count(*)::int AS count") &&
      sql.includes("provider_gateway_registrations")) {
      return { rows: [{ count: 1 }] };
    }
    if (sql.includes("AS open_transactions")) {
      return { rows: [{ ...zero, ...args.blockers }] };
    }
    if (sql.includes("UPDATE provider_runtime_listing_versions")) {
      return { rows: heads };
    }
    if (sql.includes("UPDATE services")) {
      return { rows: [{ config_revision: "7" }] };
    }
    if (sql.includes("INSERT INTO operator_config_revisions")) {
      return { rows: [] };
    }
    if (sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    throw new Error(`unexpected SQL: ${sql} ${JSON.stringify(values)}`);
  });
}

describe("gateway service retirement", () => {
  beforeEach(() => {
    h.query.mockReset();
    h.release.mockReset();
    h.audit.mockReset();
  });

  it("deactivates the service and supersedes all heads under the promotion lock", async () => {
    arrange({
      heads: [
        { listing_id: "22222222-2222-4222-8222-222222222222", skill_id: "echo" },
        { listing_id: "33333333-3333-4333-8333-333333333333", skill_id: "note" },
      ],
    });

    await expect(retireGatewayService(gateway, serviceId)).resolves.toMatchObject({
      gatewayOrigin: gateway,
      serviceId,
      serviceSlug: "example",
      alreadyRetired: false,
      serviceDeactivated: true,
      supersededListings: [
        { listingId: "22222222-2222-4222-8222-222222222222", skillId: "echo" },
        { listingId: "33333333-3333-4333-8333-333333333333", skillId: "note" },
      ],
      blockers: {
        openTransactions: 0,
        liveAssets: 0,
        openEscalations: 0,
        openAssetActions: 0,
        pendingChainWrites: 0,
        otherGatewayRegistrations: 0,
      },
    });

    expect(h.query).toHaveBeenCalledWith(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`${gateway}\n${serviceId}`],
    );
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ query: h.query }),
      expect.objectContaining({
        serviceId: service.id,
        type: "admin.service.retired",
        actor: "service-retirement",
      }),
    );
    expect(h.query).toHaveBeenCalledWith("COMMIT");
    expect(h.release).toHaveBeenCalledOnce();
  });

  it("fails closed and rolls back when any obligation or another gateway remains", async () => {
    arrange({
      blockers: {
        live_assets: 1,
        open_asset_actions: 1,
        pending_chain_writes: 1,
        other_gateway_registrations: 1,
      },
    });

    await expect(retireGatewayService(gateway, serviceId)).rejects.toEqual(
      expect.objectContaining<ServiceRetirementBlockedError>({
        name: "ServiceRetirementBlockedError",
        message: expect.stringContaining("service retirement blocked"),
        blockers: expect.objectContaining({
          liveAssets: 1,
          openAssetActions: 1,
          pendingChainWrites: 1,
          otherGatewayRegistrations: 1,
        }),
      }),
    );
    expect(h.query).toHaveBeenCalledWith("ROLLBACK");
    expect(h.query.mock.calls.some(([sql]) =>
      String(sql).includes("UPDATE provider_runtime_listing_versions"))).toBe(false);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("is a no-op when the service and every head are already retired", async () => {
    arrange({ active: false });

    await expect(retireGatewayService(gateway, serviceId)).resolves.toMatchObject({
      alreadyRetired: true,
      serviceDeactivated: false,
      supersededListings: [],
    });
    expect(h.query.mock.calls.some(([sql]) =>
      String(sql).includes("UPDATE services"))).toBe(false);
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.query).toHaveBeenCalledWith("COMMIT");
  });
});
