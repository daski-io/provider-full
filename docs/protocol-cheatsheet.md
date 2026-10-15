# Standard-rail protocol cheatsheet

The provider accepts paid work only through the standard Exact-EVM rail.

## Payment and dispatch

1. The gateway obtains a provider-signed quote for a promoted runtime listing.
2. The buyer signs an EIP-3009 `transferWithAuthorization` for exact USDC.
3. The facilitator submits that authorization directly to the listing's
   immutable splitter.
4. The gateway independently verifies the deposit event and sends a signed,
   recipe-bound dispatch to the provider.
5. The provider verifies the gateway signer, audience, order, quote, request
   hash, policy hashes, deadlines, and replay state before fulfillment. For
   both pricing modes it loads the persisted provider quote named by the
   nonzero `providerQuoteHash` and checks its outcome, listing, request,
   price, pricing mode and payer (compared as an address; a `null` quote
   payer admits any payer), and that its window covers the gateway quote.
   Settlement time is proven by the authenticated deposit block timestamp
   inside the gateway quote window. There is no provider-side quote-age cap:
   the gateway may dispatch a timely-paid order with a fresh envelope long
   after the quote expired.
6. Provider terminal attestations and chain evidence drive the gateway order
   state machine. Launch payments are not automatically reversed after release.

There is no provider payment endpoint, local facilitator, native settlement
router, or alternate payment-rail selector.

## Published skill contracts

Each paid skill's AgentCard contract carries exactly the gateway's closed key
set `inputSchema, resultSchema, pricing, paymentRequired,
requiresAssetOwnership, assetType, fulfillmentMode, purchaseReadiness,
capacity, deadlines, assetAction`; the gateway refuses a registration missing
any of them. `purchaseReadiness` is always `null` (no payer-DNS purchase
prerequisite in generic core) and `deadlines` always names both
`dispatchSeconds` (default 300) and `fulfillmentSeconds` (default 2,592,000).
Registration refuses `fulfillmentSeconds < dispatchSeconds + 300`: a lost
initial dispatch is replaced only after `validBefore + 60 s`, answered within
the 120-second synchronous budget, plus a reviewed 120-second margin, and the
gateway stops re-dispatching `fulfillmentSeconds` after it observed the
release. Every key is hashed into `skillContractHash`; a changed contract is a
new version that re-registers through `npm run daski:register`.

## Direct A2A methods

`POST /a2a/:serviceSlug` accepts JSON-RPC `SendMessage` only for admitted,
open, free skills. `GetTask` polls a public free task when the initial call
does not return a terminal result. `SubscribeToTask` and `ListTasks` return
an explicit unsupported-operation error; `CancelTask` and push-configuration
methods are not implemented and AgentCards advertise push as unavailable.
Paid and order-bound work always enters through
the Daski gateway and standard rail.

## Provider endpoints

- `GET /health/live`
- `GET /health/ready` (200 while persisted reads can be served; body names
  `reads`, `admission` and `servicing` with stable codes)
- `GET /health/admission` (200 only while new sales are admitted)
- `GET /.well-known/agent.json`
- `GET /agent-cards/<slug>.json`, the same card at
  `/agent-cards/<slug>.json/.well-known/agent-card.json`
- `POST /standard-rail/quote`
- `POST /standard-rail/dispatch`
- lifecycle, outcome, and evidence operations under `/standard-rail`

The exact schemas are defined in `src/core/standardRail/schema.ts` and
`src/core/standardRail/types.ts`. Treat signatures and hash fields as opaque
protocol commitments; callers must canonicalize exactly as the gateway does.

## Transport

Every `POST`/`PUT` under `/standard-rail` must be uncompressed
`application/json` (no `Content-Encoding` other than `identity`, UTF-8 only).
Bodies are bounded (2 MiB; 16 KiB for `/dispatch/status`), decoded as strict
UTF-8, and rejected before any handler runs when they contain a duplicate key
at any depth, a `__proto__`/`constructor`/`prototype` key, a key longer than
256 characters, more than 64 levels of nesting, or more than 262,144 values.
Those refusals are `400 {"error":"invalid_json"}`,
`413 {"error":"request_too_large"}`, or
`415 {"error":"uncompressed_application_json_required"}`.

Answers are plain `application/json`; the starter installs no compression
middleware. Signed answers carry `Cache-Control: no-store`: they are built and
signed for each request and never cached.

## Quotes and intake

The gateway posts `{"request": envelope}` to the quote URL for fixed and
dynamic listings alike. Each handler checks the artifact type and schema
version first, then the environment, chain, provider audience, the
`gateway-dispatch` signer key id and freshness, and only then the signature;
several envelope types share that key. Only the canonical signature encoding
the gateway emits is accepted (lowercase hex, `v` of `1b`/`1c`, low `s`), so a
re-encoded copy of a signature can never become a second dispatch identity.

- `ProviderQuoteRequestV1` carries exactly `outcomeId`,
  `listingManifestHash`, `requestHash`, `request` and `payer` (lowercase hex,
  or `null` for a payer-unbound readiness check). The answer has exactly
  `outcomeId`, `listingManifestHash`, `requestHash`, `grossAmount`, `payer`,
  `issuedAt`, `validBefore` and `signature`, where `payer` echoes the request
  literally and the signature is EIP-191 over the canonical hash of the other
  seven fields. That hash is the gateway's nonzero `providerQuoteHash`.
- A fixed listing's amount is always its admitted price; the service may
  decline the request but never change the price. Fixed quotes live 120 s;
  dynamic quotes use the admitted quote policy capped at 180 s. Both leave at
  least 60 s above the 30 s minimum payment window the gateway requires,
  strictly, at receipt.
- Before signing, core validates the request schema and bounds, service
  availability (sales paused stops quotes), this process's new-sale admission
  (the `admission` part of `/health/ready`), a fresh proof of the rail
  contracts, open paid work for the listing version against its capacity, the
  service `quote()`, a supplier-cost ceiling if one is returned, and the
  optional read-only `requestReadiness` hook. The quote is persisted with its payer, pricing mode, price, request,
  listing and window before it is signed. A quote never starts or reserves
  product work.
- `ProviderIntakeRequestV1` (payload without `payer`) returns the signed
  intake contract: `requestSchema`, `requiredFields`, `selectorsRequired`,
  `normalizedSelectors`, `fieldErrors`, `supported`, `issuedAt`,
  `validBefore` (60 s). It stores, prices and starts nothing.

Refusals are bounded JSON. `4xx {"error":"quote_rejected","reason":...}`
declines the request (`envelope`, `envelope_lifetime`, `signature`,
`outcome_policy`, `request_invalid`, `price`); `request_invalid` adds
`fieldErrors: [{path, rule, message, allowedValues?}]` derived from the schema
or from reviewed service text, never from submitted values.
`503 {"error":"quote_unavailable","reason":...}` means retry later
(`service_unavailable`, `capacity`, `readiness_unavailable`, `price`,
`unavailable`).

## Dispatch and status answers

`POST /standard-rail/dispatch` and `POST /standard-rail/dispatch/status`
answer with exactly `taskId`, `dispatchHash`, `signature`, `state` and
`operations`, plus `terminalAttestation` only for `completed`, `failed` and
`canceled`. `state` is one of `dispatching`, `submitted`, `working`,
`input-required`, `completed`, `failed`, `canceled`; no inline `result` is
returned.

- `signature` is EIP-191 by the provider authority key over the canonical
  hash of `{taskId, dispatchHash, state, operations}`.
- `operations` is `{schemaVersion: 1, revision, observedAt, fulfillment,
  support, recovery}`. The semantic projection and its revision are persisted
  with the claim (core migration 004); `fulfillment` and `recovery` are always
  `null` in this starter, `support` appears once a support receipt exists,
  and all-null content keeps revision 0 forever. A database trigger requires
  a higher revision for any content change and refuses a revision change
  without one.
- `observedAt` is the database clock at the moment of the read. Every answer
  is built and signed for its request: the gateway accepts observations at
  most 300 s old and 30 s in the future, so a cached signed body goes stale.
- `terminalAttestation` is `{payload: {taskId, dispatchHash, state,
  resultHash, completedAt}, signature}` signed by the terminal attestation
  key over the canonical payload hash; `completedAt` is the task's completion
  time.

A status read is one SELECT plus signing: it writes nothing, calls no
product, and rebuilds no history for a pending order.

## Dispatch outcomes

Accepted work is keyed by gateway audience and order. Its request, payer,
provider-quote and dispatch bindings are immutable and a claim is never
deleted (core migration 005). Every dispatch ends in exactly one of three
outcomes:

| Provider knowledge | Answer |
| --- | --- |
| Definite refusal before any admission, re-confirmed by an authoritative claim probe | `409 {"error":"dispatch_rejected","reason":...}` (`503` for `service_unavailable`); the gateway later sends a new envelope |
| A claim exists for this exact envelope | `200` with the signed snapshot, even after the envelope expired |
| Admission exists for another envelope, the commit outcome is unknown, or admitted work cannot be rendered | empty `503` (no body, `Retry-After`); the gateway reconciles by status with the original hash |

Refusal reasons are `validator`, `envelope_lifetime`, `signature`,
`outcome_policy`, `self_purchase`, `quote_window`, `price`, `evidence` and
`service_unavailable`. `quote_window` covers a forwarded QuoteV1 the signed
dispatch does not bind or that names a provider quote this provider never
persisted; `price` covers a persisted quote that does not bind this order.
No route or middleware turns a possibly-admitted dispatch into a JSON error.

- The forwarded QuoteV1's shape, its hash binding into the signed dispatch and
  its `gateway-quote` signature are verified offline before any claim is
  looked up; an exact replay always carries the identical quote.
- An authenticated envelope that has expired is still checked, read-only, for
  an exact replay of an admitted claim before it is refused, so a duplicate
  delivery of admitted work receives its signed snapshot.

- Admission runs under a per-order transaction advisory lock. As its last
  statement before commit it rechecks `validBefore` against the database
  clock, so no claim commits at or after expiry however slowly the request
  arrived. If the commit acknowledgement is lost, the request probes the
  claim and continues only when the claim carries its own task id.
- A different envelope for an admitted order is recorded as a security
  incident and answered with the empty 503; it never replaces the claim.
- A funded dispatch is never refused because sales are paused, the skill row
  is inactive, or open work exceeds the listing's capacity: the gateway
  reserves capacity per listing version from payment, and new readiness
  quotes stop instead.
- Fulfilment in this starter is synchronous, so while a service's declared
  readiness invariants fail a fresh dispatch is refused before admission with
  `service_unavailable`; the gateway retries it with a new envelope rather
  than the provider signing a failure during the outage.
- Once the service was called, only its own failed result, a supplier's
  typed rejection (`SupplierClientError` classified `supplier_rejected`) or
  the admitted cost ceiling's refusal becomes a signed terminal failure. Any other exception from the call (an
  ambiguous supplier outcome, a timeout, abort or infrastructure failure, or
  an unrecognized error such as an unparseable response) leaves the task
  `working` and flagged `standard_reconciliation_required` (with an
  `ambiguous_supplier_outcome` incident). If persisting the service's own
  answer fails, the answer is never rewritten as a failure; the dispatch is
  answered ambiguously and status reports the persisted state.

## Status outcomes

`/dispatch/status` verifies the signed `DispatchStatusQueryV1` (artifact type,
domain, `gateway-dispatch` key id, freshness, signature) before reading any
claim. Exactly `404 {"error":"dispatch_status_unavailable","reason":"outcome_policy"}`
means "no claim": it is returned only after an authoritative probe found no
claim for (gateway audience, order) while holding the order's admission lock.
Every other failure leaves the dispatch unknown:

| Condition | Answer |
| --- | --- |
| Malformed body or query, stale or wrong-domain envelope | `400 {"error":"dispatch_status_rejected","reason":"validator"\|"envelope_lifetime"}` |
| Bad signature | `401 {"error":"dispatch_status_rejected","reason":"signature"}` |
| A claim exists for a different dispatch hash | `409 {"error":"dispatch_status_unavailable","reason":"dispatch_conflict"}` |
| Admission in flight | `503 {"error":"dispatch_status_unavailable","reason":"admission_in_progress"}` |
| Database or signing failure | `503 {"error":"dispatch_status_unavailable","reason":"unavailable"}` |

Status reads are exempt from the per-client and purchase rate limits (the
gateway polls about every ten seconds for an order's whole life); the process
concurrency budget, the 16 KiB body bound and signature verification still
apply. A client whose status queries fail authentication 30 times within a
minute is answered `429 {"error":"rate_limit_exceeded"}` before any signature
recovery until the minute passes; verified reads and `RATE_LIMIT_BYPASS_IPS`
never consume that budget. The terminal
`resultHash` comes from the frozen terminal-result store described below.

## Lifecycle actions

The gateway proxies every buyer order action to `POST /standard-rail/lifecycle`
with exactly `orderId`, `providerTaskId`, `action`, `request`,
`authorization`, `grant`, `payer` and `gatewayAudience`. Every call is
authenticated before anything is read:

1. the `ProviderLifecycleGrantV1` grant: artifact type and schema version,
   environment, chain, provider audience, the `gateway-lifecycle` key id and
   key, at most 120 s of validity, and its bindings to this exact order, task,
   action, request hash, authorization hash, payer and gateway audience;
2. then the authorization. `{"type":"DaskiReadCap","scope":<action>}` is the
   gateway's own attestation of a read capability: it authorizes a `status` or
   `artifact` read of exactly that scope and nothing else, and consumes no
   nonce. Otherwise it is the payer's nine-field `OrderActionAuthorizationV1`,
   verified (EOA offline, or a configured ERC-1271 account) against the payer
   the grant attests; its nonce is consumed only after it verified.

Answers have exactly `orderId`, `taskId`, `state`, `operations` and
`signature`, plus `terminalAttestation` (`{orderId, taskId, state,
resultHash, completedAt}`, the frozen terminal identity) once terminal and
`result` where allowed. `status` never carries a result. `artifact` carries
the frozen projection of a completed order: unrevealed under a read
capability, with its frozen protected references revealed under the payer's
fresh signature. An `input` that completes the order carries the frozen
unrevealed projection, whose hash the attestation signs. `operations` is
observed afresh and signed per answer, as for dispatch. No `inputRequest` or
`documents` view is added, whether or not `daski-order-status-view` asks.

`support` takes exactly `{requestId, message}`: the gateway's business
`requestId` (1 to 128 of `A-Za-z0-9_-`, kept by the buyer across retries) and
1 to 4,000 non-blank characters without control characters other than tab and
line breaks. It is deduplicated by order, payer and `requestId`, bound to the
hash of the request (core migration 007): a retry with the same body under a
fresh authorization returns the original receipt, while different content
under the same `requestId` is `action_conflict`. A new request records the
protected buyer message (never part of the task projection), opens or joins
the order's human support Review (`standard_order_support`), and publishes
`operations.support = {reviewId, status: "open", lastAcceptedRequest:
{requestId, messageId, acceptedAt}}` under a higher revision in the same
transaction. The answer's `result` is `{supportReceipt: {requestId, messageId,
reviewId, acceptedAt}}` with UUID ids and an ISO time; terminal evidence is
untouched. Closing the Review (the `resolve_order_support` review action, or
any path that closes it) reports `status: "closed"` under a higher revision in
that same transaction; a later request opens a new Review. Operator replies
are not published in this release.

`input` and `cancel` keep their request schemas (`{inputText, data}`, where
`data` may only repeat fields of the payer-committed request, and
`{reason?}`) and have no business request id, so each is identified by its
admitted task and its own content (core migration 008): a cancellation once
per order, an input by its request hash. The identity is claimed under a
300-second lease, renewed while the service call runs, before the service is
called, and committed in the same transaction as the task state it produced;
every later write of the claim is fenced by its attempt number, so an attempt
that outlived its lease can never commit for, release or cut the lease of the
attempt that took over. A retry under a fresh gateway grant or payer nonce
therefore answers the committed outcome without calling the service again; a
cancellation with a different reason, or a different input while one is
unresolved, is `action_conflict`. A definite service refusal
(`CancellationRefusedError`), or a failure before the service was called when
no earlier attempt could have acted, frees the identity. Any other failure
keeps it bound and answers `lifecycle_unavailable`, and the next attempt with
the same content reconciles it: once the order moved on (for a cancellation,
once it is terminal, canceled or not) that state is recorded as the outcome
and answered; otherwise the service is called again with
`task.lifecycleAction.resumed` set and the same
`task.lifecycleAction.idempotencyKey`, so its supplier journal reconciles
instead of repeating. An identical input repeated in a later input round is
the same identity; send it with different content.

Every failure is a refusal with exactly one key:

| Answer | Meaning |
| --- | --- |
| `401 {"error":"lifecycle_rejected"}` | Authentication or binding failure: forged or stale grant, another order or payer, a read capability for anything but its own read, a replayed authorization or a malformed request |
| `409 {"error":"artifact_unavailable"}` | An artifact read before completed fulfilment, or one whose deliverable bytes are not retained |
| `409 {"error":"unsupported_action"}` | Not available for this order now; nothing changed (for example cancelling a terminal order, input while not awaiting it, input that changes the committed request, an action this starter does not offer) |
| `409 {"error":"action_conflict"}` | The action's durable identity is already bound to different content |
| `503 {"error":"lifecycle_unavailable"}` | Temporarily unavailable, `Retry-After: 10`; asserts nothing about an earlier attempt's effect (a verification outage, a database fault, input while the service declares an outage, an uncertain cancellation or input, an unreconciled legacy terminal row) |

Lifecycle calls, like status reads, are servicing traffic the gateway sends for
every buyer from its own addresses: they skip the per-client and purchase rate
limits and sales admission, keep the concurrency budget and body bound (only
buyer input also waits out its service's declared outage, before its nonce is
consumed), and
spend a separate 30-per-minute authentication-failure budget that only calls
without a verified gateway grant count against, so one buyer's refused
authorizations never exhaust lifecycle service for the others behind the same
gateway address. A lifecycle call the concurrency budget refuses is answered
`503 {"error":"lifecycle_unavailable"}` before anything is authenticated or
consumed.

## Frozen terminal results

`standard_terminal_results` (core migration 006) holds one immutable row per
terminal standard order, written in the transaction of its first terminal
transition after every deliverable and message of that transition:

- `state`, `completed_at` and `result_hash`, the canonical hash of the
  unrevealed A2A task projection (latest message and persisted artifacts with
  protected fields still redacted; buyer support messages are never part of
  it);
- that projection itself, encrypted at rest and bound to its row, and the
  `artifact_secrets` references it may reveal;
- provenance: `terminal-transition`, `verified-attestation` or
  `unobserved-reconstruction`.

Every dispatch, status and lifecycle terminal attestation signs exactly this
identity, forever: later messages, support requests, event retention, a
restart or an internal revival of the task never change it. The public state
of a frozen order is the frozen state. A database trigger refuses any update
or delete except re-encrypting the projection under a newer key (readers
re-verify its hash) and a one-way isolation. An authorized artifact read
returns a separate representation in which the frozen protected references
carry their current, unexpired values; its plaintext is never the hash input.
Deliverables without a canonical JSON form (an unsafe key, a broken surrogate
pair, nesting deeper than 64) never block the terminal transition: the order
becomes terminal unfrozen, is never answered with a guess, is listed as
unresolved, and a `noncanonical_terminal_result` incident records it.

### Legacy terminal rows

A standard order that became terminal before this release has no frozen row,
because earlier releases re-hashed a projection rebuilt from mutable events.
The provider never signs a guess for it: dispatch status answers
`503 dispatch_status_unavailable` and lifecycle reads answer unavailable until
the row is reconciled from recorded evidence:

| Evidence | Result |
| --- | --- |
| A provider terminal attestation the gateway retained (dispatch or lifecycle form, signed by this provider's terminal attestation key, bound to this task and order) and a reconstruction that hashes to it | frozen with those bytes (`verified-attestation`) |
| The same, but no reconstruction matches (deliverable events were already purged or drifted) | the identity alone is frozen; status keeps its evidence, artifact reads are unavailable |
| The gateway handoff states that no terminal identity was admitted | the deterministic reconstruction is frozen (`unobserved-reconstruction`) |
| No evidence, conflicting attestations, an attestation that does not match the row, or an attestation contradicting an already frozen identity | isolated with a stable diagnostic (`legacy_identity_unverified`, `legacy_evidence_conflict`, `legacy_evidence_mismatch`) |

The bearer-admin endpoints `GET /admin/standard-rail/terminal-results/unresolved`
(read-only; ids, states, times and diagnostics only) and
`POST /admin/standard-rail/terminal-results/<taskId>/evidence` (header
`x-admin-actor`, body `{"kind":"attestation","attestation":{payload,signature},"reference"}`
or `{"kind":"unobserved","reference"}`) list and reconcile these rows.
Evidence is append-only and audited. Obtain the retained attestations or the
no-identity statement from the gateway migration handoff before release; a
reconciled row is served from then on, and other orders stay serviceable
throughout.

### Retention

Event retention keeps every event of a standard order whose terminal identity
is not frozen yet (nonterminal and unreconciled legacy orders), because those
events are still its deliverable bytes. Once frozen, the order's events may be
purged; the frozen projection and its protected references are never removed
by retention, and the protocol has no paid-order read expiry. Protected
artifact values keep their own validity window (`artifact_secrets.expires_at`).

## Conformance fixtures

`test/fixtures/provider-wire/` vendors the gateway's canonical synthetic
provider-wire fixtures verbatim, and `test/fixtures/provider-wire.source.json`
records their gateway commit and the manifest's SHA-256. The offline parity
test checks every listed file's hash, that no other file is present and that
the manifest matches its record; the directory is checked out with `-text`.
The vector tests drive the real quote, intake, dispatch, status and lifecycle
handlers against a disposable PostgreSQL database with a frozen clock and
require byte-for-byte canonical equality with each vector a full provider
answers. The tests also carry a port of the gateway's dispatch and lifecycle
consumers that must reproduce the gateway's verdict on every vector,
including the rejected forms no provider should send; every dispatch, status
and lifecycle answer the wire tests receive is then judged by that port
against the gateway's stored view of the order, so a lifecycle answer the
gateway would reject, an unnamed 409 or 503 refusal, a revision that names two
projections or a changed terminal identity fails the test. To re-vendor after
an intentional gateway change, from a gateway checkout at the new commit:

```sh
git -C ../gateway archive <commit> test/fixtures/provider-wire | tar -x
git -C ../gateway show <commit>:test/fixtures/provider-wire/manifest.json | sha256sum
```

then update the source record and fix any vector the provider no longer
matches; never edit a fixture file.

## ERC-8004 identity

`PROVIDER_AGENT_ID` identifies the provider in the canonical per-chain
ERC-8004 registry. The provider refuses startup unless the registry's verified
`agentWallet` matches `PROVIDER_WALLET_PRIVATE_KEY`.

## Ownership and subsequent actions

Standard dispatch records the payer and order identity on the task. An asset's
current owner comes from one authority (`src/core/db/queries/assetOwnership.ts`):
an owner override when one committed, otherwise the payer of the most recent
standard order linked to the asset, at version 0. A public task ID,
transaction hash, order ID or asset ID is never an authorization credential.

A wallet action acts only on an asset the grant-attested payer currently owns,
of the action's service and type, in a lifecycle state the service admits for
it (active by default) and with the identifier its input names. A destructive
follow-up acts only on the staged row of the asset its request names. Every
claim, confirmation and post-review resumption records the owner version it
was admitted under; the supplier call, the persistence of the result and every
signed final response compare it with the current one under the asset owner
fence.

| Situation | Answer |
| --- | --- |
| Not the current owner; wrong service, type, identifier or state | `403 PROVIDER_ASSET_QUERY_REJECTED`, nothing consumed |
| A follow-up naming another asset than its staged row | `403`, nothing consumed |
| The asset stopped being an eligible target after admission | signed `failed` with `errorClass: "asset_unavailable"`, no supplier call |
| The owner version changed before the result was persisted or released | `403`; the result is withheld from both owners and the execution ends `failed` with `asset_owner_changed` |
| A replay, follow-up replay or recovery for a later owner version | `403`, nothing consumed |
| A replay of a finished action | its stored (or regenerated) answer, released under the fence; never a second execution |

Owner-only paid orders are linked to their asset at dispatch under the same
fence, re-admitted before buyer input or a reviewed execution resumes (input
for an asset that changed owner is `409 unsupported_action`), and checked
again immediately before the supplier call. A result whose admitted owner went
stale ends the order `failed` with `asset_owner_changed` instead of persisting
its deliverable; when that result answered a buyer input, the input's
lifecycle call commits that failure as its outcome and answers the signed
`failed` state at once, exactly as dispatch does.

## Payer signatures

Every payer EIP-712 signature (order action authorizations, wallet action and
asset query authorizations) goes through `src/core/standardRail/payerSignature.ts`:

- the signature must be `0x` plus 1 to 4,096 bytes of hex;
- a 65-byte, low-`s` ECDSA signature that recovers to the payer is an EOA and
  verifies offline, with no RPC;
- anything else is a contract-account signature, admitted only when
  `PAYER_ACCOUNT_TYPES` includes `contract`: an ERC-6492 counterfactual
  wrapper is refused, and within `PAYER_SIGNATURE_VERIFY_TIMEOUT_MS` the payer
  must have deployed code and `isValidSignature(bytes32,bytes)` must return
  exactly `0x1626ba7e` followed by 28 zero bytes from an `eth_call` capped at
  1,000,000 gas and 16 KiB of response. At most eight contract verifications
  run at once, and at most two for one payer (the payer the gateway's grant
  attests), so one payer cannot occupy the whole budget.
- A revert, another value, missing code or a malformed answer is an invalid
  signature. Transport failure on the primary and one fallback, the deadline
  or the concurrency bound is a retryable outage: it never consumes a provider
  nonce or counts as a wrong signature.

The asset action and asset query surfaces verify the gateway grant (an offline
recovery) before the payer signature, so a request without a valid grant
never reaches the chain.

Each AgentCard's Daski extension publishes the enforced policy as
`auth.payerAccounts`, `{ "types": ["eoa"], "counterfactual": false }` or
`{ "types": ["eoa", "contract"], "counterfactual": false }`, derived from the
same parsed setting the verifier uses. `contract` is refused at boot in mock
chain mode, which has no RPC to verify a contract account.
