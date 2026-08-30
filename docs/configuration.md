# Configuration

`.env.example` is the Testnet-first configuration worksheet. Copy it to
`.env` for local development, keep `.env` untracked, and inject the same names
from a secret manager in deployed environments.

This guide covers every variable in the template. Less common tuning values
and their validated defaults live next to the schema in `src/core/config.ts`.
Service-specific variables belong in `src/services/<slug>/config.ts` and
should be documented with that service.

## Loading and precedence

`npm run dev`, `npm start`, and `npm run doctor` load `.env` when it exists
using Node's native environment-file support. Values already supplied by the
process environment take precedence. Container platforms should inject values
at runtime rather than copy `.env` into an image.

Doctor reports whether a required name came from `.env`, the process
environment, or is missing. It never prints secret values.

## Stage posture

| Stage | `NODE_ENV` | `CHAIN_ID` | `CHAIN_MODE` | `STANDARD_RAIL_ENVIRONMENT` |
| --- | --- | --- | --- | --- |
| Local provider tests | `development` or `test` | `84532` | `mock` or `live` | `testnet` when artifacts are loaded |
| Testnet deployment | normally `production` | `84532` | `live` | `testnet` |
| Mainnet deployment | `production` | `8453` | `live` | `mainnet` |

Production means long-lived deployment hygiene, even on Testnet. Mainnet adds
separate fail-closed contract, proxy, edge, supplier, custody, and governance
requirements.

## Runtime and public origins

| Variable | Purpose and rules |
| --- | --- |
| `NODE_ENV` | `development`, `test`, or `production`. Mainnet requires `production`. |
| `PORT` | HTTP listen port; defaults to 4000. The container exposes the platform-supplied port. |
| `DEPLOYMENT_REVISION` | Optional public commit, tag, or build id shown in health output; maximum 128 characters. |
| `BASE_URL` | Stable public origin of this provider. Production and signed audiences require credential-free HTTPS. Mock mode requires loopback. |
| `GATEWAY_BASE_URL` | Public Daski gateway origin used by standard-rail/admin enrichment. It must agree with the signed gateway origin. |
| `CHAIN_MODE` | `live` for Testnet/Mainnet. `mock` is loopback-only provider testing and never a paid gateway topology. |

Do not silently change a public origin after signed artifacts or ERC-8004
registration are issued. Audience and service URI changes require coordinated
revalidation.

## Provider identity and legal metadata

| Variable | Purpose and rules |
| --- | --- |
| `PROVIDER_NAME` | Public legal or trading name shown in provider discovery. Required. |
| `PROVIDER_DESCRIPTION` | Optional concise public provider description. |
| `PROVIDER_WEBSITE_URL` | Optional organization website, distinct from the provider API origin. |
| `PROVIDER_ICON_URL` | Optional public square icon URL hosted by the provider or its reviewed CDN. |
| `MARKETPLACE_TERMS_URL` | Daski marketplace terms supplied/confirmed during onboarding; HTTPS. |
| `MARKETPLACE_PRIVACY_URL` | Daski marketplace privacy notice supplied/confirmed during onboarding; HTTPS. |
| `PROVIDER_TERMS_URL` | Provider's own public terms; HTTPS. |
| `PROVIDER_PRIVACY_URL` | Provider's own public privacy notice; HTTPS. |
| `SUPPORT_EMAIL` | Public support address included in every AgentCard. |
| `SUPPORT_RESPONSE_SLA` | Public free-text response target; defaults to one business day. |

Marketplace and provider legal URLs are separate because a purchase can be
subject to both sets. Keep them stable, public, and consistent with the
service's actual handling of data and fulfillment.

## PostgreSQL

| Variable | Purpose and rules |
| --- | --- |
| `DATABASE_URL` | Long-lived runtime database principal. Local Compose uses `postgresql://daski_provider:local-only-provider-password@127.0.0.1:55432/daski_provider`. |
| `MIGRATION_DATABASE_URL` | Separate schema-owner principal. Required in production and must differ from `DATABASE_URL`. |
| `DATABASE_SSL_MODE` | `disable`, `require`, or `verify-full`. Production requires `verify-full`; local loopback Compose uses `disable`. |
| `DATABASE_CA_CERT` | Optional PEM CA material for verified database TLS. Literal `\\n` sequences are expanded. |

Production runtime roles must not own or create schema objects. Migrations use
the distinct privileged role, then runtime privileges are reduced and checked.
Never use a production or shared Testnet URL with disposable migration/security
smoke scripts.

## Base and ERC-8004 coordinates

| Variable | Purpose and rules |
| --- | --- |
| `CHAIN_ID` | `84532` for Base Sepolia or `8453` for Base Mainnet. |
| `BASE_RPC_URL` | Primary credential-free HTTPS Base RPC endpoint. |
| `BASE_RPC_FALLBACK_URLS` | Optional comma-separated ordered RPC fallbacks. Keep them reviewed and credential-free. |
| `IDENTITY_REGISTRY_ADDRESS` | ERC-8004 IdentityRegistry for the selected chain. Mainnet must use the canonical reviewed address. |
| `SERVICE_REGISTRY_ADDRESS` | Daski service registry coordinated for the selected environment. |
| `PROVIDER_REGISTRY_ADDRESS` | Provider registry used by the registration helper. |
| `AGENT_INDEX_ADDRESS` | Daski provider index used by the registration helper. |
| `USDC_ADDRESS` | Canonical USDC for the selected chain. Mainnet must use Circle's reviewed canonical contract. |
| `CHAIN_WRITE_FINALITY_CONFIRMATIONS` | Confirmation target for persisted provider chain writes. |

Contract addresses are public bindings, not secrets. Verify them against the
current onboarding manifest; do not copy a mixture of Testnet and Mainnet
coordinates.

## Provider wallet and registration

| Variable | Purpose and rules |
| --- | --- |
| `PROVIDER_AGENT_ID` | Unsigned decimal ERC-8004 agent id minted/bound for this provider. One provider identity can publish several services. |
| `PROVIDER_WALLET_PRIVATE_KEY` | Dedicated 32-byte EVM signing key, `0x` plus 64 hexadecimal characters. Secret. |

Use separate wallets for Testnet and Mainnet. The provider continuously verifies
that the registry's wallet binding matches the configured signing key.
Registration is a chain mutation and is never performed by doctor or boot
merely to fix configuration.

After deployment and explicit operator review, `npm run daski:register --
--gateway <origin>` owns provider identity reconciliation, service
registration, splitter activation, and runtime-catalog promotion. It may sign
artifacts and send transactions. `--service <slug>` narrows the run;
`--retire 0x<SERVICE_ID>` is a separate guarded retirement operation.

## Standard Exact-EVM rail

These values are issued or reviewed as one environment-specific set. Missing,
extra, expired, differently signed, or inconsistent values fail closed.

| Variable | Purpose and rules |
| --- | --- |
| `STANDARD_RAIL_ENVIRONMENT` | Signed domain environment, normally `testnet` or `mainnet`. |
| `STANDARD_RAIL_GATEWAY_SIGNER` | Gateway protocol signer admitted for quotes, dispatch, lifecycle, and release artifacts. |
| `STANDARD_RAIL_GATEWAY_AUDIENCE` | Audience committed by signed release envelopes. |
| `STANDARD_RAIL_GATEWAY_ORIGIN` | Credential-free HTTPS origin used for gateway wallet endpoints; must match `GATEWAY_BASE_URL`. |
| `STANDARD_RAIL_PROVIDER_AUDIENCE` | Provider audience; must match the `BASE_URL` origin. |
| `REPUTATION_STORAGE_ADDRESS` | Standard reputation outcome contract. |
| `EAS_ADDRESS` | EAS contract used by the reviewed evidence profile. |
| `EAS_RUNTIME_CODE_HASH` | Non-zero reviewed EAS runtime code hash. |
| `EAS_OUTCOME_SCHEMA_UID` | Reviewed bytes32 outcome schema uid. |
| `SANCTIONS_ORACLE_ADDRESS` | Standard-rail sanctions oracle coordinate. Service/provider screening remains a separate product policy. |
| `STANDARD_RAIL_PROVIDER_CONTROL_PROFILE_HASH` | Provider control profile committed by runtime listings and servicing artifacts. |
| `STANDARD_RAIL_GLOBAL_POLICY_JSON` | Daski-issued JSON containing signed chain-evidence, active-rail, and capability envelopes plus reviewed global code hashes. Preserve exactly. |
| `STANDARD_RAIL_SERVICING_ADMISSION_JSON` | Signed servicing admission envelope for owner actions. Do not edit or self-sign. |
| `STANDARD_RAIL_ASSET_ACTION_CATALOG_JSON` | Signed exact action catalog. Action ids, destructiveness, replay policy, schemas, and validity must match code. |
| `STANDARD_RAIL_FINALITY_CONFIRMATIONS` | Standard evidence confirmation requirement; must be positive and agree with the release profile. |

Paid skills and asset-action definitions derive from installed service
contracts. Registration must promote a gateway-verified runtime listing for
each paid skill; boot warns on an unlisted installed skill and rejects foreign
or inconsistent heads. The signed action catalog must exactly equal installed
action definitions. A provider cannot locally grant itself a listing or action
by changing configuration.

## Application secrets and protected data

| Variable | Purpose and rules |
| --- | --- |
| `ADMIN_TOKEN` | Separate high-entropy secret (minimum 32 characters) for JSON admin routes. Documented placeholders and low-diversity strings are rejected. |
| `PROVIDER_DATA_ENCRYPTION_KEY` | Independent non-zero 32-byte key for protected provider data. It must never equal the wallet key. |
| `PROVIDER_DATA_ENCRYPTION_KEY_ID` | Stable id for the active encryption key; 1-64 safe characters. |
| `PROVIDER_DATA_ENCRYPTION_PREVIOUS_KEYS` | Optional comma-separated `key-id=0x<64 hex>` read keys during controlled rotation. IDs and material must be unique. |

Generate independent values with a cryptographically secure tool, such as
`openssl rand -hex 32`, and store them in a secret manager. Do not paste them
into issues, chat, logs, screenshots, artifacts, tests, or documentation.

## Optional model features

| Variable | Purpose and rules |
| --- | --- |
| `OPENAI_API_KEY` | Optional until a service enables pre-execution review or the operator/email agents are used. Secret. |
| `LLM_MODEL` | Default model for enabled model-backed features. |
| `EMAIL_AGENT_LLM_MODEL` | Optional email-agent override; otherwise uses `LLM_MODEL`. |
| `OPERATOR_AGENT_LLM_MODEL` | Optional operator-agent override; otherwise uses `LLM_MODEL`. |

The dummy service does not require an API key. Model review is advisory policy,
not input validation, payment authorization, or a substitute for deterministic
rules.

## Admin and browser access

| Variable | Purpose and rules |
| --- | --- |
| `ADMIN_WALLET_ALLOWLIST` | Optional comma-separated wallet allowlist for SIWE browser admin access. Empty disables that login path. |
| `CORS_ORIGINS` | Optional comma-separated browser origins. Server-to-server calls without an `Origin` header do not use this allowlist. |

Keep admin authority separate from buyer and supplier credentials. Browser
writes also require exact-origin, session, CSRF, confirmation, and audit
controls.

## Optional Postmark email

| Variable | Purpose and rules |
| --- | --- |
| `POSTMARK_SERVER_TOKEN` | Enables configured inbound/outbound Postmark integration. Secret. |
| `POSTMARK_TEST_MODE` | Strict boolean. Testnet can use Postmark's test mode; Mainnet cannot. |
| `POSTMARK_INBOUND_WEBHOOK_SECRET` | Minimum 32-character webhook secret. Required in production even if normal use does not depend on inbound email. |
| `POSTMARK_INBOUND_WEBHOOK_SECRET_PREVIOUS` | Optional previous secret during a bounded rotation window. |

Webhook credentials in query strings are rejected. Use provider-supported
authentication or a reviewed signing proxy as described in the security model.

## Safety and operations controls

| Variable | Purpose and rules |
| --- | --- |
| `SUPPLIER_BREAKER_WINDOW_MINUTES` | Rolling supplier circuit-breaker window. |
| `SUPPLIER_BREAKER_THRESHOLD` | Failures admitted before the supplier circuit opens. |
| `ESCALATION_MAX_HOLD_HOURS` | Maximum paid-task hold for pre-execution review before terminal handling. |
| `RATE_LIMIT_SERVICE_CAPACITY` | Per-IP service-route burst capacity. |
| `RATE_LIMIT_SERVICE_PER_MIN` | Per-IP sustained service-route rate. |
| `RATE_LIMIT_A2A_CAPACITY` | Per-IP A2A burst capacity. |
| `RATE_LIMIT_A2A_PER_MIN` | Per-IP sustained A2A rate. |
| `RATE_LIMIT_BYPASS_IPS` | Optional reviewed gateway hosts/narrow CIDRs. Production rejects overbroad ranges. |
| `TRUST_PROXY_HOPS` | Exact trusted reverse-proxy hop count, zero when none. Mainnet requires a reviewed proxy topology. |
| `TRUST_PROXY_CIDRS` | Trusted proxy addresses/narrow CIDRs. Mainnet requires them; production rejects overbroad ranges. |
| `EDGE_RATE_LIMIT_VERIFIED` | Strict boolean evidence that production edge limiting is configured. Required on Mainnet. |
| `PUSH_NOTIFICATION_ALLOW_HTTP` | Local-only escape hatch for HTTP destinations; forbidden in production and Mainnet. |

Do not raise limits or broaden proxy/bypass ranges merely to clear readiness.
Document the real ingress topology and verify the edge behavior.

## Bounded mock mode

| Variable | Purpose and rules |
| --- | --- |
| `MOCK_BUYER_AGENT_ID` | Explicit local mock buyer agent id; defaults to 99. |
| `MOCK_BUYER_WALLET_ADDRESS` | Wallet authorized for the configured mock buyer. Required in mock mode. |

Mock mode also requires a loopback `BASE_URL`. It does not remove signed
standard-rail artifact requirements and cannot replace a Testnet gateway paid
purchase.

## Service-specific configuration

Add product variables after the template and parse them strictly in the
service that owns them. Recommended rules:

- credentials are required only when the service is installed;
- base endpoints are fixed or selected from a closed reviewed set;
- booleans use strict parsing;
- Testnet prefers a supplier sandbox or explicit fake;
- a chargeable Testnet account uses an explicit non-live mode plus durable
  payer, operation-count, and aggregate-spend campaign limits;
- Mainnet refuses mock, sandbox, and charged-test modes and asserts live
  readiness;
- values never appear in public manifests, docs, errors, logs, prompts, or
  test fixtures; and
- an invalid service configuration fails before traffic is accepted.

Use [Integrating an existing product](integrating-existing-product.md) for API,
MCP, and chargeable-Testnet configuration boundaries.

## Validate without disclosing values

```bash
npm run doctor
npm run doctor -- --stage=testnet
npm run doctor -- --stage=mainnet
npm run --silent doctor -- --stage=testnet --json
```

Share the stable check codes and missing variable names when asking for help.
Never share `.env` or the raw JSON output of a provider/supplier system unless
it has been deliberately redacted and approved for that channel.
