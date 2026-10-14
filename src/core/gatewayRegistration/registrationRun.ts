import { bootstrapServiceRegistry } from "../chain/serviceRegistrar.js";
import { listActiveServices, type ServiceRow } from "../db/queries/services.js";
import { redactSensitiveText } from "../security/redaction.js";
import { registerServiceWithGateway, type RegistrationOutcome } from "./client.js";
import { activationPolling } from "./evidence.js";

// One `daski:register` run after migrations and the identity helper: the
// ServiceRegistry bootstrap and the two gateway registration phases.

const describe = (error: unknown) =>
  redactSensitiveText(error instanceof Error ? error.message : String(error));

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
