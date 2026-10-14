# Architecture

The provider is one Express + TypeScript process with PostgreSQL-backed durable
state. Core implements the Daski provider protocol and security boundaries;
service modules implement the product being sold.

## Dependency direction

```text
src/bootstrap.ts
  └─ index.ts
       ├─ providerServices.ts ───────────> services/<slug>/
       ├─ providerScreening.ts
       └─ core/
            ↑
            └──────────── services consume core contracts
```

The allowed dependency direction is strict:

- `src/core` never imports `src/services`.
- A service never imports a sibling service.
- A service never imports a provider-specific screening/policy implementation.
- Provider extensions never import services.
- Only root composition files know which modules are installed.

This lets a provider copy or remove a service folder without leaving product
logic in the platform core.

## Repository layout

```text
src/
  core/                       protocol and service-neutral runtime
  services/
    dummy/                    compiled reference service
      docs/
      skills/
      tests/                  service-owned tests
  providerExtensions/
    <name>/                   optional provider policy/vendor implementation
  providerServices.ts         installed services
  registerGatewayServices.ts  registration, activation, and retirement CLI
  providerScreening.ts        optional policy extension composition
test/                         core and cross-service tests
docs/                         public provider integration guidance
scripts/                      build, registration, migration, and security tools
docs/agent-skill.md           link to the canonical cross-starter agent skill
```

`src/providerExtensions/` is intentionally absent until a provider needs a
private policy integration. Such an extension is wired only through the root
`providerScreening.ts` composition boundary; it cannot import services, and
services cannot import it.

## Service modules

A `ServiceModule` groups optional behavior by responsibility:

- `manifest` and `skills` define the public catalog.
- `fulfillment` supplies quote, execute, input, cancel, and optional
  pre-execution review.
- `protocol` supplies docs and optional HTTP/email hooks.
- `operations` supplies migrations, seed, workers, and readiness.
- `agents` supplies bounded email/operator tools.
- `security` supplies redaction, protected identifiers, and encryption
  rotation sinks.
- `assets` supplies asset identity, lookup states, and ownership policy.
- `screening` supplies service-owned subject extraction.
- `admin` supplies service-specific operator controls.

Registration validates the manifest, skill ids, documentation coverage,
screening scopes, and service readiness declarations, then upserts public
catalog rows.

## Boot sequence

The process fails before listening when a required trust boundary cannot be
proven. In broad order it:

1. parses core and imported service configuration;
2. connects to PostgreSQL and applies checksummed core/service migrations;
3. verifies runtime and migration database roles;
4. installs the optional provider screening extension;
5. registers each `ServiceModule` and its docs/catalog;
6. validates operator and email tool registries;
7. derives paid skills/actions from installed service contracts and loads the
   promoted runtime-listing catalog;
8. parses the signed global rail policy, servicing admission, and exact
   asset-action catalog;
9. verifies reviewed contracts, runtime commitments, identity, wallet, and
   catalog;
10. starts required workers and readiness monitors; and
11. starts the HTTP listener.

`/health/live` reports process life. `/health/ready` reports whether the
dependencies and workers required to serve admitted traffic remain healthy.

## Discovery and free A2A

Provider identity is published at `/.well-known/agent.json`. One A2A entry is
emitted for every active service. Per-service AgentCards publish taxonomy,
skills, pricing metadata, access class, lifecycle, legal links, and support
contact.

An open free request may use `/a2a/:serviceSlug` directly only when the skill
is free, does not require ownership, and satisfies the open-A2A boundary. It is
still validated, rate-limited, body-limited, and protected by provider
identity readiness.

Ephemeral task durability is allowed only for terminal, unpaid, open automated
reads that create no durable product state.

## Paid order path

A paid order crosses several independent bindings:

1. The provider quote validates service arguments and returns exact atomic
   USDC (the admitted listing price for fixed listings). It is persisted with
   the gateway's exact payer before it is signed and never starts work.
2. Daski binds the quote to the promoted runtime listing and payment recipe.
3. The buyer authorizes a standard Exact-EVM USDC transfer.
4. The facilitator verifies the payment and the gateway records finalized
   standard evidence.
5. The gateway signs a dispatch committing to the provider, service, skill,
   request, order, payer, audience, and deadline.
6. The provider verifies all bindings, including the persisted provider quote
   for both pricing modes and the deposit block's settlement time, and
   atomically claims replay state under a per-order lock with a final
   expiry fence. A funded order is an obligation: paused sales or full
   local capacity never refuse it, an exact replay returns the same task,
   and a different envelope never replaces it.
7. Core materializes the transaction and invokes the service adapter.
8. Results, artifacts, asset ownership, status, and terminal evidence are
   persisted. Every dispatch and status answer re-reads the task state and
   the persisted operations projection, stamps the database time and is
   signed for that request; no signed body is cached.
9. The provider writes a replay-safe terminal reputation outcome.

The adapter never receives authority to reinterpret payment evidence.

## Registration and runtime catalog

`npm run daski:register` is the only generic registration composition entry.
It derives the published service/skill contracts from installed modules,
ensures the provider identity and on-chain service, signs provider intent,
verifies gateway preparations and canonical splitter transactions, persists
every chain write before broadcast, waits for finality, submits evidence, and
cross-checks the gateway's runtime commitments. All skill versions for a
service promote atomically into an append-only catalog.

Unchanged listings remain on their original commitment; changed contracts
append a new version and supersede the old head. A listing the gateway reuses
is expected at the commitment its admission promoted, rebuilt with that
admission's provider intent; one that no longer reproduces its head, or a
free listing whose admission no head or signed envelope records, is refused
as identity drift. A refused cross-check names each disagreeing listing.
Safe retirement is a separate explicit command and fails while active tasks,
assets, jobs, supplier operations, or reviews remain.

Every run decides its next step from the local registration record and the
gateway's live view of the same registration
(`gatewayRegistration/recovery.ts`): promote a registration the gateway
activated, continue a pending one under its persisted intent, or sign a new
intent only when there is nothing to resume. A pending registration's
intent, preparation, splitter writes and accepted evidence are never
replaced; accepted evidence is replayed exactly, and only evidence the
gateway never accepted is re-signed over the original splitter
transactions. The `--check-only` forecast runs the same decision and
verification with read-only database sessions and gateway `GET` requests.

## Assets and wallet actions

Returning `AdapterResult.asset` provisions a new asset and links it to the
wallet-authorized payer. A service action on an existing asset declares how to
derive the canonical identifier and which statuses are eligible.

Owner-only reads and mutations use the standard wallet authorization plus an
independent gateway provider grant. The current servicing admission and signed
action catalog must contain the exact action definition.

A destructive action adds a delayed second authorization. Confirmation binds a
safe preview to the original request; cancel and confirm race through
conditional database transitions. A service must not create its own
authorization scheme.

## Supplier mutations and durability

Core supplies a generic supplier-operation journal, resource locks, durable
jobs, circuit breakers, and review flows.

Before a non-convergent external write, the service writes intent with a stable
logical key and request fingerprint. If the call outcome is ambiguous, the row
stays ambiguous. A later attempt reconciles authoritative supplier state and
records a definitive result before continuing. Blind retries are forbidden.

A paid task that may spend externally carries the supplier-cost ceiling its
quote admitted. Core binds it immutably at admission; the journal compares the
planned spend with it immediately before every mutation and refuses an
over-ceiling operation without calling the supplier.

Workers declare heartbeat ids and service invariants through
`operations.readiness`. Dead letters surface as human reviews rather than
silently stopping.

## Screening and human review

Screening is split deliberately:

- a service identifies the subjects and context that apply to its product;
- an optional provider extension owns policy, vendors, evidence, storage, and
  decisions; and
- core orchestrates the declared scopes without knowing either product or
  vendor.

If a service declares required scopes and no compatible extension is
installed, registration fails. Human-only and automated review paths persist
typed, auditable records; consequential operator actions require exact
confirmation.

## Protected data

Core provides versioned AES-256-GCM envelopes with purpose-derived keys and
record/field authenticated context. Services declare any additional protected
columns or JSON paths as rotation sinks. Sensitive asset identifiers can be
encrypted while retaining a keyed lookup hash.

Logs, events, public errors, prompts, and artifacts are separate disclosure
boundaries. Encryption at rest does not authorize disclosure at any of them.

## Database ownership

Core migrations live in `src/core/db/migrations`. Service migrations are
declared by that service and run after core migrations. Published migrations
are append-only and checksummed.

Financial, replay, lease, and lifecycle transitions are PostgreSQL-backed.
Process-local state may optimize but must never be the only source of truth for
money, authorization, ownership, or external mutations.

## Environments

The normal development/runtime target is Base Sepolia with current Daski
Testnet artifacts. The provider and gateway can run as local processes behind
public TLS origins while both verify Testnet contracts.

Mock chain mode is limited to provider-only testing. The gateway has no fake
local facilitator, so mock mode is not an end-to-end payment topology.

Base mainnet requires a separate coordinated release and fails closed while
the dummy service is installed. Provider admission is allowlisted; complete the
[Testnet onboarding checklist](onboarding.md) and ask for Mainnet whitelisting
through the official Daski Discord.

The hosting-neutral deployment contract and release evidence are described in
[getting started](getting-started.md) and [releasing](releasing.md).
