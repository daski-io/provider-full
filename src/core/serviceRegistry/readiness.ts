import { getScreeningExtension } from "../screening/registry.js";
import { getService } from "./registry.js";
import type { ServiceModule } from "./types.js";

/** Evaluate only the invariants owned by one service and its screening facet. */
export async function serviceInvariantFailures(
  module: ServiceModule,
): Promise<string[]> {
  const reasons: string[] = [];
  try {
    reasons.push(...await module.operations?.readiness?.checkInvariants?.() ?? []);
    const scopes = module.screening?.requiredScopes ?? [];
    if (scopes.length === 0) return reasons;

    const extension = getScreeningExtension();
    if (!extension) return [...reasons, "required screening extension is not installed"];
    const missing = scopes.filter((scope) => !extension.scopes.includes(scope));
    if (missing.length > 0) {
      reasons.push(`screening scopes unavailable: ${missing.join(", ")}`);
    }
    reasons.push(...await extension.readiness?.checkInvariants?.() ?? []);
    return reasons;
  } catch {
    return ["invariant check failed"];
  }
}

/**
 * Whether the installed service `slug` declares an outage now: its own or
 * its screening facet's invariants fail. Its new work waits meanwhile,
 * since running it could end it failed on the outage: a fresh paid
 * dispatch, the fulfillment worker, buyer input, a wallet action or
 * destructive confirmation, and a free skill call. Reads, status, support,
 * cancellation and action recovery still answer.
 */
export async function serviceDeclaresOutage(slug: string): Promise<boolean> {
  const module = getService(slug);
  if (!module) return false;
  return (await serviceInvariantFailures(module)).length > 0;
}
