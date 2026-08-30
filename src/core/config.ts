import { z } from "zod";
import { isAddress } from "viem";
import {
  BASE_MAINNET_CHAIN_ID,
  BASE_MAINNET_EXTERNAL_CONTRACTS,
} from "./chain/reviewedDeployments.js";

// Core env schema. Service-specific knobs live in their own
// services/<slug>/config.ts so a misconfigured service fails fast on
// registration without polluting core.

const TRUE_BOOLEAN_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_BOOLEAN_VALUES = new Set(["0", "false", "no", "off"]);

function hasOverbroadCidr(value: string): boolean {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean).some((entry) => {
    const slash = entry.lastIndexOf("/");
    if (slash < 0) return false;
    const prefix = Number(entry.slice(slash + 1));
    if (!Number.isInteger(prefix)) return true;
    return entry.slice(0, slash).includes(":") ? prefix < 64 : prefix < 24;
  });
}

function isLoopbackUrl(value: string): boolean {
  const hostname = new URL(value).hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Strict environment boolean parser; unlike Boolean("false"), false stays false. */
export const strictBooleanEnv = z.preprocess((value) => {
  if (typeof value === "boolean" || value === undefined) return value;
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (TRUE_BOOLEAN_VALUES.has(normalized)) return true;
  if (FALSE_BOOLEAN_VALUES.has(normalized)) return false;
  return value;
}, z.boolean());

const addressSchema = z.string().refine((value) => isAddress(value), {
  message: "must be a valid EVM address",
});
const httpsUrlSchema = z.string().trim().min(1).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}, { message: "must be a valid HTTPS URL without embedded credentials" });
const adminTokenSchema = z.string().min(32).refine(
  (value) =>
    value !== "replace-with-a-long-random-string"
    && value !== "replace-me"
    && new Set(value).size >= 8,
  { message: "must be a high-entropy secret and not a documented placeholder" },
);
const UINT256_MAX = (1n << 256n) - 1n;
const uint256Schema = z.coerce.bigint().refine(
  (value) => value >= 0n && value <= UINT256_MAX,
  { message: "must fit an unsigned 256-bit integer" },
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  BASE_URL: z.string().url(),
  CHAIN_MODE: z.enum(["live", "mock"]).default("live"),
  MOCK_BUYER_AGENT_ID: uint256Schema.default(99n),
  MOCK_BUYER_WALLET_ADDRESS: addressSchema.optional(),

  // Daski gateway public API root (e.g. https://sandbox-gateway.daski.io).
  // Used by the admin UI's Buyer detail page to pull the buyer's marketplace
  // identity (name, wallet) and aggregated reputation. Optional — when
  // unset, the buyer detail page falls back to local-only data and skips
  // the "Identity and Reputation" enrichment.
  GATEWAY_BASE_URL: z.string().url().optional(),

  // Provider-level identity surfaced at the top level of the ERC-8004
  // registration file (/.well-known/agent.json). Distinct from per-service
  // name/description (those live in src/services/<slug>/manifest.ts and
  // are surfaced via the A2A AgentCard at /agent-cards/<slug>.json).
  // PROVIDER_NAME is required so every deploy makes an explicit identity
  // choice instead of falling through to a service title; the gateway
  // caches and exposes it as `providerName` to marketplace UIs.
  PROVIDER_NAME: z.string().trim().min(1, "PROVIDER_NAME is required"),
  PROVIDER_DESCRIPTION: z.string().optional(),
  // Provider organization website. Optional — surfaced on the ERC-8004
  // registration file at /.well-known/agent.json as `external_url` (the
  // ERC-721/OpenSea convention for a project's homepage). Marketplace UIs
  // link from the provider chip. Distinct from BASE_URL (the API origin).
  PROVIDER_WEBSITE_URL: z.string().url().optional(),
  // Square icon URL. Optional — surfaced on the ERC-8004 registration
  // file at /.well-known/agent.json as `image`, matching the ERC-721
  // metadata layout so NFT-aware indexers can render the provider's
  // brand mark directly. Recommended: 1:1 aspect ratio, transparent
  // background, ≥256px on a side. Host on the provider's own
  // infrastructure (PROVIDER_WEBSITE_URL or its asset CDN), never on
  // the marketplace.
  PROVIDER_ICON_URL: z.string().url().optional(),
  // Public legal documents surfaced in provider discovery, every service
  // Agent Card, and successful quotes. All four are required and HTTPS-only
  // so a deploy cannot list a purchasable service without stable legal links.
  MARKETPLACE_TERMS_URL: httpsUrlSchema,
  MARKETPLACE_PRIVACY_URL: httpsUrlSchema,
  PROVIDER_TERMS_URL: httpsUrlSchema,
  PROVIDER_PRIVACY_URL: httpsUrlSchema,

  DATABASE_URL: z.string().min(1),
  MIGRATION_DATABASE_URL: z.string().min(1).optional(),
  DATABASE_SSL_MODE: z.enum(["disable", "require", "verify-full"]).default("disable"),
  DATABASE_CA_CERT: z.string().optional(),
  DATABASE_ACQUIRE_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(30_000),
  DATABASE_IDLE_TX_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(30_000),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(20),
  DATABASE_APPLICATION_NAME: z.string().min(1).max(63).default("daski-provider"),
  BASE_RPC_URL: httpsUrlSchema,
  // Comma-separated ordered failover RPC endpoints tried after
  // BASE_RPC_URL. Empty = single-endpoint behavior. Ignored entirely under
  // CHAIN_MODE=mock (the blackhole transport stays authoritative).
  BASE_RPC_FALLBACK_URLS: z.string().default("").refine(
    (csv) =>
      csv
        .split(",")
        .map((url) => url.trim())
        .filter(Boolean)
        .every((url) => {
          try {
            const parsed = new URL(url);
            return parsed.protocol === "https:" || parsed.protocol === "http:";
          } catch {
            return false;
          }
        }),
    { message: "must be a comma-separated list of absolute HTTP(S) URLs" },
  ),
  CHAIN_ID: z.coerce.number().int().refine((id) => id === 8453 || id === 84532, {
    message: "CHAIN_ID must be Base (8453) or Base Sepolia (84532)",
  }),
  CHAIN_WRITE_FINALITY_CONFIRMATIONS: z.coerce.number().int().min(1).max(10_000).default(12),
  PROVIDER_WALLET_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  IDENTITY_REGISTRY_ADDRESS: addressSchema,
  SERVICE_REGISTRY_ADDRESS: addressSchema,
  // The provider's ERC-8004 agentId. Constant across all services.
  PROVIDER_AGENT_ID: uint256Schema,
  USDC_ADDRESS: addressSchema,

  // LLM client (core). Used by the pre-execute agent runner. Per-service
  // prompts override only the system prompt; the model + key are global.
  OPENAI_API_KEY: z.string(),
  LLM_MODEL: z.string().default("gpt-5.4-mini"),
  // Per-agent model overrides. Both fall back to LLM_MODEL when unset, so
  // existing deploys keep working. The tool-using triage / operator agents
  // generally want a stronger model than the pre-execute default, so these
  // let ops pin e.g. gpt-4o for the agents while keeping gpt-4o-mini for
  // cheap per-execute calls.
  EMAIL_AGENT_LLM_MODEL: z.string().optional(),
  OPERATOR_AGENT_LLM_MODEL: z.string().optional(),

  SUPPLIER_BREAKER_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1_440).default(30),
  SUPPLIER_BREAKER_THRESHOLD: z.coerce.number().int().min(1).max(100).default(5),

  // Required — gates every /admin/* route. The middleware fails closed
  // if missing. See src/core/admin/routes.ts.
  ADMIN_TOKEN: adminTokenSchema,
  // Auto-flushed admin UI session length, in hours.
  ADMIN_UI_SESSION_HOURS: z.coerce.number().int().min(1).max(24).default(12),

  // Comma-separated lowercase 0x-prefixed wallet addresses permitted to
  // sign in to the admin UI via SIWE. Empty / unset disables the SIWE
  // login path (the JSON API still accepts bearer ADMIN_TOKEN).
  ADMIN_WALLET_ALLOWLIST: z.string().default(""),

  // Postmark integration. Optional during local dev — the provider only
  // wires up the inbound webhook and outbound sender if a token is set.
  // Without these, /webhooks/postmark/inbound 503s and outbound sends
  // throw, but the rest of the system runs.
  POSTMARK_SERVER_TOKEN: z.string().optional(),
  // On testnet the provider emails the FAKE addresses used in test
  // transactions (e.g. office@harborandpine.com), which hard-bounce and get
  // Postmark-suppressed → 422 "inactive recipient" failures. In test mode the
  // outbound sender swaps in Postmark's reserved test token (POSTMARK_API_TEST):
  // the send path still executes and is recorded, but Postmark delivers nothing
  // and skips suppression checks. Defaults ON for any non-mainnet CHAIN_ID;
  // set explicitly (true/false) to override. Parsed by hand — z.coerce.boolean()
  // treats the string "false" as true.
  POSTMARK_TEST_MODE: strictBooleanEnv.optional(),
  // Shared secret that gates the inbound + delivery webhooks. When set,
  // a request must prove knowledge of it via ONE of (see
  // src/core/email/postmarkAuth.ts):
  //   - HTTP Basic Auth (provider-supported webhook authentication).
  //   - an X-Postmark-Signature HMAC-SHA256 of the raw body (for a
  //     signing proxy in front of Postmark).
  // Query-string credentials are intentionally rejected. Production refuses
  // to boot without a secret; every other deployment fails the route closed.
  POSTMARK_INBOUND_WEBHOOK_SECRET: z.string().min(32).optional(),
  POSTMARK_INBOUND_WEBHOOK_SECRET_PREVIOUS: z.string().min(32).optional(),
  POSTMARK_INBOUND_MAX_SUBJECT_CHARS: z.coerce.number().int().min(1).max(10_000).default(500),
  POSTMARK_INBOUND_MAX_BODY_CHARS: z.coerce.number().int().min(1).max(500_000).default(50_000),
  POSTMARK_INBOUND_MAX_HEADERS: z.coerce.number().int().min(1).max(500).default(100),
  POSTMARK_INBOUND_MAX_ATTACHMENTS: z.coerce.number().int().min(0).max(50).default(10),
  POSTMARK_INBOUND_MAX_ATTACHMENT_BYTES: z.coerce.number().int().min(1).max(25_000_000).default(10_000_000),
  POSTMARK_INBOUND_MAX_TOTAL_ATTACHMENT_BYTES: z.coerce.number().int().min(1).max(50_000_000).default(20_000_000),
  POSTMARK_INBOUND_MAX_REQUEST_BYTES: z.coerce.number().int().min(1_000_000).max(75_000_000).default(30_000_000),
  EMAIL_AGENT_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),

  // Comma-separated list of origins permitted to call this provider from
  // a browser context (CORS allowed-origin allowlist). Server-to-server
  // callers (gateway facilitator, MCP buyers, ops scripts) never send an
  // Origin header and bypass CORS. Empty string = no browser origins.
  CORS_ORIGINS: z.string().default(""),

  // Encryption key for at-rest secrets (transfer auth codes today;
  // registrant PII later). 32-byte hex string. Different from
  // PROVIDER_WALLET_PRIVATE_KEY for blast-radius reasons. Optional during
  // local dev — features that require it (transfer-out) gate on it
  // dynamically and surface a clear error if missing.
  PROVIDER_DATA_ENCRYPTION_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "PROVIDER_DATA_ENCRYPTION_KEY must be 32-byte hex"),
  PROVIDER_DATA_ENCRYPTION_KEY_ID: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).default("primary"),
  // Comma-separated retired/previous read keys: key-id=0x<64 hex>.
  PROVIDER_DATA_ENCRYPTION_PREVIOUS_KEYS: z.string().default(""),

  // Max hours a pre-execute escalation may hold a PAID transaction (funds
  // captured, task parked in 'working') before the timeout worker auto-
  // refunds the buyer and fails the task. Gives operators a review window
  // without holding buyer funds indefinitely. Default: 72h.
  ESCALATION_MAX_HOLD_HOURS: z.coerce.number().int().min(1).max(168).default(72),

  // Push notification HTTP timeout in ms (per attempt).
  PUSH_NOTIFICATION_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(10_000),
  PUSH_NOTIFICATION_MAX_URL_CHARS: z.coerce.number().int().min(1).max(8_192).default(2_048),
  PUSH_NOTIFICATION_MAX_TOKEN_CHARS: z.coerce.number().int().min(1).max(4_096).default(512),
  PUSH_NOTIFICATION_MAX_AUTH_SCHEMES: z.coerce.number().int().min(0).max(16).default(4),
  PUSH_NOTIFICATION_MAX_PER_TASK: z.coerce.number().int().min(1).max(100).default(5),
  PUSH_NOTIFICATION_MAX_GLOBAL: z.coerce.number().int().min(1).max(1_000_000).default(10_000),
  PUSH_NOTIFICATION_DELIVERY_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),

  // SSRF guard for push-notification webhook URLs. Default is HTTPS-only;
  // flip to true for local-dev round-trips against a non-TLS gateway. The
  // private/loopback/link-local IP block runs in either mode — this knob
  // only gates the scheme.
  PUSH_NOTIFICATION_ALLOW_HTTP: strictBooleanEnv.default(false),

  // Per-IP token-bucket rate limits. `_CAPACITY` is the burst size;
  // `_PER_MIN` is the sustained rate. Service-owned routes have a separate
  // budget from /a2a/* and the standard rail.
  RATE_LIMIT_SERVICE_CAPACITY: z.coerce.number().default(30),
  RATE_LIMIT_SERVICE_PER_MIN: z.coerce.number().default(30),
  RATE_LIMIT_A2A_CAPACITY: z.coerce.number().default(120),
  RATE_LIMIT_A2A_PER_MIN: z.coerce.number().default(120),
  RATE_LIMIT_A2A_OPEN_CAPACITY: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_A2A_OPEN_PER_MIN: z.coerce.number().positive().default(30),
  RATE_LIMIT_GLOBAL_CAPACITY: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_GLOBAL_PER_MIN: z.coerce.number().positive().default(300),
  RATE_LIMIT_WEBHOOK_CAPACITY: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_WEBHOOK_PER_MIN: z.coerce.number().positive().default(60),
  RATE_LIMIT_HEALTH_CAPACITY: z.coerce.number().int().positive().default(120),
  // Comma-separated CIDR/IP allowlist that bypasses rate limits — set
  // to the gateway's egress IPs so server-to-server traffic from a
  // single source IP doesn't share a bucket with anonymous callers.
  // Empty (default) = no bypass.
  RATE_LIMIT_BYPASS_IPS: z.string().default(""),
  EDGE_RATE_LIMIT_VERIFIED: strictBooleanEnv.default(false),

  // Express proxy topology. Zero means forwarded headers are ignored.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(3).default(0),
  TRUST_PROXY_CIDRS: z.string().default(""),
  TRUSTED_REQUEST_COUNTRY_HEADER: z.string()
    .regex(/^(?:|[A-Za-z0-9!#$%&'*+.^_`|~-]+)$/)
    .default(""),
  HTTP_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(10_000).default(200),
  HTTP_MAX_CONCURRENCY_PER_IP: z.coerce.number().int().min(1).max(1_000).default(20),
  HTTP_HEADERS_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
  HTTP_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
  HTTP_KEEP_ALIVE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(5_000),
  A2A_MAX_BODY_BYTES: z.coerce.number().int().min(4_096).max(262_144).default(65_536),

  OUTBOUND_TOTAL_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(30_000),
  OUTBOUND_MAX_RESPONSE_BYTES: z.coerce.number().int().min(1_024).max(100_000_000).default(5_000_000),
  OUTBOUND_MAX_CONCURRENCY_PER_ORIGIN: z.coerce.number().int().min(1).max(1_000).default(16),
  OUTBOUND_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(100).default(5),
  OUTBOUND_CIRCUIT_OPEN_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
  HEALTH_READINESS_CACHE_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
  READINESS_CHAIN_MAX_AGE_SECONDS: z.coerce.number().int().min(10).max(3_600).default(180),
  REGISTRATION_RECONCILE_MAX_AGE_SECONDS: z.coerce.number().int().min(10).max(3_600).default(300),
  WORKER_HEARTBEAT_MAX_AGE_SECONDS: z.coerce.number().int().min(30).max(3_600).default(600),
  PROVIDER_WRITE_GAP_SECONDS: z.coerce.number().int().min(30).max(3_600).default(180),
  PROVIDER_WRITE_MAX_FEE_BUMPS: z.coerce.number().int().min(1).max(10).default(3),
  PROVIDER_WRITE_FEE_BUMP_PERCENT: z.coerce.number().int().min(10).max(100).default(15),
  PROVIDER_WRITE_MAX_FEE_GWEI: z.coerce.number().int().min(1).max(10_000).default(500),
  EMAIL_RETENTION_DAYS: z.coerce.number().int().min(1).max(3_650).default(90),
  EVENT_RETENTION_DAYS: z.coerce.number().int().min(30).max(3_650).default(365),
  OPERATOR_CHAT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3_650).default(90),
  DURABLE_JOB_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  ANONYMOUS_TASK_RETENTION_HOURS: z.coerce.number().int().min(1).max(168).default(24),

  // Provider-wide support contact, surfaced in every per-service AgentCard
  // under `support.email`. Per the Daski Communication Spec v1, this is the
  // canonical channel for buyer-initiated unstructured comms — refund
  // requests, complaints, status questions, replies to provider-sent email.
  // Required so deployments make an explicit ops choice.
  SUPPORT_EMAIL: z.string().email("SUPPORT_EMAIL must be a valid email"),
  // Free-text SLA shown to buyer agents in the AgentCard.
  SUPPORT_RESPONSE_SLA: z.string().default("1 business day"),
}).superRefine((env, ctx) => {
  // Two hardening tiers, deliberately distinct:
  //  - `production` (NODE_ENV) = deployment hygiene every long-lived deploy
  //    must satisfy, INCLUDING the testnet sandbox (which runs with
  //    NODE_ENV=production baked into the image).
  //  - `mainnet` (CHAIN_ID 8453) = real-money infrastructure requirements.
  //    The testnet sandbox cannot and should not satisfy these (it mocks
  //    suppliers by design), so gating them on NODE_ENV bricks sandbox boot.
  //    Mainnet implies NODE_ENV=production via the gate below, so mainnet
  //    checks are a strict superset.
  const mainnet = env.CHAIN_ID === BASE_MAINNET_CHAIN_ID;
  const production = env.NODE_ENV === "production";
  const reject = (path: keyof typeof env, message: string) => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  };

  if ((production || mainnet) && env.CHAIN_MODE === "mock") {
    reject("CHAIN_MODE", "mock chain mode is forbidden in production and on Base mainnet");
  }
  if (!env.GATEWAY_BASE_URL) {
    reject("GATEWAY_BASE_URL", "the standard rail requires the public gateway base URL");
  }
  if (env.CHAIN_MODE === "mock" && !isLoopbackUrl(env.BASE_URL)) {
    reject("BASE_URL", "mock chain mode requires a loopback BASE_URL");
  }
  if (env.CHAIN_MODE === "mock" && !env.MOCK_BUYER_WALLET_ADDRESS) {
    reject(
      "MOCK_BUYER_WALLET_ADDRESS",
      "mock chain mode requires the wallet authorized for the configured mock buyer",
    );
  }
  if (mainnet && !production) {
    reject("NODE_ENV", "Base mainnet is permitted only with NODE_ENV=production");
  }
  if (/^0x0{64}$/i.test(env.PROVIDER_DATA_ENCRYPTION_KEY)) {
    reject(
      "PROVIDER_DATA_ENCRYPTION_KEY",
      "every deployment requires a nonzero protected-data encryption key",
    );
  }
  if (
    env.PROVIDER_DATA_ENCRYPTION_KEY.toLowerCase()
    === env.PROVIDER_WALLET_PRIVATE_KEY.toLowerCase()
  ) {
    reject(
      "PROVIDER_DATA_ENCRYPTION_KEY",
      "protected-data encryption and provider signing keys must be distinct",
    );
  }
  if (production && new URL(env.BASE_URL).protocol !== "https:") {
    reject("BASE_URL", "production BASE_URL must use HTTPS");
  }
  if (production && env.DATABASE_SSL_MODE !== "verify-full") {
    reject("DATABASE_SSL_MODE", "production database connections must use verified TLS");
  }
  if (production && (
    !env.MIGRATION_DATABASE_URL
    || env.MIGRATION_DATABASE_URL === env.DATABASE_URL
  )) {
    reject(
      "MIGRATION_DATABASE_URL",
      "production requires a distinct privileged migration database role",
    );
  }
  if (mainnet && (env.TRUST_PROXY_HOPS < 1 || env.TRUST_PROXY_CIDRS.trim().length === 0)) {
    reject("TRUST_PROXY_CIDRS", "Base mainnet must declare the trusted reverse-proxy CIDRs");
  }
  if (production && hasOverbroadCidr(env.TRUST_PROXY_CIDRS)) {
    reject("TRUST_PROXY_CIDRS", "production proxy trust must use reviewed IPv4 /24 or IPv6 /64 (or narrower) ranges");
  }
  if (production && hasOverbroadCidr(env.RATE_LIMIT_BYPASS_IPS)) {
    reject("RATE_LIMIT_BYPASS_IPS", "production rate-limit bypasses must use explicit hosts or narrow reviewed CIDRs");
  }
  if (env.HTTP_MAX_CONCURRENCY_PER_IP > env.HTTP_MAX_CONCURRENCY) {
    reject(
      "HTTP_MAX_CONCURRENCY_PER_IP",
      "per-IP HTTP concurrency cannot exceed the global concurrency budget",
    );
  }
  if (env.HTTP_HEADERS_TIMEOUT_MS > env.HTTP_REQUEST_TIMEOUT_MS) {
    reject(
      "HTTP_HEADERS_TIMEOUT_MS",
      "HTTP header timeout cannot exceed the full request timeout",
    );
  }
  if (mainnet && !env.EDGE_RATE_LIMIT_VERIFIED) {
    reject("EDGE_RATE_LIMIT_VERIFIED", "Base mainnet requires verified edge-level request limiting");
  }
  if (production && !env.POSTMARK_INBOUND_WEBHOOK_SECRET) {
    reject("POSTMARK_INBOUND_WEBHOOK_SECRET", "production webhooks require a 32+ character secret");
  }
  if ((production || mainnet) && env.PUSH_NOTIFICATION_ALLOW_HTTP) {
    reject("PUSH_NOTIFICATION_ALLOW_HTTP", "HTTP push destinations are forbidden in production/mainnet");
  }
  // Testnet runs suppliers in mock/test mode by design (there is no money at
  // stake and, for some suppliers, no sandbox); only mainnet forbids them.
  // Supplier-specific mainnet gates (mock-mode refusal, evidence
  // attestations, screening seeds) live in each service's config module —
  // core stays supplier-agnostic.
  if (mainnet && env.POSTMARK_TEST_MODE === true) {
    reject("POSTMARK_TEST_MODE", "Postmark test mode is forbidden on Base mainnet");
  }
  if (
    mainnet
    && env.IDENTITY_REGISTRY_ADDRESS.toLowerCase()
      !== BASE_MAINNET_EXTERNAL_CONTRACTS.identityRegistry.toLowerCase()
  ) {
    reject(
      "IDENTITY_REGISTRY_ADDRESS",
      "Base mainnet requires the canonical ERC-8004 IdentityRegistry",
    );
  }
  if (
    mainnet
    && env.USDC_ADDRESS.toLowerCase()
      !== BASE_MAINNET_EXTERNAL_CONTRACTS.usdc.toLowerCase()
  ) {
    reject("USDC_ADDRESS", "Base mainnet requires Circle's canonical USDC contract");
  }

  const previousIds = new Set<string>();
  const previousMaterials = new Set<string>();
  const activeMaterial = env.PROVIDER_DATA_ENCRYPTION_KEY.toLowerCase();
  for (const entry of env.PROVIDER_DATA_ENCRYPTION_PREVIOUS_KEYS.split(",")) {
    if (!entry.trim()) continue;
    const match = /^([A-Za-z0-9._-]{1,64})=(0x[0-9a-fA-F]{64})$/.exec(entry.trim());
    if (!match) {
      reject("PROVIDER_DATA_ENCRYPTION_PREVIOUS_KEYS", "expected comma-separated key-id=0x<64 hex> entries");
      break;
    }
    if (match[1] === env.PROVIDER_DATA_ENCRYPTION_KEY_ID || previousIds.has(match[1])) {
      reject("PROVIDER_DATA_ENCRYPTION_PREVIOUS_KEYS", "key IDs must be unique and differ from the active key ID");
      break;
    }
    const material = match[2].toLowerCase();
    if (material === activeMaterial || previousMaterials.has(material)) {
      reject("PROVIDER_DATA_ENCRYPTION_PREVIOUS_KEYS", "encryption key material must not be reused under another key ID");
      break;
    }
    previousIds.add(match[1]);
    previousMaterials.add(material);
  }
});

export type Config = z.infer<typeof envSchema>;

export function parseConfig(env: NodeJS.ProcessEnv): Config {
  if (env.PAYMENT_RAIL !== undefined) {
    throw new Error("PAYMENT_RAIL is retired; the provider always uses standard Exact-EVM");
  }
  return envSchema.parse(env);
}

export const config: Config = parseConfig(process.env);
