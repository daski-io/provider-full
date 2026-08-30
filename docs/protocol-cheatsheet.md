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
   hash, policy hashes, deadlines, and replay state before fulfillment.
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

## ERC-8004 identity

`PROVIDER_AGENT_ID` identifies the provider in the canonical per-chain
ERC-8004 registry. The provider refuses startup unless the registry's verified
`agentWallet` matches `PROVIDER_WALLET_PRIVATE_KEY`.

## Ownership and subsequent actions

Standard dispatch records the payer and order identity on the task. Subsequent
asset mutations use the provider's capability schemas and the identity bound
to that standard order. A public task ID or transaction hash is never an
authorization credential.
