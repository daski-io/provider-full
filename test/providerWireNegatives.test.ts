import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FulfillmentAdapter } from "../src/core/serviceRegistry/types.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });
vi.mock("../src/core/db/pool.js", async () => (await import("./providerWireHarness.js")).poolModule());
vi.mock("../src/core/serviceRegistry/registry.js", async () => (await import("./providerWireHarness.js")).registryModule());
vi.mock("../src/core/standardRail/identifiers.js", async () => (await import("./providerWireHarness.js")).identifiersModule());
vi.mock("../src/core/engine/preExecuteRunner.js", () => ({
  consultPreExecuteAgent: async () => ({ action: "proceed" }),
}));

const { ProviderEvidenceVerifier } = await import("../src/core/standardRail/evidence.js");
const { WIRE_AUTHORIZATION_KEY, startWireHarness, wire } = await import("./providerWireHarness.js");
const { appliesToFull, fixture } = await import("./providerWireFixture.js");

/**
 * Every vendored request a full provider must refuse (envelope-negatives.json)
 * is refused with a 4xx before any lookup, admission or mutation, and no
 * status handler answers one with the no-claim 404. Lifecycle negatives are
 * driven with the lifecycle vectors.
 */
const negatives = fixture("envelope-negatives.json");
const STATE_TABLES = /\b(?:standard_dispatch_claims|standard_provider_quotes|transactions|standard_evidence_admissions)\b/;
/**
 * Deliberate deviation: an authenticated dispatch envelope that has expired
 * is first checked, read-only, for an exact replay of an admitted claim, so a
 * duplicate delivery of admitted work after expiry still receives its signed
 * snapshot instead of a refusal the gateway would act on (C03). The refusal
 * itself is definite, and nothing is admitted or written.
 */
const READ_ONLY_REPLAY_CHECK = new Set(["dispatch.expired"]);
const CLAIM_READ = "SELECT dispatch_hash,transaction_id FROM standard_dispatch_claims WHERE gateway_audience=$1 AND order_id=$2";
let harness: Awaited<ReturnType<typeof startWireHarness>>;
let executions = 0;

beforeAll(async () => {
  vi.spyOn(ProviderEvidenceVerifier.prototype, "verify").mockResolvedValue({ authorizationKey: WIRE_AUTHORIZATION_KEY });
  vi.spyOn(ProviderEvidenceVerifier.prototype, "assertNotSanctioned").mockResolvedValue();
  wire.adapter = {
    execute: async () => { executions += 1; return { status: "working" }; },
    handleInput: async () => ({ status: "working" }),
    cancel: async () => undefined,
    quote: async () => { executions += 1; return { ok: true, amount: 250_000n, currency: "USDC" }; },
    intake: async () => ({ requiredFields: {}, selectorsRequired: [], normalizedSelectors: {}, fieldErrors: [], supported: true }),
  } satisfies FulfillmentAdapter;
  harness = await startWireHarness("provider_wire_negatives");
});

afterAll(async () => {
  vi.restoreAllMocks();
  await harness?.close();
});

beforeEach(async () => {
  await harness.reset();
  executions = 0;
});

describe("provider-wire envelope negatives", () => {
  const vectors = (negatives.vectors as Array<{ id: string; handler: string; appliesTo: string[] }>)
    .filter((entry) => appliesToFull(entry) && entry.handler !== "lifecycle");

  it("covers every non-lifecycle handler", () => {
    expect(new Set(vectors.map((entry) => entry.handler))).toEqual(new Set(["quote", "intake", "dispatch", "status"]));
  });

  it.each(vectors.map((entry) => [entry.id, entry] as const))("refuses %s before any lookup or mutation", async (_id, entry) => {
    const negative = entry as unknown as {
      handler: string;
      provider: { now: number };
      http: { url: string; headers: Record<string, string>; body: unknown };
    };
    await harness.at(negative.provider.now);
    wire.statements.length = 0;
    const answer = await harness.send({ ...negative.http, bodyText: JSON.stringify(negative.http.body) });
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(answer.status).toBeLessThan(500);
    const body = JSON.parse(answer.text) as { error?: unknown; reason?: unknown };
    expect(body.error).toEqual(expect.any(String));
    if (negative.handler === "dispatch") expect(body.error).toBe("dispatch_rejected");
    if (negative.handler === "status") expect(answer.status === 404 && body.reason === "outcome_policy").toBe(false);
    const touched = wire.statements.filter((sql) => STATE_TABLES.test(sql));
    if (READ_ONLY_REPLAY_CHECK.has(_id)) {
      expect(touched.length).toBeGreaterThan(0);
      expect(touched.every((sql) => sql === CLAIM_READ || sql.includes("pg_try_advisory_xact_lock_shared")
        || sql.startsWith("SELECT dispatch_hash,transaction_id FROM standard_dispatch_claims"))).toBe(true);
    } else {
      expect(touched).toEqual([]);
    }
    expect(executions).toBe(0);
    const stored = await harness.database.pool.query(
      "SELECT (SELECT count(*) FROM standard_dispatch_claims)::int AS claims,(SELECT count(*) FROM standard_provider_quotes)::int AS quotes",
    );
    expect(stored.rows[0]).toEqual({ claims: 0, quotes: 0 });
  });
});
