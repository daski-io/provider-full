# Scripts

These helpers have different trust boundaries. Read the script before running
it. Commands that accept a database URL or private key can mutate real state;
never point smoke tests at a shared, Testnet, or production database.

## Safe local learning

- `npm run try-skill -- dummy echo` and
  `npm run try-skill -- dummy create-note` load tracked request examples and
  invoke only the bundled dummy adapter in memory. An optional JSON object may
  be supplied as a final argument. The command refuses real services and
  performs no gateway, payment, database, supplier, or chain work.
- `npm run doctor -- --stage=<local|testnet|mainnet>` performs redacted,
  read-only environment, repository, PostgreSQL, and configuration checks.
  Add `--live` only when bounded provider-health and Base RPC reads are wanted;
  `--json` emits stable machine-readable check codes. It does not register,
  deploy, fund, sign, whitelist, migrate, or call a supplier.
- `npm run dev:db:up` starts the loopback-only PostgreSQL 16 development
  service. `npm run dev:db:stop` stops it while preserving its named volume.
- `npm run copy-assets` copies core UI assets and every installed service's
  documentation into `dist/`; `npm run build` runs it automatically.

## Registration and chain diagnostics

These scripts use the configured wallet or RPC. Review the chain banner,
addresses, signer, and funded wallet before use:

- `node --env-file=.env scripts/register-provider.mjs` registers or
  reconciles the provider identity, wallet binding, AgentIndex entry, and
  marketplace listing. It sends transactions and may spend ETH and USDC.
  `--update-uri` also changes the on-chain agent URI.
- `npm run daski:register -- --gateway <origin>` registers every active
  service contract with the gateway, persists splitter writes before
  broadcast, submits activation evidence, and promotes runtime-catalog heads.
  It can send transactions and mutate gateway/database state. `--service
  <slug>` narrows an intentional update. `--retire 0x<SERVICE_ID>` is a
  separate guarded retirement and must not be combined with `--service`.
- `node --env-file=.env scripts/probe-identity.mjs` reads the configured
  Base Sepolia identity and registry state.
- `node --env-file=.env scripts/probe-tokenuri.mjs <agentId>...` reads
  Base Sepolia identity URIs.

`probe-identity.mjs` and `probe-tokenuri.mjs` are intentionally pinned to
Base Sepolia. Do not repurpose them for mainnet by changing only the RPC URL.

## Database operations and diagnostics

- Run `npm run build` before
  `node scripts/run-pending-migrations.mjs <DATABASE_URL>`. It applies core
  and installed-service migrations with the same advisory locks and checksum
  ledgers as boot. It mutates schema and catalog state.
- `node scripts/set-agent-domain.mjs <DATABASE_URL> <slug> <agent-domain>`
  updates one service row and is a database mutation.
- `npm run ops:sync-preexecute -- <skillId> [--include-model]` synchronizes
  reviewed pre-execution prompt defaults into one installed skill. It mutates
  the configured database and requires verified TLS for non-loopback hosts.
- `node scripts/list-tables.mjs <DATABASE_URL>` lists public tables without
  changing them.
- `node --env-file=.env scripts/check-clock-skew.mjs` compares application
  and database clocks without changing data.
- `npm run security:rotate -- --scan` inventories protected envelopes.
  `--rotate --from-key-id=<id> [--run-id=<uuid>]` and
  `--verify-retirement --key-id=<id>` mutate or validate key retirement.
  Follow the rotation runbook and use reviewed keys and backups.

## CI and disposable-database checks

The following are verification internals, not deployment or recovery tools:

- `scripts/security/static-gates.mjs` checks repository architecture and
  fail-closed deployment invariants.
- `scripts/security/pii-scan.mjs` scans built artifacts for likely protected
  data and forbidden captured-output paths.
- `scripts/security/migration-smoke.mjs` builds a fresh disposable schema,
  registers installed services, and exercises migration invariants and
  durable-job fencing.
- `scripts/security/concurrent-migration-smoke.mjs` proves concurrent
  migration runners serialize and preserve checksums.
- `scripts/security/postgres-security-integration.mjs` exercises database
  authorization, retention, replay, supplier-journal, and evidence controls.
- `scripts/security/postgres-standard-evidence-locator.mjs` and
  `scripts/security/postgres-supplier-diagnostics.mjs` are focused helpers
  invoked by that integration suite.

These checks require the explicit disposable URLs documented by their CI
workflow. They may create, alter, and delete test data and schemas. Do not
provide production credentials.

## Maintainer-only utilities

`scripts/copy-assets.mjs` is normally invoked through the build. Shell
wrappers and one-off scratch commands are not supported repository interfaces;
keep them outside the tracked tree.
