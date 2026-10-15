// Vitest setup file. Pins every env var `src/core/config.ts`'s zod schema
// (or a service config module) parses to one canonical test value so the
// suite computes byte-identical config everywhere: a clean developer
// shell, a shell with stray exports, and CI.
//
// This is a hermeticity boundary, not a convenience. The security-release
// workflow declares env at the JOB level for its image-boot smoke steps
// (CHAIN_MODE=mock, MOCK_BUYER_WALLET_ADDRESS,
// PROVIDER_DATA_ENCRYPTION_KEY_ID=ci, ...), and every vitest step in that
// job inherits the whole block. While this file only cleared a subset,
// paidQuoteAdmission.test.ts asserted live-mode behavior and failed only
// in CI under the leaked CHAIN_MODE=mock (PR #18, run 30658417836; pinned
// tactically in b3e62ea). Every key the job env sets must appear below —
// pinned or cleared — and workflowEnvHermeticity.test.ts enforces that.
//
// Tests that need different config values either
// `vi.mock("../src/core/config.js")`, or set process.env themselves and
// re-import through vi.resetModules() (the workerReadiness.test.ts /
// paidQuoteAdmission.test.ts idiom). File-scope statements run after this
// setup, so both idioms are unaffected by the pinning here.

const fakeAddress = "0x" + "0".repeat(40);
const fakeKey = "0x" + "1".repeat(64);
const fakeDataKey = "0x" + "2".repeat(64);

// Force-set canonical values for everything the suite needs config to
// hold. Assignments are deliberately unconditional: `?? fallback` keeps
// whatever the invoking environment exported, which is exactly the leak
// this file exists to stop.
const PINNED_TEST_ENV: Record<string, string> = {
  NODE_ENV: "test",
  BASE_URL: "http://localhost:4000",
  GATEWAY_BASE_URL: "https://gateway.test",
  BASE_RPC_URL: "https://sepolia.base.org",
  BASE_RPC_FALLBACK_URLS: "",
  PROVIDER_NAME: "Test Provider",
  SUPPORT_EMAIL: "support@example.com",
  MARKETPLACE_TERMS_URL: "https://marketplace.test/terms-of-use",
  MARKETPLACE_PRIVACY_URL: "https://marketplace.test/privacy-policy",
  PROVIDER_TERMS_URL: "https://provider.test/terms-of-use",
  PROVIDER_PRIVACY_URL: "https://provider.test/privacy-policy",
  DATABASE_URL: "postgresql://localhost/daski_provider_test",
  CHAIN_ID: "84532",
  PROVIDER_AGENT_ID: "1",
  PROVIDER_WALLET_PRIVATE_KEY: fakeKey,
  IDENTITY_REGISTRY_ADDRESS: fakeAddress,
  SERVICE_REGISTRY_ADDRESS: fakeAddress,
  PROVIDER_REGISTRY_ADDRESS: fakeAddress,
  USDC_ADDRESS: fakeAddress,
  OPENAI_API_KEY: "test-key",
  LLM_MODEL: "gpt-4o-mini",
  ADMIN_TOKEN: "test-admin-token-0123456789abcdef",
  PROVIDER_DATA_ENCRYPTION_KEY: fakeDataKey,
};

// Clear the mode/supplier toggles and defaulted knobs that flip real code
// paths when the ambient environment sets them. Clearing reproduces a
// clean developer shell and lets the config defaults apply (CHAIN_MODE=live,
// PROVIDER_DATA_ENCRYPTION_KEY_ID=primary,
// DATABASE_SSL_MODE=disable).
const CLEARED_TEST_ENV: string[] = [
  "CHAIN_MODE",
  "MOCK_BUYER_WALLET_ADDRESS",
  "MOCK_BUYER_AGENT_ID",
  "DATABASE_SSL_MODE",
  "PROVIDER_DATA_ENCRYPTION_KEY_ID",
  "MIGRATION_DATABASE_URL",
  "POSTMARK_SERVER_TOKEN",
  "POSTMARK_TEST_MODE",
  "SUPPLIER_PRICE_TOLERANCE_PERCENT",
];

for (const [key, value] of Object.entries(PINNED_TEST_ENV)) {
  process.env[key] = value;
}
for (const key of CLEARED_TEST_ENV) {
  delete process.env[key];
}

// DATABASE_URL_TEST is the one deliberate pass-through: the
// PostgreSQL-backed migration tests read a live database from it (CI's
// verify job supplies its service container; developers fall back to the
// documented local container). Runtime config never reads it — grep src/
// stays empty — so the suite still computes identical provider config with
// or without it, which is the property this file exists to protect.
const PASSTHROUGH_TEST_ENV: string[] = ["DATABASE_URL_TEST"];

// Every job-level workflow env key this setup accounts for — pinned,
// cleared, or documented pass-through (SCREENING_POLICY_JSON is pinned
// further down). workflowEnvHermeticity.test.ts asserts the workflow's
// job-level env block never grows a key outside this set.
export const NEUTRALIZED_ENV_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(PINNED_TEST_ENV),
  ...CLEARED_TEST_ENV,
  ...PASSTHROUGH_TEST_ENV,
  "SCREENING_POLICY_JSON",
]);

// Deliberately synthetic screening policy. Live membership, aliases, and
// thresholds are deployment-only values supplied through one environment
// variable and never copied into the repository.
process.env.SCREENING_POLICY_JSON = JSON.stringify({
  schemaVersion: "1",
  policyVersion: "test-policy-1",
  rulesVersion: "test-rules-1",
  countryMappingVersion: "test-countries-1",
  nameScorerVersion: "test-scorer-1",
  bundleMetadata: { bundleId: "synthetic-tests", effectiveAt: "2026-01-01T00:00:00Z" },
  tiers: { tier1: ["XZ"], tier2: ["XY"], tier3: ["XX"] },
  serviceBindings: {
    dummy: {
      activeTiers: ["tier1"],
      quoteNameMode: "none",
      postPaymentNameMode: "none",
      exactMode: "hold",
      aliasMode: "hold",
      partialMode: "evaluate",
    },
  },
  countryAliases: {
    XZ: ["XZ", "TEST REQUIRED"], XY: ["XY", "TEST SECONDARY"], XX: ["XX", "TEST LAUNCH"],
    US: ["US", "TEST HOME"], CA: ["CA", "TEST NEIGHBOR"],
    DE: ["DE", "TEST OTHER"],
  },
  restrictedRegions: [{
    id: "test-region", subdivisionCodes: ["XZ-01"], aliases: ["TEST RESTRICTED CITY"],
  }],
  callingCodes: {
    "1": ["US", "CA"], "7": ["XY", "DE"], "49": ["DE"], "999": ["XZ"],
  },
  approvedSourceIds: ["synthetic_test_source"],
  thresholds: { personWeakMatchThreshold: 0.123, companyWeakMatchThreshold: 0.234 },
  r1: {
    yearTolerance: 2, monthContradiction: true, dayContradiction: false,
    exactNameEligible: false,
  },
  r2: { minimumSignals: 2, postHoldAttestationEligible: false },
  r3: {
    partialOnly: true, corroborationGuard: true, unparseableCandidateDataHolds: true,
  },
  limits: { adjudicationMemoryTtlDays: 365, vendorCacheTtlHours: 24, sweepIntervalHours: 24 },
});

// Direct service-module tests need the core contract to be satisfiable, but
// importing the real root composition here would eagerly load database,
// supplier, chain, and worker modules before per-file mocks are installed.
// Register a policy-shaped no-I/O test extension instead. Private-extension
// behavior is exercised by its co-located tests.
const { registerScreeningExtension } = await import("../src/core/screening/registry.js");
const policyBundle = JSON.parse(process.env.SCREENING_POLICY_JSON) as Record<string, any>;
registerScreeningExtension({
  id: "synthetic-test-screening",
  version: "1",
  scopes: ["policy", "quote", "post-payment", "vendor", "asset-profiles", "restrictions"],
  policyHash: "sha256:" + "0".repeat(64),
  policy: {
    schemaVersion: "1",
    policyVersion: policyBundle.policyVersion,
    rulesVersion: policyBundle.rulesVersion,
    countryMappingVersion: policyBundle.countryMappingVersion,
    nameScorerVersion: policyBundle.nameScorerVersion,
    sourceIds: policyBundle.approvedSourceIds,
    tiers: policyBundle.tiers,
    serviceBindings: policyBundle.serviceBindings,
    countryAliases: policyBundle.countryAliases,
    restrictedRegions: policyBundle.restrictedRegions,
    callingCodes: policyBundle.callingCodes,
    thresholds: policyBundle.thresholds,
    r1: policyBundle.r1,
    r2: policyBundle.r2,
    r3: policyBundle.r3,
    adjudicationMemoryTtlDays: policyBundle.limits.adjudicationMemoryTtlDays,
    vendorCacheTtlHours: policyBundle.limits.vendorCacheTtlHours,
    sweepIntervalHours: policyBundle.limits.sweepIntervalHours,
  },
  async evaluate(request) {
    return {
      decision: "allow",
      decisionId: "00000000-0000-4000-8000-000000000001",
      ruleIds: ["SYNTHETIC_TEST_ALLOW"],
      policyVersion: policyBundle.policyVersion,
      policyHash: "sha256:" + "0".repeat(64),
      evidenceFingerprint: request.serviceSlug,
      retryable: false,
    };
  },
  async screenVendorSubject() { return []; },
  async storeAssetProfile() {},
  async bindTransactionAsset() {},
  async hasActiveRestriction() { return false; },
  async hasBlockingTransaction() { return false; },
  normalizeCountry(value) {
    const normalized = value.trim().toUpperCase();
    const entry = Object.entries(policyBundle.countryAliases as Record<string, string[]>)
      .find(([country, aliases]) => country === normalized || aliases.includes(normalized));
    return { normalized, iso2: entry?.[0] ?? null };
  },
  phoneCountryCandidates() { return null; },
});
