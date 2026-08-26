# Adding a service

This guide turns the compiled `dummy` module into a real provider-owned Daski
service. If you already expose a product through HTTP or MCP, begin with
[integrating an existing product](integrating-existing-product.md). Then read
the [architecture](architecture.md) and [security model](../SECURITY.md).

## 1. Define the offering with Daski

Before coding, agree on the public service and paid outcome with your Daski
provider-onboarding contact:

- service slug, version, taxonomy, and jurisdictions;
- skill ids, required/optional fields, examples, and fulfillment mode;
- free versus paid skills and atomic-USDC pricing behavior;
- one-shot versus durable fulfillment;
- asset types, lifecycle, ownership, and any owner-only actions;
- supplier/compliance dependencies and human-party data;
- outcome id, request schema, deadlines, capacity, and Testnet admission.

A skill id is an operation inside your service. A standard-rail outcome id is
the reviewed marketplace listing/payment coordinate. They may differ, as
`create-note` and `dummy-create-note` do.

Do not invent signed artifact values. Daski onboarding issues a consistent
Testnet set after the service contract is reviewed.

## 2. Copy and rename the dummy

Choose a lowercase kebab-case slug:

```bash
cp -r src/services/dummy src/services/report-builder
```

Rename exported symbols and files where useful. Replace every dummy-specific
identifier, description, field, and test. Remove the Base-mainnet dummy guard
from the copied module and add the live/sandbox checks your own service needs.

Do not register the copied service yet; keep the repository compiling as you
work.

A typical service folder is:

```text
src/services/report-builder/
  adapter.ts
  config.ts
  index.ts
  manifest.ts
  validation.ts
  skills/
  docs/
    index.md
    <skill-id>.md
  tests/
    reportBuilder.test.ts
```

Add `migrations.ts`, `workers/`, `clients/`, `readiness.ts`, or other
folders only when the service actually needs them.

## 3. Write the manifest and skills

`manifest.ts` is public marketplace data:

```typescript
import type {
  ServiceManifest,
  SkillDefinition,
} from "../../core/serviceRegistry/types.js";

export const manifest: ServiceManifest = {
  slug: "report-builder",
  version: "1",
  name: "Report Builder",
  categoryFamily: "data",
  serviceType: "data-other",
  jurisdictions: ["global"],
  description: "Builds a structured report from supplied source material.",
  turnaroundEstimate: "< 2 minutes",
  serviceLifecycle: "asset-lifecycle",
  dispatchMode: "one-shot",
  defaultFulfillmentMode: "automated",
  defaultTags: ["reports"],
  supplier: "report-engine",
  assetLifecycle: {
    report: {
      states: ["active", "deleted"],
      terminalStates: ["deleted"],
      transitions: [
        { from: null, to: "active", skill: "create-report" },
        { from: "active", to: "deleted", skill: "delete-report" },
      ],
    },
  },
};

export const skills: SkillDefinition[] = [
  {
    id: "create-report",
    name: "Create Report",
    description: "Creates a report from a title and source text.",
    examples: ["Create a report titled 'Quarterly review' from this source"],
    pricing: { USDC: { type: "one-time", fixed_amount: "1000000" } },
    fulfillmentMode: "automated",
    requiresAssetOwnership: false,
    assetType: "report",
    requiredFields: ["title", "source"],
    optionalFields: ["format"],
    humanParties: "none",
  },
];
```

Rules enforced at registration include:

- service, type, and skill ids use stable kebab-case;
- jurisdiction is `global` alone or unique ISO 3166-1/3166-2 codes;
- each skill has valid pricing and fulfillment mode;
- every skill has non-placeholder documentation; and
- an ephemeral task is free, open, automated, terminal, and creates no durable
  business state.

Use the taxonomy guide rather than creating a new category family. Coordinate a
new `serviceType` with Daski.

## 4. Validate input once, use it twice

Put deterministic validation in `validation.ts` and call it from both
`quote()` and the executor.

`quote()` runs before payment. Return structured field errors instead of
throwing for buyer-correctable input:

```typescript
async quote(
  skillId: string,
  args: Record<string, unknown>,
): Promise<QuoteResult> {
  if (skillId !== "create-report") {
    return {
      ok: false,
      errors: [{
        field: "skillId",
        code: "unknown_skill",
        message: "unknown skill",
      }],
    };
  }

  const errors = validateCreateReport(args);
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    amount: 1_000_000n,
    currency: "USDC",
  };
}
```

If the price depends on a supplier quote, validate the input first, bound the
supplier call, and return the exact amount. Use `supplierCostCeiling` when
fulfillment must prove it stayed within a quoted external-spend ceiling.

Never log request data to debug validation.

## 5. Implement fulfillment

Dispatch from the adapter by exact skill id:

```typescript
export class ReportBuilderAdapter implements FulfillmentAdapter {
  async execute(
    skillId: string,
    task: TaskContext,
    data: Record<string, unknown>,
  ): Promise<AdapterResult> {
    switch (skillId) {
      case "create-report":
        return executeCreateReport(task, data);
      default:
        throw new Error(`Unknown skill: ${skillId}`);
    }
  }

  async handleInput(): Promise<AdapterResult> {
    return { status: "failed", message: "Additional input is not supported." };
  }

  async cancel(): Promise<void> {
    // Clean up reversible external state or refuse safely.
  }

  async quote(
    skillId: string,
    data: Record<string, unknown>,
  ): Promise<QuoteResult> {
    // Validate and quote as shown above.
  }
}
```

An executor returns one of `working`, `input-required`, `completed`, or
`failed`. Buyer-visible outputs are artifacts. To provision a first asset,
return:

```typescript
return {
  status: "completed",
  message: "Report created.",
  artifacts: [{
    name: "report_created",
    data: { reportId, format },
  }],
  asset: {
    assetType: "report",
    assetIdentifier: reportId,
    assetData: { format },
  },
};
```

Core links a new asset to the wallet-authorized payer. Do not accept an owner
wallet in service input. For an existing asset, mutate it through a durable,
authorized path and do not return a second provisioning block.

### External supplier writes

For non-convergent supplier mutations, use the core supplier-operation journal
with a stable logical key. Persist intent before the call. If the response is
ambiguous, reconcile the supplier's authoritative state. Never blindly repeat a
purchase, provisioning request, filing, or other non-idempotent action.

Implement bounded classification, retry, circuit-breaker, cancellation, and
recovery tests alongside the service.

## 6. Add service configuration

Parse service variables in `src/services/report-builder/config.ts`. Reject
malformed or missing live values during import/registration and add explicit
mainnet gates:

```typescript
import { z } from "zod";
import { config as coreConfig } from "../../core/config.js";

const schema = z.object({
  REPORT_ENGINE_API_KEY: z.string().min(1),
  REPORT_ENGINE_SANDBOX: z.enum(["true", "false"]),
});

const serviceConfig = schema.parse(process.env);

if (coreConfig.CHAIN_ID === 8453 && serviceConfig.REPORT_ENGINE_SANDBOX === "true") {
  throw new Error("report-builder requires the live supplier on Base mainnet");
}
```

Use a strict boolean parser if accepting multiple boolean spellings. Pin and
review supplier base URLs in code; do not accept arbitrary endpoint variables.
Send requests through the core outbound HTTP/SSRF boundary, never direct
`fetch`.

## 7. Add migrations and seed only if needed

Core `transactions`, `assets`, artifacts, jobs, email, reviews, and supplier
journal cover many services. Add a service table only for service-owned state.

Module migrations are append-only `{ name, sql }` objects:

```typescript
export const reportBuilderMigrations: ServiceMigration[] = [{
  name: "001_reports",
  sql: `
    CREATE TABLE report_builder_reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      transaction_id TEXT NOT NULL REFERENCES transactions(id),
      state TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `,
}];
```

Wire them through `operations.migrations`. Migration names and SQL are
checksummed after application; never edit an applied migration. Add a new one.

Use `operations.seed` only for idempotent service-owned initialization.

## 8. Add docs

Create `docs/index.md` and exactly one `docs/<skill-id>.md` per skill. Explain:

- what the service/skill does and does not do;
- access and payment requirements;
- every field, type, bound, and conditional requirement;
- price/quote behavior;
- artifacts and asset lifecycle;
- timing, supplier/human dependencies, cancellation, and failure semantics;
- data handling and any human-party requirement; and
- at least one valid request example.

Wire the files into `ServiceModule.protocol.docs` as the dummy does.
Registration rejects missing, blank, and placeholder docs.

## 9. Add optional facets deliberately

Only add a facet when your product needs it:

- `operations.readiness`: required worker ids and live invariants;
- `operations.startWorkers`: durable worker startup with a stop function;
- `security.redactSensitiveFields`: service-specific prompt/review redaction;
- `security.protectedDataSinks`: rotation for encrypted service columns/JSON;
- `security.protectedAssetIdentifiers`: encrypt sensitive identifiers while
  preserving lookup;
- `protocol.routes`: service-specific HTTP routes under the core boundary;
- `protocol.inboundEmail`: bounded recipient interception with the trust
  boundary below;
- `agents`: bounded tools with explicit authority;
- `screening`: subject extraction and required provider-policy scopes;
- `admin`: service controls with mandatory audit/transaction behavior; and
- `assets`: canonical identifier and ownership lookup behavior.

### Inbound email trust boundary

Webhook authentication proves that the HTTP request passed the configured
Postmark boundary. It does not authenticate the person or organization named
in an email's `From`, `Reply-To`, headers, or body.

Core evaluates the unique Postmark SPF, aligned-DKIM, and SpamAssassin signals
once at ingress and persists fail-closed verdicts on `InboundEmailRow`:

- `postmark_sender_authenticated` is true only for complete passing SPF and
  aligned-DKIM signals; and
- `postmark_spam_safe` is true only for a complete non-spam verdict below the
  admitted score threshold.

Missing, incomplete, or duplicate verdict headers produce `false`. A service
must consume these booleans rather than reinterpret raw `Authentication-Results`
or other message-controlled headers. Even a true verdict is not business
authorization: normalize and pin the expected participant or use a
service-owned sender/domain allowlist before correspondence can affect state.
Email alone must never authorize payment, ownership, a destructive asset
action, or an arbitrary recipient/body supplied to an outbound relay.

Keep `match(recipient)` deterministic and bounded. Exactly one active service
may match a recipient, and `handle(row)` must be idempotent because webhook and
worker delivery can repeat. Treat bodies, links, and attachments as untrusted.
The starter does not persist or relay inbound attachments; adding that
capability requires explicit request/count/byte limits, encrypted storage,
content handling policy, malware controls or isolated human review, retention,
and replay tests. Postmark's SpamAssassin processing does not scan attachment
content.

### Atomic service-owned admin state

When a service admin action must change both a core asset and service-owned
database state, use `commitAdminAssetMutation`. Its optional
`additionalMutation(db)` callback receives the same transaction used for the
asset update and mandatory audit. If the callback or audit fails, all database
changes roll back.

The callback is for short, deterministic database writes through the supplied
`Queryable`. Do not perform supplier, network, model, email, or other
irreversible work while holding the transaction. Journal and reconcile those
effects through the normal service workflow.

Pre-execution model review is advisory policy, not input validation or
authorization. Choose `onError: "escalate"` for a fail-closed skill. Project
only the minimum safe data through `buildPreExecuteReviewData`.

## 10. Assemble the module

If screening is required, place the provider-owned policy/vendor adapter under
`src/providerExtensions/<name>/` and wire it only through
`src/providerScreening.ts`. The service declares subjects and scopes; it
must not import the extension or know which vendor implements the policy.

```typescript
export const reportBuilderService: ServiceModule = {
  manifest,
  skills,
  fulfillment: {
    adapter: new ReportBuilderAdapter(),
  },
  protocol: {
    docs: {
      service: readDoc("index"),
      skills: Object.fromEntries(
        skills.map((skill) => [skill.id, readDoc(skill.id)]),
      ),
    },
  },
  operations: {
    migrations: reportBuilderMigrations,
    readiness: reportBuilderReadiness,
  },
  assets: {
    assetIdentifierFromData(skillId, data) {
      if (skillId !== "create-report") return null;
      return typeof data.reportId === "string" ? data.reportId : null;
    },
  },
};
```

Keep each concern in its facet. Do not work around the contract by importing a
service from core.

## 11. Keep tests with the service

Put tests in `src/services/report-builder/tests/`. Begin with the dummy
suite's coverage and add the risks your service introduces:

- docs exactly cover declared skills;
- valid/invalid/free/paid quotes;
- execute revalidation;
- exact field bounds, including Unicode code-point boundaries;
- artifacts and canonical, collision-safe asset identifiers;
- supplier success, rejection, retry, ambiguity, and reconciliation;
- idempotency, repeated equivalent inputs, and concurrent attempts;
- cancellation before and after each irreversible boundary;
- readiness in sandbox/live modes;
- protected-data redaction and rotation;
- screening allow/reject/hold/unavailable, when applicable; and
- owner/action signature mismatch, expiry, delay, and replay, when applicable.

Run a co-located suite directly:

```bash
npm run test:run -- src/services/report-builder/tests
```

Do not leave service-specific tests under root `test/`.

## 12. Register the service

Update only `src/providerServices.ts`:

```typescript
import type { ServiceModule } from "./core/serviceRegistry/types.js";
import { reportBuilderService } from "./services/report-builder/index.js";

export const providerServices: ServiceModule[] = [reportBuilderService];
```

Remove the dummy import and folder when you no longer need the reference.

If the service requires a provider screening policy, implement it under
`src/providerExtensions/<name>/`, outside both core and service code, then
install it through `src/providerScreening.ts`. The service declares
subjects/scopes; the extension declares policy/vendor.

## 13. Coordinate the launch policy

For every paid outcome, replace the dummy id in
`src/providerLaunchPolicy.ts` with the reviewed outcome id. Add only asset
actions present in the signed catalog, including the exact destructive and
replay classifications.

The provider rejects signed configuration with a missing, extra, duplicate, or
differently classified id. That exact-set validation is a release boundary, not
a nuisance to bypass.

Send the final manifest, skill/request schema, pricing mode, service and skill
ids, provider identity, and action definitions through Daski Testnet
onboarding. Install the returned artifacts together.

## 14. Verify locally and on Testnet

Run the complete local checks:

```bash
npm run typecheck
npm run typecheck:test
npm run lint
npm run lint:architecture
npm run docs:check
npm run test:run
npm run test:coverage
npm run test:critical-coverage
npm run test:mainnet-readiness
npm run build
```

Run `npm run doctor -- --stage=testnet`, then follow the
[onboarding checklist](onboarding.md). A passing diagnostic does not create or
approve signed standard-rail artifacts.

After a successful Testnet boot, inspect:

```bash
curl https://YOUR_PROVIDER/health/ready
curl https://YOUR_PROVIDER/.well-known/agent.json
curl https://YOUR_PROVIDER/agent-cards/report-builder.json
curl https://YOUR_PROVIDER/skills/report-builder.md
curl https://YOUR_PROVIDER/skills/report-builder/create-report.md
```

Finally exercise discovery, quote, one paid purchase, status/evidence,
ownership, actions, cancellation, and recovery through the Daski gateway. Keep
the Testnet identities and spend explicitly bounded and reconcile every
ambiguous payment before retrying.

Do not consider mainnet until the dummy is gone, all service-specific live
readiness checks exist, and Daski's coordinated security/release review is
complete.
