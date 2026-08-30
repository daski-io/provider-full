# Daski service and skill authoring guide

A Daski service is a coherent product boundary. A skill is one buyer-visible
operation inside that product. Good definitions let an agent decide whether,
when, and how to call you without guessing.

## Start with the service boundary

Create a separate service when the offering has a meaningfully different
product, supplier/custody model, lifecycle, jurisdiction, support contract, or
risk boundary. Do not create a separate service merely to expose another verb.

A service manifest should answer:

- What outcome does this product deliver?
- Where can it be fulfilled?
- Is fulfillment automated, human, or hybrid?
- Is it one-shot or does it create a managed asset?
- What public turnaround and support expectations apply?

Use one approved `categoryFamily`, one coordinated `serviceType`, and at
least one jurisdiction.

## Define one action per skill

A skill should have one clear effect and one clear result. Prefer stable
imperative ids such as `create-report`, `get-report`, or `delete-report`.

Avoid skills that:

- select among unrelated products;
- hide required fields until after payment;
- combine reversible and destructive operations;
- claim success before an external mutation is definitive; or
- use prose input where a closed structured schema is possible.

Required and optional fields must be explicit and disjoint. Document types,
bounds, normalization, conditional rules, and examples.

## Write for discovery

Marketplace text search matches exact tokens in the published service name and
description and each skill's name, description, and tags. Examples and schemas
are not searched. Include the truthful product names and common synonyms a
buyer will actually type; do not rely only on internal taxonomy vocabulary or
advertise a product the schema cannot accept. Presentation copy is outside the
hashed skill contract, so a copy-only correction republishes on AgentCard
refresh without a new listing commitment.

## Choose the access model

### Open free read

Use only when the call is free, needs no ownership, creates no durable business
state, and is safe for anonymous public traffic. It may opt into ephemeral task
durability.

### Paid outcome

Use when a purchase or paid fulfillment begins. The gateway supplies a signed
standard dispatch after finalized payment evidence. Your adapter validates and
executes; it does not verify payment itself.

### Owner-only asset action

Use for a read or mutation of an existing asset. It requires wallet
authorization, provider grant, stored ownership, current servicing admission,
and a signed action definition. Do not implement custom bearer tokens or
service-local signatures.

## Price and quote precisely

Prices use atomic USDC (six decimals). `1000000` is 1 USDC.

A fixed price can be declared directly. A variable price must be calculated by
`quote()` from fully validated input and returned as an exact integer. If an
external supplier price contributes, bind a safe supplier-cost ceiling and
define what happens when the price changes before fulfillment.

Never issue a successful paid quote with unknown required input.

## Asset lifecycle

If a skill provisions a durable item, declare:

- a stable asset type;
- deterministic canonical identifier;
- allowed states;
- terminal states; and
- the skill causing each transition.

Only first-time provisioning returns `AdapterResult.asset`. Existing assets
are updated in place after ownership authorization.

Use a destructive classification whenever an action irreversibly deletes,
releases, publishes, transfers, revokes, or otherwise removes meaningful
control. If uncertain, treat the action as destructive during review.

## Replay and idempotency

Choose an action replay policy that matches the result:

- `stable-result`: return the same durable result;
- `regenerate-ephemeral`: safely regenerate a non-stable read;
- `redacted-after-window`: replay is acknowledged after protected output is
  no longer available.

A replay policy is not permission to repeat a supplier mutation. Journal and
reconcile external writes separately.

## Human parties and data

Set `humanParties` to `required`, `varies`, or `none` so agents know
whether fulfillment needs a person of record. Human data is request data, not
the buyer's Daski identity.

Collect the minimum fields, explain why they are needed, encrypt protected
storage, and define retention. Do not include secrets or personal data in skill
examples.

## Fulfillment and failure language

Describe:

- what starts immediately after payment;
- normal completion time;
- external or human dependencies;
- when additional input can be requested;
- whether cancellation is possible;
- what artifact proves completion; and
- how retryable, terminal, ambiguous, and provider-configuration failures are
  surfaced.

Do not promise automatic refunds or reversals unless the active Daski order
lifecycle actually provides them.

## Documentation template

Each skill document should include:

1. summary;
2. access/payment requirements;
3. input table;
4. quote behavior;
5. output/artifact schema;
6. asset effect and lifecycle;
7. timing and cancellation;
8. failure/retry semantics;
9. data handling; and
10. valid examples.

The manifest description is concise discovery copy; the Markdown document is
the complete integration contract. Keep them consistent.

## Review checklist

- Is this one operation in one service?
- Can an agent pre-validate every field?
- Does `quote()` return an exact price or structured errors?
- Is ownership derived from the signed payer?
- Are external writes journaled and ambiguity reconciled?
- Is the asset lifecycle accurate?
- Is destructive behavior classified conservatively?
- Do published action and paid-skill contracts match the reviewed catalog and
  runtime listings exactly?
- Are protected fields excluded from logs, prompts, errors, and artifacts?
- Do co-located tests cover invalid, replay, concurrency, cancellation, and
  ambiguous paths?
