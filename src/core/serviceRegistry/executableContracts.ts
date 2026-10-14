import type { Hex } from "viem";
import { isPaymentRequired } from "../pricing/index.js";
import { canonicalHash } from "../standardRail/canonical.js";
import { compileProviderSchema } from "../standardRail/schema.js";
import type { FulfillmentAdapter } from "./adapterTypes.js";
import type { SkillDefinition } from "./manifestTypes.js";
import type { ServiceModule } from "./serviceModule.js";

/*
 * What a skill handler executes: the parts of a published skill contract
 * that define the accepted input, the produced result and the ownership and
 * fulfillment semantics. Pricing, capacity and deadlines are commercial
 * policy core enforces from each listing version's own committed values, so
 * a version that changes only those is served by the current handler.
 *
 * Contracts published before `purchaseReadiness` existed carry no such key;
 * it had no other meaning then, so a missing value reads as null.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export function executableContractOf(contract: unknown): Record<string, unknown> {
  if (!isRecord(contract)) throw new Error("skill contract must be an object");
  const { inputSchema, resultSchema, paymentRequired, requiresAssetOwnership, fulfillmentMode } = contract;
  if (
    !isRecord(inputSchema) || !isRecord(resultSchema) ||
    typeof paymentRequired !== "boolean" || typeof requiresAssetOwnership !== "boolean" ||
    typeof fulfillmentMode !== "string"
  ) throw new Error("skill contract lacks its executable fields");
  return {
    inputSchema,
    resultSchema,
    paymentRequired,
    requiresAssetOwnership,
    assetType: contract.assetType ?? null,
    fulfillmentMode,
    purchaseReadiness: contract.purchaseReadiness ?? null,
    assetAction: contract.assetAction ?? null,
  };
}

export function executableDefinitionHash(serviceSlug: string, skillId: string, contract: unknown): Hex {
  return canonicalHash({ schemaVersion: 1, serviceSlug, skillId, execution: executableContractOf(contract) });
}

/** The executable part of the contract a definition publishes today. */
export function currentExecutableContract(
  module: Pick<ServiceModule, "manifest">,
  definition: SkillDefinition,
): Record<string, unknown> {
  return executableContractOf({
    inputSchema: definition.inputSchema,
    resultSchema: definition.resultSchema,
    paymentRequired: isPaymentRequired(definition.pricing),
    requiresAssetOwnership: definition.requiresAssetOwnership,
    assetType: definition.assetType ?? null,
    fulfillmentMode: definition.fulfillmentMode ?? module.manifest.defaultFulfillmentMode,
    purchaseReadiness: null,
    assetAction: definition.assetAction ?? null,
  });
}

export interface ExecutableContractEntry {
  serviceSlug: string;
  skillId: string;
  executableDefinitionHash: Hex;
  /** True for a retained earlier contract; false for the current one. */
  retained: boolean;
  execution: Record<string, unknown>;
  /** Null for the current contract: its handler is the service's registered adapter. */
  adapter: FulfillmentAdapter | null;
}

/** Every contract a module executes: each skill's current one and its declared retained ones. */
export function executableContracts(module: Pick<ServiceModule, "manifest" | "skills">): ExecutableContractEntry[] {
  const slug = module.manifest.slug;
  return module.skills.flatMap((definition) => {
    const current = currentExecutableContract(module, definition);
    return [
      {
        serviceSlug: slug, skillId: definition.id, retained: false, execution: current, adapter: null,
        executableDefinitionHash: executableDefinitionHash(slug, definition.id, current),
      },
      ...(definition.previousContracts ?? []).map((retained) => ({
        serviceSlug: slug, skillId: definition.id, retained: true,
        execution: executableContractOf(retained.contract), adapter: retained.adapter,
        executableDefinitionHash: executableDefinitionHash(slug, definition.id, retained.contract),
      })),
    ];
  });
}

const ADAPTER_METHODS = ["execute", "handleInput", "cancel", "quote"] as const;

/**
 * A retained contract must be an earlier published contract this build can
 * still execute: valid schemas, a handler, and an executable hash that names
 * exactly one contract of its skill.
 */
export function assertRetainedContracts(module: Pick<ServiceModule, "manifest" | "skills">): void {
  const slug = module.manifest.slug;
  for (const definition of module.skills) {
    const seen = new Set<string>();
    let entries: ExecutableContractEntry[];
    try {
      entries = executableContracts({ manifest: module.manifest, skills: [definition] });
    } catch (error) {
      throw new Error(`Service ${slug}: skill "${definition.id}" retained contract is malformed: ${(error as Error).message}`);
    }
    for (const entry of entries) {
      const label = `Service ${slug}: skill "${definition.id}" ${entry.retained ? "retained" : "current"} contract`;
      if (seen.has(entry.executableDefinitionHash)) {
        throw new Error(`${label} duplicates another contract of the skill`);
      }
      seen.add(entry.executableDefinitionHash);
      if (!entry.retained) continue;
      compileProviderSchema(entry.execution.inputSchema as Record<string, unknown>);
      compileProviderSchema(entry.execution.resultSchema as Record<string, unknown>);
      if (!entry.adapter || ADAPTER_METHODS.some((method) => typeof entry.adapter![method] !== "function")) {
        throw new Error(`${label} needs a complete fulfillment adapter`);
      }
    }
  }
}
