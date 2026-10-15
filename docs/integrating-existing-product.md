# Integrating an existing API or MCP product

Most Daski providers already have a working product. The provider starter is
the controlled adapter between Daski's order protocol and that product; it is
not a replacement API gateway and should not expose the product generically.

## The integration boundary

```text
buyer agent
    │
    ▼
Daski gateway ── signed quote/dispatch/lifecycle/evidence
    │
    ▼
provider core ── payment, identity, replay, ownership, durability
    │
    ▼
ServiceModule ── typed product operations and product policy
    │
    ├── fixed API client ── your existing HTTPS API
    └── fixed MCP client ── your existing MCP server
```

Core establishes authority. The service validates, prices, and fulfills one
declared operation. The upstream API or MCP server remains a supplier from the
provider's perspective, even when your organization owns it.

Never accept a buyer-selected upstream URL, host, MCP server, HTTP method,
route, tool name, header set, or credential. Define an explicit mapping from a
Daski skill id to one reviewed product operation.

## Complete the mapping worksheet

Write this down before copying the dummy. Include one row per buyer-visible
operation.

| Product fact | Daski decision | Questions to answer |
| --- | --- | --- |
| Product boundary | Service | Is this one coherent product, lifecycle, supplier, jurisdiction, and support contract? |
| Endpoint or MCP tool | Skill | What single action and result should a buyer understand? |
| Request schema | Required/optional fields | Can the buyer validate every type, bound, conditional rule, and normalization before paying? |
| Price source | Fixed or dynamic quote | Is the exact atomic-USDC amount known? Does an upstream quote need a supplier-cost ceiling? |
| Execution mode | Immediate, durable job, or input-required | Does the product return a result, a job id, or request more data? |
| Product object | Daski asset | Is a durable object provisioned? What is its collision-safe canonical identifier and lifecycle? |
| Existing-object operation | Owner action | Is it a read, reversible mutation, or destructive mutation? |
| Retry behavior | Idempotency and journal policy | Can an external write be repeated safely? How is ambiguous success reconciled? |
| Cancellation | Adapter cancellation | What can be stopped before and after each irreversible boundary? |
| Output | Artifact/evidence | What bounded, non-secret result proves completion? |
| Data | Protection and retention | Which fields identify people, contain secrets, or require encrypted storage/redaction? |
| Availability | Readiness | Which credentials, upstream probes, workers, or webhooks must be healthy? |

If several product operations have unrelated outcomes, suppliers, risk,
jurisdictions, or lifecycle, use separate services. If they are verbs on one
coherent product, use multiple skills in one service.

## Place code with the service

A product-backed service commonly grows beyond the dummy like this:

```text
src/services/report-builder/
  adapter.ts                 skill dispatch and fulfillment
  config.ts                  strict product credentials/mode
  validation.ts              deterministic buyer-input validation
  clients/
    productApi.ts            or productMcp.ts
  skills/                    focused execution functions
  workers/                   durable job/webhook reconciliation, if needed
  readiness.ts               live product invariants, if needed
  migrations.ts              service-owned state only, if needed
  docs/                      public service and skill contracts
  tests/                     service-owned unit/adversarial tests
  index.ts                   ServiceModule assembly
```

Use core tables and facets before adding a new service table. Core already
provides transactions, tasks, assets, artifacts, durable jobs, reviews,
supplier-operation journaling, email, and retention foundations.

## API-backed products

### Pin the product origin

Keep the reviewed API base in code, not in buyer input. If environments use
different product origins, admit only an explicit closed set and fail closed
for an unknown value. Credentials belong in service configuration.

Use the provider's endpoint and outbound HTTP boundaries:

```typescript
import {
  appendReviewedOperation,
  reviewedEndpoint,
} from "../../core/security/reviewedEndpoint.js";
import { boundedFetch } from "../../core/security/outboundHttp.js";

const PRODUCT_API = "https://api.product.invalid/v1";
const base = reviewedEndpoint(PRODUCT_API, PRODUCT_API);

export async function createReport(
  request: CreateReportRequest,
  apiKey: string,
): Promise<CreateReportResponse> {
  const endpoint = appendReviewedOperation(base, "reports");
  const response = await boundedFetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "idempotency-key": request.idempotencyKey,
    },
    body: JSON.stringify(request.body),
  }, {
    timeoutMs: 15_000,
    maxResponseBytes: 256_000,
    allowedContentTypes: ["application/json"],
    publicTarget: { allowQueryOrFragment: true },
  });

  if (!response.ok) throw classifyProductFailure(response.status);
  return parseCreateReportResponse(response.json());
}
```

The example origin is intentionally non-routable; replace it with the one
reviewed product origin. Validate the response with a closed schema before it
affects state, pricing, artifacts, or logs. Do not surface upstream response
text as a public error.

`boundedFetch` keeps an error reply's HTTP status even when its body is empty
or HTML (content-type admission applies to successful bodies), throws
`OutboundCircuitOpenError` with its `retryAt` while the origin's circuit is
open, and honors a caller's `signal` together with its own timeout through
the whole response-body read; a caller abort surfaces as
`OutboundAbortedError` and never opens the circuit. An abort only stops
waiting: it never proves the product did not act, so a mutating call
reconciles instead of retrying blindly, and a timeout or abort that escapes
`execute` parks the paid order for reconciliation rather than failing it. A
failed DNS lookup keeps the resolver's error as its `cause`. Every failure
is reported to the provider log and the admin Platform Log as
`outbound.request_failed` with only its class, templated operation, status,
the remote's short error code and network code, throttled to one report a
minute per identical failure.

### Authentication

- Parse the API credential in the service's `config.ts`.
- Never accept it from a Daski request or place it in a manifest, skill doc,
  artifact, log, model prompt, or error.
- Use separate, environment-scoped credentials. Prefer a sandbox or fake on
  Testnet when the product provides one.
- Add a Mainnet gate that rejects mock, sandbox, and charged-test credentials
  or modes.
- Prefer a narrowly scoped product service account rather than an operator or
  customer credential.

### Product environments and chargeable Testnet campaigns

Daski Testnet controls the marketplace payment and chain environment. It does
not make an upstream API or MCP call harmless. Some products have no sandbox,
and a test account may still create durable records, contact people, consume
inventory, or charge the provider.

Keep the product environment as an explicit, closed service mode such as
`mock`, `sandbox`, `charged-test`, or `live`:

- Mainnet must require `live` and reject every non-live mode.
- Non-mainnet deployments must reject `live` unless a separately reviewed
  policy deliberately permits it.
- Persist the selected account/mode with every durable upstream object, job,
  callback, catalog snapshot, and external identifier. Never reinterpret an
  identifier under different credentials after a deployment-mode change.
- Switching modes parks incompatible work. It does not delete it, relabel it,
  or prove that an ambiguous upstream mutation failed.

If a Testnet exercise can cause real upstream cost or side effects, put it
behind a durable campaign envelope. At minimum, bind and freeze:

- a new campaign id for each reviewed boundary revision;
- the exact admitted payer wallet and skill or operation set;
- a small cumulative operation/count cap;
- an aggregate supplier-cost cap represented in exact integer minor units;
- the upstream account/mode identity; and
- an audit record for each admitted transaction.

Serialize admission and spend reservation against the campaign row so
concurrent transactions cannot exceed a cap. A retry must reuse its original
campaign, payer, mode, and reserved amount. Changing any frozen boundary
requires a new campaign id rather than editing the durable campaign.

The emergency stop should disable new/resumed upstream mutations while
preserving journals, reservations, callbacks, and identifiers for later
reconciliation. Retain only non-sensitive certification evidence: deployment
revision, campaign id, public Testnet transaction ids, bounded caps, durable
task ids, timestamps, outcomes, and redacted defects.

### Timeouts, responses, and retries

- Set a total timeout and maximum response size per operation.
- Reject redirects unless the exact destination is separately reviewed.
- Admit only expected content types and schemas.
- Map upstream failures to stable internal classes: retryable, rejected,
  provider configuration, ambiguous, or terminal.
- Bound retry counts and use the supplier circuit breaker.
- A timeout after sending a mutation is ambiguous, not proof of failure.

## MCP-backed products

Treat MCP as an upstream supplier interface, not as a buyer-selectable routing
layer. Define a narrow internal client around the exact tools your service
uses:

```typescript
interface ProductMcpClient {
  createReport(input: CreateReportInput): Promise<CreateReportResult>;
  getReportJob(jobId: string): Promise<ReportJobState>;
  cancelReportJob(jobId: string): Promise<CancelResult>;
}
```

The implementation may use your reviewed MCP SDK and transport, but it must:

- connect to a fixed, authenticated server controlled by configuration;
- allowlist the mapped tool names in code;
- build tool arguments from already validated skill fields;
- validate tool result content with explicit schemas;
- bound connection time, response size, concurrency, and redirects;
- keep credentials and protected tool content out of logs and public errors;
- journal consequential tool calls before dispatch; and
- preserve and reconcile upstream job or mutation ids.

If the MCP transport is HTTP-based, route it through the reviewed outbound
boundary or prove equivalent origin pinning, DNS/SSRF protection, redirect
rejection, and response bounds in the service tests. Do not rely on the MCP
server's advertised tool list as runtime authorization.

One Daski skill can map to several fixed internal product calls when that is
necessary to produce one outcome, but the buyer must not control the sequence
or select arbitrary tools.

## Synchronous and job-based products

### Immediate result

Return `completed` with bounded artifacts when the product response is
definitive. Provision an `asset` only when the operation creates the durable
object for the first time.

### Product job

When the product returns a job id:

1. persist the id and request fingerprint before returning `working`;
2. enqueue a durable polling or reconciliation job;
3. declare the worker id in service readiness;
4. update progress through conditional transitions;
5. persist a definitive result before completing the Daski task; and
6. park ambiguous or dead-letter states for review rather than losing them.

Do not keep a product job id only in memory. A provider restart must resume the
same job without repeating the original mutation. The complete pattern, with
the journaled submission, the durable poll worker, readiness and wait
supervision, and the tests it needs, is in
[Wrapping a product that returns a job id](existing-async-products.md).

### Webhook completion

Authenticate the webhook, enforce a bounded body, store an idempotency key,
and correlate it to the previously journaled product operation. A webhook is
untrusted input; it does not replace reconciliation against product truth when
the mutation outcome is ambiguous.

## Idempotency and ambiguity

| Upstream behavior | Provider pattern |
| --- | --- |
| Pure read | Bounded retry may be safe; still apply timeout and circuit breaker |
| Convergent set-to-desired-state write | Stable desired state can make retry safe after authoritative read-back |
| Native idempotency key | Persist one stable key and response; prove repeated calls cannot duplicate effects |
| Non-convergent mutation | Journal intent before the call and reconcile after any ambiguous response |
| Unknown/undocumented behavior | Treat as non-convergent until tests and product guarantees prove otherwise |

An HTTP 500, lost connection, MCP transport error, or worker crash can occur
after the product committed a mutation. Never equate transport failure with
business failure.

## Pricing and product quotes

`quote()` runs before payment and must revalidate the full buyer request.

- Fixed prices use atomic USDC; `1000000` is 1 USDC.
- A dynamic price must be an exact integer derived from validated input.
- Bound any upstream price request like a fulfillment request.
- If fulfillment will spend externally, attach a `supplierCostCeiling` that
  commits the maximum supplier cost and currency.
- Put availability checks that depend on mutable product state in the
  read-only `requestReadiness` hook. It runs before each new quote with the
  quote's payer (or `null`) and can only refuse; it must not reserve or
  start anything, and it is not consulted again after payment.
- Define what happens when a product quote expires or changes before dispatch.
- Never return a successful paid quote while a required field or material
  upstream cost is unknown.

## Assets and existing-object operations

Map a product object to a Daski asset only when buyers retain an ongoing
ownership relationship. Define:

- a stable asset type;
- a canonical, collision-safe identifier;
- initial, active, suspended, and terminal states that actually exist;
- which skill provisions the asset; and
- which owner-only actions can read or mutate it.

Ownership is always derived from the wallet-authorized payer. Do not accept an
owner wallet or bearer token in service input.

Classify an action as destructive when it deletes, publishes, transfers,
releases, revokes, cancels, or irreversibly changes meaningful control. Such an
action needs the signed action catalog and delayed second wallet authorization.
Do not add a product-specific signature scheme.

## Cancellation

Document and test cancellation at each boundary:

1. before any product call;
2. after intent is persisted but before dispatch;
3. after an idempotent or convergent write;
4. after an ambiguous response;
5. after an irreversible external commitment; and
6. while a product job or human step is active.

Refuse cancellation explicitly when the product cannot safely cancel. Do not
claim a reversal, refund, or deletion that product truth does not support.

## Protected data and artifacts

Collect the minimum product fields required for the chosen skill. For each
protected field decide:

- whether it needs storage at all;
- the encryption purpose and rotation sink;
- whether it can appear in product calls, prompts, operator reviews, or email;
- the safe public artifact projection; and
- retention and legal-hold behavior.

Product responses are not automatically safe artifacts. Return only bounded,
buyer-appropriate fields. Keep API keys, MCP authentication, upstream debug
payloads, personal data, and internal ids out unless the public skill contract
specifically requires and protects them.

## Readiness

A real service must make admission fail closed when it cannot fulfill new
work: a failing service invariant or a dead required worker stops new quotes
(the `admission` part of `/health/ready`) and degrades `servicing`, while the
process stays routable for funded orders' persisted reads. A failing
invariant also holds the service's other new work (a fresh dispatch, the
fulfillment worker, buyer input, wallet actions and free skill calls) as
retryable until it passes, so an outage never becomes a failed order or
action. Typical service checks include:

- required credentials are present and valid for the selected product mode;
- the configured mock, sandbox, charged-test, or live product environment
  matches Testnet/Mainnet and any durable campaign boundary;
- required durable workers are alive;
- product schema or capability version is supported;
- webhook/callback configuration is current;
- circuit breaker or dependency outage makes new work unsafe; and
- any custody, compliance, or human queue requirement is available.

Avoid expensive supplier calls on every health request: core evaluates the
invariants for each readiness probe and before each piece of new work. Use
bounded cached probes or worker-maintained evidence appropriate to the
product.

## Test the adapter in isolation

Use a controlled fake API server or fake MCP transport inside the service test
suite. It must not use real product credentials or a shared product account.
Cover:

- exact skill-to-operation mapping and rejection of unknown operations;
- request and response schema boundaries;
- auth header/transport construction without logging the credential;
- timeout, size, content-type, redirect, and origin enforcement;
- success, rejection, retryable, terminal, and provider-config failures;
- idempotency, ambiguity, reconciliation, and concurrent attempts;
- job restart and webhook replay;
- cancellation around irreversible boundaries;
- artifact/redaction boundaries; and
- mock/sandbox/charged-test/live readiness, including Mainnet refusal of every
  non-live mode.

Keep these tests under `src/services/<slug>/tests/`. Do not retain a
provider-specific product fixture in the upstream generic starter.

## Integration completion checklist

- Every buyer-visible operation maps to one explicit skill.
- No buyer input controls an upstream endpoint, server, method, or tool.
- Quote and execute share deterministic validation.
- Product origins and tool names are fixed and reviewed.
- Requests and responses are bounded and schema-validated.
- External mutations are journaled and ambiguous outcomes reconcile product
  truth.
- Product jobs survive provider restarts.
- Assets and actions use wallet-bound ownership.
- Protected data is minimized, encrypted, redacted, and retained deliberately.
- Readiness proves the product mode and required workers.
- Co-located tests exercise API/MCP failure and adversarial paths.
- The final service/skill/outcome/action contract is sent through Daski
  Testnet onboarding.
