# Changelog

All notable changes to this project will be documented here.

## Unreleased

### Added

- [Wrapping a product that returns a job id](docs/existing-async-products.md):
  a journaled, reconcilable submission, a durable lease-based poll worker,
  readiness and wait supervision, the pending, overdue and failed
  distinction, and the tests such a service keeps, using the runtime's
  existing jobs and supplier journal; polling-only fixed-price products are
  pointed to the smaller starter's external-job mode.
- `npm run compatibility:check` (`node dist/checkCompatibility.js` in the
  image), a read-only report comparing the build's compiled capability
  manifest and provider keys with every listing version and asset action the
  database still owes; it needs only the database, the gateway origin and the
  provider keys.
- Generic Daski provider starter based on the production provider architecture.
- Dummy reference service with free and paid paths, asset provisioning, docs,
  and co-located tests.
- Testnet-first onboarding, local integration, service-authoring, and AI-agent
  guidance.
- Genericity and composition gates that prevent known provider-specific
  services, suppliers, brands, and policies from entering the starter.
- Human-first onboarding guides for existing API and MCP products, including
  Testnet evidence, Mainnet allowlisting, configuration, and troubleshooting.
- A loopback-only PostgreSQL 16 Compose service and a read-only, redacted
  `doctor` for local, Testnet, and Mainnet readiness diagnostics.
- Coding-agent guidance that links the single canonical Daski provider skill,
  published and versioned only by `daski-io/provider`
  (`.agents/skills/daski-provider/`), with its install and refresh command;
  this repository keeps no copy of it.
- Documentation and release-package validation gates.
- `npm run daski:register -- --check-only`, a read-only registration
  forecast with read-only database sessions and gateway `GET` requests only.
- `npm run security:prior-runtime`, run in CI, builds the prior release from
  its own commit and proves on a synthetic previous-version database that
  this build migrates it, passes its compatibility check, keeps terminal
  rows, resumes a never-started order without repeating a started one, and
  that the prior image can no longer write once the schema has moved.

### Changed

- Processes built for an older schema can no longer write (core migration
  011): every session declares this build's runtime epoch when it connects,
  and every core table, the asset owner tables of core migrations 012 and
  013 included (core migration 014), refuses insert, update, delete and
  truncate statements from a session below the schema's minimum. An earlier
  image left running after the upgrade fails before it registers, admits,
  claims a job or sweeps tasks, and a build refuses to start on a schema
  whose minimum epoch is above its own. Manual maintenance SQL must declare
  the epoch, and transaction-mode connection pooling is not supported.
- Each build embeds its source digest (and the commit given in the
  `SOURCE_COMMIT` build argument) in `dist/build-identity.json`; `/health`
  names it instead of depending on a hosting platform's commit variable, and
  its capability manifest describes the same artifact. Boot, a registration
  run and its forecast check that manifest and the provider keys against
  durable obligations, requiring a version's handler while it is unretired
  with any provider quote; a servicing monitor rechecks when the catalog's
  activation revision moves and every ten minutes, refreshes the sold heads
  without a restart (again on the poll after a move), and fails readiness on
  any gap.
- The task watchdog no longer uses the boot catalog's 300-second dispatch
  deadline as a stall threshold, nor sets `standard_reconciliation_required`
  on stalls. It reads persisted per-order state for orders of any listing
  version: a never-started order is a stall after 10 minutes and a `working`
  task after 15 minutes without progress, unless a healthy service poller
  durably claims it through the new `operations.waitSupervision` hook. Stall
  incidents resolve on progress, completion or supervision (dropping a stall
  flag no ambiguous supplier outcome raised) and reopen on a new stall. Work
  past its admitted fulfillment duration is marked overdue once and never
  made terminal.
- Admitted paid work is resumable (core migration 010): each claim records
  the order's dispatch deadline and its listing version's fulfillment
  duration, and admission creates the order's durable
  `standard-paid-fulfillment` job leased to the admitting request. A new
  required worker resumes a never-started order after that request died,
  only on a build that can run its admitted contract, and parks a started
  call whose answer was lost instead of repeating it. One start fence, taken
  only under the order's live job lease and never while a buyer's
  cancellation holds the order, makes `execute` run at most once, and every
  pre-start rejection, escalation or failure must win it first (an
  escalation in its own transaction), so a racing or stale executor never
  ends or escalates an order another one started. A database failure before
  the call, the database client's own query timeout included, no longer
  signs a failure, the worker waits out a declared service outage, an order
  runs with its admitted contract's asset-ownership rule, and only a
  never-started order fails, as
  `standard_fulfillment_expired`, once its admitted fulfillment deadline
  passed; the dispatch deadline never fails admitted work.
- Every promoted listing version stays resolvable by its commitment hash
  (core migration 009): dispatch, lifecycle, support, reviews and legacy
  terminal evidence use the version an order was sold under, so a timely-paid
  order of a superseded version is still admitted with its original
  definition, price and deadlines while sales are paused. Each runs on the
  handler of its admitted contract, current or declared in a skill's
  `previousContracts` (matched by an executable definition hash that ignores
  pricing, capacity and deadlines); a build without it refuses the dispatch
  before admission. Answers are signed with the agent wallet the version names,
  kept after a rotation by `PROVIDER_RETAINED_WALLET_PRIVATE_KEYS`, and asset
  actions keep their admitted signed definitions across catalog epochs.
- Retirement ends a paid version's dispatch support only with the gateway's
  signed `GatewayContractRetirementV1` receipt for that version and no open
  local obligation, now including unfinished durable jobs, claimed lifecycle
  actions and unexpired quotes; only the receipt ends a quote that may have
  been paid but was never dispatched. It counts them after locking the
  version rows that a database trigger makes every new order and quote lock,
  so a concurrent admission either blocks it or is refused definitely.
  `daski:register` gains `--retire-listing` and `--gateway-receipt`; reads of
  retired versions are never retired.
- Refreshed dependencies past current advisories: fast-uri 3.1.8, qs 6.16.0,
  js-yaml 4.3.2 (override), proxy-addr 2.0.8, source-map-js 1.2.2 and
  Vitest 4.1.11; `npm audit` reports no moderate or higher findings.
- Made the skill validator and doctor tooling portable across LF and CRLF
  checkouts, and added a focused Windows tooling CI gate.
- Clarified Provider versus upstream Supplier terminology and linked the
  official Base Sepolia faucet directory from Testnet wallet setup.
- Made optional LLM configuration truly optional and added concise,
  value-redacted startup configuration errors.
- Made dummy input limits Unicode-aware and its provisioned asset identifiers
  task-bound so repeated titles cannot collide.
- Added a safe, dummy-only offline skill walkthrough and documented every
  operator/CI script by risk.
- Collapsed the unpublished inherited migration history into a clean starter
  baseline for new provider databases.
- Made the Dockerfile the canonical deployment artifact and removed the
  upstream hosting-vendor descriptor.
- Renamed the private package metadata to match the public provider
  repository.
- Clarified standard-rail release accounting as an interval-based invariant.
- Standard-rail requests are parsed as bounded, uncompressed, strict UTF-8
  JSON with duplicate, prototype-named, oversized, and deeply nested keys
  refused before any handler runs; signed answers are never cached.
- Fixed and dynamic listings answer the gateway's payer-bound
  `ProviderQuoteRequestV1` with the exact seven-field signed quote (payer
  echoed literally), persisted with its payer and pricing mode in core
  migration 002. Fixed quotes always carry the admitted listing price and
  live 120 s; dynamic quotes follow the admitted policy, at most 180 s.
- Quote refusals return gateway-format `fieldErrors` and reviewed reasons
  instead of a generic 422; signed `ProviderIntakeRequestV1` discovery is
  answered on the quote URL without creating a quote.
- Added the optional read-only `requestReadiness` and `intake` adapter hooks,
  quote-time capacity per listing version, and strict supplier-cost ceiling
  validation.
- Core binds a quoted supplier-cost ceiling immutably to the admitted task
  (core migration 003) and `runSupplierOperation({ spend })` refuses a
  planned supplier operation above it, for another supplier or currency, or
  without an admitted ceiling before the supplier is called, closing that
  operation key as `execute.not_applied`.
- Dispatch and status answers carry a signed `operations` observation from
  a persisted semantic projection and revision (core migration 004, all-null
  at revision 0), freshly stamped with the database clock and signed per
  request; terminal answers keep the attestation and inline results are gone.
- Dispatch has three outcomes: a definite pre-admission
  `409 {"error":"dispatch_rejected","reason"}` confirmed by a claim probe,
  the signed snapshot (also for exact replays after expiry), or an empty 503
  whenever admission exists, its commit is uncertain, or a different envelope
  targets an admitted order. Admission rechecks expiry against the database
  clock under a per-order lock, and claims are immutable and never deleted
  (core migration 005).
- `/dispatch/status` returns
  `404 {"error":"dispatch_status_unavailable","reason":"outcome_policy"}` only
  for proven absence of any claim and uses distinct bodies for every other
  failure; status reads are exempt from per-client and purchase rate limits.
- Gateway envelopes must carry the canonical signature encoding, the
  standard-rail media type check parses charset parameters exactly as the
  body parser does, unauthenticated status reads spend a per-client failure
  budget, and concurrent status probes share the order lock.
- Funded dispatches are no longer refused for paused sales or local capacity;
  a declared service readiness outage refuses them before admission with
  `service_unavailable` instead of executing and signing a failure. Reviewed
  paid orders resolve while sales are paused.
- An ambiguous supplier outcome during dispatch fulfilment keeps the task
  nonterminal and flagged for reconciliation, a failure to persist the
  service's own answer is never rewritten as a failure, and the task
  watchdog also flags admitted tasks that never started.
- Dispatch now verifies the persisted, nonzero provider quote for both
  pricing modes, including payer, request, listing, price and window
  coverage, and no longer caps how long after its quote a timely-paid order
  may be dispatched.
- Lifecycle actions, wallet actions and asset queries verify payer EIP-712
  signatures through one bounded verifier: EOAs recover offline, and with
  `PAYER_ACCOUNT_TYPES=eoa,contract` a deployed ERC-1271 account answers one
  gas-, size- and time-bounded `isValidSignature` read that must return the
  exact zero-padded magic value. Counterfactual ERC-6492 wrappers are
  refused, and a verification outage stays retryable instead of looking like
  a wrong signature. Asset actions and queries verify the gateway grant
  before the payer signature, so an ungranted request never spends RPC.
- Asset ownership has one authority (core migration 012): an owner override
  when one committed, otherwise the payer of the most recent linked standard
  order at version 0, and the architecture gate refuses any other
  derivation. Owner-only work is admitted under a per-asset owner fence that
  records the owner's version: asset-action claims, staging, destructive
  confirmations and post-review resumptions, and owner-only paid orders at
  dispatch (only by the executor that holds the order's live fulfillment
  job lease, before it starts), buyer input and reviewed execution. The
  supplier call, result persistence and every signed asset-action response
  compare that version with the current owner under the fence; a stale
  owner's result is withheld from both owners and ends `failed` with
  `asset_owner_changed`; a stale owner's replay or recovery is refused
  before any nonce is consumed, and an asset action's task result and
  execution settle in one transaction. Fenced wallet-action transactions now
  run read committed so a read after the fence sees what committed before
  it, and the expiry sweep purges spent nonces and rate buckets apart from
  the rows it updates.
- Each AgentCard publishes the payer account policy exactly as the verifier
  enforces it (`auth.payerAccounts`, never counterfactual accounts),
  `PAYER_ACCOUNT_TYPES` with `contract` is refused at boot in mock chain
  mode, and one payer may hold at most two of the eight concurrent
  contract-account verifications.
- Services that deliver asset information to its owner have a generic
  owner-fenced delivery admission (core migration 013,
  `deliverAssetInformation`): the delivery is admitted under the asset owner
  fence, sent outside every lock, and renewed under the fence by
  `sendEmail`'s new `beforeSend` hook immediately before the outbound call.
  A revoked admission or a changed owner is an explicit, terminal
  `send_skipped` refusal; an infrastructure failure of that check records
  `send_retryable` with the request fingerprint and a cooldown, and the
  same logical send is validated again when retried.
- Wallet actions act only on an asset of their service and type in a state
  the service admits for the action (`assets.assetLookupStatuses`, active
  only by default) and with the identifier their input names; a destructive
  follow-up acts only on the staged row of the asset it names. An asset that
  stops being eligible before execution fails the action with
  `asset_unavailable` without supplier work.
- Buyer input and cancellation are durably idempotent (core migration 008):
  each is identified by its task and content, claimed under a lease before
  the service is called and committed with the task state it produced, so a
  fresh grant or payer nonce never repeats a committed mutation. A definite
  pre-effect failure frees the identity, an uncertain outcome keeps it bound
  for the next attempt to reconcile, and conflicting content is
  `action_conflict`.
- Support accepts the gateway's `{requestId, message}`, deduplicated by
  order, payer and `requestId` against its content hash (core migration 007):
  a retry under a fresh authorization returns the original signed
  `supportReceipt` with UUID message and Review ids, and changed content is
  `action_conflict`. Each request records the protected buyer message, opens
  or joins the order's human support Review and publishes `operations.support`
  under a higher revision; closing the Review publishes `closed` the same way.
  Support never touches terminal evidence.
- Lifecycle calls verify the gateway grant before any authorization, accept
  the gateway's grant-attested `DaskiReadCap` stub for status and artifact
  reads (never for mutations), verify payer-signed authorizations against the
  grant's payer before any lookup, and answer with exactly the gateway's keys,
  a fresh signed `operations` observation and the frozen terminal identity.
  Every lifecycle error is now one of the named refusals
  (`artifact_unavailable`, `unsupported_action`, `action_conflict`,
  `lifecycle_unavailable`) or a detail-free `401 lifecycle_rejected` instead
  of a blanket 401, and lifecycle calls skip per-client and purchase limits
  behind their own authentication-failure budget.
- A standard order's terminal identity is frozen with its first terminal
  transition (core migration 006): state, completion time, the canonical
  unrevealed task projection encrypted at rest, its hash, protected artifact
  references and provenance. Dispatch, status and lifecycle attestations sign
  that identity forever; support messages, event retention, restarts and
  internal revivals no longer change it, and authorized artifact reads reveal
  protected fields in a separate representation. Terminal rows from earlier
  releases are never answered with a guess: they are reconciled only from a
  verified retained attestation or a recorded no-identity handoff through
  bearer-admin endpoints, or isolated with a stable diagnostic. Event
  retention keeps the events of every standard order not yet frozen.
- The gateway's canonical provider-wire fixtures are vendored under
  `test/fixtures/provider-wire/` with an offline parity check, and the real
  quote, intake, dispatch and status handlers are driven through every
  applicable vector byte for byte. A `service_unavailable` dispatch refusal is
  now a `503` JSON refusal, an unknown provider quote is refused as
  `quote_window`, and the forwarded QuoteV1's binding and signature are
  verified before any claim lookup.
- Published skill contracts carry the gateway's closed key set, including
  `purchaseReadiness: null`, and both deadlines explicitly; registration
  refuses a fulfillment window shorter than `dispatchSeconds + 300`, which a
  lost initial dispatch could not survive. Every contract hash changes, so
  changed services re-register through `daski:register`.

- `/health/ready` separates read serviceability, admission and servicing
  (C05): its status code is 200 while persisted reads can be served (the
  database answers at a supported schema epoch), and its body reports
  `reads`, `admission` and `servicing` with stable codes. Any chain,
  identity, catalog, registration, invariant or servicing trouble now stops
  new quotes in-process with `503 service_unavailable` instead of taking
  funded orders' reads off the network; dispatches, lifecycle calls and reads
  are never gated by it. `/health/admission` answers 200 only while new sales
  are admitted. The required workers of a paused or inactive service stay
  required while it still owes nonterminal tasks or unresolved supplier
  operations, and readiness logs each transition once.

- Every failed outbound call is reported redacted and throttled
  (`outbound.request_failed`): supplier and email HTTP, the gateway
  registration fetch, each chain RPC endpoint attempt with its method and
  block-tag class (a JSON-RPC error answer is `rpc_error`, not a network
  failure), and LLM calls. `boundedFetch` keeps an empty or non-JSON error
  reply's HTTP status, throws `OutboundCircuitOpenError` with the circuit's
  real `retryAt`, and composes a caller's `signal` with its own timeout
  through the whole body read on both the fetch and the pinned path; a caller
  abort is `OutboundAbortedError` and never opens the circuit.

- Recurring work logs state transitions instead of every poll: polling
  workers log a failure when it starts or changes and their recovery once;
  the registration reconciler no longer writes a mandatory
  `chain.service_registration_verified` audit row per service every cycle
  (it audits `chain.service_registered` only when a link changes, records
  each verdict for the operations summary and logs a change of verdict);
  empty retention sweeps are silent.

- Idle chain polling is lower: identity and registration refresh every three
  minutes (five-minute freshness unchanged), rail-contract integrity every
  five minutes in the background (390-second heartbeat), and nonce-gap
  recovery skips chain reads while no provider write is unresolved. Quotes,
  buyer input and cancellation (before the nonce is consumed), wallet
  actions, reputation writes and dispatch evidence verification now each
  prove the rail contracts freshly before they act.

- Each agent card is also served at
  `/agent-cards/<slug>.json/.well-known/agent-card.json`, for registry
  crawlers that treat the card URL listed in the registration file as a site
  root; the canonical URL and the on-chain service URI are unchanged.

- Optional verified edge mode (`EDGE_SECRET`, disabled by default): behind a
  Cloudflare edge the secret the edge adds proves the path, the client is the
  address the edge forwards, and forwarding headers are dropped unread, so a
  caller's forwarding chain and the edge secret are never interchangeable;
  `/health` is exempt, and on Mainnet the secret declares the topology instead
  of proxy hops and ranges. The admin SIWE nonce and sign-in now use the same
  normalized client address as rate limits and the concurrency budget.

- A rate-limit token spend commits without waiting for the WAL flush, for
  that single statement's own transaction only (a crash may lose the last
  fraction of a second of spends); every financial, evidence, job and result
  write stays fully durable. A PostgreSQL test pins the statement's scope.

### Fixed

- The provider-write reconciler stays ready while another replica's live
  session holds its cycle lease, reports a lease stuck for five minutes, and
  jitters its schedule so replicas cannot phase-lock.
- A first boot that registers several services fits the reconcile budget: the
  45-second budget pauses while a broadcast receipt is awaited, each receipt
  wait is bounded, a duplicate-registration revert is adopted from the latest
  block, and an abandoned cycle can no longer overwrite a newer verdict.
- The identity helper finds an existing agent on the canonical registry
  (`--agent-id`, or the wallet's balance and `Transfer` events), never mints
  while the wallet owns one, and no longer calls `walletRotationNonce`.
- Re-registration keeps reused listings on the commitment their admission
  promoted, refuses identity drift, and names every cross-check mismatch.
- Registration resumes from the persisted record and the gateway's live
  state: an activated registration left in `ATTENTION` is promoted without a
  new intent or transaction, accepted evidence is replayed exactly after
  expiry, unaccepted evidence is refreshed over the original splitter
  transactions, and gateway rate limits are retried with bounded backoff.
- A pre-execute review opens again. Its INSERT no longer binds one parameter
  to both a uuid and a text column, which PostgreSQL refused for every review,
  free tasks included; and a funded order's review is bound to the provider
  request its dispatch verified (the claim's request hash), not compared with
  the gateway's own canonical request hash, which never matched, so a
  fail-closed or flagged paid order failed as never started instead of
  waiting for its reviewer. The review still wins the order's start fence in
  its own transaction, so an order another executor started is never
  escalated.
- A transient fault before a funded order starts no longer fails it as never
  started. A fetch or DNS failure, a timeout, an outbound circuit or
  concurrency refusal, an HTTP 408, 429 or 5xx, a supplier's temporary,
  ambiguous or credential condition, or an exhausted RPC failover, raised by
  the asset lookup, a service hook or the pre-execute consult (or as a cause
  of what they raise), leaves the order unstarted for its fulfillment job to
  resume; only a definite refusal still fails it.
- Buyer input to owner-only work whose owner changed during the service call
  is answered with the order's settled `failed` state (`asset_owner_changed`,
  deliverable withheld) and commits that outcome, as dispatch does, instead
  of `503 lifecycle_unavailable` until the buyer retried.
- A timely-paid order sold before a provider control-profile rotation and
  first dispatched after it is no longer refused as `outcome_policy`: its
  dispatch carries the profile its checkout committed, which is admitted
  while `STANDARD_RAIL_RETAINED_CONTROL_PROFILE_HASHES` keeps it. Each
  readiness quote records the profile it was issued under (core migration
  015), and the compatibility check, its readiness gate and the registration
  run report a `control_profile` gap for an unretired version whose quotes
  name a profile the deployment no longer accepts.
- Asset delivery admissions no longer accumulate forever: the retention
  worker removes finished or revoked ones after `DURABLE_JOB_RETENTION_DAYS`,
  never one left open, one that could still count as live, or one whose
  asset has nonterminal owner-only work or a legal hold.

### Removed

- All source, configuration, migrations, documentation, and tests belonging to
  the original provider's marketplace offerings and suppliers.
