import { spawn } from "node:child_process";
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
import { bootstrapServiceRegistry } from "./core/chain/serviceRegistrar.js";
import { registerServiceWithGateway } from "./core/gatewayRegistration/client.js";
import {
  checkServiceRegistration,
  forecastFails,
} from "./core/gatewayRegistration/forecast.js";
import { retireGatewayService } from "./core/gatewayRegistration/retirement.js";
import { normalizedGatewayOrigin } from "./core/gatewayRegistration/wire.js";
import { redactSensitiveText } from "./core/security/redaction.js";

const SERVICE_ID = /^0x[0-9a-fA-F]{64}$/;

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

// The identity script finds an existing agent on the canonical registry;
// --agent-id pins it and --scan-blocks bounds the Transfer-event lookup.
async function ensureProviderIdentity(): Promise<void> {
  const script = fileURLToPath(new URL("../scripts/register-provider.mjs", import.meta.url));
  const agentId = option("--agent-id");
  const scanBlocks = option("--scan-blocks");
  const args = [
    script,
    ...(process.argv.includes("--update-uri") ? ["--update-uri"] : []),
    ...(agentId ? ["--agent-id", agentId] : []),
    ...(scanBlocks ? ["--scan-blocks", scanBlocks] : []),
  ];
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
// read-only and gateway access is GET only.
async function forecast(gateway: string): Promise<void> {
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
  if (retirement && !SERVICE_ID.test(retirement)) {
    throw new Error("--retire requires an exact bytes32 service id");
  }
  if (retirement && options("--service").length > 0) {
    throw new Error("--retire cannot be combined with --service");
  }
  if (process.argv.includes("--check-only")) {
    if (retirement) throw new Error("--check-only cannot be combined with --retire");
    await forecast(gateway);
    return;
  }
  if (!retirement && !process.argv.includes("--skip-provider-identity")) {
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
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  const services = selectServices(await listActiveServices());
  await bootstrapServiceRegistry();
  const failures: string[] = [];

  // Phase 1 — broadcast every service's splitter deployments up front so
  // all of them share ONE finality window instead of paying it per service.
  for (const service of services) {
    try {
      const result = await registerServiceWithGateway(gateway, service, 1, "broadcast");
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
      failures.push(`${service.slug} broadcast: ${describe(error)}`);
    }
  }

  // Phase 2 — confirm deployments, submit evidence, and activate. One
  // service's failure (including an AMBIGUOUS receipt) never blocks the
  // others; an incomplete service is reported, never activated.
  for (const service of services) {
    try {
      const result = await registerServiceWithGateway(gateway, service);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
      failures.push(`${service.slug} activation: ${describe(error)}`);
    }
  }
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
