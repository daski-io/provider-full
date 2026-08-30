import { config } from "./core/config.js";
import {
  pool,
  checkDatabase,
  closeMigrationPool,
  configureStandardRuntimePrivileges,
  runMigrations,
  verifyDatabaseRoleSeparation,
} from "./core/db/pool.js";
import {
  setServiceStatuses,
} from "./core/health.js";
import { startServer, stopServer } from "./core/server.js";
import { startEmailIngressWorker, stopEmailIngressWorker } from "./core/email/inboundWorker.js";
import { startAuthSecurityCleanup, stopAuthSecurityCleanup } from "./core/auth/securityMaintenance.js";
import { startRetentionWorker, stopRetentionWorker } from "./core/db/retention.js";
import { registerService, getAllServices } from "./core/serviceRegistry/registry.js";
import { validateEmailAgentTools } from "./core/agents/emailAgent/toolRegistry.js";
import { validateOperatorAgentTools } from "./core/agents/operatorAgent/tools.js";
import {
  startOperatorEscalationWorker,
  stopOperatorEscalationWorker,
} from "./core/agents/operatorAgent/escalationWorker.js";
import { providerServices } from "./providerServices.js";
import {
  installProviderScreening,
  startProviderScreeningWorkers,
} from "./providerScreening.js";
import { logInfo, logError, errorExtra } from "./core/logger.js";
import {
  startProviderIdentityMonitor,
  stopProviderIdentityMonitor,
} from "./core/chain/providerIdentity.js";
import { loadProviderStandardRailConfig } from "./core/standardRail/config.js";
import { logListingCommitmentDrift } from "./core/gatewayRegistration/commitmentDriftBoot.js";
import { startStandardRailReadiness } from "./core/standardRail/readiness.js";
import { startStandardTaskWatchdog } from "./core/standardRail/taskWatchdog.js";
import { base, baseSepolia } from "viem/chains";
import {
  startServiceRegistrationReconciler,
  stopServiceRegistrationReconciler,
} from "./core/chain/serviceRegistrar.js";
import {
  startProviderWriteReconciler,
  stopProviderWriteReconciler,
} from "./core/chain/providerWriteReconciler.js";
import { enforceInitialChainReadiness } from "./core/startupChainGate.js";
import { loadProviderWalletConfig } from "./core/standardRail/walletConfig.js";
import { startReputationOutcomeWorker } from "./core/standardRail/reputationOutcome.js";
import { deriveProviderLaunchPolicy } from "./core/standardRail/launchPolicy.js";
import { startStandardReviewResolutionWorker } from "./core/standardRail/reviewResolutionWorker.js";

let shuttingDown = false;
let serviceWorkerStops: Array<() => void | Promise<void>> = [];
let screeningWorkerStops: Array<() => void | Promise<void>> = [];
let stopStandardRailReadiness: (() => void) | null = null;
let stopStandardTaskWatchdog: (() => void) | null = null;
let stopReputationOutcomeWorker: (() => void) | null = null;
let stopStandardReviewResolutionWorker: (() => Promise<void>) | null = null;

async function main(): Promise<void> {
  logInfo("Config loaded", {
    port: config.PORT,
    chainId: config.CHAIN_ID,
    chainMode: config.CHAIN_MODE,
  });
  if (!(await checkDatabase())) throw new Error("Database unreachable");
  await runMigrations();
  await configureStandardRuntimePrivileges();
  await verifyDatabaseRoleSeparation();

  await installProviderScreening();
  for (const module of providerServices) {
    await registerService(module);
  }
  await configureStandardRuntimePrivileges();
  await verifyDatabaseRoleSeparation();
  await closeMigrationPool();
  validateEmailAgentTools();
  validateOperatorAgentTools();

  const providerLaunchPolicy = deriveProviderLaunchPolicy(providerServices);
  const standardRailConfig = await loadProviderStandardRailConfig(
    providerLaunchPolicy,
    process.env,
    { warn: (message) => logInfo(message) },
  );
  const walletConfig = await loadProviderWalletConfig(
    standardRailConfig,
    providerLaunchPolicy,
  );
  // Non-fatal by design: a drifted build must boot so its new card can be
  // re-registered; the sweep's job is the loud error, not a refusal.
  void logListingCommitmentDrift(standardRailConfig.gatewayOrigin);
  stopStandardRailReadiness = await startStandardRailReadiness(
    standardRailConfig,
    config.CHAIN_ID === 8453 ? base : baseSepolia,
  );
  stopStandardTaskWatchdog = startStandardTaskWatchdog(standardRailConfig);
  stopReputationOutcomeWorker = startReputationOutcomeWorker(standardRailConfig);
  stopStandardReviewResolutionWorker = startStandardReviewResolutionWorker(
    standardRailConfig,
    walletConfig,
  );
  const { checkedAt: registrationCheckedAt } = await enforceInitialChainReadiness();

  const services = getAllServices();
  const checkedAt = registrationCheckedAt.toISOString();
  setServiceStatuses(Object.fromEntries(services.map((module) => [
    module.manifest.slug,
    {
      active: true,
      tokenId: config.PROVIDER_AGENT_ID.toString(),
      registrationVerified: true,
      standardRailVerified: true,
      standardRailVerifiedAt: checkedAt,
    },
  ])));

  startEmailIngressWorker();
  startOperatorEscalationWorker();
  startAuthSecurityCleanup();
  startRetentionWorker();
  startProviderIdentityMonitor();
  startProviderWriteReconciler();
  startServiceRegistrationReconciler();

  serviceWorkerStops = [];
  screeningWorkerStops = startProviderScreeningWorkers();
  for (const module of services) {
    const stop = module.operations?.startWorkers?.();
    if (typeof stop === "function") serviceWorkerStops.push(stop);
  }
  await startServer(standardRailConfig, walletConfig);

  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
  process.on("SIGINT", () => void shutdown("SIGINT", 0));
}

async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logInfo(`Shutting down after ${reason}`);
  try {
    await stopServer();
    stopProviderIdentityMonitor();
    stopServiceRegistrationReconciler();
    await stopProviderWriteReconciler();
    stopStandardRailReadiness?.();
    stopStandardRailReadiness = null;
    stopStandardTaskWatchdog?.();
    stopStandardTaskWatchdog = null;
    stopReputationOutcomeWorker?.();
    stopReputationOutcomeWorker = null;
    await stopStandardReviewResolutionWorker?.();
    stopStandardReviewResolutionWorker = null;
    await stopAuthSecurityCleanup();
    await stopRetentionWorker();
    await stopEmailIngressWorker();
    await stopOperatorEscalationWorker();
    await Promise.allSettled(serviceWorkerStops.map((stop) => Promise.resolve(stop())));
    await Promise.allSettled(screeningWorkerStops.map((stop) => Promise.resolve(stop())));
    await closeMigrationPool();
    await pool.end();
  } catch (error) {
    exitCode = 1;
    logError("Shutdown failed", errorExtra(error));
  } finally {
    process.exit(exitCode);
  }
}

process.on("unhandledRejection", (reason) => {
  logError("Fatal unhandled promise rejection", errorExtra(reason));
  void shutdown("unhandledRejection", 1);
});

process.on("uncaughtException", (error) => {
  logError("Fatal uncaught exception", errorExtra(error));
  void shutdown("uncaughtException", 1);
});

main().catch((error) => {
  // The cause must live in the MESSAGE (redacted like any logged string):
  // platform log viewers render only the message, and structured fields
  // alone left the 2026-08-28 boot loop diagnosable only via the log API.
  const cause = error instanceof Error ? error.message : String(error);
  logError(`Startup failed: ${cause}`, errorExtra(error));
  void shutdown("startup failure", 1);
});
