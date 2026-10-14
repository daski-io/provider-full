import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderStandardRailConfig } from "../src/core/standardRail/config.js";

const h = vi.hoisted(() => ({ query: vi.fn(), incident: vi.fn() }));
vi.mock("../src/core/db/pool.js", () => ({ pool: { query: h.query } }));
vi.mock("../src/core/standardRail/incidents.js", () => ({ recordStandardSecurityIncident: h.incident }));

const { reconcileStuckStandardTasks } = await import("../src/core/standardRail/taskWatchdog.js");

const listing = `0x${"3".repeat(64)}`;
const config = {
  outcomes: new Map([["fixed", { listingManifestHash: listing, dispatchDeadlineSeconds: 300 }]]),
} as unknown as ProviderStandardRailConfig;

beforeEach(() => {
  h.query.mockReset();
  h.incident.mockReset();
});

describe("standard task watchdog", () => {
  it("also flags an admitted task that never started", async () => {
    const now = Date.parse("2026-10-14T12:00:00Z");
    h.query.mockImplementation(async (sql: string) => sql.startsWith("SELECT")
      ? {
        rows: [{
          id: "task-1", standard_order_id: "ord_1", status: "submitted",
          standard_listing_manifest_hash: Buffer.from(listing.slice(2), "hex"),
          updated_at: new Date(now - 301_000),
        }],
      }
      : { rows: [], rowCount: 1 });
    await expect(reconcileStuckStandardTasks(config, now)).resolves.toBe(1);
    expect(h.query.mock.calls[0]?.[0]).toContain("'submitted'");
    expect(h.incident).toHaveBeenCalledWith(expect.objectContaining({
      kind: "stuck_standard_task", details: expect.objectContaining({ state: "submitted" }),
    }));
  });
});
