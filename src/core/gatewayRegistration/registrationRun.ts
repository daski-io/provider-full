import { bootstrapServiceRegistry } from "../chain/serviceRegistrar.js";
import { listActiveServices, type ServiceRow } from "../db/queries/services.js";
import { redactSensitiveText } from "../security/redaction.js";
import { registerServiceWithGateway, type RegistrationOutcome } from "./client.js";
import { activationPolling } from "./evidence.js";

// One `daski:register` run, after migrations: the provider identity helper's
// arguments, the ServiceRegistry bootstrap, and the two registration phases.

const describe = (error: unknown) =>
  redactSensitiveText(error instanceof Error ? error.message : String(error));

/**
 * Arguments for scripts/register-provider.mjs. The run registers services
 * under PROVIDER_AGENT_ID, so the helper is pinned to that agent: it claims
 * the index entry and pays the listing fee for no other one, and never mints.
 */
export function identityHelperArguments(argv: readonly string[], providerAgentId: bigint): string[] {
  const value = (name: string) => {
    const index = argv.indexOf(name);
    return index < 0 ? null : argv[index + 1] ?? "";
  };
  const agentId = value("--agent-id");
  if (agentId !== null && agentId !== providerAgentId.toString()) {
    throw new Error(
      `--agent-id ${agentId} differs from PROVIDER_AGENT_ID ${providerAgentId}; services are registered under PROVIDER_AGENT_ID, so set it to the agent this provider registers with`,
    );
  }
  if (value("--scan-blocks") !== null) {
    throw new Error(
      "--scan-blocks applies only to scripts/register-provider.mjs run directly; daski:register verifies PROVIDER_AGENT_ID instead of searching for an agent",
    );
  }
  return [
    ...(argv.includes("--update-uri") ? ["--update-uri"] : []),
    "--agent-id",
    providerAgentId.toString(),
  ];
}

/**
 * Register the selected active services with the gateway. Configuration the
 * run relies on and the selection are validated before any chain write, and
 * the gateway phases use the rows the ServiceRegistry bootstrap left behind,
 * which carry the on-chain id of every service it registered or adopted.
 * Phase 1 broadcasts every service's splitter deployments so they share one
 * finality window; phase 2 confirms them, submits evidence and activates.
 * One service's failure never blocks another; failures are returned.
 */
export async function registerSelectedServices(args: {
  gateway: string;
  select: (active: ServiceRow[]) => ServiceRow[];
  report: (outcome: RegistrationOutcome) => void;
}): Promise<string[]> {
  activationPolling();
  args.select(await listActiveServices());
  await bootstrapServiceRegistry();
  const services = args.select(await listActiveServices());
  const failures: string[] = [];
  for (const service of services) {
    try {
      args.report(await registerServiceWithGateway(args.gateway, service, 1, "broadcast"));
    } catch (error) {
      failures.push(`${service.slug} broadcast: ${describe(error)}`);
    }
  }
  for (const service of services) {
    try {
      args.report(await registerServiceWithGateway(args.gateway, service));
    } catch (error) {
      failures.push(`${service.slug} activation: ${describe(error)}`);
    }
  }
  return failures;
}
