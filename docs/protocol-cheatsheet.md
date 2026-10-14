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

Answers are plain `application/json` with `Cache-Control: no-store`; the
starter installs no compression middleware. Signed bodies are built and
signed for each request and never cached.

## Quotes and intake

The gateway posts `{"request": envelope}` to the quote URL for fixed and
dynamic listings alike. Each handler checks the artifact type and schema
version first, then the environment, chain, provider audience, the
`gateway-dispatch` signer key id and freshness, and only then the signature;
several envelope types share that key.

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
product, and rebuilds no history for a pending order. The terminal
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
