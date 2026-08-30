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
import { listActiveServices } from "./core/db/queries/services.js";
import { bootstrapServiceRegistry } from "./core/chain/serviceRegistrar.js";
import { registerServiceWithGateway } from "./core/gatewayRegistration/client.js";
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

async function ensureProviderIdentity(updateUri: boolean): Promise<void> {
  const script = fileURLToPath(new URL("../scripts/register-provider.mjs", import.meta.url));
  const args = [script, ...(updateUri ? ["--update-uri"] : [])];
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
  if (!retirement && !process.argv.includes("--skip-provider-identity")) {
    await ensureProviderIdentity(process.argv.includes("--update-uri"));
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

  const selected = new Set(options("--service"));
  const services = (await listActiveServices()).filter((service) =>
    selected.size === 0 || selected.has(service.slug));
  if (services.length === 0) throw new Error("no active provider services matched");
  const missing = [...selected].filter((slug) =>
    !services.some((service) => service.slug === slug));
  if (missing.length > 0) {
    throw new Error(`unknown or inactive services: ${missing.join(", ")}`);
  }

  await bootstrapServiceRegistry();
  const failures: string[] = [];
  const describe = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

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
  const message = redactSensitiveText(
    error instanceof Error ? error.message : String(error),
  );
  process.stderr.write(`daski registration failed: ${message}\n`);
  process.exitCode = 1;
}).finally(async () => {
  await closeMigrationPool().catch(() => undefined);
  await pool.end().catch(() => undefined);
});
