# AGENTS.md — Daski provider-full starter guide

This is the canonical repository guide for coding agents and contributors.
Read it before changing code. Keep durable project knowledge in tracked
documentation, not chat history or harness-specific files.

## Repository purpose

This is the full-featured generic Express + TypeScript starter for offering
services through Daski. It receives discovery, quote, signed dispatch,
lifecycle, wallet-action, and evidence calls over the standard Exact-EVM rail.

Use this repository for dynamic quotes, durable jobs, later input/cancellation,
assets/actions, human review, email/admin, direct A2A, protected-data workflows,
or multi-replica recovery. When every operation is fixed-price, automated,
one-shot, and terminal within 50 seconds, prefer the smaller
`https://github.com/daski-io/provider` starter.

The repositories are alternatives. The Daski Provider integration skill for
coding agents is maintained only in `daski-io/provider`; after selecting this
full starter, this file and this repository's docs are authoritative.

The only marketplace service is `src/services/dummy`, a reference with free
`echo` and paid `create-note` skills. It has no supplier/private policy and is
forbidden on Base Mainnet. A provider fork replaces it with its product.

Do not reintroduce retired payment routers, alternate native payment paths, or
provider-specific code from another repository.

## Architecture boundary

- `src/core/` owns protocol, identity, payment/evidence verification,
  persistence, jobs, security, admin, email, and service-neutral contracts.
- `src/services/<slug>/` owns one service's manifest, skills, adapter,
  validation, configuration, migrations, docs, workers, supplier integration,
  protected-data declarations, admin extensions, and tests.
- `src/providerServices.ts` is the single installed-service composition.
- Paid skills and asset actions are derived from installed service contracts.
- `src/registerGatewayServices.ts` owns reviewed gateway registration,
  activation, catalog promotion, and safe retirement.
- `src/providerScreening.ts` is the optional provider-policy composition.

Core must never import from services. Services must never import sibling
services or provider-specific extensions. Keep provider-policy implementations
independent of individual services. ESLint and the architecture gate enforce
these directions.

Service-owned tests belong in `src/services/<slug>/tests/`. `test/` contains
only core and cross-service tests.

## Commands

```bash
npm run dev:db:up
npm run doctor -- --stage=testnet
npm run daski:register -- --gateway <reviewed-testnet-origin>
npm run try-skill -- dummy echo
npm run docs:check
npm run dev
npm run typecheck
npm run typecheck:test
npm run lint
npm run lint:architecture
npm run test:run
npm run test:coverage
npm run test:critical-coverage
npm run test:mainnet-readiness
npm run build
npm start
```

Node 24 and PostgreSQL 16 are required. Compose starts a loopback-only
development database; `npm run dev:db:stop` preserves its named volume.
`doctor` is read-only and redacted. Unit tests need no live database, RPC, or
supplier. PostgreSQL security/migration scripts require an explicit disposable
database.
`daski:register` can sign, write to chain, and mutate gateway/catalog state;
listing it here is not authorization to run it.

## Change workflow

1. Inspect the closest types, implementation, docs, and tests before editing.
2. Make the smallest cohesive change.
3. Update manifest/docs, runtime, validation, migrations, and tests together
   when a contract changes.
4. Keep service behavior inside its service folder.
5. Run targeted tests, then the full relevant gates.
6. Scan the diff for credentials, customer data, supplier account data,
   private policy, raw runtime output, and provider-specific leakage.
7. Never weaken a fail-closed check merely to make a fixture/deployment pass.

Keep files near 250 lines when practical. Split by responsibility before
adding another large branch to an already-large module.

## Implementation invariants

- Quote validates buyer data before payment; execute revalidates it.
- Financial/lifecycle state uses conditional writes, locks, leases,
  idempotency keys, and fencing. Never use process-local money/task guards.
- Journal intent before a non-convergent external mutation. Reconcile
  authoritative supplier state after ambiguity; never guess or blindly retry.
- Persist signed chain writes before broadcast and reconcile after restart.
- Ownership comes from the wallet-authorized payer. Order ids, asset ids, and
  caller metadata are not credentials.
- Consequential asset mutations require an admitted standard action.
  Destructive actions also require delayed second authorization and adversarial
  mismatch/replay tests. Do not invent a service-local signature scheme.
- Applied migrations are immutable, append-only, and checksummed. Core
  migrations live under `src/core/db/migrations`; service migrations stay with
  their service.
- Use the centralized logger. Never log protected payloads or include
  supplier-controlled details in public errors.
- Direct supplier HTTP uses the reviewed outbound boundary with pinned
  endpoints, bounded requests/responses, and SSRF protection.
- Declare workers and live supplier invariants through service readiness so
  `/health/ready` fails closed.
- Treat published skill contracts, prices, and action definitions as
  coordinated Daski release changes. Registration must produce matching
  gateway preparations and runtime commitments; never edit catalog rows.

## Configuration and environments

`.env.example` is Testnet-first. A full boot needs Daski-issued signed
standard-rail artifacts and valid contract/signer bindings; placeholders are
expected to fail.

The upstream starter is hosting-neutral. Its Dockerfile is the canonical
production artifact; forks may add deployment descriptors. Use
`/health/ready` for traffic activation and keep required workers available.

Service variables belong in `src/services/<slug>/config.ts` and are parsed
strictly. Keep credentials out of manifests, docs, errors, and tests. Testnet
uses supplier sandboxes/fakes; Mainnet services must refuse them and enforce
live readiness evidence. Dummy must never boot on Base Mainnet.

## Public surfaces

- `/health/live`, `/health/ready`
- `/.well-known/agent.json`, `/.well-known/agent-registration.json`
- `/agent-cards/<slug>.json`, `/skills/*`, `/llms.txt`
- `/standard-rail/*`
- `/a2a/:serviceSlug`
- `/admin/ui/*`, `/admin/*`
- `/webhooks/postmark/*`

## Documentation

Start at `README.md`, then use:

- `docs/getting-started.md`
- `docs/integrating-existing-product.md`
- `docs/adding-a-service.md`
- `docs/configuration.md`
- `docs/onboarding.md`
- `docs/troubleshooting.md`
- `docs/architecture.md`
- `docs/daski-skill-creation-best-practices.md`
- `docs/protocol-cheatsheet.md`
- `docs/service-taxonomy.md`
- `docs/standard-rail-evidence-v2.md`
- `docs/agent-skill.md`
- `docs/releasing.md`
- `SECURITY.md`

The portable agent entrypoint is published by
`https://github.com/daski-io/provider/tree/develop/.agents/skills/daski-provider`.
`docs/agent-skill.md` explains the single-copy policy. Do not leave the only
copy of a durable decision in a harness directory or assistant memory.

## Git policy

Work lands on `develop` or a branch merged into `develop`. Do not push `main`
without explicit authorization in the current session. Never add AI-tool
attribution or co-author trailers to commits, pull requests, tags, or release
notes.
