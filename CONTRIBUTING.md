# Contributing

Thank you for improving the Daski provider-full starter. Changes should make it
safer or faster for a new provider to implement its own service without
introducing a provider-specific dependency.

## Setup

```bash
nvm use
npm ci
cp .env.example .env
npm run dev:db:up
npm run doctor -- --stage=testnet
```

The unit suite does not require a populated `.env`, PostgreSQL, an RPC, or a
supplier. Full runtime boot requires the Testnet onboarding values described in
the README. The bundled PostgreSQL 16 service binds only to loopback and is for
local development; never point disposable-database security scripts at a shared
database.

## Where code belongs

- Service-neutral protocol and security behavior: `src/core/`
- One service's behavior and tests: `src/services/<slug>/`
- Installed services: `src/providerServices.ts`
- Reviewed paid outcomes/actions: `src/providerLaunchPolicy.ts`
- Optional provider policy/vendor implementations: `src/providerExtensions/`
- Core/cross-service tests: `test/`

Core may not import a service, and sibling services may not import each other.
Do not add a special case to core when a `ServiceModule` facet can express the
same requirement.

## Before opening a pull request

Run:

```bash
npm run typecheck
npm run typecheck:test
npm run lint
npm run lint:architecture
npm run docs:check
npm run test:run
npm run build
```

Run coverage, dependency audit, and PostgreSQL-backed checks when your change
touches security-critical, dependency, or migration behavior.

A pull request should explain the user-visible change, security implications,
tests run, and any Daski onboarding/artifact coordination required. Include a
migration with schema changes and keep service tests co-located with the
service.

Never include secrets, customer data, supplier account data, private policy,
or raw production/Testnet logs.

## Branches and commits

Target `develop`. Keep commits focused and use an imperative summary. Do not
add coding-agent attribution or co-author trailers.
