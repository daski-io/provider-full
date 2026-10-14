import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { buildIdentity } from "./core/buildIdentity.js";
import { compatibilityReport } from "./core/compatibility/compatibilityReport.js";
import { config } from "./core/config.js";
import { checkDatabase, closeMigrationPool, pool } from "./core/db/pool.js";
import { assertReadOnlySessions, enforceReadOnlySessions } from "./core/db/readOnlySessions.js";
import { normalizedGatewayOrigin } from "./core/gatewayRegistration/wire.js";
import { redactSensitiveText } from "./core/security/redaction.js";
import { assertRetainedContracts } from "./core/serviceRegistry/executableContracts.js";
import { parseRetainedSigningKeys } from "./core/standardRail/signingKeys.js";
import { providerServices } from "./providerServices.js";

/*
 * The read-only compatibility check: does this artifact, with this
 * deployment's provider keys, serve every listing version and asset action
 * the database still owes? It prints the compatibility report (the
 * artifact's capability manifest and build identity, the activation
 * revision, every version's obligations and coverage, and each gap) and
 * exits non-zero on any gap. It runs no migration, registers nothing, signs
 * nothing, calls no gateway or chain, and its database sessions refuse
 * writes. Only the database URL, the gateway origin and the provider keys
 * are read; no hosting or release-coordinator variable is used.
 */

async function main(): Promise<void> {
  enforceReadOnlySessions(pool);
  if (!await checkDatabase()) {
    throw new Error(
      "provider database is unreachable on read-only sessions; a connection pooler must pass startup options through",
    );
  }
  await assertReadOnlySessions(pool);
  for (const module of providerServices) assertRetainedContracts(module);
  const current = privateKeyToAccount(config.PROVIDER_WALLET_PRIVATE_KEY as Hex).address;
  const retained = parseRetainedSigningKeys(process.env.PROVIDER_RETAINED_WALLET_PRIVATE_KEYS, current);
  const origin = process.env.STANDARD_RAIL_GATEWAY_ORIGIN?.trim() || config.GATEWAY_BASE_URL;
  if (!origin) throw new Error("STANDARD_RAIL_GATEWAY_ORIGIN or GATEWAY_BASE_URL is required");
  const report = await compatibilityReport(pool, {
    gatewayOrigin: normalizedGatewayOrigin(origin),
    modules: providerServices,
    signingKeys: new Set([current, ...retained.keys()]),
    build: buildIdentity(),
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`compatibility check failed: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}\n`);
  process.exitCode = 1;
}).finally(async () => {
  await closeMigrationPool().catch(() => undefined);
  await pool.end().catch(() => undefined);
});
