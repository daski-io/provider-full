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
