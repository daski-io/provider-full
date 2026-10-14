import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "./core/config.js";
import {
  checkDatabase,
  closeMigrationPool,
  configureStandardRuntimePrivileges,
  pool,
  runMigrations,
  verifyDatabaseRoleSeparation,
} from "./core/db/pool.js";
import {
  assertReadOnlySessions,
  enforceReadOnlySessions,
} from "./core/db/readOnlySessions.js";
import { listActiveServices, type ServiceRow } from "./core/db/queries/services.js";
import { activationPolling } from "./core/gatewayRegistration/evidence.js";
import {
  checkServiceRegistration,
  forecastFails,
} from "./core/gatewayRegistration/forecast.js";
import {
  identityHelperArguments,
  registerSelectedServices,
} from "./core/gatewayRegistration/registrationRun.js";
import { retireListingVersion } from "./core/gatewayRegistration/listingRetirement.js";
import { retireGatewayService } from "./core/gatewayRegistration/retirement.js";
import { retirementReceiptDomain } from "./core/gatewayRegistration/retirementReceipt.js";
import { assertNoDuplicateJsonKeys } from "./core/standardRail/canonical.js";
import {
  forbidGatewayWrites,
  normalizedGatewayOrigin,
} from "./core/gatewayRegistration/wire.js";
import { redactSensitiveText } from "./core/security/redaction.js";

const SERVICE_ID = /^0x[0-9a-fA-F]{64}$/;
const MAX_RECEIPT_FILE_BYTES = 1_048_576;

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function options(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== name) continue;
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    values.push(value);
  }
  return values;
}

const describe = (error: unknown) =>
  redactSensitiveText(error instanceof Error ? error.message : String(error));

// Gateway retirement receipts the operator obtained from Daski, one JSON
// receipt or an array of them per file; each is verified before use.
function gatewayReceipts(): unknown[] {
  return options("--gateway-receipt").flatMap((path) => {
    if (statSync(path).size > MAX_RECEIPT_FILE_BYTES) throw new Error("gateway receipt file is too large");
    const source = readFileSync(path, "utf8");
    assertNoDuplicateJsonKeys(source);
    const parsed = JSON.parse(source) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
  });
}

// The identity script verifies and binds PROVIDER_AGENT_ID, the agent every
// service is registered under; see identityHelperArguments.
async function ensureProviderIdentity(): Promise<void> {
  const script = fileURLToPath(new URL("../scripts/register-provider.mjs", import.meta.url));
  const args = [script, ...identityHelperArguments(process.argv, config.PROVIDER_AGENT_ID)];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(
        `provider identity registration failed (${signal ?? `exit ${code}`})`,
      ));
    });
  });
}

function selectServices(active: ServiceRow[]): ServiceRow[] {
  const selected = new Set(options("--service"));
  const services = active.filter((service) =>
    selected.size === 0 || selected.has(service.slug));
  if (services.length === 0) throw new Error("no active provider services matched");
  const missing = [...selected].filter((slug) =>
    !services.some((service) => service.slug === slug));
  if (missing.length > 0) {
    throw new Error(`unknown or inactive services: ${missing.join(", ")}`);
  }
  return services;
}

// Read-only forecast of what a registration run would do per service. No
// migration, identity script, ServiceRegistry bootstrap, signature,
// broadcast, gateway mutation or database write: every database session is
// read-only and any gateway request other than GET is refused before it is
// sent.
async function forecast(gateway: string): Promise<void> {
  activationPolling();
  forbidGatewayWrites();
  enforceReadOnlySessions(pool);
  if (!await checkDatabase()) {
    throw new Error(
      "provider database is unreachable on read-only sessions; --check-only needs a connection that accepts the startup option -c default_transaction_read_only=on (a direct connection, or a pooler that passes startup options through)",
    );
  }
  await assertReadOnlySessions(pool);
  let failing = 0;
  for (const service of selectServices(await listActiveServices())) {
    let line;
    try {
      line = await checkServiceRegistration(gateway, service);
    } catch (error) {
      line = {
        serviceSlug: service.slug,
        state: "BLOCKED" as const,
        action: "forecast-read-failed",
        detail: describe(error).replace(/\s+/g, " ").slice(0, 512),
      };
    }
    process.stdout.write(`${JSON.stringify(line)}\n`);
    if (forecastFails(line)) failing += 1;
  }
  if (failing > 0) throw new Error(`${failing} service(s) would not complete registration`);
}

async function main(): Promise<void> {
  const gateway = option("--gateway") ?? config.GATEWAY_BASE_URL;
  if (!gateway) throw new Error("--gateway or GATEWAY_BASE_URL is required");
  const retirement = option("--retire");
  const listingRetirement = option("--retire-listing");
  if (retirement && !SERVICE_ID.test(retirement)) {
    throw new Error("--retire requires an exact bytes32 service id");
  }
  if (listingRetirement && !SERVICE_ID.test(listingRetirement)) {
    throw new Error("--retire-listing requires an exact bytes32 listing manifest hash");
  }
  if (retirement && listingRetirement) throw new Error("--retire cannot be combined with --retire-listing");
  if ((retirement || listingRetirement) && options("--service").length > 0) {
    throw new Error("--retire cannot be combined with --service");
  }
  if (process.argv.includes("--check-only")) {
    if (retirement || listingRetirement) throw new Error("--check-only cannot be combined with --retire");
    await forecast(gateway);
    return;
  }
  const retiring = Boolean(retirement || listingRetirement);
  if (!retiring) activationPolling();
  if (!retiring && !process.argv.includes("--skip-provider-identity")) {
    await ensureProviderIdentity();
  }
  if (!await checkDatabase()) throw new Error("provider database is unreachable");
  await runMigrations();
  await configureStandardRuntimePrivileges();
  await verifyDatabaseRoleSeparation();
  await closeMigrationPool();

  if (retirement) {
    const result = await retireGatewayService(
      normalizedGatewayOrigin(gateway),
      retirement.toLowerCase() as `0x${string}`,
      {
        receipts: gatewayReceipts(),
        providerAgentId: config.PROVIDER_AGENT_ID.toString(),
        domain: retirementReceiptDomain(),
      },
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (listingRetirement) {
    const [receipt, ...extra] = gatewayReceipts();
    if (!receipt || extra.length > 0) throw new Error("--retire-listing needs exactly one --gateway-receipt");
    const result = await retireListingVersion({
      gatewayOrigin: normalizedGatewayOrigin(gateway),
      listingManifestHash: listingRetirement.toLowerCase() as `0x${string}`,
      receipt,
      providerAgentId: config.PROVIDER_AGENT_ID.toString(),
      domain: retirementReceiptDomain(),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  const failures = await registerSelectedServices({
    gateway,
    select: selectServices,
    report: (outcome) => process.stdout.write(`${JSON.stringify(outcome)}\n`),
  });
  if (failures.length > 0) {
    throw new Error(`registration incomplete:\n${failures.join("\n")}`);
  }
}

main().catch((error) => {
  process.stderr.write(`daski registration failed: ${describe(error)}\n`);
  process.exitCode = 1;
}).finally(async () => {
  await closeMigrationPool().catch(() => undefined);
  await pool.end().catch(() => undefined);
});
