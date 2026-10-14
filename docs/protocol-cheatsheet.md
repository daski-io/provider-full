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
- `GET /health/ready`
- `GET /.well-known/agent.json`
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
  availability (sales paused stops quotes), open paid work for the listing
  version against its capacity, the service `quote()`, a supplier-cost
  ceiling if one is returned, and the optional read-only `requestReadiness`
  hook. The quote is persisted with its payer, pricing mode, price, request,
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
  `null` in this starter, and all-null content keeps revision 0 forever. A
  database trigger requires a higher revision for any content change and
  refuses a revision change without one.
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
| Definite refusal before any admission, re-confirmed by an authoritative claim probe | `409 {"error":"dispatch_rejected","reason":...}`; the gateway later sends a new envelope |
| A claim exists for this exact envelope | `200` with the signed snapshot, even after the envelope expired |
| Admission exists for another envelope, the commit outcome is unknown, or admitted work cannot be rendered | empty `503` (no body, `Retry-After`); the gateway reconciles by status with the original hash |

Refusal reasons are `validator`, `envelope_lifetime`, `signature`,
`outcome_policy`, `self_purchase`, `quote_window`, `price`, `evidence` and
`service_unavailable`. No route or middleware turns a possibly-admitted
dispatch into a JSON error.

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
- Once admitted, a definite service failure becomes a signed terminal
  failure, but an ambiguous supplier outcome leaves the task `working` and
  flagged `standard_reconciliation_required` (with an
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
`resultHash` is still derived from the task projection today; the frozen
terminal-result store replaces that single seam
(`src/core/standardRail/terminalResult.ts`).

## ERC-8004 identity

`PROVIDER_AGENT_ID` identifies the provider in the canonical per-chain
ERC-8004 registry. The provider refuses startup unless the registry's verified
`agentWallet` matches `PROVIDER_WALLET_PRIVATE_KEY`.

## Ownership and subsequent actions

Standard dispatch records the payer and order identity on the task. Subsequent
asset mutations use the provider's capability schemas and the identity bound
to that standard order. A public task ID or transaction hash is never an
authorization credential.

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
  run at once.
- A revert, another value, missing code or a malformed answer is an invalid
  signature. Transport failure on the primary and one fallback, the deadline
  or the concurrency bound is a retryable outage: it never consumes a provider
  nonce or counts as a wrong signature.

The asset action and asset query surfaces verify the gateway grant (an offline
recovery) before the payer signature, so a request without a valid grant
never reaches the chain.
