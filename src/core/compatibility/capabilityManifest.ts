import { readdirSync } from "node:fs";
import type { Hex } from "viem";
import type { BuildIdentity } from "../buildIdentity.js";
import { OPERATOR_ESCALATION_QUEUE } from "../db/queries/escalations.js";
import { RUNTIME_SCHEMA_EPOCH } from "../db/runtimeEpoch.js";
import { EMAIL_INGRESS_QUEUE } from "../email/inboundWorker.js";
import { ESCALATION_RESOLUTION_QUEUE } from "../engine/escalationResolutionStore.js";
import { executableContracts, type ExecutableContractEntry } from "../serviceRegistry/executableContracts.js";
import type { ServiceModule } from "../serviceRegistry/types.js";
import { canonicalHash } from "../standardRail/canonical.js";
import { PAID_FULFILLMENT_QUEUE } from "../standardRail/fulfillmentJobs.js";

/*
 * What this compiled artifact can do, derived only from its own code: the
 * contracts it executes (each skill's current one and the earlier ones it
 * retains), the core migrations it applies, the runtime epoch its sessions
 * declare and the durable queues it consumes, together with the build's
 * embedded source identity. It replaces any external release coordinator's
 * view of an image: the compatibility check compares it with what durable
 * state still requires.
 */

export interface ExecutableCapability {
  serviceSlug: string;
  skillId: string;
  executableDefinitionHash: Hex;
  retained: boolean;
  assetAction: boolean;
}

export interface ProviderCapabilityManifestV1 {
  artifactType: "ProviderCapabilityManifestV1";
  schemaVersion: 1;
  build: BuildIdentity;
  /** The schema runtime epoch every session of this build declares (core migration 011). */
  runtimeEpoch: number;
  coreMigrations: string[];
  workerQueues: string[];
  executableContracts: ExecutableCapability[];
}

export const WORKER_QUEUES = [
  PAID_FULFILLMENT_QUEUE, ESCALATION_RESOLUTION_QUEUE, OPERATOR_ESCALATION_QUEUE, EMAIL_INGRESS_QUEUE,
].sort();

/** The core migrations this build applies, by file name. */
export function coreMigrationNames(): string[] {
  return readdirSync(new URL("../db/migrations/", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

export type CapabilityModule = Pick<ServiceModule, "manifest" | "skills">;

/** Every executable contract of the given modules. */
export function moduleContracts(modules: readonly CapabilityModule[]): ExecutableContractEntry[] {
  return modules.flatMap((module) => executableContracts(module));
}

export function capabilityManifest(
  modules: readonly CapabilityModule[],
  build: BuildIdentity,
): ProviderCapabilityManifestV1 {
  return {
    artifactType: "ProviderCapabilityManifestV1",
    schemaVersion: 1,
    build,
    runtimeEpoch: RUNTIME_SCHEMA_EPOCH,
    coreMigrations: coreMigrationNames(),
    workerQueues: [...WORKER_QUEUES],
    executableContracts: moduleContracts(modules)
      .map((entry) => ({
        serviceSlug: entry.serviceSlug,
        skillId: entry.skillId,
        executableDefinitionHash: entry.executableDefinitionHash,
        retained: entry.retained,
        assetAction: entry.execution.assetAction !== null,
      }))
      .sort((left, right) =>
        `${left.serviceSlug}\n${left.skillId}\n${left.executableDefinitionHash}`
          .localeCompare(`${right.serviceSlug}\n${right.skillId}\n${right.executableDefinitionHash}`)),
  };
}

/** The hash of what the artifact can do, independent of which build carries it. */
export function capabilityHash(manifest: ProviderCapabilityManifestV1): Hex {
  const { build: _build, ...capabilities } = manifest;
  return canonicalHash(capabilities);
}
