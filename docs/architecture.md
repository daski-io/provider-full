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
10. checks its compiled capability manifest and provider keys against every
    listing version and asset action the database still owes;
11. starts required workers and readiness monitors; and
12. starts the HTTP listener.

`/health/live` reports process life. `/health/ready` reports whether the
dependencies and workers required to serve admitted traffic remain healthy,
including whether this build serves every retained obligation. `/health`
names the build's embedded source digest and commit.

## Capabilities and compatibility

Each build describes itself without any external release coordinator: its
compiled capability manifest (`compatibility/capabilityManifest.ts`) lists
the executable contracts it runs, current and retained, the core migrations
it applies, the runtime epoch its sessions declare and the durable queues it
consumes, together with the source digest (and commit, when the image build
was given one) that `scripts/copy-assets.mjs` embeds in
`dist/build-identity.json`. Hosting metadata only supplements that identity.

The compatibility report (`compatibility/compatibilityReport.ts`) compares
the manifest and the deployment's provider keys with durable state alone. A
listing version needs its handler while it is sold, while it is unretired
with any provider quote (a quote may still be paid, even by more than one
order), or while it has pending orders, jobs, supplier operations, reviews
or lifecycle actions; it needs its signing key while any order of it can be
read. An open asset action needs its admitted definition and that
definition's handler. Boot runs the check, and the servicing monitor reruns
it when the catalog's activation revision moves or every ten minutes,
re-reading the heads each time (and once more on the poll after a move, as
the revision can move before its promotion commits) so new sales follow a
promotion without a restart; a gap fails readiness. A registration run
refuses to start while the registering build has a gap, and its
`--check-only` forecast prints the same verdict. `npm run
compatibility:check` (`node dist/checkCompatibility.js` in the image) prints
the full report from read-only database sessions and needs only the
database, the gateway origin and the provider keys.

Images built before a schema change cannot run that check, since they apply
only the migrations they know and ignore the rest. The database therefore
enforces the runtime epoch (core migration 011): every pool session declares
`daski.runtime_epoch` (`db/runtimeEpoch.ts`) before its first statement, and
every core table refuses insert, update, delete and truncate statements from
a session that declared none or one below `provider_minimum_runtime_epoch()`.
An earlier image left running after the migration therefore fails on its
first write, before it can register, admit, transition, claim a job, sweep
tasks or journal a supplier call; reads keep working and only the migration
ledgers stay writable. A build also refuses to finish migrating a schema
whose minimum epoch is above its own. A change that breaks this release's
runtimes raises both the database minimum and `RUNTIME_SCHEMA_EPOCH`; every
later migration that creates a table guards it with the same statement
trigger (core migration 014 guards the asset owner tables of 012 and 013).
`scripts/security/prior-runtime-compatibility.mjs` proves the upgrade and
overlap against the prior release's own compiled code.

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
7. Core materializes the transaction, records the dispatch deadline and the
   listing version's fulfillment duration with the claim (core migration
   010), creates the order's durable fulfillment job leased to the admitting
   request, and invokes the handler of the contract the order was admitted
   under. If that request dies before the order started, a
   `standard-paid-fulfillment` worker resumes it once the lease expires.
8. Results, artifacts, asset ownership, status, and terminal evidence are
   persisted. The first terminal transition freezes the order's terminal
   identity (state, completion time, the canonical unrevealed task
   projection, its hash, protected artifact references and provenance) in
   the same transaction (core migration 006). Every dispatch, status and
   lifecycle answer re-reads the task state, that frozen identity and the
   persisted operations projection, stamps the database time and is signed
   for that request; no signed body is cached.
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
Promoted versions are never changed or deleted (core migration 009).

Every write to the catalog advances a database sequence, the activation
revision. A running process compares it with the revision it validated and
re-checks its servicing compatibility when it moves.

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

## Retained listing versions

An order belongs to the listing version it was sold under, named by the
commitment hash it carries. New sales use the current heads; dispatch,
workers, lifecycle reads, support and legacy terminal evidence resolve the
order's own version from the catalog (`standardRail/listingVersions.ts`),
whatever the head is now. A timely-paid order of a superseded version is
therefore admitted with its original definition, price, splitter and
deadlines, even after a new contract version is promoted or sales are
paused.

Its handler is the one for the contract it was admitted under. A skill's
current contract runs on the service adapter; an earlier contract runs only
on the handler the skill declares in `previousContracts`, matched by an
executable definition hash over the input and result schemas, ownership,
asset action and fulfillment semantics (`serviceRegistry/executableContracts.ts`).
Pricing, capacity and deadlines are commercial terms core enforces from the
version's own committed values, so changing only those needs no retained
handler. A build without the handler or signing key of a version refuses
that version's dispatch before admission (`503 service_unavailable`) and
never runs the work on another contract's handler.

Every answer about an order is signed with the keys its checkout snapshot
names, the agent wallet the version was registered under. After a wallet
rotation, `PROVIDER_RETAINED_WALLET_PRIVATE_KEYS` keeps the earlier wallets'
keys for their orders; without it those orders get no signed answer at all
rather than one under another key. A first dispatch carries the provider
control profile its checkout snapshot committed, not the current one, while
its rail profile is always the gateway's current one and is compared with
the current global policy. A dispatch under an earlier control profile is
admitted only while `STANDARD_RAIL_RETAINED_CONTROL_PROFILE_HASHES` keeps it
(`standardRail/controlProfiles.ts`); every readiness quote records the
profile it was issued under (core migration 015), and the compatibility
check reports a `control_profile` gap for an unretired version whose quotes
name a profile the deployment no longer accepts. Asset actions keep the signed definition
they were admitted under: boot records every definition of the verified
catalog, so an execution accepted under one completes under it after the
catalog moves to a new epoch.

Retirement ends a paid version's dispatch and execution support, never the
reads of its orders, its frozen results or its key. It requires the
gateway's signed `GatewayContractRetirementV1` receipt for the exact version,
because an expired provider quote may already have been paid and still be
owed its first dispatch, and no open local execution obligation: pending
orders, unfinished jobs, unresolved supplier operations, reviews,
reputation writes, claimed lifecycle actions and unexpired quotes. The
obligations are counted only after the version rows are locked `FOR UPDATE`,
the same rows every new standard order and quote locks `FOR SHARE` in a
database trigger, so an admission either commits first and blocks the
retirement, or waits and is refused. Retiring a whole service needs a
receipt for every paid version it promoted.

## Assets and wallet actions

Returning `AdapterResult.asset` provisions a new asset and links it to the
wallet-authorized payer. A service action on an existing asset declares how to
derive the canonical identifier and which statuses are eligible.

Owner-only reads and mutations use the standard wallet authorization plus an
independent gateway provider grant. The current servicing admission and signed
action catalog must contain the exact action definition. A wallet action acts
only on an asset of the action's service and type that the grant-attested
payer currently owns, in a lifecycle state the service admits for the action
(`assets.assetLookupStatuses`, active only by default), and with the
identifier its input names when the service derives one.

A destructive action adds a delayed second authorization. Confirmation binds a
safe preview to the original request; a follow-up acts only on the staged row
of the asset its request names; cancel and confirm race through conditional
database transitions. A service must not create its own authorization scheme.

### One owner authority

`src/core/db/queries/assetOwnership.ts` is the only owner resolver: an
`asset_owner_overrides` row when one committed (core migration 012), otherwise
the payer of the most recent standard order linked to the asset, at version
0. Wallet listings and actions, owner-only paid orders and services all read
it, and the architecture gate refuses any other derivation of an owner from
`transactions.standard_payer`. A request body, an order id, an execution's
`payer` or any other cached owner field is never a second source of
ownership.

### Asset owner fence

Every transition that starts or resumes owner-only work takes
`pg_advisory_xact_lock(hashtextextended('asset-owner:' || asset_id, 0))` and
records the owner it admitted, with its version: an asset-action claim or
staging, a destructive confirmation, the resumption of an action after review,
the dispatch link of an owner-only paid order and its resumption after buyer
input or a review, and a delivery admission. Only the executor that holds an
unstarted order's live fulfillment-job lease links it, so an executor that
lost the order never moves the owner a started call was admitted under. The
lock order is fixed: a request's own advisory lock and endpoint rate
buckets, then the fence, then the execution row, then its transaction; the
expiry sweep purges spent nonces and rate buckets apart from the transaction
that holds execution rows. These transactions run read committed, so a read
after the fence sees what committed before it was granted. A fence holder
uses only its own connection and never waits on a network call.

The admitted owner is compared with the current one at three boundaries:

- consequential execution: a short fenced check immediately before the
  supplier call, which also re-checks that the asset is still an eligible
  target (an ineligible asset fails the action with `asset_unavailable`
  without supplier work);
- result persistence: an asset action settles its task's result and its
  execution in one fenced transaction (`settleAssetAction`), and
  `processAdapterResult` guards owner-only paid orders and later service
  results. Neither persists a deliverable for a stale owner: the work ends
  failed with the redacted `asset_owner_changed` outcome, its protected
  artifact fields are purged, and an `asset_owner.result_withheld` audit row
  is written, all in the same transaction;
- result release: a replay, a destructive follow-up replay or a recovery is
  refused for a stale owner before any nonce is consumed, and every signed
  final asset-action response (fresh, replayed, recovered or regenerated) is
  signed inside the fence transaction that compared the version, so no owner
  change commits between the check and the signature. A stale owner gets
  `403` with nothing loaded or signed.

### Asset delivery admissions

Core delivers no asset information itself: its email paths answer inbound
mail and deliver no asset record or protected data. A service that emails an
owner, releases a protected document or sends a notice about an asset uses
`deliverAssetInformation` (`src/core/standardRail/assetDeliveryAdmission.ts`,
core migration 013):

1. the delivery is admitted in a short transaction under the asset owner
   fence for the owner it addresses, recording that owner's version; any
   recipient resolution runs in the same transaction through the fenced
   connection;
2. the send runs outside every lock;
3. `sendEmail`'s `beforeSend` hook renews the admission under the fence
   immediately before the bounded outbound call. A revoked or finished
   admission, or a changed owner or version, is an explicit refusal
   (`OutboundSendRefusedError`): the journaled email is recorded
   `send_skipped` and never resent. Any other failure of the check is
   infrastructure: nothing was sent, the email is recorded `send_retryable`
   with its request fingerprint and a cooldown, and the same logical send is
   validated again when it is retried; changed content is refused for
   review;
4. the admission is closed with the attempt's outcome.

An unknown Postmark outcome stays `outcome_unknown` and is never resent
automatically, unlike a refusal or a retryable check. No lock holder needs a
second pooled connection and no lock is held across the outbound call. An
open admission counts as live work for an owner change for ten minutes after
its last renewal, far longer than the bounded outbound call that follows a
renewal.

Admissions are lock bookkeeping, not evidence. The retention worker removes
one that finished, or was revoked, more than `DURABLE_JOB_RETENTION_DAYS`
ago and is far outside that live window. It never removes an admission left
open (its send never resolved), nor one whose asset still has a nonterminal
asset action or owner-only order, or is under a legal hold.

### Owner changes

The starter ships no path that changes an owner, and the architecture gate
refuses writes to `asset_owner_overrides`. A fork that adds one must not
bypass these guards: in one transaction under the asset fence (and any
compliance lease the deployment uses) it re-checks the expected owner and
version, refuses while owner-only work is active (an execution in `claimed`,
`executing` or `attention`; an owner-only paid order that is not terminal; an
open review or an unresolved supplier operation for the asset; a live
delivery admission), writes the next version, cancels staged destructive
actions, revokes open delivery admissions and audits the change. Telling the
gateway, notifying both owners and handing the asset over are part of the
same reviewed design, not an afterthought.

## Supplier mutations and durability

Core supplies a generic supplier-operation journal, resource locks, durable
jobs, circuit breakers, and review flows.

Before a non-convergent external write, the service writes intent with a stable
logical key and request fingerprint. If the call outcome is ambiguous, the row
stays ambiguous. A later attempt reconciles authoritative supplier state and
records a definitive result before continuing. Blind retries are forbidden.

A paid task that may spend externally carries the supplier-cost ceiling its
quote admitted, bound immutably at admission. When the service declares the
planned spend (`runSupplierOperation({ spend })`), the journal compares it
with that ceiling immediately before the mutation and refuses an
over-ceiling operation without calling the supplier.

Every admitted paid order owns one durable `standard-paid-fulfillment` job,
created in the admission transaction and leased to the admitting request.
Exactly one executor wins the order's start fence (`submitted` to
`working`, `standardRail/orderStart.ts`), and only while it holds the job's
live lease and no buyer cancellation holds the order, so the service's
`execute` runs at most once per order. Every decision taken before the call
(a pre-execute rejection or escalation, a definite pre-start failure such
as a stale or foreign asset owner, the admitted deadline passing) wins the
same fence first, an escalation inside its own transaction, so an executor
that lost the race or its lease never ends or escalates an order another
one started. A fault before the call that decides nothing leaves the order
resumable (`standardRail/faultClassification.ts`): a database or connection
failure (the database client's own query timeout included), an asset owner
check that reached no decision, and a transient, ambiguous or provider-side
condition, timeout or outbound-boundary refusal met by the asset lookup, a
service hook or the pre-execute consult. Only a definite refusal, such as a
supplier's explicit rejection or a missing asset, fails it as never started,
and the job's worker resumes it on any replica whose build can run the
order's contract (a job names the executable definition it needs), waiting
while the service declares an outage or a lifecycle action holds the order.
A started call whose answer was never persisted is never repeated: the
order is parked for reconciliation. Three clocks stay separate: the
dispatch deadline bounds only when a new claim may commit, the job lease
and task watchdog watch worker progress, and the admitted fulfillment
duration, counted from durable acceptance, marks work overdue. Only an
order that never started fails at that deadline, as never started;
accepted, started or ambiguous work stays nonterminal so a late result is
still delivered.

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
are append-only and checksummed. Core tables carry the runtime epoch barrier
described under [Capabilities and compatibility](#capabilities-and-compatibility).

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
