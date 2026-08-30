# Getting started

This guide takes a clean clone from an offline demonstration to a provider
that is ready to receive Daski Testnet configuration. It deliberately separates
local product development from Daski admission so placeholder artifacts are
never mistaken for a broken installation.

## The four milestones

| Milestone | What works | External inputs |
| --- | --- | --- |
| Offline dummy | Quote and execute the reference skills in memory | None |
| Local development | PostgreSQL, tests, service implementation, and doctor | Docker or PostgreSQL 16 |
| Testnet boot | Full provider, gateway discovery, paid orders, and evidence | Public HTTPS, wallet, Daski-issued Testnet coordinates/artifacts |
| Mainnet | Approved production service | Successful Testnet, Daski whitelist, separate production controls |

Do not try to make a placeholder `.env` boot by weakening validation. Complete
the offline and local milestones while Daski reviews the service contract.

## Prerequisites

Required for local development:

- Git;
- Node.js 24 and npm; and
- Docker with the Compose plugin, or an independently managed PostgreSQL 16+
  database.

Required later for Testnet:

- a dedicated Base Sepolia provider wallet with Testnet ETH from a current
  option in Base's official
  [network faucet directory](https://docs.base.org/base-chain/network-information/network-faucets);
- a stable public HTTPS origin for this provider;
- supplier sandbox credentials or an explicit fake that cannot reach Mainnet;
  and
- the signer bindings, contract coordinates, and signed standard-rail
  artifacts supplied through Daski onboarding.

`nvm` is optional. If you use it, `.nvmrc` selects the intended Node release.
Otherwise install Node 24 using your normal version manager or package source
and confirm `node --version` starts with `v24.`.

## 1. Clone and install

```bash
git clone https://github.com/daski-io/provider-full.git
cd provider-full
npm ci
```

`npm ci` uses the committed lockfile. Do not replace it with an unreviewed
dependency update during initial setup.

## 2. Run the offline reference

These commands are shell-neutral because the input is loaded from committed
JSON files:

```bash
npm run try-skill -- dummy echo
npm run try-skill -- dummy create-note
```

Both commands should print JSON containing:

- `mode: "offline-dummy-only"`;
- the request source;
- an exact quote;
- the adapter result; and
- the public skill documentation.

The paid `create-note` example does not move money. It demonstrates the shape
of a paid quote and newly provisioned asset only. The helper refuses every
service other than `dummy`, so a real product cannot accidentally bypass
gateway admission or supplier safeguards.

## 3. Create `.env`

On Linux, macOS, or WSL:

```bash
cp .env.example .env
```

In PowerShell:

```powershell
Copy-Item .env.example .env
```

The copied file is a worksheet, not valid runtime configuration. Leave the
Daski-issued fields as placeholders until onboarding supplies them. Start by
setting your public provider identity and product-independent local values.
Use [Configuration](configuration.md) for every variable and secret boundary.

Never commit `.env`. It is ignored by Git and excluded from the production
image.

## 4. Start local PostgreSQL

The included `compose.yaml` starts one development-only PostgreSQL 16 service:

```bash
npm run dev:db:up
```

It is bound to `127.0.0.1:55432`; it is not reachable from other hosts. Data is
kept in the named `daski-provider-full-dev-postgres` volume when the container is
stopped.

Set this local URL in `.env`:

```dotenv
DATABASE_URL=postgresql://daski_provider:local-only-provider-password@127.0.0.1:55432/daski_provider
DATABASE_SSL_MODE=disable
```

If port 55432 is already in use, change the host-side port in your fork's
Compose file and update `DATABASE_URL`.

If you operate PostgreSQL yourself, create an empty disposable development
database and use its URL instead. Do not point initial setup at a shared
Testnet or production database.

## 5. Run doctor

```bash
npm run doctor
```

Doctor performs only read operations. It checks Node, repository layout,
configuration names and placeholders, PostgreSQL version/reachability, service
composition, stage bindings, and—when configuration permits—the actual core
schema and signed-artifact validators.

At this milestone, a healthy result normally includes passes for Node,
repository layout, PostgreSQL, service composition, and local stage bindings,
plus warnings for missing Daski artifacts. That is expected. Stable diagnostic
codes and remedies are listed in [Troubleshooting](troubleshooting.md).

For machine-readable output:

```bash
npm run --silent doctor -- --json
```

Doctor does not run migrations, register a provider, send transactions,
contact a supplier, or print secret values.

## 6. Verify the repository

Unit tests do not require a live database, chain, gateway, or supplier:

```bash
npm run typecheck
npm run typecheck:test
npm run lint
npm run lint:architecture
npm run docs:check
npm run test:run
npm run build
```

The PostgreSQL-backed security scripts are release checks for explicit
disposable databases; they are not part of the first local run.

## 7. Adapt your existing product

Read [Integrating an existing product](integrating-existing-product.md) and
complete its mapping worksheet before copying the dummy. It covers both API
and MCP products, synchronous and job-based operations, pricing, assets,
cancellation, ambiguity, protected data, and readiness.

Then implement the module using [Adding a service](adding-a-service.md):

1. copy `src/services/dummy` to `src/services/<your-slug>`;
2. replace its public contract, validation, adapter, docs, and tests;
3. add only the optional facets your product requires;
4. install it in `src/providerServices.ts`;
5. coordinate the published paid-skill/action contracts with Daski; and
6. remove `dummy` before Mainnet.

Keep your API/MCP client behind explicit service operations. Never build a
buyer-controlled pass-through for endpoints, servers, methods, or tool names.

## 8. Prepare Testnet configuration

Follow [Testnet onboarding](onboarding.md#testnet-onboarding). Daski and the
provider exchange a review packet before the signed configuration can exist.
The final Testnet `.env` must use one consistent set of:

- Base Sepolia coordinates and canonical USDC;
- provider identity and wallet binding;
- provider and gateway HTTPS audiences;
- gateway signer;
- signed global rail policy and registration policy;
- servicing admission and asset-action catalog; and
- provider control profile and evidence contracts.

Providers do not invent or edit Daski-signed artifacts. Paid runtime listings
are created by the reviewed registration flow from the provider's own signed
service contract. If an id, hash,
audience, signer, service, skill, action classification, or expiry differs, the
provider fails closed.

## 9. Check Testnet readiness

Before starting the server:

```bash
npm run doctor -- --stage=testnet
```

Add bounded public provider/RPC probes only after the provider is deployed:

```bash
npm run doctor -- --stage=testnet --live
```

Start the deployed candidate locally or through the Docker image:

```bash
npm run dev
```

The first full boot applies checksummed migrations, validates the database
roles appropriate to the environment, registers service catalog rows, verifies
signed standard-rail configuration, checks chain identity/catalog bindings,
starts required workers, and only then opens the HTTP listener.

Before registration, a paid skill can boot but is not purchasable. Once the
public AgentCard is reachable and an operator has reviewed the wallet, chain,
gateway origin, and possible Testnet transaction costs, register:

```bash
npm run daski:register -- --gateway https://<daski-testnet-gateway>
```

The command reconciles provider identity, registers all active services,
persists/broadcasts splitter transactions, verifies finality and activation,
and atomically promotes runtime-listing heads. Use `--service <slug>` to narrow
an intentional update. It is externally mutating and is never run by doctor or
normal boot.

Inspect:

```bash
curl http://127.0.0.1:4000/health/live
curl http://127.0.0.1:4000/health/ready
```

Liveness means the process exists. Readiness means the dependencies and
workers required for admitted traffic are currently healthy.

## Local provider with gateway and contracts

The normal local integration topology runs local provider and gateway
processes while both point at the reviewed Base Sepolia deployment:

- full provider: [daski-io/provider-full](https://github.com/daski-io/provider-full);
- gateway: [daski-io/gateway](https://github.com/daski-io/gateway); and
- contracts: [daski-io/contracts](https://github.com/daski-io/contracts).

Use a TLS development tunnel or reverse proxy when a signed public audience
must address a local process. Gateway and provider must agree exactly on
origins, signer bindings, service/skill/runtime-listing ids, and hashes.

The contracts repository can be built and tested locally with Foundry. Point
runtime integration at the reviewed Base Sepolia deployment unless you are
deliberately developing the protocol itself. A private chain is an advanced
protocol topology because it also requires a facilitator, signer set, and new
signed artifacts.

`CHAIN_MODE=mock` is only for bounded provider-side tests on loopback. The
gateway has no fake local facilitator, so mock mode cannot test a paid Daski
purchase end to end.

## Stop the local database

```bash
npm run dev:db:stop
```

This preserves the named development volume. Remove or reset that volume only
when you intentionally want to destroy local development data; no destructive
reset command is included in the starter.

## Clean-install completion checklist

- Node 24 is selected.
- `npm ci` completes from the lockfile.
- Both offline dummy commands succeed.
- PostgreSQL 16 is reachable on loopback.
- `npm run doctor` clearly separates local passes from onboarding warnings.
- The type, lint, documentation, skill, unit, and build gates pass.
- No `.env`, credentials, customer data, supplier output, or runtime logs are
  tracked by Git.

At that point the local installation is complete. Testnet boot is the next
milestone, not a workaround for missing local setup.
