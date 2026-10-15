# Releasing provider-full

This is the maintainer checklist for the full starter. It does not authorize a
provider fork's Testnet registration, deployment, or Mainnet admission.

Development lands on `develop`. Move an exact reviewed commit to `main` and tag
it only after a clean human install, all CI/security/database/container gates,
the applicable Testnet journeys, and explicit repository-owner approval.

## Candidate checks

From a clean clone with Node 24:

```bash
npm ci --ignore-scripts
npm run security:audit
npm run typecheck
npm run typecheck:test
npm run lint
npm run lint:architecture
npm run docs:check
npm run test:coverage
npm run test:critical-coverage
npm run test:mainnet-readiness
npm run build
docker compose config --quiet
npm run doctor
```

Run PostgreSQL migration/concurrency/security checks only against the explicit
disposable databases described by CI. After the build, `npm run
security:prior-runtime` builds the prior release from its own commit and
proves on its own disposable database that this build migrates, checks and
resumes what the prior left, and that the prior image can no longer write
once the schema has moved. Verify the image's non-root user and
excluded test/docs/scripts boundary. Build the image with
`--build-arg SOURCE_COMMIT=<commit>` so `/health` and the capability manifest
name the exact source; the embedded source digest is reproducible from the
same checkout.

## Compatible gateway revision

The provider's wire contract is the gateway's. `test/fixtures/provider-wire/`
vendors the gateway's canonical synthetic fixtures verbatim from the commit
recorded in `test/fixtures/provider-wire.source.json`, with the sha256 of its
manifest; the tests verify that parity offline and drive the real quote,
intake, dispatch, status and lifecycle handlers through every vector. That
gateway commit is the release's tested consumer contract: deploy against a
gateway at or after it, with its fulfillment-deadline protection, named
lifecycle refusals and first-dispatch quote age bound (no new dispatch
envelope more than 30 days after a quote's `validBefore`,
`MAX_FIRST_DISPATCH_QUOTE_AGE_SECONDS`), which the retention sweep's quote
pruning relies on. Re-vendor only a fixture revision the gateway publishes,
reviewed by both starters' maintainers, never by editing the files.

Record with each release the package version, source commit, image digest,
the image's embedded source digest (`/health`), its core migrations, and the
fixture gateway commit and manifest sha256.

## Upgrading a deployment that holds orders

A new build must serve every listing version and asset action its database
still owes before it takes traffic:

1. Run `npm run compatibility:check` (or `node dist/checkCompatibility.js`
   inside the candidate image) against the production database. It is
   read-only and exits non-zero on any gap: a sold or possibly paid listing
   version whose contract the build no longer executes (declare it in the
   skill's `previousContracts`), an earlier agent wallet whose key is not in
   `PROVIDER_RETAINED_WALLET_PRIVATE_KEYS`, a quoted control profile no longer
   in `STANDARD_RAIL_RETAINED_CONTROL_PROFILE_HASHES` after a rotation, or an
   open asset action whose definition or handler is missing.
2. Deploy only a candidate with no gap; a candidate with one reports the
   `retained_servicing_gap` servicing code and takes no new sales
   (`/health/admission` fails), refuses those versions' dispatches before
   admission and never claims their fulfillment jobs, while its persisted
   reads stay served.
3. Register a changed contract only after the build that serves both the
   old and new contract is live; the registration run refuses otherwise.
4. Remove a retained contract or key only once the compatibility check no
   longer names it: a listing version needs its contract until it is
   retired with the gateway's receipt
   (`npm run daski:register -- --retire-listing`) or owes no work and has no
   unlapsed quote (a quote lapses 31 days after its `validBefore`), and its
   key for as long as its orders can be read.

Rotating the provider control profile is an upgrade too: keep the earlier
profile's hash in `STANDARD_RAIL_RETAINED_CONTROL_PROFILE_HASHES` (the
compatibility check names it while quotes issued under it may still be
paid), and keep its audience and endpoints routable, since a delayed first
dispatch carries the profile its checkout committed.

The first upgrade from a release before migration 009 is a stop-and-drain
cutover: pause sales, let synchronous dispatches finish, stop every old
process, then deploy. Earlier images ignore migrations they do not know and
cannot run a check they do not contain. Core migration 011 makes the
database refuse every write from them instead: an old process left running
fails with `this process predates the database schema and may not write
<table>` (SQLSTATE `55000`) before it registers, admits, claims or sweeps
anything, so it cannot take the new release's jobs. Earlier images are
therefore not rollback targets on the migrated schema; roll back only to an
image of this release or later that passes the compatibility check on the
migrated database.

A later migration that this release's runtimes cannot safely run beside must
raise the schema's minimum runtime epoch (replace
`provider_minimum_runtime_epoch()`) and the build's `RUNTIME_SCHEMA_EPOCH`
together. Builds below that epoch then refuse to start on the migrated
schema and their running processes can no longer write, which turns the
upgrade into the same stop-and-drain cutover. Every migration that creates a
table adds the same `<table>_runtime_epoch` statement trigger.

The deployed Testnet candidate must pass `npm run doctor -- --stage=testnet
--live` and the service's applicable discovery, quote, dispatch, lifecycle,
asset/action, cancellation, restart, ambiguity, readiness, email/admin, and
protected-data cases.

## Version and publication

For the first stable release, set `package.json` to `1.0.0`, move completed
changelog entries from `Unreleased`, rerun all gates, and record the exact
approved commit/image. The portable agent skill is versioned and released only
from [daski-io/provider](https://github.com/daski-io/provider); do not copy or
retag it here.

After explicit approval, update `main` through the reviewed branch process and
create the annotated `v1.0.0` tag. The tag job verifies the package version,
archives `provider-full`, writes SHA-256 checksums, and publishes the GitHub
release. Never move a published stable tag; fix forward with a new version.

Release notes may include public commits, checksums, versions, contract
coordinates, and redacted results. They must not include private keys, signed
buyer authorizations, API/admin/webhook/database/encryption secrets,
customer/protected payloads, supplier account data/raw responses, private
policy, dumps, `.env`, or raw logs.
