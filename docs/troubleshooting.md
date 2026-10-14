# Troubleshooting

Start with doctor. It is read-only, emits stable check codes, and deliberately
does not run migrations, registration, chain writes, deployments, or supplier
calls.

```bash
npm run doctor
npm run doctor -- --stage=testnet
npm run doctor -- --stage=mainnet
npm run --silent doctor -- --stage=testnet --json
```

Use `--live` only when you intend to make bounded read-only requests to the
configured provider health endpoint and Base RPC.

## Doctor codes

| Code | Meaning | Typical remedy |
| --- | --- | --- |
| `NODE_VERSION` | The process is not using Node 24 | Select/install Node 24, reinstall dependencies, rerun |
| `REPOSITORY_LAYOUT` | Required starter files are missing | Run from the repository root or restore the missing tracked files |
| `ENVIRONMENT_INPUTS` | Required names are missing or placeholders | Use [Configuration](configuration.md); request Daski-issued values rather than inventing them |
| `DATABASE_REACHABLE` | The SELECT-only PostgreSQL probe failed or server is too old | Start local Compose, fix URL/TLS/network, or use PostgreSQL 16+ |
| `SERVICE_COMPOSITION` | `src/services/` and `providerServices.ts` differ | Register/remove service imports deliberately and keep one composition point |
| `MAINNET_DUMMY_FORBIDDEN` | The reference dummy remains installed | Replace/remove dummy and its reviewed outcome before Mainnet |
| `STAGE_BINDINGS` | Chain, mode, environment, or public audiences disagree | Install one internally consistent Testnet/Mainnet configuration set |
| `RUNTIME_CONFIGURATION` | Core's actual environment schema rejects boot | Fix the named variables; never weaken the schema to accept a placeholder |
| `SIGNED_ARTIFACTS` | Signed domains, signatures, exact sets, expiry, or service references fail | Ask Daski onboarding for one new consistent artifact set |
| `LIVE_READ_ONLY_PROBES` | Opt-in provider liveness or RPC chain-id probe failed | Check public routing, TLS, readiness process, RPC, and stage |
| `MAINNET_WHITELIST_REQUIRED` | The external Daski Mainnet gate cannot be machine-verified | Request/retain approval through Daski Discord; no local flag can clear it |

Warnings are intentional stage information. A local warning about signed
artifacts is normal before onboarding. Testnet/Mainnet failures are release
blockers.

## Install and Node problems

### `npm ci` rejects the Node version

Confirm:

```bash
node --version
npm --version
```

The Node version must start with `v24.`. If you changed Node after installing,
remove/recreate dependencies using your normal clean-install workflow and rerun
`npm ci`. Do not loosen `package.json` engines to accommodate an older runtime.

### Lifecycle-script warning during `npm ci`

Review the exact package and current lockfile before allowing new lifecycle
scripts. The repository CI installs with `--ignore-scripts`; runtime behavior
must not depend on an unreviewed package install hook.

### Offline dummy command fails on JSON quoting

Use the shell-neutral committed requests:

```bash
npm run try-skill -- dummy echo
npm run try-skill -- dummy create-note
```

Passing raw JSON remains optional for quick experiments, but committed request
files are the portable path for PowerShell, cmd, Bash, and coding agents.

## PostgreSQL and Compose

### Docker is unavailable

Docker is a convenience, not a runtime requirement. Install/enable Docker with
the Compose plugin, or run a PostgreSQL 16+ database using your normal local
tooling and update `DATABASE_URL`.

### Port 55432 is already in use

Stop the other local service or change the host-side port in your fork's
`compose.yaml`, then make the same change in `DATABASE_URL`. Keep the bind
address on loopback.

### Local container starts but doctor cannot connect

Check:

```bash
docker compose ps
docker compose logs postgres
```

The expected local URL is:

```text
postgresql://daski_provider:local-only-provider-password@127.0.0.1:55432/daski_provider
```

Use `DATABASE_SSL_MODE=disable` only for this loopback service. Do not apply
that fix to a remote database; production requires verified TLS.

### Migrations or database roles fail in production

Production needs a distinct `MIGRATION_DATABASE_URL` with schema ownership and
a reduced `DATABASE_URL` runtime principal. Both need verified TLS. Do not give
the runtime role ownership/superuser privileges to clear the check. Follow the
database security error and inspect the migration/role posture on a disposable
candidate first.

## Placeholder and configuration errors

### Startup prints one structured configuration error and exits

That is expected fail-closed behavior. Run doctor and fix the named variables.
The error intentionally omits their values. `.env.example` contains onboarding
placeholders and cannot start the full server by itself.

### `PROVIDER_WALLET_PRIVATE_KEY` is invalid

It must be `0x` followed by exactly 64 hexadecimal characters. Use a dedicated
environment wallet from a secret manager. Do not paste it into a command line,
issue, log, or support message.

### `PROVIDER_AGENT_ID` is invalid

It is an unsigned decimal ERC-8004 id, not a wallet address, service id, or
transaction hash. It comes from the authorized registration/binding flow.

### Encryption key equals the wallet key

Generate an independent 32-byte data-encryption key. Wallet signing and data
encryption must have separate blast radii.

### Production refuses HTTP, database TLS, webhook, proxy, or edge settings

These checks protect every long-lived deployment, including Testnet. Configure
real HTTPS, verified database TLS, distinct database roles, webhook
authentication, and the actual ingress topology. Do not switch `NODE_ENV` to
development in a deployed service to bypass them.

## Signed artifacts and audiences

### `SIGNED_ARTIFACTS` says configuration is malformed

Do not hand-edit the global-policy JSON, runtime catalog, or signed envelopes. Confirm the
entire value survived secret-manager/environment transport without line breaks,
shell expansion, truncation, or escaping changes. If uncertain, reinstall the
exact artifact supplied by onboarding.

### Signature or domain is invalid

Check that all artifacts belong to the same environment/revision and agree on:

- chain id and `STANDARD_RAIL_ENVIRONMENT`;
- gateway signer and audience;
- provider/gateway origins;
- provider agent id and control profile;
- validity window; and
- runtime-listing/action exact sets.

Ask Daski for a new set when any reviewed contract changes. Do not resign it
with the provider key.

### Runtime listing differs from the installed contract

Paid skills derive from installed service contracts. A promoted runtime head
must reproduce the same service/skill id, contract hash, price, schema,
capacity, deadline, provider intent, and splitter provenance. A foreign,
duplicate, or inconsistent head fails closed.

If boot reports an installed paid skill without a runtime listing, it is not
purchasable yet. Deploy the reviewed AgentCard and run the authorized
`npm run daski:register -- --gateway <origin> [--service <slug>]` workflow.
Do not insert or update catalog rows manually.

If boot logs `listing commitment drift`, the running build publishes a changed
skill contract while the old catalog head is still promoted. Startup remains
non-fatal so the gateway can read the new AgentCard; promptly run the reviewed
re-registration or the gateway will quarantine the service on card refresh.

### Asset-action catalog differs

Every action id, destructive flag, replay policy, schema, service, and validity
must match the signed catalog and servicing admission. A destructive action
also needs a binding confirmation schema/template and delay. Do not downgrade
classification to make the catalog load.

### Provider/gateway audience mismatch

Signed audiences bind exact public origins. `STANDARD_RAIL_PROVIDER_AUDIENCE`
must agree with `BASE_URL`; `STANDARD_RAIL_GATEWAY_ORIGIN` must agree with
`GATEWAY_BASE_URL`. A tunnel URL, staging host, and production host require
separate coordinated configuration when they differ.

## Identity, wallet, and contracts

### Provider identity readiness fails

Confirm the selected chain, `PROVIDER_AGENT_ID`, configured registries, and
wallet address derived from the private key. The canonical IdentityRegistry's
verified `agentWallet` must match. A provider identity cannot be repaired by
changing the service id.

### Registration helper would create or update state unexpectedly

Stop. Both `scripts/register-provider.mjs` and `npm run daski:register` are
mutating. Review their chain, addresses, agent/service ids, origin, wallet,
balances, gateway, and selected service/retirement flags with the onboarding
contact before authorizing them. Doctor and boot never invoke registration.
`npm run daski:register -- --gateway <origin> --check-only` is the read-only
forecast of what a run would do; see
[Gateway registration recovery](#gateway-registration-recovery).

### Identity helper refuses to mint a second agent

The helper finds an existing agent on the canonical IdentityRegistry, not only
through the Daski AgentIndex: a run that stopped between `register()` and the
index claim is found through the wallet's ERC-721 balance and its `Transfer`
events. Only an agent minted to the provider wallet is adopted; an agent
someone else transferred to it is never treated as this provider's
registration. When the wallet holds agents the scan cannot account for within
`--scan-blocks` (default 500,000 blocks), or several minted to it, it stops
without sending anything. It also refuses to mint while any transaction from
the wallet is not yet mined, and it signs a mint at the nonce it read with the
zero balance, so an earlier registration and a new one can never both be
mined. Re-run with `--agent-id <id>`; the id is verified with `ownerOf`
against the provider wallet. `npm run daski:register` forwards `--agent-id`
and `--scan-blocks` to the helper. Never mint a replacement to get past this
message.

### Identity helper reports no `agentWallet`

The canonical registry binds the registering wallet in `register()`, and the
helper only verifies that binding. It no longer calls `walletRotationNonce` or
the former `setAgentWallet` consent flow, which the registry does not expose.
An agent with no bound wallet is a separate, reviewed recovery; the message
names any transaction the run already sent.

### RPC is reachable but reports the wrong chain

Use `--live` to confirm the configured RPC's `eth_chainId`. Testnet requires
Base Sepolia 84532; Mainnet requires Base 8453. Do not mix fallback RPCs from
different chains.

### Testnet transaction lacks funds or finality

Fund only the dedicated Base Sepolia wallet with bounded Testnet assets. Verify
the canonical Testnet USDC and wait for configured confirmations. Do not reduce
finality to make a slow or reorganized transaction appear complete.

### Boot fails during service registration reconciliation

Boot verifies or registers every active service on the ServiceRegistry before
it listens. The 45-second reconcile budget covers chain reads, the signer
lease and local writes; it pauses while a transaction the cycle broadcast is
awaited, and each receipt wait is bounded by the configured confirmations at
Base's block time plus a margin. A first boot that must register several
services therefore fits, while a hung read or lease still fails boot with an
explicit `service registration reconcile exceeded 45000ms` error. A
registration this provider already journaled is resumed while its transaction
is pending, never signed a second time, and journaled writes are marked
settled once their receipts are final. A broadcast refused as `service already
registered`, or a duplicate that reverted because another replica registered
first, is adopted only after the entry reaches the finalized depth and its
identity is verified there. An abandoned cycle persists and broadcasts
nothing, and can never mark a later, failed reconciliation healthy.

## Gateway registration recovery

Re-running `npm run daski:register` is convergent. Each run reads the local
registration record and the gateway's live view of the same registration, then
resumes where the previous run stopped. A record is replaced by a new signed
intent only for a first admission, a changed card of an already promoted
registration, an activation that a changed rail policy or payee left
unpromotable, a registration the gateway ended (`REJECTED` or `SUPERSEDED`)
or no longer knows (`404 REGISTRATION_NOT_FOUND`, for example after its
records were reset), or an intent the gateway never prepared. While the
gateway holds a registration as pending, or as active and promotable, its
persisted intent, preparation, splitter writes and accepted evidence are
kept.

Concurrent runs for one service are safe. Every write to the local record, and
every splitter deployment claim, is fenced on the intent the run planned
under; a run whose intent another run replaced writes and broadcasts nothing
and stops with `another registration run replaced the gateway record`. A
preparation and its splitter rows are stored in one transaction, and a
continued registration restores any splitter row an older record lacks before
it deploys or confirms splitters.

Pausing or resuming a skill never blocks a registration in progress. Skill
availability is mutable card state outside listing identity, and the gateway
keeps the value it prepared with, so only a preparation the gateway made for
the current request is checked against the card's availability.

### Forecast a run first

```bash
npm run daski:register -- --gateway https://<daski-gateway> --check-only
```

The forecast performs the same chain, card, database and gateway reads and
the same recovery decision, verification and promotion cross-check as a run,
then prints one JSON line per active service. It runs no migration, identity
helper or ServiceRegistry bootstrap, opens only read-only database sessions,
sends only gateway `GET` requests, and signs or broadcasts nothing. It exits
non-zero when any service is `BLOCKED` or a promotion would fail.

| State | Meaning |
| --- | --- |
| `ACTIVE` | Registered and unchanged; a run does nothing. |
| `RESUME` | The gateway activated the registration; a run promotes it. `crossCheck` says whether the exact-set check passes. |
| `IN_PROGRESS` | A pending registration continues under its persisted intent; `action` names the evidence step (`replay-accepted-evidence`, `refresh-unaccepted-evidence`, `resubmit-unaccepted-evidence`, `confirm-splitters-and-submit-evidence`), or `post-persisted-intent` for a signed intent the gateway never answered; its `detail` says when that intent binds a previous card, rail policy or payee. |
| `RE-REGISTER` | A run signs a new intent; `changedSkills` lists skills whose contract differs from their promoted head. |
| `BLOCKED` | A run would refuse; `action` and `detail` name the reason. |

### Activation evidence

The gateway accepts evidence once and then honors only an exact replay of that
envelope, also after it expires. In `EVIDENCE_PENDING` the provider replays the
persisted envelope unchanged and never re-signs, refreshes or overwrites it,
including from `ATTENTION`. While the gateway still reports `PREPARED`, no
evidence was accepted: an expired persisted envelope, or one refused once as
`EVIDENCE_AUTH_INVALID`, is re-signed over the same registration, preparation
and original splitter transaction hashes and persisted before it is posted.
Recovery never redeploys or re-signs a splitter transaction; a journaled write
that never reached the mempool is resent with its original signed bytes.

Activation polling defaults to every 20 seconds, and gateway `429` answers are
retried with bounded backoff that honors `Retry-After`. See
[Configuration](configuration.md#provider-wallet-and-registration).

### Registration in `ATTENTION`

The record's `last_error_code` says why a run stopped. Diagnostics name
skills, listing ids, commitment fields and public hashes only, never a signed
body or secret.

| Code | Next run |
| --- | --- |
| `runtime_commitment_mismatch` | The gateway activated, but its reported runtime commitments differ from the local resolution; the error names each listing with the expected and reported hash. While the gateway still reports `ACTIVE`, a run resumes promotion with the persisted intent and signs or broadcasts nothing. A repeated mismatch needs Daski review. |
| `reused_listing_drift` | A listing the gateway reused no longer reproduces its admitted commitment (the error names the differing fields), or it is a free listing without a control profile and no promoted head exists for it. This is identity drift and is refused; do not edit catalog rows. |
| `prepared_registration_drift`, `gateway_registration_rejected`, `gateway_registration_superseded` | The gateway ended the registration; a run starts a new intent and logs the restart. |
| `gateway_registration_not_found` | The gateway holds no registration under the persisted id; nothing is pending there, so a run starts a new intent and logs the restart. |
| `intent_expired_before_prepare`, `intent_superseded_before_prepare` | The gateway refused the persisted intent as expired, or as bound to a card, rail policy or payee the provider no longer serves. It checks a replay first, so it never prepared that intent; a run signs a new one, within a bounded attempt budget. |
| `activated_registration_stale` | The gateway activated the registration, but the rail policy or the provider payee changed before it was promoted, so it can never be promoted. A run signs a new intent; the gateway prepares a superseding registration that reuses no listing, and the restart is logged. |
| `rail_policy_changed_during_prepare`, `payee_changed_during_registration`, `prepared_registration_changed` | The pending registration no longer matches the gateway's policy, the provider payee or its own persisted preparation. It cannot continue; restore the previous payee, or ask Daski to end it. |

A signed intent the gateway never answered is posted again under its
idempotency key before anything replaces it, also after the card, rail policy
or payee changed, because only the gateway's answer says whether it prepared
that intent. If it did, the run keeps the intent and stops with
`card_changed_during_registration`, `rail_policy_changed_during_prepare` or
`payee_changed_during_registration`, naming the registration the gateway holds
and its state.

A run also stops without changing state when the served card changed while a
registration is pending (`card_changed_during_registration`) or activated but
unpromoted (`activated_registration_unpromoted`; publish the registered card
again, let the run promote it, then deploy the change), when the gateway holds
accepted evidence this provider never persisted
(`accepted_evidence_not_persisted`), or when the gateway answers a registration
admitted under an intent this provider did not persist. Report these to Daski
rather than deleting local records.

## Service, API, and MCP integration

### Service folder is not registered

Add exactly one import/entry in `src/providerServices.ts`. Do not import the
service from core or another service. Remove incomplete copied folders before
Testnet or keep them outside `src/services` while drafting.

### Quote succeeds but execute rejects input

Quote and execute must call the same deterministic validation. Keep validation
in one service module and test exact Unicode code-point boundaries,
normalization, and conditional requirements.

### API authentication fails

Check the service's environment selection and secret source without printing
the token. Confirm Testnet uses the sandbox credential and exact reviewed API
origin. Validate only safe status/error classes; do not expose response bodies.

### MCP tool cannot be found

The client must use an explicit allowlist of reviewed tool names. Confirm the
product server version and mapping in code. Do not fall back to whatever tool
name the buyer requests or dynamically execute the server's advertised list.

### Upstream response schema changed

Fail closed, park/review active work as appropriate, and update the service
client, validation, docs, and tests together. Do not accept an unknown response
shape into artifacts or lifecycle state.

### External call timed out after a mutation

Treat the result as ambiguous. Keep the journal entry and stable idempotency
key, then query authoritative product state. Do not blindly retry, refund,
complete, or fail the task until the mutation is reconciled.

### Worker readiness is stale

Check the declared worker id, durable job queue, leases, heartbeat age,
dead-letter/review state, and product dependency. Restarting a process must
resume the same job; it must not repeat the original supplier mutation.

The provider-write reconciler runs on every replica behind one cycle lease. A
lease held by another replica's live session counts as a healthy cycle, so a
rolling deploy stays ready, and ticks are jittered so replicas cannot
phase-lock. A lease observed busy for more than five minutes is treated as a
stuck peer and reported not ready, as are a failed cycle and active nonce-gap
recovery. A busy lease never clears a failure or nonce gap this replica saw in
its own last cycle; only its own next clear cycle does.

## HTTP, proxy, and health behavior

### `/health/live` passes but `/health/ready` fails

This is expected when the process exists but a required database, identity,
catalog, rail, product, or worker invariant is unhealthy. Route no admitted
traffic until readiness recovers. Use the readiness details and service
invariants; do not configure the load balancer against liveness.

### Client IP, rate limit, or SIWE domain is wrong behind a proxy

Set the exact trusted hop count and narrow proxy CIDRs for the actual platform.
Confirm it strips untrusted forwarded headers at the edge. Do not trust all
proxies or use broad CIDRs as a convenience.

### Public provider fails the live doctor probe

Confirm DNS, TLS certificate, public path routing, `BASE_URL`, container port,
and the process's liveness. A health proxy must not rewrite the signed public
origin or bypass readiness for normal traffic.

## Mainnet

### Mainnet refuses the dummy

This is permanent by design. Replace/remove `src/services/dummy`, its outcome,
offline-only integration, and any dummy docs before the production release.

### All technical checks pass but Mainnet is still blocked

Mainnet requires explicit Daski whitelisting and coordinated release approval.
Request it through the [Daski Discord](https://discord.gg/uyeMp7Q2HW). Do not
add a local flag or infer approval from Testnet success.

## Safe support bundle

When asking Daski or your own operator team for help, provide only:

- repository commit/tag and public `DEPLOYMENT_REVISION`;
- doctor stage, stable codes, and redacted JSON output;
- Node/PostgreSQL major versions;
- public chain id, provider origin, provider agent id, and reviewed public
  contract addresses when relevant;
- service/skill/outcome/action ids;
- safe request/order identifiers approved for the support channel; and
- a concise timeline and expected/observed state.

Never provide `.env`, private keys, admin/API/webhook tokens, signed buyer
authorizations, protected payloads, customer data, supplier account material,
private policy, database dumps, or raw runtime/supplier logs.

For a suspected vulnerability, follow [SECURITY.md](../SECURITY.md) and use a
private security channel rather than normal support.
