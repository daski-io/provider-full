import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import ts from "typescript";

const root = process.cwd();
const failures = [];
const read = (path) => readFileSync(join(root, path), "utf8");
const projectPath = (path) => relative(root, path).replaceAll("\\", "/");

function files(path) {
  return readdirSync(path).flatMap((name) => {
    const absolute = join(path, name);
    return statSync(absolute).isDirectory() ? files(absolute) : [absolute];
  });
}

const packageJson = JSON.parse(read("package.json"));
const gitAttributes = read(".gitattributes");
if (!/^\* text=auto eol=lf\s*$/m.test(gitAttributes)) {
  failures.push("Git text files must use LF for cross-platform checksums");
}
if (packageJson.private !== true) {
  failures.push("package.json must prevent accidental npm publication");
}
if (packageJson.engines?.node !== ">=24.0.0 <25") {
  failures.push("package.json must restrict production to Node 24");
}
if (
  !packageJson.scripts?.dev?.includes("src/bootstrap.ts")
  || !packageJson.scripts?.start?.includes("dist/bootstrap.js")
) {
  failures.push("runtime entrypoints must use the sanitized bootstrap");
}
const bootstrapSource = read("src/bootstrap.ts");
if (!bootstrapSource.includes("npm run doctor -- --stage=testnet")) {
  failures.push(
    "sanitized configuration failures must route operators to read-only doctor",
  );
}
for (const script of [
  "daski:register",
  "doctor",
  "docs:check",
  "typecheck",
  "typecheck:test",
  "test:run",
  "test:coverage",
  "test:critical-coverage",
  "security:audit",
  "security:pii-scan",
]) {
  if (!packageJson.scripts?.[script]) {
    failures.push(`package.json is missing ${script}`);
  }
}

const criticalCoverage = read("vitest.critical.config.ts");
for (const criticalFile of [
  "src/core/chain/providerWriteCoordinator.ts",
  "src/core/chain/runtimeTrust.ts",
  "src/core/chain/signerLease.ts",
  "src/core/auth/requestHash.ts",
  "src/core/standardRail/walletAuthorization.ts",
  "src/core/compliance/lease.ts",
  "src/core/db/sessionAdvisoryLock.ts",
  "src/core/security/reviewedEndpoint.ts",
  "src/core/suppliers/operationJournal.ts",
]) {
  if (!criticalCoverage.includes(`"${criticalFile}"`)) {
    failures.push(`critical coverage gate is missing ${criticalFile}`);
  }
}
if (
  !/perFile:\s*true/.test(criticalCoverage)
  || !/statements:\s*90/.test(criticalCoverage)
  || !/branches:\s*85/.test(criticalCoverage)
  || !/functions:\s*90/.test(criticalCoverage)
  || !/lines:\s*90/.test(criticalCoverage)
) {
  failures.push("critical coverage thresholds must remain 90/85/90/90 per file");
}

const healthSource = read("src/core/health.ts");
if (!/healthRouter\.get\(\s*["']\/ready["']/.test(healthSource)) {
  failures.push("health router must expose /health/ready");
}
const startupSource = read("src/index.ts");
const railReadiness = startupSource.indexOf("await startStandardRailReadiness(");
const chainReadiness = startupSource.indexOf("await enforceInitialChainReadiness(");
const listenerStart = startupSource.indexOf("await startServer(");
if (
  railReadiness < 0
  || chainReadiness < 0
  || listenerStart < 0
  || railReadiness > listenerStart
  || chainReadiness > listenerStart
) {
  failures.push("rail and identity readiness must pass before the listener starts");
}

const dockerfile = read("Dockerfile");
if (!/node:24-bookworm-slim@sha256:[0-9a-f]{64}/.test(dockerfile)) {
  failures.push("Dockerfile must pin the reviewed Node 24 image digest");
}
if (!/^USER\s+(?!root\b|0\b)\S+/m.test(dockerfile)) {
  failures.push("Dockerfile runtime must use a non-root user");
}
if (!/^CMD\s+\["node",\s*"dist\/bootstrap\.js"\]\s*$/m.test(dockerfile)) {
  failures.push("Dockerfile runtime must use the sanitized bootstrap");
}
if (/npm\s+ci[^\n]*--no-audit/.test(dockerfile)) {
  failures.push("Dockerfile must not suppress dependency audit");
}

const ignored = new Set(
  read(".dockerignore").split(/\r?\n/).map((line) => line.trim()),
);
for (const entry of [
  ".git",
  ".github",
  ".claude",
  "compose.yaml",
  "docs",
  "scripts",
  "test",
  "**/fixtures",
  "**/captures",
]) {
  if (!ignored.has(entry)) failures.push(`.dockerignore must exclude ${entry}`);
}

const composeSource = read("compose.yaml");
if (!/postgres:16-bookworm@sha256:[0-9a-f]{64}/.test(composeSource)) {
  failures.push("compose.yaml must pin the reviewed PostgreSQL 16 image digest");
}
if (
  !composeSource.includes('"127.0.0.1:55432:5432"')
  || !/^\s*network_mode:\s*bridge\s*$/m.test(composeSource)
) {
  failures.push("the local PostgreSQL service must publish only on loopback");
}
if (
  !composeSource.includes("provider_postgres_data:/var/lib/postgresql/data")
  || !composeSource.includes("name: daski-provider-full-dev-postgres")
) {
  failures.push("the local PostgreSQL service must use its named development volume");
}
for (const requiredPath of ["scripts/doctor.mjs"]) {
  if (!existsSync(join(root, requiredPath))) failures.push(`${requiredPath} is missing`);
}
const releaseWorkflow = read(".github/workflows/security-release.yml");
for (const required of [
  'tags: ["v*"]',
  "npm run docs:check",
  "runs-on: windows-latest",
  "needs: [verify, windows-tooling]",
  "docker compose config --quiet",
  'provider-full-${VERSION}.tar.gz',
  "SHA256SUMS",
  "gh release create",
]) {
  if (!releaseWorkflow.includes(required)) {
    failures.push(`security-release workflow is missing: ${required}`);
  }
}

const sourceFiles = files(join(root, "src"));
for (const file of sourceFiles) {
  if (!/\.(?:ts|js|mjs)$/.test(file)) continue;
  const source = readFileSync(file, "utf8");
  const path = projectPath(file);

  if (/\bconsole\.(?:log|info|warn|error|debug)\s*\(/.test(source)) {
    failures.push(`${path} uses console instead of the centralized logger`);
  }
  if (
    path.startsWith("src/core/db/queries/")
    && /\bfrom\s+["'][^"']*\/engine\//.test(source)
  ) {
    failures.push(`${path} imports engine policy from persistence`);
  }
  if (
    path !== "src/core/chain/providerWriteCoordinator.ts"
    && /\bwalletClient\.(?:sendRawTransaction|writeContract)\s*\(/.test(source)
  ) {
    failures.push(`${path} bypasses the provider-write coordinator`);
  }

  const imports = [...source.matchAll(/\b(?:from\s+|import\s*\()["']([^"']+)["']/g)]
    .map((match) => match[1]);
  if (
    path.startsWith("src/core/")
    && imports.some((value) =>
      (value.includes("/services/") && !value.startsWith("./services/"))
      || value.includes("/providerExtensions/"))
  ) {
    failures.push(`${path} crosses the service-neutral core boundary`);
  }
  if (
    path.startsWith("src/services/")
    && imports.some((value) => value.includes("/providerExtensions/"))
  ) {
    failures.push(`${path} imports a provider-specific extension`);
  }
  if (
    path.startsWith("src/providerExtensions/")
    && imports.some((value) => value.includes("/services/"))
  ) {
    failures.push(`${path} imports a marketplace service`);
  }
  if (
    path.startsWith("src/services/")
    && !path.includes("/tests/")
    && /\bfetch\s*\(/.test(source)
  ) {
    failures.push(
      `${path} calls fetch directly; use the reviewed outbound HTTP boundary`,
    );
  }
}

const walletAuthorization = read("src/core/standardRail/walletAuthorization.ts");
for (const required of [
  "requestHash",
  "expectedPayer",
  "expectedRequestHash",
  "expectedActionHash",
  "expectedAudienceHash",
  "recoverTypedDataAddress",
  "recoverMessageAddress",
]) {
  if (!walletAuthorization.includes(required)) {
    failures.push(`wallet authorization is missing ${required}`);
  }
}
const actionStore = read("src/core/standardRail/actionStore.ts");
for (const ledger of [
  "standard_wallet_action_nonces",
  "standard_provider_grant_nonces",
]) {
  if (!actionStore.includes(ledger)) {
    failures.push(`asset actions must durably consume ${ledger}`);
  }
}
for (const retiredPath of [
  "src/core/a2a/taskAccessChallenges.ts",
  "src/core/capability/taskAccess.ts",
]) {
  if (existsSync(join(root, retiredPath))) {
    failures.push(`${retiredPath} must remain removed`);
  }
}
const confirmationQueries = sourceFiles
  .filter((file) => projectPath(file).startsWith("src/core/db/queries/confirmation"))
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");
if (/\bpending_payload\b/.test(confirmationQueries)) {
  failures.push("confirmation runtime references the retired plaintext payload");
}

const emailEscalation = read("src/core/agents/emailAgent/tools/escalate.ts");
const escalationStore = read("src/core/db/queries/escalations.ts");
if (
  !/OPERATOR_ESCALATION_QUEUE\s*=\s*["']operator-escalation["']/.test(escalationStore)
  || !/status:\s*["']in_agent_review["']/.test(emailEscalation)
  || !/assignee:\s*["']operator_agent["']/.test(emailEscalation)
) {
  failures.push("email triage must durably produce bounded operator review jobs");
}

const operatorTools = read("src/core/agents/operatorAgent/tools.ts");
const autonomousTools =
  /const ESCALATION_AUTONOMOUS_TOOLS[^=]*=\s*\[([\s\S]*?)\];/
    .exec(operatorTools)?.[1] ?? "";
for (const forbidden of [
  "serviceAction",
  "LegalHold",
  "ProviderWrite",
  "Reputation",
  "TransactionsTool",
]) {
  if (autonomousTools.includes(forbidden)) {
    failures.push(`autonomous triage includes forbidden capability ${forbidden}`);
  }
}
for (const required of [
  "getEscalationTool",
  "replyToBuyerTool",
  "resolveEscalationTool",
  "requestHumanReviewTool",
]) {
  if (!autonomousTools.includes(required)) {
    failures.push(`autonomous triage is missing ${required}`);
  }
}

const operationJournal = read("src/core/suppliers/operationJournal.ts");
if (/\bop\.error\b|SET\s+state\s*=\s*'[^']+',\s*error\s*=/s.test(operationJournal)) {
  failures.push("supplier journal references the retired plaintext error field");
}
for (const required of ["error_code", "operationErrorCode", "assertSupplierErrorCode"]) {
  if (!operationJournal.includes(required)) {
    failures.push(`supplier journal is missing ${required}`);
  }
}

const sessionLockModules = new Set([
  "src/core/chain/signerLease.ts",
  "src/core/compliance/lease.ts",
  "src/core/db/cycleLease.ts",
  "src/core/db/pool.ts",
  "src/core/security/protectedDataRotation.ts",
  "src/core/serviceRegistry/moduleMigrations.ts",
  "src/core/suppliers/operationJournal.ts",
  "src/core/suppliers/resourceLock.ts",
]);
for (const file of sourceFiles) {
  const path = projectPath(file);
  if (!file.endsWith(".ts") || path.includes("/tests/") || path.endsWith(".test.ts")) {
    continue;
  }
  const source = readFileSync(file, "utf8");
  if (!/\bpg_(?:try_)?advisory_lock\s*\(/.test(source)) continue;
  if (!sessionLockModules.has(path)) {
    failures.push(`${path} adds an unreviewed session advisory lock`);
  }
  if (!source.includes("withSessionAdvisoryLock")) {
    failures.push(`${path} bypasses the shared advisory-lock guard`);
  }
}

function resolveSourceImport(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const imported = resolve(dirname(fromFile), specifier);
  const candidates = extname(imported) === ".js"
    ? [imported.slice(0, -3) + ".ts"]
    : [imported, `${imported}.ts`, join(imported, "index.ts")];
  return candidates.find((candidate) => sourceFileSet.has(candidate)) ?? null;
}

const productionSources = sourceFiles.filter((file) => {
  const path = projectPath(file);
  return file.endsWith(".ts")
    && !file.endsWith(".d.ts")
    && !path.includes("/tests/")
    && !path.endsWith(".test.ts");
});
const sourceFileSet = new Set(productionSources);
const reachable = new Set();
// These are public building blocks for real service modules. The dummy service
// intentionally has no external supplier, compliance vendor, or asset
// mutation, so these entrypoints are not reached by the starter composition.
const reusableCoreEntrypoints = [
  "src/core/admin/assetMutation.ts",
  "src/core/compliance/blocklist.ts",
  "src/core/compliance/lease.ts",
  "src/core/security/publicFailures.ts",
  "src/core/security/reviewedEndpoint.ts",
  "src/core/suppliers/circuitBreaker.ts",
  "src/core/suppliers/circuitBreakerPolicy.ts",
  "src/core/suppliers/circuitBreakerRecovery.ts",
  "src/core/suppliers/circuitBreakerStore.ts",
  "src/core/suppliers/errorClassifier.ts",
  "src/core/suppliers/operationJournal.ts",
  "src/core/suppliers/resourceLock.ts",
];
const pending = [
  join(root, "src/bootstrap.ts"),
  join(root, "src/rotateProtectedData.ts"),
  join(root, "src/registerGatewayServices.ts"),
  join(root, "src/core/standardRail/offerCli.ts"),
  ...reusableCoreEntrypoints.map((path) => join(root, path)),
];
while (pending.length > 0) {
  const file = pending.pop();
  if (!file || reachable.has(file)) continue;
  reachable.add(file);
  const imports = ts.preProcessFile(
    readFileSync(file, "utf8"),
    true,
    true,
  ).importedFiles;
  for (const imported of imports) {
    const resolved = resolveSourceImport(file, imported.fileName);
    if (resolved && !reachable.has(resolved)) pending.push(resolved);
  }
}
for (const file of productionSources) {
  if (!reachable.has(file)) {
    failures.push(`${projectPath(file)} is unreachable production code`);
  }
}

const publicDocs = [
  "README.md",
  "SECURITY.md",
  ...files(join(root, "docs")),
];
for (const publicDoc of publicDocs) {
  const source = readFileSync(publicDoc, "utf8");
  const path = projectPath(publicDoc);
  if (/\.claude\//.test(source) && path !== "docs/agent-skill.md") {
    failures.push(`${projectPath(publicDoc)} references a harness-local file`);
  }
}
const agentSkillGuide = read("docs/agent-skill.md");
if (!agentSkillGuide.includes("https://github.com/daski-io/provider")) {
  failures.push("agent skill guide must link to the canonical provider skill");
}
if (existsSync(join(root, ".agents/skills/daski-provider"))) {
  failures.push("provider-full must not duplicate the canonical provider skill");
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("architecture gates passed\n");
