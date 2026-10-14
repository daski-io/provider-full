import type { Hex } from "viem";
import { pool } from "../db/pool.js";
import { canonicalHash } from "../standardRail/canonical.js";
import type { FulfillmentAdapter } from "./adapterTypes.js";
import {
  assertRetainedContracts,
  executableContracts,
  executableDefinitionHash,
  type ExecutableContractEntry,
} from "./executableContracts.js";
import type { ServiceModule } from "./serviceModule.js";

/*
 * Which handler executes a given admitted contract in this build. The
 * current contract of a skill runs on the service's registered adapter; an
 * earlier contract runs only on the handler the service retained for it, and
 * a contract with neither has no handler here: work admitted under it must
 * not run on this build.
 */

export type HandlerChoice =
  | { kind: "current" }
  | { kind: "retained"; adapter: FulfillmentAdapter };

/** An admitted order or action whose contract this build cannot execute. */
export class RetainedHandlerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetainedHandlerUnavailableError";
  }
}

interface ModuleContracts {
  entries: Map<string, ExecutableContractEntry>;
  retainedSkills: Set<string>;
  all: ExecutableContractEntry[];
}

const MODULES = new Map<string, ModuleContracts>();
const key = (skillId: string, hash: string) => `${skillId}\n${hash.toLowerCase()}`;

/** Called by service registration once the module validated. */
export function registerRetainedContracts(module: Pick<ServiceModule, "manifest" | "skills">): void {
  assertRetainedContracts(module);
  const all = executableContracts(module);
  MODULES.set(module.manifest.slug, {
    all,
    entries: new Map(all.map((entry) => [key(entry.skillId, entry.executableDefinitionHash), entry])),
    retainedSkills: new Set(all.filter((entry) => entry.retained).map((entry) => entry.skillId)),
  });
}

/** Every executable definition hash this build can run, current and retained. */
export function registeredExecutableHashes(): Set<Hex> {
  return new Set([...MODULES.values()].flatMap((module) =>
    module.all.map((entry) => entry.executableDefinitionHash)));
}

export function hasRetainedContracts(serviceSlug: string, skillId: string): boolean {
  return MODULES.get(serviceSlug)?.retainedSkills.has(skillId) ?? false;
}

const choice = (entry: ExecutableContractEntry): HandlerChoice =>
  entry.retained ? { kind: "retained", adapter: entry.adapter! } : { kind: "current" };

/**
 * The handler for one service skill's published contract. A null contract is
 * a head configured without the runtime catalog, which this build sells and
 * executes with its current handler by construction.
 */
export function contractHandler(serviceSlug: string, skillId: string, contract: unknown): HandlerChoice | null {
  if (contract === null) return { kind: "current" };
  const module = MODULES.get(serviceSlug);
  if (!module) return null;
  let hash: Hex;
  try {
    hash = executableDefinitionHash(serviceSlug, skillId, contract);
  } catch {
    return null;
  }
  const entry = module.entries.get(key(skillId, hash));
  return entry ? choice(entry) : null;
}

export interface AdmittedActionContract {
  serviceSlug: string;
  actionId: string;
  assetType: string;
  destructive: boolean;
  replayPolicy: string;
  retentionSeconds: number;
  requestSchema: Record<string, unknown>;
  responseSchema: Record<string, unknown>;
}

/** The handler for a signed asset-action definition: the skill contract whose action and schemas it names. */
export function assetActionHandler(definition: AdmittedActionContract): HandlerChoice | null {
  const module = MODULES.get(definition.serviceSlug);
  if (!module) return null;
  const request = canonicalHash(definition.requestSchema);
  const response = canonicalHash(definition.responseSchema);
  const matches = module.all.filter((entry) => {
    const action = entry.execution.assetAction as
      { effect?: string; replayPolicy?: string; retentionSeconds?: number } | null;
    return entry.skillId === definition.actionId && !!action &&
      entry.execution.assetType === definition.assetType &&
      (action.effect === "destructive") === definition.destructive &&
      action.replayPolicy === definition.replayPolicy &&
      action.retentionSeconds === definition.retentionSeconds &&
      canonicalHash(entry.execution.inputSchema) === request &&
      canonicalHash(entry.execution.resultSchema) === response;
  });
  const entry = matches.find((candidate) => !candidate.retained) ?? matches[0];
  return entry ? choice(entry) : null;
}

interface TaskBindingRow {
  listing: Buffer | null;
  contract: unknown;
  action_definition_hash: Buffer | null;
  action_definition: AdmittedActionContract & { actionDefinitionHash?: string } | null;
}

/**
 * Route an adapter call for a task of a skill that retains earlier
 * contracts to the handler of the contract the task was admitted under.
 */
export async function retainedTaskHandler(serviceSlug: string, skillId: string, taskId: string): Promise<HandlerChoice> {
  const row = (await pool.query<TaskBindingRow>(
    `SELECT t.standard_listing_manifest_hash AS listing,
            (SELECT v.bundle->'skillContract'->'contract' FROM provider_runtime_listing_versions v
              WHERE v.runtime_commitment_hash=t.standard_listing_manifest_hash
              ORDER BY v.promoted_at,v.id LIMIT 1) AS contract,
            x.action_definition_hash,d.definition AS action_definition
       FROM transactions t
       LEFT JOIN standard_asset_action_executions x ON x.execution_id=t.standard_action_execution_id
       LEFT JOIN standard_admitted_action_definitions d ON d.action_definition_hash=x.action_definition_hash
      WHERE t.id=$1`,
    [taskId],
  )).rows[0];
  if (row?.listing) {
    const handler = contractHandler(serviceSlug, skillId, row.contract ?? null);
    if (!handler) throw new RetainedHandlerUnavailableError("The order's admitted contract has no handler in this build");
    return handler;
  }
  if (row?.action_definition_hash) {
    const definition = row.action_definition;
    const { actionDefinitionHash: _hash, ...preimage } = definition ?? {};
    const handler = definition &&
      `0x${row.action_definition_hash.toString("hex")}` === canonicalHash(preimage) &&
      definition.serviceSlug === serviceSlug && definition.actionId === skillId
      ? assetActionHandler(definition)
      : null;
    if (!handler) throw new RetainedHandlerUnavailableError("The action's admitted definition has no handler in this build");
    return handler;
  }
  return { kind: "current" };
}
