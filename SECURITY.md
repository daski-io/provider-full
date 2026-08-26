# Security model

This document describes the reusable security boundaries in the Daski provider
starter and the obligations of a provider that adds a real service.

## Reporting a vulnerability

For this upstream starter, open a
[private GitHub security advisory](https://github.com/daski-io/provider-full/security/advisories/new).
Do not put exploit details, credentials, customer data, protected payloads, or
affected transaction identifiers in a public issue.

Include the affected commit, chain/environment, reproduction conditions, and
the smallest safe proof needed to validate the finding.

Providers who fork this repository must replace this destination with a
private security channel they operate. Report vulnerabilities in a provider's
deployment or customer/supplier data to that provider, not to this upstream
starter.

## Threat model

- The published A2A and discovery transport is public.
- Wallet addresses, contract events, and provider identity are observable and
  are bindings, not secrets.
- Buyer input, email, supplier responses, webhooks, and model output are
  untrusted.
- An external mutation can succeed even when its response times out.
- Operator authority is powerful and must remain authenticated, scoped,
  confirmed, and audited.
- A provider deployment can be compromised even when contracts and the Daski
  gateway are correct.

## Authorization invariants

All paid work enters through the Daski gateway. Only explicitly declared open,
free reads may be called anonymously.

| Concern | Required mechanism |
| --- | --- |
| Wallet authority | Recover the exact wallet authorization and match the expected payer, request, action, audience, and lifetime. |
| Gateway authority | Verify the configured gateway signer and independently signed provider grant. |
| Payment | Verify finalized standard dispatch and release evidence bound to provider, service, skill, payer, amount, recipe, and order. |
| Replay | Atomically consume wallet, provider-grant, dispatch, and envelope nonces in PostgreSQL. |
| Ownership | Resolve the normalized payer wallet from stored ownership; never trust caller ownership metadata. |
| Consequential action | Require an admitted owner-only action from the signed catalog. |
| Destructive action | Require a delayed, separately signed confirm/cancel step bound to the exact preview and request. |

An order handle, transaction hash, asset identifier, provider agent id, or
caller-supplied wallet address is never sufficient authorization.

The provider continuously checks its ERC-8004 identity and wallet binding.
Failed, stale, or mismatched checks make readiness fail and reject protected
traffic.

## State, money, and supplier safety

- Use conditional database writes, transactions, leases, idempotency keys, and
  fencing for financial and lifecycle state.
- Persist signed chain writes before broadcast and reconcile them after a
  restart.
- Journal external mutation intent before calling a supplier when retrying
  could duplicate spend or effects.
- Treat timeout/connection loss after dispatch as ambiguous. Reconcile
  supplier truth before retrying or deciding success/failure.
- Keep retries bounded and use circuit breakers for supplier outages.
- Never make a process-local lock the only guard for money, ownership, or an
  external mutation.
- Return stable internal error codes. Supplier-controlled text must not reach
  public errors or logs.

Every real service must add tests for concurrent attempts, replay, mismatched
bindings, ambiguous supplier responses, and cancellation at each irreversible
boundary it introduces.

## Protected data

- Collect the minimum data needed to fulfill the selected skill.
- Encrypt protected values with the versioned core envelope and a key separate
  from the provider signing key.
- Declare service-owned rotation sinks and protected asset-identifier schemes.
- Redact secrets and personal data before prompts, reviews, logs, metrics,
  errors, events, or public artifacts.
- Apply explicit retention and legal-hold behavior to service-owned tables.
- Do not commit credentials, customer records, supplier account material,
  private screening policy, or raw runtime output.

Screening is an optional provider extension. A service declares only the
subjects and scopes it needs; it must not import a vendor or decide provider
policy. If a service requires screening, registration and readiness must fail
closed when a compatible extension or current policy is unavailable.

## Network and HTTP boundaries

- Provider supplier integrations must use reviewed, pinned HTTPS endpoints and
  the core outbound HTTP/SSRF controls. Do not call `fetch` directly from a
  service.
- Bound request bodies, response sizes, redirects, concurrency, and timeouts.
- Resolve and re-check webhook/push destinations to resist DNS rebinding.
- Browser admin writes require SIWE session authorization, exact-origin and
  CSRF checks, and confirmation for consequential actions.
- JSON admin routes use the separate high-entropy `ADMIN_TOKEN`.
- Webhooks require a configured secret; credentials in query strings are
  rejected.
- Production depends on an edge rate limiter in addition to process-local
  limits.

## Deployment

Testnet and mainnet must use separate wallets, databases, keys, supplier
accounts, and signed artifacts. Testnet is the mandatory first integration
target. Run `npm run doctor -- --stage=testnet` before requesting onboarding;
the command is read-only and never grants admission or replaces Daski review.

A production deployment requires HTTPS, verified database TLS, a distinct
migration role, protected-data key management, trusted proxy configuration,
edge rate limiting, current identity/catalog/rail checks, and monitored
readiness. Each real service must add fail-closed mainnet checks for live
supplier mode, credentials, custody, and governance relevant to that service.
Base Mainnet provider admission is allowlisted. After completing Testnet
evidence and the provider security checklist, request Mainnet whitelisting in
the official Daski Discord; never copy Testnet artifacts or treat a successful
local check as approval.

The dummy service cannot run on Base mainnet.

## Required adversarial coverage

For every new paid or owner-only path, test at least:

1. the valid signed request;
2. unauthorized and wrong-provider signers;
3. changed payer, service, skill, request, audience, action, or catalog fields;
4. expired and future-dated envelopes;
5. each nonce replay;
6. signer/identity lookup failure;
7. concurrent attempts with exactly one winner;
8. ambiguous supplier and chain outcomes;
9. cancellation after each irreversible boundary; and
10. public error/log redaction.

Destructive actions additionally require delay, second-authorization,
confirm/cancel race, mismatch, expiry, and replay cases.

## Limitations

- Replay ledgers and fulfillment state are provider-operated PostgreSQL state.
  A fully compromised provider can corrupt them.
- Open free reads are anonymous and must be rate-limited.
- External suppliers, RPC endpoints, email providers, and model APIs remain
  trusted dependencies within their bounded interfaces.
- This starter supplies technical controls, not a provider's legal,
  compliance, custody, supplier, incident-response, or business-continuity
  program.
