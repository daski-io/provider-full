# Changelog

All notable changes to this project will be documented here.

## Unreleased

### Added

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
- A harness-agnostic Agent Skill under `.agents/skills/` plus installation and
  validation guidance for compatible coding agents.
- Documentation, skill, and release-package validation gates.
- `npm run daski:register -- --check-only`, a read-only registration
  forecast with read-only database sessions and gateway `GET` requests only.

### Changed

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
  without an admitted ceiling before the supplier is called.
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
- Funded dispatches are no longer refused for paused sales or local capacity.
- Dispatch now verifies the persisted, nonzero provider quote for both
  pricing modes, including payer, request, listing, price and window
  coverage, and no longer caps how long after its quote a timely-paid order
  may be dispatched.

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

### Removed

- All source, configuration, migrations, documentation, and tests belonging to
  the original provider's marketplace offerings and suppliers.
