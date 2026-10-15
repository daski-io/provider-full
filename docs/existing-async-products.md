# Wrapping a product that returns a job id

Some products accept a request, return a job id at once, and deliver their
result minutes or hours later. `provider-full` wraps such a product with the
pieces it already has: the core supplier-operation journal for a safe,
reconcilable submission, a durable job queue for polling, a service worker,
and readiness and wait-supervision declarations. There is no second job
runtime to add and no special adapter type: the service keeps the ordinary
`FulfillmentAdapter`.

Choose the starter first. When the product's only extra need is polling its
own fixed-price job, with no dynamic price, later buyer input, cancellation,
asset or operator workflow, use the external-job mode of the smaller
[`daski-io/provider`](https://github.com/daski-io/provider) starter instead,
from a release that ships it. Wrap the job here when the product sits beside
richer services or needs those features.

The examples use a synthetic report product with three operations: submit a
report job (`POST /jobs`, accepting a client reference), look a job up by
that client reference (`GET /jobs?clientReference=`), and read a job
(`GET /jobs/{id}`, whose `state` is `queued`, `running`, `succeeded` or
`failed`, with the report once `succeeded`). Replace it with your product's
reviewed endpoints, behind the [outbound boundary](integrating-existing-product.md#api-backed-products).

## What the product must guarantee

Establish these facts from the product's documentation before writing code;
if one is missing, the integration is incomplete, and choosing this starter
does not supply it:

- **Start against the paid Daski order.** Daski has already taken payment
  when your adapter runs. The submission must be a provider-owned operation
  tied to the order, never a public purchase that charges again.
- **Authoritative lookup after a lost response.** A timeout, crash or lost
  response after submitting must be resolvable: by a client reference the
  product stores (the Daski task id is a good one) or by an idempotency key
  the product honors for longer than your worst-case recovery time. A job URL
  that only the lost response carried is not enough.
- **Exact job states and a durable report.** Know which states are pending,
  which are a definitive failure, and how long the report stays retrievable.
  Daski does not keep the report for you.
- **Bounds.** Normal and maximum job duration (the skill's declared
  fulfillment duration must cover queueing, retries and report retrieval) and
  the product's poll rate limits.

## 1. Submit once, journal first

`execute` runs at most once per paid order, usually inside the dispatch
request, which has a short budget: submit, record the reference, schedule
polling and return `working`. Never hold the request open for the job.

```typescript
import { enqueueDurableJob } from "../../core/db/queries/durableJobs.js";
import { inTransaction } from "../../core/db/queryable.js";
import { pool } from "../../core/db/pool.js";
import {
  runSupplierOperation,
  SupplierOutcomeAmbiguousError,
} from "../../core/suppliers/operationJournal.js";

export const REPORT_POLL_QUEUE = "report-builder-poll";

async function submitReport(task: TaskContext, data: ReportRequest): Promise<AdapterResult> {
  // The job row and its poll job exist before the product is called, so a
  // crash after submitting is recovered by the worker, never forgotten.
  await inTransaction(pool, async (db) => {
    await db.query(
      `INSERT INTO report_builder_jobs (transaction_id, state) VALUES ($1, 'submitting')
       ON CONFLICT (transaction_id) DO NOTHING`,
      [task.id],
    );
    await enqueueDurableJob({
      db, queue: REPORT_POLL_QUEUE, idempotencyKey: task.id,
      payload: { taskId: task.id }, availableAt: new Date(Date.now() + 30_000),
    });
  });
  try {
    await submitJob(task, data);
  } catch (error) {
    // Unknown outcome: the job may exist. The worker reconciles it; the
    // order is pending, not failed.
    if (!(error instanceof SupplierOutcomeAmbiguousError)) throw error;
  }
  return { status: "working", message: "Report job accepted." };
}

/** Exactly-once submission under one logical key for the order. */
export function submitJob(task: TaskContext, data: ReportRequest) {
  return runSupplierOperation({
    serviceId: task.service_id,
    transactionId: task.id,
    opKey: `report-job:${task.id}`,
    kind: "report.submit",
    request: data,
    execute: async () => {
      try {
        return { jobId: await product.submit({ ...data, clientReference: task.id }) };
      } catch (error) {
        // Only a documented refusal that proves no job was created is a
        // definitive outcome; journal it as this operation's result.
        const refused = documentedRefusal(error); // a reviewed code, or null
        if (refused) return { rejected: refused };
        throw error; // anything else leaves the outcome unknown
      }
    },
    // After an ambiguous attempt: the product's own record decides.
    reconcile: async () => {
      const found = await product.findByClientReference(task.id);
      return found ? { jobId: found.id } : null; // null: it never happened
    },
  });
}
```

The journal records the intent before the call. Anything `execute` throws
marks the operation `ambiguous`, since the product may have acted; every
later attempt under the same key runs `reconcile` against the product first
and calls `execute` again only when the product proves the job does not
exist. Throw `SupplierOutcomeAmbiguousError` from `reconcile` while the
product cannot answer; the operation stays parked. A documented refusal that
proves nothing was created is returned as the operation's result
(`{ rejected }`), so the worker maps it to a reviewed failure instead of
retrying it. A spend-bearing submission passes
`spend: { ceiling: task.supplierCostCeiling, planned }` so core refuses a
call above the supplier price the quote reported plus the recorded price
tolerance before it is made.

If the process dies inside `execute`, core never calls it again for that
order: it flags the order for reconciliation and records an incident, while
the poll job, which already exists, reconciles the submission through the
journal and finishes the order.

Persist only what you need: the job id, never request secrets. If the product
returns a bearer job URL, store it encrypted (`encryptString` with a
service-owned context), keep it out of logs and diagnostics, and still rely
on the client-reference lookup for recovery. Create `report_builder_jobs`
with a service migration that carries the runtime epoch trigger
([adding a service](adding-a-service.md#7-add-migrations-and-seed-only-if-needed)).

## 2. Poll from a durable worker

The worker claims due poll jobs under a lease, so any replica resumes after a
restart or deployment and two replicas never poll one job at once:

```typescript
import {
  claimDurableJob, completeDurableJob, deferDurableJob, failDurableJob, withDurableJobLease,
} from "../../core/db/queries/durableJobs.js";
import { processAdapterResult } from "../../core/engine/taskFinalization.js";
import { heartbeatWorker } from "../../core/health.js";

async function pollOnce(workerId: string, serviceId: string): Promise<void> {
  const job = await claimDurableJob({ queue: REPORT_POLL_QUEUE, workerId, leaseSeconds: 120 });
  if (!job) return;
  const claim = { id: job.id, workerId, leaseToken: job.lease_token };
  const taskId = String(job.payload.taskId);
  try {
    const step = await withDurableJobLease({ ...claim, leaseSeconds: 120, work: () => advance(taskId, serviceId) });
    if (step === "pending") {
      // Polling is not failing: a deferral consumes no attempt.
      await deferDurableJob({ ...claim, retryAt: nextPollAt(job) });
    } else {
      await completeDurableJob(claim);
    }
  } catch {
    // The product or the database could not answer: try again later. After
    // the attempt budget the job dead-letters for an operator; the order
    // itself stays open.
    await failDurableJob({ ...claim, error: "report poll failed", retryAt: backoff(job.attempts) });
  }
}
```

`advance` does nothing for an order that is already terminal. Otherwise it
resolves the job id (reconciling the submission through the same `submitJob`
key when the row has none yet; a journaled `{ rejected }` ends the order with
that reviewed failure code), reads the product job, and maps its state:

| Product answer | Provider action |
| --- | --- |
| `queued`, `running` | Pending: return `"pending"`; the job is deferred, not failed. |
| `succeeded` | Read the report, validate it against the skill's result schema, then `processAdapterResult(taskId, { status: "completed", artifacts }, serviceId)`. |
| `failed` with a documented, definitive reason | `processAdapterResult(taskId, { status: "failed", error: "<reviewed code>", message: "<reviewed text>" }, serviceId)`. Never forward the product's free text. |
| Report fails validation | Keep the order open and open an operator review (`createHumanEscalation`); never sign an invalid report. |
| Timeout, 5xx, rate limit, unknown state | Throw: the job retries with backoff; the order stays open. |

`processAdapterResult` is the result-persistence boundary: it makes the
order terminal, freezes its terminal identity, applies the owner-version
guard for owner-only work and records reputation, so the gateway's next
status read answers it. A worker never writes task state directly.

Start the loop from `operations.startWorkers`, heartbeat it every cycle, and
return its stop function:

```typescript
operations: {
  migrations: reportBuilderMigrations,
  startWorkers: startReportPoller, // heartbeatWorker("report-builder-poller") each cycle
  readiness: { requiredWorkers: ["report-builder-poller"] },
  waitSupervision: {
    worker: "report-builder-poller",
    supervisedTasks: async ({ db, taskIds }) => new Set((await db.query<{ id: string }>(
      `SELECT transaction_id AS id FROM report_builder_jobs
        WHERE transaction_id = ANY($1) AND state IN ('submitting','polling')`,
      [taskIds],
    )).rows.map((row) => row.id)),
  },
},
```

The required worker keeps readiness honest: a dead poller degrades
`servicing` and stops new quotes while funded orders' reads stay served, and
it stays required while the service still owes work after it is paused. Wait
supervision tells the task watchdog that a long `working` order is owned by a
healthy poller rather than stalled; it never suspends the order's clocks.

## 3. Pending, overdue and failed are different

- **Pending** is the normal state of a running product job. Polls back off
  under the product's rate limits and never count against a failure budget.
- **Overdue** begins when the order's admitted fulfillment duration has
  passed since durable acceptance. The task watchdog marks the order overdue
  once and keeps it open; keep polling, and a late report is still delivered.
  An expired deadline does not prove the product failed, and the gateway owns
  its own deadline outcome for the buyer.
- **Failed** is only a definitive product failure, mapped to a reviewed code.
  A lost response, an ambiguous submission or an exhausted retry budget is
  not a failure: reconcile, or leave it for an operator.

## 4. Cancellation and later input

Implement `cancel` only when the product can stop the job: key the product
call on `task.lifecycleAction.idempotencyKey`, reconcile first when
`task.lifecycleAction.resumed` is set, and update the job row so the poller
stops. Throw `CancellationRefusedError` when nothing changed, for example once
the job already finished. Buyer input works the same way through
`handleInput`.

## 5. Tests to keep with the service

Use a fake product client and fake clocks; never call the live product in
tests. Cover at least:

- a lost submit response (the product created the job): the worker
  reconciles it by client reference and never submits again;
- an idempotency key that expired during an outage: the lookup still finds
  the original job, and nothing is resubmitted blindly;
- pending polls that outlast the attempt budget without failing the order;
- a definitive product failure mapped to its reviewed code;
- a report that violates the result schema: the order stays open and an
  operator review is opened;
- completion after the fulfillment deadline: the late report is delivered;
- a restart or deployment mid-job: another replica resumes from the durable
  row and poll job.

A fake-backed adapter proves the wiring, not the product's payment,
idempotency, lookup or retention guarantees; record those facts from the
product's owner before Testnet.
