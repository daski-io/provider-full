# Testnet and Mainnet onboarding

Daski provider admission is a coordinated product and protocol review. Code
that builds locally is not automatically listed, and signed artifacts do not
by themselves grant Mainnet access.

Start on Testnet. Mainnet is a separate whitelisted release requested through
the [Daski Discord](https://discord.gg/uyeMp7Q2HW).

## Shared vocabulary

| Term | Meaning |
| --- | --- |
| Provider | Your organization and one ERC-8004 identity/wallet binding |
| Supplier | The upstream API, MCP server, or product vendor used by the provider, even when your organization owns it |
| Service | One coherent product boundary published by the provider |
| Skill | One buyer-visible operation within a service |
| Runtime listing | Reviewed paid listing/payment coordinate for a skill |
| Asset | Durable product object owned by the wallet-authorized payer |
| Asset action | Reviewed owner-only operation on an existing asset |
| Gateway | Daski entrypoint that discovers providers, admits payment, and signs dispatch/lifecycle calls |
| Signed artifacts | Daski-issued global-policy, servicing-admission, action-catalog, and gateway preparation envelopes |

One provider can publish several services. A provider agent id is not a service
id, and a runtime listing binds one service/skill contract version.

## Who supplies what

| Provider supplies | Daski/onboarding supplies or confirms |
| --- | --- |
| Legal identity, website, terms, privacy, support, and public HTTPS origin | Current marketplace legal links and onboarding contact |
| Service manifest, skill docs, request schemas, examples, pricing behavior, lifecycle, actions, and tests | Taxonomy/service-type review and listing/admission decision |
| Dedicated provider wallet and intended ERC-8004 identity | Current registries, index coordinates, signer bindings, and registration expectations |
| Product mock/sandbox/charged-test/live modes, credentials, readiness, operations, and incident contacts | Testnet gateway origin and standard-rail environment bindings |
| Provider payee/custody facts and any externally controlled wallets | Global rail policy, control profile, evidence coordinates, and signed release artifacts |
| Deployed provider and successful end-to-end Testnet evidence | Mainnet whitelist and coordinated release approval |

Providers must not invent, edit, compress differently, resign, or work around
validation of Daski-issued artifacts. Ask onboarding to issue a new consistent
set when the service contract changes.

## Prepare the review packet

Send a concise, versioned packet before expecting signed configuration:

1. provider legal/public identity and support contact;
2. intended public provider HTTPS origin;
3. service slug, version, description, category family, coordinated service
   type, jurisdictions, fulfillment mode, and turnaround;
4. every skill id, description, example, required/optional field, bound,
   conditional rule, and human-party requirement;
5. fixed or dynamic pricing behavior in atomic USDC;
6. exact request schema used by quote and execute;
7. one-shot or durable fulfillment, dependencies, timing, cancellation, and
   failure behavior;
8. provisioned asset types, identifiers, lifecycle, and ownership behavior;
9. each proposed owner action, including destructive and replay
   classifications;
10. product API/MCP origin/tool mapping, mock/sandbox/charged-test/live
    separation, any bounded Testnet campaign, idempotency, ambiguity
    reconciliation, and readiness evidence;
11. protected data, retention, redaction, compliance/custody dependencies, and
    human review boundaries; and
12. provider payee, provider-controlled wallets, capacity/deadlines, and the
    proposed paid skills, capacity, deadlines, and action definitions.

The checked-in service docs and tests should be the review packet's technical
source, not a separate specification that can drift.

## Testnet onboarding

### 1. Define the product contract

Complete the worksheet in
[Integrating an existing product](integrating-existing-product.md). Agree on
service, skill, runtime-listing, asset, and action boundaries before hardening the
adapter around unstable ids.

### 2. Implement the service locally

Replace the dummy with the product-backed `ServiceModule`, co-located docs and
tests, service configuration, clients, migrations, workers, and readiness
facets actually required by the product.

Keep a supplier sandbox or explicit fake for automated tests. Mainnet must be
incapable of selecting any non-live product mode.

If Testnet must use a real upstream account, identify every possible charge,
external record, message, and human side effect before enabling it. Require an
explicit charged-test mode and a durable campaign that freezes the admitted
payer/skills, small count limit, aggregate supplier-cost cap, and upstream
account identity. See
[Integrating an existing product](integrating-existing-product.md#product-environments-and-chargeable-testnet-campaigns).

### 3. Submit and review the packet

Daski reviews discovery taxonomy, request/price behavior, standard-rail
listings, assets/actions, evidence, and operational/security posture. Resolve
contract changes in code, docs, tests, and the packet together.

### 4. Establish public origins

Deploy or tunnel a stable provider HTTPS origin. Confirm the gateway and
provider origins before artifact issuance. Audiences are signed bindings;
localhost and a later public host are not interchangeable.

The upstream Dockerfile is hosting-neutral. Your fork owns its platform
configuration and must use `/health/ready` for traffic activation.

### 5. Receive one consistent Testnet set

Install the Base Sepolia coordinates, gateway signer/audiences, provider
control profile, signed global rail policy, servicing admission, and action
catalog exactly as issued. Check expiry and environment. Never combine fields
from separate revisions. Per-skill runtime listings are created and promoted
by the registration flow rather than copied into an environment variable.

### 6. Prepare the Testnet wallet

Use a dedicated Base Sepolia wallet, separate from Mainnet and from the data
encryption key. Fund only the bounded Testnet ETH/USDC needed for registration
and exercises. The official Base documentation maintains a current list of
[Base Sepolia network faucets](https://docs.base.org/base-chain/network-information/network-faucets)
for Testnet funds. Retain the wallet in an approved secret manager.

### 7. Run staged doctor

```bash
npm run doctor -- --stage=testnet
```

This validates the local schema, stage, audiences, signatures, promoted
runtime-listing/action sets, service references, and read-only database connectivity.
Fix every failure. Warnings should have an explicit owner and reason.

### 8. Register identity and services when authorized

After Daski confirms the coordinates, origin, and intended identity, build and
review the registration helper:

```bash
npm run build
node --env-file=.env scripts/register-provider.mjs
```

This is a chain mutation. It may register the ERC-8004 agent, bind the wallet,
claim the Daski index entry, and pay a listing fee. Verify the displayed chain,
contracts, signer, origin, and funded wallet before authorizing it. Put the
minted/bound id in `PROVIDER_AGENT_ID`.

After setting the minted/bound id, deploy the candidate so the gateway can read
its AgentCards. Then register active service contracts:

```bash
npm run daski:register -- --gateway https://<daski-testnet-gateway>
```

This second command signs provider intent, verifies gateway preparations,
persists splitter writes before broadcast, submits activation evidence,
cross-checks runtime commitments, and atomically promotes catalog heads. Use
`--service <slug>` only for an intentional narrowed run. Both commands are
external mutations; doctor and boot invoke neither.

### 9. Prove deployed readiness and discovery

Verify the deployed candidate:

```bash
npm run doctor -- --stage=testnet --live
```

Inspect its public surfaces:

- `/health/live` and `/health/ready`;
- `/.well-known/agent.json` and
  `/.well-known/agent-registration.json`;
- `/agent-cards/<slug>.json`;
- `/skills/<slug>.md` and skill documents; and
- `/llms.txt`.

Legal metadata, service/skill ids, pricing, lifecycle, support, and origins
must match the reviewed packet.

### 10. Exercise the full Testnet journey

Through the Daski gateway, test at least:

1. provider/service discovery;
2. an admitted open free skill, if the service has one;
3. invalid quote input and structured field errors;
4. a successful exact quote;
5. one paid purchase and signed dispatch;
6. durable status and terminal artifacts;
7. standard evidence and reputation outcome;
8. asset ownership lookup, when applicable;
9. every owner action, including delayed destructive confirmation;
10. cancellation before/after irreversible product boundaries;
11. provider restart during an active job/mutation;
12. ambiguous supplier/product response and authoritative reconciliation; and
13. readiness failure/recovery for required product dependencies and workers.

Keep Testnet identities, product accounts, and spend bounded. When upstream
effects are real, retain the durable campaign binding and its non-sensitive
audit evidence. Reconcile an ambiguous payment or mutation before retrying.

### 11. Capture safe evidence

Retain commit/image digest, public deployment revision, doctor check codes,
request ids safe for support, on-chain public coordinates, and redacted test
results. Do not retain or share `.env`, private keys, API tokens, customer
payloads, signed authorization material, or raw supplier responses as release
evidence.

## Testnet completion criteria

- Local and CI gates pass from a clean clone.
- Doctor Testnet has no failures.
- The deployed candidate stays ready under expected workers/dependencies.
- Discovery and docs match the reviewed contract.
- Free and paid gateway paths behave as documented.
- Evidence, ownership, actions, cancellation, restart, and ambiguity paths are
  exercised where applicable.
- No dummy or provider-specific fixture is part of the real service path.
- Daski confirms Testnet review completion.

Testnet completion is required for Mainnet consideration. It is not Mainnet
approval.

## Mainnet onboarding and whitelist

Mainnet is not self-service. Ask for whitelisting through the
[Daski Discord](https://discord.gg/uyeMp7Q2HW) and provide the completed
Testnet evidence plus the proposed immutable release commit.

Do not add a local `MAINNET_ENABLED` or whitelist flag. No repository value,
doctor result, signed artifact, contract deployment, or successful Testnet
purchase can grant Daski Mainnet admission.

### Mainnet separation

Create separate Mainnet resources:

- provider wallet and custody controls;
- database and backups;
- protected-data/admin/webhook secrets;
- product live account and credentials;
- RPC and monitoring;
- HTTPS origin when environments are separated;
- signed standard-rail artifacts; and
- incident, support, and business-continuity procedures.

Never promote the Testnet database, wallet key, supplier account, encryption
key, or signed artifacts into Mainnet.

### Mainnet technical gates

Before requesting the final release:

- remove `src/services/dummy` and register the real service listings;
- use Base chain id 8453 and `NODE_ENV=production`;
- refuse mock, sandbox, and charged-test product modes in every service;
- use canonical reviewed contracts and USDC;
- use verified database TLS and distinct migration/runtime roles;
- verify trusted proxies, narrow CIDRs, and edge request limiting;
- configure webhook authentication and protected-data rotation/recovery;
- prove live product credentials, workers, custody, compliance, and readiness;
- complete adversarial action/payment/replay/concurrency/ambiguity tests;
- run `npm run doctor -- --stage=mainnet` and every release gate; and
- obtain explicit Daski whitelist and coordinated release approval.

Doctor deliberately emits `MAINNET_WHITELIST_REQUIRED` because that manual
external gate cannot be proven by the repository.

## Changes that require renewed coordination

Contact onboarding before changing a reviewed:

- public provider or gateway audience/origin;
- provider identity/wallet or payee;
- service, skill, runtime-listing, asset, or action id;
- request, response, confirmation, or evidence schema;
- fixed/dynamic price mode, commission, deadline, or capacity;
- action destructiveness or replay policy;
- provider control profile, contract, signer, or evidence source; or
- product behavior that changes custody, compliance, protected data, or
  fulfillment guarantees.

Treat a coordinated artifact revision as one atomic set. Keep the previous
release available until the new candidate has passed Testnet and the intended
environment's approval process.
