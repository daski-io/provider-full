// The programs prior-runtime-compatibility.mjs runs inside one release's
// compiled runtime: each is evaluated as a module with that release's
// checkout as its working directory, so `./dist/...` and its dependencies
// are that release's own. PROOF_INPUT carries the shared synthetic values;
// each program prints one `{"proof": ...}` line.

const PRELUDE = `
const input = JSON.parse(process.env.PROOF_INPUT);
const { checkDatabase, runMigrations, closeMigrationPool, pool } = await import("./dist/core/db/pool.js");
const { installProviderScreening } = await import("./dist/providerScreening.js");
const { registerService, getAdapter } = await import("./dist/core/serviceRegistry/registry.js");
const { providerServices } = await import("./dist/providerServices.js");
const { randomBytes, randomUUID } = await import("node:crypto");
const hex = () => "0x" + randomBytes(32).toString("hex");
const bytes = (value) => Buffer.from(value.slice(2), "hex");
const emit = (proof) => console.log(JSON.stringify({ proof }));
const startup = async () => {
  if (!await checkDatabase()) throw new Error("database unreachable");
  await runMigrations();
  await installProviderScreening();
  for (const module of providerServices) await registerService(module);
};
`;

const PRIOR_ADMISSION = `
const { StandardDispatchService } = await import("./dist/core/standardRail/dispatch.js");
/** A dispatch admitted through the prior's own claim transaction (its verification is out of scope). */
const admit = async (title) => {
  const dispatch = {
    gatewayAudience: input.gatewayOrigin, orderId: "ord_" + randomUUID(), dispatchNonce: hex(), payer: input.payer,
    canonicalProviderRequestHash: hex(), canonicalRequestHash: hex(), listingManifestHash: input.listing,
    orderKey: hex(), providerOfferHash: hex(), depositEvidenceHash: hex(), releaseEvidenceHash: hex(),
    grossAmount: "1000000", providerNetAmount: "950000", daskiCommissionAmount: "50000",
  };
  const request = { title };
  const claimed = await StandardDispatchService.prototype.claim.call(null, {
    dispatch, dispatchHash: hex(), request, supplierCostCeiling: null,
    outcome: { serviceSlug: "dummy", skillId: "create-note", maxOpenOrders: 100, token: process.env.USDC_ADDRESS },
  });
  return { taskId: claimed.taskId, orderId: dispatch.orderId, request };
};
`;

/** The prior image boots on its own schema and leaves synthetic retained obligations. */
export const PRIOR_SEED = `${PRELUDE}
const { buildContractExtension } = await import("./dist/core/agentCards/contractExtension.js");
const { promoteRuntimeListingVersions } = await import("./dist/core/gatewayRegistration/runtimeCatalog.js");
const { getServiceBySlug } = await import("./dist/core/db/queries/services.js");
const { getSkillsByServiceId } = await import("./dist/core/db/queries/skills.js");
const { processAdapterResult } = await import("./dist/core/engine/taskFinalization.js");
const { canonicalHash } = await import("./dist/core/standardRail/canonical.js");
const { privateKeyToAccount } = await import("viem/accounts");
try {
  await startup();
  const service = await getServiceBySlug("dummy");
  const module = providerServices.find((entry) => entry.manifest.slug === "dummy");
  const contract = buildContractExtension(service, await getSkillsByServiceId(service.id), module)
    .skills.find((skill) => skill.skillId === "create-note").contract;
  input.listing = hex();
  // The listing version as the prior's registration promotes it, with the
  // bundle fields a version's servicing reads.
  await promoteRuntimeListingVersions(input.gatewayOrigin, hex(), [{
    skillId: "create-note", listingId: randomUUID(), listingKey: hex(), paymentRequired: true,
    runtimeCommitmentHash: input.listing, runtimeCommitment: {},
    bundle: {
      skillContract: { skillId: "create-note", contract },
      intent: { payload: { serviceSlug: "dummy" } },
      providerIdentity: { agentWallet: privateKeyToAccount(process.env.PROVIDER_WALLET_PRIVATE_KEY).address },
    },
  }]);
  ${PRIOR_ADMISSION}
  // The start fence exactly as the prior's accept() takes it.
  const start = (order) => pool.query(
    "UPDATE transactions SET status='working',updated_at=now()," +
    "metadata=metadata || '{\\"supplier_mutation_started\\":true}'::jsonb " +
    "WHERE id=$1 AND standard_order_id=$2 AND status='submitted'", [order.taskId, order.orderId]);
  // Admitted, and the process died before the order started.
  const unstarted = await admit("Kept unstarted");
  // Started, and the process died before the service answered.
  const started = await admit("Kept started");
  await start(started);
  // Fulfilled to completion through the prior's own result path.
  const terminal = await admit("Kept terminal");
  await start(terminal);
  const result = await getAdapter(service.adapter_name).execute("create-note", {
    id: terminal.taskId, service_id: service.id, skill_id: "create-note", status: "working",
    supplierMutationStarted: true,
  }, terminal.request, undefined);
  const processed = await processAdapterResult(terminal.taskId, result, service.id);
  await pool.query(
    "UPDATE standard_dispatch_claims SET state=$2,resolved_at=now(),response_hash=$3 " +
    "WHERE gateway_audience=$1 AND order_id=$4",
    [input.gatewayOrigin, processed.status, bytes(canonicalHash(result)), terminal.orderId]);
  // A quote issued two days ago that may have been paid but was never
  // dispatched, persisted as the prior's quote() persists it.
  const issuedAt = Math.floor(Date.now() / 1000) - 172_800;
  await pool.query(
    "INSERT INTO standard_provider_quotes (quote_hash,outcome_id,listing_manifest_hash,request_hash," +
    "gross_amount,supplier_cost_ceiling,issued_at,valid_before) " +
    "VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7),to_timestamp($8)) ON CONFLICT (quote_hash) DO NOTHING",
    [bytes(hex()), "create-note", bytes(input.listing), bytes(hex()), "1000000", null, issuedAt, issuedAt + 120]);
  emit({
    listing: input.listing, deadlines: contract.deadlines ?? {}, terminalState: processed.status,
    orders: { unstarted: unstarted.taskId, started: started.taskId, terminal: terminal.taskId },
  });
} finally {
  await closeMigrationPool();
  await pool.end();
}`;

/** This release boots on the previous-version database and migrates it forward. */
export const CURRENT_UPGRADE = `${PRELUDE}
try {
  await startup();
  const migrations = (await pool.query("SELECT name FROM _migrations ORDER BY name")).rows.map((row) => row.name);
  const clocks = Object.fromEntries((await pool.query(
    "SELECT transaction_id,admitted_dispatch_seconds,admitted_fulfillment_seconds FROM standard_dispatch_claims",
  )).rows.map((row) => [row.transaction_id, [row.admitted_dispatch_seconds, row.admitted_fulfillment_seconds]]));
  const frozen = (await pool.query("SELECT transaction_id FROM standard_terminal_results")).rows.length;
  emit({ migrations, clocks, frozen });
} finally {
  await closeMigrationPool();
  await pool.end();
}`;

/** This release gives the order the prior admitted but never started its fulfillment job. */
export const CURRENT_ENQUEUE = `${PRELUDE}
const { enqueueUnqueuedAdmissions } = await import("./dist/core/standardRail/paidFulfillmentWorker.js");
const { registeredExecutableHashes } = await import("./dist/core/serviceRegistry/retainedHandlers.js");
try {
  await startup();
  const queued = await enqueueUnqueuedAdmissions({ gatewayOrigin: input.gatewayOrigin, outcomes: new Map() });
  const runnable = registeredExecutableHashes();
  const jobs = (await pool.query(
    "SELECT idempotency_key,status,required_capability FROM durable_jobs WHERE queue='standard-paid-fulfillment'",
  )).rows.map((row) => ({ taskId: row.idempotency_key, status: row.status, runnable: runnable.has(row.required_capability) }));
  emit({ queued, jobs });
} finally {
  await closeMigrationPool();
  await pool.end();
}`;

/** The prior image, started against the migrated schema, tries its first writes. */
export const PRIOR_OVERLAP = `${PRELUDE}
const { claimDurableJob } = await import("./dist/core/db/queries/durableJobs.js");
const { reconcileStuckStandardTasks } = await import("./dist/core/standardRail/taskWatchdog.js");
${PRIOR_ADMISSION}
const refused = {};
const attempt = async (name, work) => {
  try {
    await work();
    refused[name] = "accepted";
  } catch (error) {
    refused[name] = error.code ?? error.message;
  }
};
try {
  // The prior's migrations are all applied, so its migration step passes...
  if (!await checkDatabase()) throw new Error("database unreachable");
  await runMigrations();
  await installProviderScreening();
  // ...and its next boot step and every worker write are refused.
  await attempt("registerService", async () => {
    for (const module of providerServices) await registerService(module);
  });
  await attempt("claimJob", () => claimDurableJob({
    queue: "standard-paid-fulfillment", workerId: "prior-runtime", leaseSeconds: 300,
  }));
  await attempt("sweepTasks", () => reconcileStuckStandardTasks({
    outcomes: new Map([["create-note", { listingManifestHash: input.listing, dispatchDeadlineSeconds: 30 }]]),
  }, Date.now() + 3_600_000));
  await attempt("admitOrder", () => admit("Refused"));
  emit({ refused });
} finally {
  await closeMigrationPool();
  await pool.end();
}`;

/** This release's fulfillment worker resumes the job. */
export const CURRENT_RESUME = `${PRELUDE}
const { runPaidFulfillmentCycle } = await import("./dist/core/standardRail/paidFulfillmentWorker.js");
try {
  await startup();
  await runPaidFulfillmentCycle({ gatewayOrigin: input.gatewayOrigin, outcomes: new Map() }, false);
  const tasks = Object.fromEntries((await pool.query(
    "SELECT t.id,t.status,r.provenance,j.status AS job FROM transactions t " +
    "LEFT JOIN standard_terminal_results r ON r.transaction_id=t.id " +
    "LEFT JOIN durable_jobs j ON j.queue='standard-paid-fulfillment' AND j.idempotency_key=t.id",
  )).rows.map((row) => [row.id, { status: row.status, provenance: row.provenance, job: row.job }]));
  emit({ tasks });
} finally {
  await closeMigrationPool();
  await pool.end();
}`;
