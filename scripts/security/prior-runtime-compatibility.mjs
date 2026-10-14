import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";
import { CURRENT_ENQUEUE, CURRENT_RESUME, CURRENT_UPGRADE, PRIOR_OVERLAP, PRIOR_SEED } from "./prior-runtime-steps.mjs";

// F-T11, C-T07: with the prior release's own compiled code, this release's
// compiled code and a synthetic previous-version database, prove that
//   1. the prior image boots on its schema and leaves retained obligations
//      it wrote itself: a promoted listing version, an admitted order that
//      never started, a started order whose answer was lost, a completed
//      order and an old quote that may have been paid;
//   2. this release migrates that database, passes its startup steps and
//      its compatibility check against those obligations, and keeps the
//      completed order exactly as the prior left it;
//   3. the prior image, started against the migrated schema, passes only
//      its migration step: registering services, claiming the queued job,
//      sweeping tasks and admitting an order are refused, and no row moves;
//   4. this release then resumes the never-started order to completion and
//      never repeats the started one.
// The prior's role-separation boot checks are skipped: the disposable
// database has one principal. No private fixture, chain, gateway, supplier
// or signature is involved; only building the prior uses the network.
//
// usage: node scripts/security/prior-runtime-compatibility.mjs [--prior <built prior checkout>]
// Without --prior the prior release is extracted with git archive and built.
// Test-only: NODE_ENV=test and a loopback DATABASE_URL server, after
// `npm run build`; it creates and drops its own database.

const PRIOR_REF = "c42518ac6540f8158dbe458e06ae64b8825c6e53";
const DATABASE = "daski_prior_runtime_ci";
const root = process.cwd();

if (process.env.NODE_ENV !== "test") throw new Error("prior-runtime compatibility proof is test-only");
const base = new URL(process.env.DATABASE_URL);
if (!["127.0.0.1", "localhost"].includes(base.hostname)) {
  throw new Error("prior-runtime compatibility proof requires a loopback PostgreSQL server");
}
const adminUrl = new URL(base);
adminUrl.pathname = "/postgres";
const targetUrl = new URL(base);
targetUrl.pathname = `/${DATABASE}`;
const target = targetUrl.toString();
const input = {
  gatewayOrigin: new URL(process.env.GATEWAY_BASE_URL).origin,
  payer: "0x9999999999999999999999999999999999999999",
  listing: null,
};

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr.slice(-2_000)}`);
}

/** The prior release built from its own source, never this checkout relabeled. */
function priorRuntime() {
  const index = process.argv.indexOf("--prior");
  if (index >= 0) return { dir: resolve(process.argv[index + 1]), cleanup: () => undefined };
  if (spawnSync("git", ["cat-file", "-e", `${PRIOR_REF}^{commit}`], { cwd: root }).status !== 0) {
    run("git", ["fetch", "--no-tags", "--depth=1", "origin", PRIOR_REF], root);
  }
  const dir = mkdtempSync(join(tmpdir(), "daski-prior-runtime-"));
  const archive = spawnSync("git", ["archive", "--format=tar", PRIOR_REF], { cwd: root, maxBuffer: 1 << 28 });
  if (archive.status !== 0) throw new Error("git archive of the prior release failed");
  if (spawnSync("tar", ["-x", "-C", dir], { input: archive.stdout }).status !== 0) {
    throw new Error("extracting the prior release failed");
  }
  run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], dir);
  run("npm", ["run", "build"], dir);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Run one step program inside the compiled runtime at `cwd`; resolves its proof. */
function step(name, cwd, program) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", program], {
      cwd,
      env: {
        ...process.env, DATABASE_URL: target, MIGRATION_DATABASE_URL: target, PROOF_INPUT: JSON.stringify(input),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => {
      const line = stdout.trim().split("\n").reverse().find((entry) => entry.startsWith("{\"proof\""));
      if (status !== 0 || !line) fail(new Error(`${name} failed (${status}): ${stderr.slice(-2_000)}`));
      else done(JSON.parse(line).proof);
    });
  });
}

function expectThat(condition, message, detail) {
  if (!condition) throw new Error(`prior-runtime compatibility: ${message}${detail ? ` ${JSON.stringify(detail)}` : ""}`);
}

const SNAPSHOT_TABLES = [
  "_migrations", "services", "skills", "customers", "transactions", "standard_dispatch_claims", "durable_jobs",
  "standard_terminal_results", "standard_provider_quotes", "standard_security_incidents",
  "standard_reputation_outcomes", "provider_runtime_listing_versions", "events", "assets",
];

/** Every row of the tables the prior image would touch, in a stable order. */
async function snapshot(client) {
  const rows = {};
  for (const table of SNAPSHOT_TABLES) {
    rows[table] = (await client.query(`SELECT to_jsonb(x)::text AS row FROM ${table} x ORDER BY 1`)).rows;
  }
  return JSON.stringify(rows);
}

/** The completed order's rows in the prior schema's own columns. */
async function terminalRows(client, taskId) {
  const order = await client.query(
    `SELECT id,status,metadata,completed_at,updated_at,version,standard_order_id,standard_payer,
            standard_listing_manifest_hash,standard_order_key,standard_token,standard_gross_amount,
            standard_provider_net_amount,standard_daski_commission_amount
       FROM transactions WHERE id=$1`, [taskId]);
  const claim = await client.query(
    `SELECT gateway_audience,order_id,dispatch_hash,request_hash,payer,state,response_hash,claimed_at,resolved_at
       FROM standard_dispatch_claims WHERE transaction_id=$1`, [taskId]);
  const reputation = await client.query(
    "SELECT order_key,outcome,state FROM standard_reputation_outcomes WHERE transaction_id=$1", [taskId]);
  return JSON.stringify([order.rows, claim.rows, reputation.rows]);
}

const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
const prior = priorRuntime();
let probe = null;
try {
  await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DATABASE}`);
  // This release's sessions declare its runtime epoch (core migration 011).
  probe = new pg.Client({ connectionString: target, options: "-c daski.runtime_epoch=1" });
  await probe.connect();

  const seeded = await step("prior seed", prior.dir, PRIOR_SEED);
  input.listing = seeded.listing;
  const { unstarted, started, terminal } = seeded.orders;
  expectThat(seeded.terminalState === "completed", "the prior did not complete its terminal order", seeded);
  const legacyTerminal = await terminalRows(probe, terminal);

  const upgraded = await step("current upgrade", root, CURRENT_UPGRADE);
  expectThat(upgraded.migrations.includes("011_runtime_epoch_barrier.sql"), "the schema did not migrate", upgraded);
  const clock = (field, fallback) => Number.isSafeInteger(seeded.deadlines[field]) ? seeded.deadlines[field] : fallback;
  const admittedClock = JSON.stringify([clock("dispatchSeconds", 300), clock("fulfillmentSeconds", 2_592_000)]);
  expectThat([unstarted, started, terminal].every((id) => JSON.stringify(upgraded.clocks[id]) === admittedClock),
    "earlier claims did not take their version's deadlines", upgraded.clocks);
  expectThat(upgraded.frozen === 0, "a terminal identity was frozen from a guess during the upgrade", upgraded);

  const check = spawnSync(process.execPath, ["dist/checkCompatibility.js"], {
    cwd: root, encoding: "utf8", env: { ...process.env, DATABASE_URL: target },
  });
  const report = JSON.parse(check.stdout.trim().split("\n").at(-1) || "{}");
  expectThat(check.status === 0 && report.ok === true, "the compatibility check failed", report.gaps ?? check.stderr);
  const version = report.versions.find((entry) => entry.listingManifestHash === seeded.listing);
  expectThat(version?.pendingTasks === 2 && version.terminalTasks === 1 && version.unadmittedQuotes === 1 &&
    version.requiresHandler && version.requiresSigningKey, "the retained obligations were not inventoried", version);

  const enqueued = await step("current enqueue", root, CURRENT_ENQUEUE);
  expectThat(enqueued.queued === 1 && enqueued.jobs.length === 1 && enqueued.jobs[0].taskId === unstarted &&
    enqueued.jobs[0].status === "queued" && enqueued.jobs[0].runnable, "the never-started order was not queued", enqueued);

  const before = await snapshot(probe);
  const overlap = await step("prior overlap", prior.dir, PRIOR_OVERLAP);
  const refusals = Object.values(overlap.refused);
  expectThat(refusals.length === 4 && refusals.every((code) => code === "55000"),
    "the prior image wrote to the migrated schema", overlap.refused);
  expectThat(await snapshot(probe) === before, "the prior image changed rows of the migrated schema");

  const resumed = await step("current resume", root, CURRENT_RESUME);
  expectThat(JSON.stringify(resumed.tasks[unstarted]) === JSON.stringify({
    status: "completed", provenance: "terminal-transition", job: "completed",
  }), "the never-started order did not resume to completion", resumed.tasks);
  expectThat(JSON.stringify(resumed.tasks[started]) === JSON.stringify({ status: "working", provenance: null, job: null }),
    "the started order was repeated or guessed terminal", resumed.tasks);
  expectThat(await terminalRows(probe, terminal) === legacyTerminal, "the completed order changed after the upgrade");

  process.stdout.write(`${JSON.stringify({
    priorRef: PRIOR_REF, migrations: upgraded.migrations.length, capabilityHash: report.capabilityHash,
    obligations: {
      pendingTasks: version.pendingTasks, terminalTasks: version.terminalTasks, unadmittedQuotes: version.unadmittedQuotes,
    },
    priorOverlap: overlap.refused, resumed: resumed.tasks[unstarted].status,
  })}\nprior-runtime compatibility proof passed\n`);
} finally {
  await probe?.end().catch(() => undefined);
  await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`).catch(() => undefined);
  await admin.end();
  prior.cleanup();
}
