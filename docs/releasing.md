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
disposable databases described by CI. Verify the image's non-root user and
excluded test/docs/scripts boundary.

The deployed Testnet candidate must pass `npm run doctor -- --stage=testnet
--live` and the service's applicable discovery, quote, dispatch, lifecycle,
asset/action, cancellation, restart, ambiguity, readiness, email/admin, and
protected-data cases.

## Version and publication

For the first stable release, set `package.json` to `1.0.0`, move completed
changelog entries from `Unreleased`, rerun all gates, and record the exact
approved commit/image. The portable agent skill is versioned and released only
from the [Daski Provider integration skill guide](https://github.com/daski-io/provider/blob/develop/docs/agent-skill.md)
in `daski-io/provider`; do not copy or retag it here.

After explicit approval, update `main` through the reviewed branch process and
create the annotated `v1.0.0` tag. The tag job verifies the package version,
archives `provider-full`, writes SHA-256 checksums, and publishes the GitHub
release. Never move a published stable tag; fix forward with a new version.

Release notes may include public commits, checksums, versions, contract
coordinates, and redacted results. They must not include private keys, signed
buyer authorizations, API/admin/webhook/database/encryption secrets,
customer/protected payloads, supplier account data/raw responses, private
policy, dumps, `.env`, or raw logs.
