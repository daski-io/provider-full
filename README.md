# Daski Provider Full Starter

Build the provider-side adapter that lets agents discover, buy, and operate
your existing product through [Daski](https://daski.io).

This repository is for organizations that already have a service exposed by
an API, MCP server, SDK, or internal application. It supplies the Daski
protocol, payment, identity, ownership, persistence, security, and operator
foundations. You supply the product integration and operate the resulting
provider.

## Choose the right starter

| Starter | Use it when |
| --- | --- |
| [`provider`](https://github.com/daski-io/provider) | Every operation is fixed-price, fully automated, one-shot, terminal within 50 seconds, and needs no durable asset/lifecycle or later reconciliation. |
| `provider-full` (this repository) | Any operation needs dynamic quotes, long-running jobs, later input, cancellation, durable assets/actions, human review, email, admin, direct A2A, protected-data workflows, or multi-replica recovery. |

The starters share the standard Exact-EVM rail but are alternatives, not
layers. The **Daski Provider integration skill for coding agents** is published
only by `provider`; this full repository links to that canonical copy instead
of maintaining a duplicate.

The starter is intentionally generic. Its only marketplace service is
`src/services/dummy`, a small reference with a free `echo` skill and a paid
`create-note` skill. It has no production supplier, customer policy, or
provider-specific behavior, and it cannot run on Base Mainnet.

## What this repository does

| Starter responsibility | Your responsibility |
| --- | --- |
| Daski discovery, AgentCards, skill docs, and ERC-8004 metadata | Define the service and skills buyers should see |
| Standard Exact-EVM quote, dispatch, lifecycle, evidence, and reputation rail | Validate, price, and fulfill product requests |
| Wallet-bound asset ownership and reviewed owner actions | Map your product's durable objects and lifecycle |
| PostgreSQL durability, jobs, supplier journal, health, and operator surfaces | Integrate your API or MCP product and run its dependencies |
| Signature, replay, SSRF, encryption, rate-limit, and fail-closed boundaries | Add product-specific data, supplier, compliance, and readiness controls |

This is not a buyer SDK, a generic API proxy, an MCP gateway, or a payment
simulator. Paid work enters through the Daski gateway after standard-rail
admission. A service adapter never decides whether a payment is valid.

## Choose your path

| Goal | Start here |
| --- | --- |
| See a service run without configuration | [Offline five-minute tour](#offline-five-minute-tour) |
| Install and reach a deterministic local setup | [Getting started](docs/getting-started.md) |
| Adapt an existing API or MCP product | [Integrating an existing product](docs/integrating-existing-product.md) |
| Build the `ServiceModule` | [Adding a service](docs/adding-a-service.md) |
| Understand environment variables | [Configuration](docs/configuration.md) |
| Prepare for Daski Testnet or Mainnet | [Onboarding](docs/onboarding.md) |
| Fix setup, readiness, or integration errors | [Troubleshooting](docs/troubleshooting.md) |
| Give a coding agent the workflow | [Daski Provider integration skill](docs/agent-skill.md) |

Testnet is the normal first integration target. Mainnet is a separate,
whitelisted release: ask for admission through the
[Daski Discord](https://discord.gg/uyeMp7Q2HW) after your Testnet service is
complete.

## Offline five-minute tour

You need Node.js 24 and npm. No database, wallet, RPC, Daski artifact, or API
credential is used by this tour.

```bash
git clone https://github.com/daski-io/provider-full.git
cd provider-full
npm ci
npm run try-skill -- dummy echo
npm run try-skill -- dummy create-note
```

The helper loads committed JSON requests from `examples/requests/`, quotes the
dummy skill, executes it in memory, and prints its documentation. It is
deliberately restricted to `dummy`; it does not perform gateway admission,
payment, persistence, supplier calls, or chain writes.

Next, follow [Getting started](docs/getting-started.md) to launch the local
PostgreSQL service and run:

```bash
npm run doctor
```

Doctor is read-only. It reports stable codes, never prints configured secret
values, and explains which onboarding inputs still block a full boot.

## How an order reaches your product

1. The provider publishes your service manifest and skill contracts.
2. Daski requests a quote; your adapter validates the buyer input and returns
   an exact atomic-USDC amount or structured field errors.
3. The gateway admits and verifies the standard payment requirements.
4. The gateway sends a signed dispatch bound to the provider, service, skill,
   payer, request, order, audience, recipe, and deadline.
5. Core verifies every binding and atomically claims replay state before your
   adapter runs.
6. Your adapter calls the fixed, reviewed operation in your API or MCP product.
7. Core persists status, artifacts, asset ownership, evidence, and the terminal
   reputation outcome.

If an external mutation times out after dispatch, the provider must reconcile
the product's authoritative state before retrying. It must never guess whether
a purchase, provisioning request, filing, or other non-convergent action
succeeded.

## Repository map

```text
src/core/                         service-neutral Daski runtime
src/services/dummy/               reference ServiceModule, docs, and tests
src/providerServices.ts           installed-service composition
src/registerGatewayServices.ts    reviewed self-registration/update CLI
src/providerScreening.ts          optional provider-policy composition
test/                              core and cross-service tests
docs/                              canonical integration and onboarding guides
scripts/                           diagnostics, operations, and CI helpers
compose.yaml                       local PostgreSQL only
Dockerfile                         canonical hosting-neutral runtime image
```

Core never imports a service. Services never import sibling services or a
provider-specific policy implementation. Product behavior, configuration,
clients, migrations, workers, docs, and tests stay with the service that owns
them. The architecture and static gates enforce these boundaries.

## Environments

| Stage | Purpose | Expected result |
| --- | --- | --- |
| Offline dummy | Learn quote and execution shape | Works immediately after `npm ci` |
| Local | Develop a service and use local PostgreSQL | `npm run doctor` passes local machine checks; Daski placeholders may warn |
| Testnet | Real gateway, Base Sepolia, signed artifacts, and supplier sandbox | `npm run doctor -- --stage=testnet` and `/health/ready` pass |
| Mainnet | Whitelisted, reviewed production provider on Base | Dummy removed, production gates pass, and Daski grants admission |

A copied `.env.example` is not bootable by design. Daski onboarding issues a
mutually consistent set of Testnet contract coordinates, signer bindings,
signed global policy, servicing-admission, and action-catalog artifacts. Paid
runtime listings are derived from each published service contract and promoted
by the registration workflow. Providers must not invent or edit these values.

The provider can run locally while pointing at Testnet. A fully private local
payment topology would require a complete contract deployment, facilitator,
signer set, and newly signed artifacts; it is protocol development, not the
provider quickstart. The gateway has no fake local facilitator.

## Build and verify

Service-owned tests belong in `src/services/<slug>/tests/`; `test/` is only for
core and cross-service contracts.

```bash
npm run typecheck
npm run typecheck:test
npm run lint
npm run lint:architecture
npm run docs:check
npm run test:run
npm run test:coverage
npm run test:critical-coverage
npm run test:mainnet-readiness
npm run security:audit
npm run build
```

PostgreSQL security and migration smoke scripts require explicit disposable
database URLs. Never point them at a shared Testnet or production database.
See [scripts/README.md](scripts/README.md) before running an operator script.

## Deployment

The Dockerfile is the canonical production artifact and uses a pinned,
non-root Node 24 runtime. The upstream starter intentionally prescribes no
hosting vendor. A provider fork can add its own deployment descriptor.

Every deployment needs stable HTTPS at `BASE_URL`, durable PostgreSQL 16 or
newer, runtime-injected secrets, the required outbound API/RPC access, and at
least one continuously available provider process while services are active.
Route traffic only when `/health/ready` succeeds; `/health/live` proves only
that the process exists.

## Register with Daski

Unlike the minimal starter, `provider-full` owns the reviewed self-registration
workflow. After the public provider is deployed, configuration passes, and the
operator has reviewed the wallet, chain, gateway, and possible transaction
costs, run on Testnet:

```bash
npm run daski:register -- --gateway https://<daski-testnet-gateway>
```

The command reconciles the configured ERC-8004 provider identity, publishes
every active service contract, obtains gateway-signed preparations, persists chain writes
before broadcast, verifies activation evidence, and atomically promotes the
runtime catalog. `--service <slug>` limits a run. Re-running an unchanged
service is convergent.

Retirement is separate and explicit:

```bash
npm run daski:register -- --retire 0x<SERVICE_ID>
```

It first proves the service has no active work or assets and records the
retirement locally and at the gateway. Never use registration or retirement
against Mainnet without the coordinated, whitelisted release procedure.

## Documentation

### Install and integrate

- [Getting started](docs/getting-started.md)
- [Integrating an existing API or MCP product](docs/integrating-existing-product.md)
- [Configuration](docs/configuration.md)
- [Adding a service](docs/adding-a-service.md)
- [Service and skill authoring](docs/daski-skill-creation-best-practices.md)

### Join Daski and operate safely

- [Testnet and Mainnet onboarding](docs/onboarding.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Security model](SECURITY.md)
- [Operator and CI scripts](scripts/README.md)

### Understand the platform

- [Architecture](docs/architecture.md)
- [Service taxonomy](docs/service-taxonomy.md)
- [Protocol cheatsheet](docs/protocol-cheatsheet.md)
- [Standard-rail evidence V2](docs/standard-rail-evidence-v2.md)

### Work with coding agents

- [Daski Provider integration skill](docs/agent-skill.md)
- [Repository agent guide](AGENTS.md)
- [Contributing](CONTRIBUTING.md)

## Staying current

Fork this repository when possible, then retain it as an upstream remote:

```bash
git remote add upstream https://github.com/daski-io/provider-full.git
git fetch upstream
git merge upstream/develop
```

Keep provider-specific work concentrated in services, root composition,
optional `src/providerExtensions/`, environment configuration, and your own
deployment files. Review upstream migrations and protocol changes before
merging, then rerun the full gates and Testnet purchases. Never edit an applied
migration to make an update merge cleanly.

After forking, replace the vulnerability-reporting destination in
[SECURITY.md](SECURITY.md) with a private channel operated by your organization.

## License

MIT. See [LICENSE](LICENSE).
