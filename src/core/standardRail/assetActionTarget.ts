import { pool } from "../db/pool.js";
import { getAssetById, normalizeIdentifier, type AssetRow } from "../db/queries/assets.js";
import { inTransaction } from "../db/queryable.js";
import { getService } from "../serviceRegistry/registry.js";
import type { AssetActionExecutionRow } from "./actionStore.js";
import { admittedOwnerOf, assertAdmittedOwnerCurrent, type AdmittedOwner } from "./assetOwnerFence.js";
import type { AssetActionDefinitionV1 } from "./walletConfig.js";

/** The action's asset is not, or is no longer, an eligible target of its definition. */
export class AssetActionTargetDeniedError extends Error {
  constructor() {
    super("asset action denied");
    this.name = "AssetActionTargetDeniedError";
  }
}

/** The asset an admitted execution acts on and the owner it was admitted under. */
export interface AssetActionTarget {
  assetId: string;
  admitted: AdmittedOwner;
}

export function targetOf(row: AssetActionExecutionRow): AssetActionTarget {
  return { assetId: row.provider_asset_id, admitted: admittedOwnerOf(row) };
}

interface TargetFacts {
  service_id: string;
  type: string;
  identifier: string;
  status: string;
}

/** The identifier the service derives from this input, or null when the input names none. */
async function inputIdentifier(
  definition: AssetActionDefinitionV1,
  input: Record<string, unknown>,
): Promise<{ statuses: readonly string[]; identifier: string | null }> {
  const module = getService(definition.serviceSlug);
  if (!module) throw new Error("asset action unavailable");
  return {
    statuses: module.assets?.assetLookupStatuses?.(definition.actionId) ?? ["active"],
    identifier: (await module.assets?.assetIdentifierFromData?.(definition.actionId, input)) ?? null,
  };
}

function assertTarget(
  definition: AssetActionDefinitionV1,
  serviceId: string,
  asset: TargetFacts,
  expected: { statuses: readonly string[]; identifier: string | null },
): void {
  if (
    asset.service_id !== serviceId || asset.type !== definition.assetType ||
    !expected.statuses.includes(asset.status) ||
    // Compared in the canonical form the asset's identifier is stored in.
    (expected.identifier !== null && normalizeIdentifier(asset.type, expected.identifier) !== asset.identifier)
  ) throw new AssetActionTargetDeniedError();
}

/**
 * An asset ID grants authority only over that asset: one of the action's
 * service and asset type, in a lifecycle state the service admits for the
 * action (`assets.assetLookupStatuses`, active only by default), and, when
 * the service derives an identifier from the input, that very identifier.
 */
export async function assertAssetActionTarget(args: {
  definition: AssetActionDefinitionV1;
  serviceId: string;
  asset: TargetFacts;
  input: Record<string, unknown>;
}): Promise<void> {
  assertTarget(args.definition, args.serviceId, args.asset, await inputIdentifier(args.definition, args.input));
}

/**
 * The asset an admitted execution may act on right now, checked in one
 * short fenced transaction before supplier work: the owner it was admitted
 * under must still be current and the asset still an eligible target of
 * this input. The service's identifier derivation runs before the fence,
 * and nothing stays locked once this returns.
 */
export async function loadAdmittedAssetTarget(args: {
  definition: AssetActionDefinitionV1;
  serviceId: string;
  target: AssetActionTarget;
  input: Record<string, unknown>;
}): Promise<AssetRow> {
  const expected = await inputIdentifier(args.definition, args.input);
  return inTransaction(pool, async (db) => {
    await assertAdmittedOwnerCurrent(db, args.target.assetId, args.target.admitted);
    const asset = await getAssetById(args.target.assetId, db);
    if (!asset) throw new AssetActionTargetDeniedError();
    assertTarget(args.definition, args.serviceId, asset, expected);
    return asset;
  });
}
