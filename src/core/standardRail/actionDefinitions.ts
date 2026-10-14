import type { Hex } from "viem";
import { pool } from "../db/pool.js";
import type { Queryable } from "../db/queryable.js";
import { canonicalHash } from "./canonical.js";
import type { AssetActionDefinitionV1, ProviderWalletConfig } from "./walletConfig.js";

/*
 * An asset action is executed under the signed definition it was admitted
 * with. The current catalog's definitions are recorded by hash at boot
 * (core migration 009), so an execution accepted under one is still
 * completed under it after the catalog moves to a new epoch. Every stored
 * definition is re-verified against its own hash and provider when read.
 */

const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");

function verified(definition: AssetActionDefinitionV1, hash: Hex, providerAgentId: string): boolean {
  const { actionDefinitionHash, ...preimage } = definition;
  return actionDefinitionHash === hash && canonicalHash(preimage) === hash &&
    definition.providerAgentId === providerAgentId;
}

/** Record every definition of the verified current catalog; existing rows are never changed. */
export async function retainAdmittedActionDefinitions(
  wallet: Pick<ProviderWalletConfig, "catalog" | "actionCatalogHash">,
  db: Queryable = pool,
): Promise<number> {
  let recorded = 0;
  for (const definition of wallet.catalog.actions) {
    if (!verified(definition, definition.actionDefinitionHash, wallet.catalog.providerAgentId)) {
      throw new Error("asset action definition does not reproduce its hash");
    }
    const inserted = await db.query(
      `INSERT INTO standard_admitted_action_definitions
         (action_definition_hash,service_slug,action_id,definition,action_catalog_hash)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (action_definition_hash) DO NOTHING`,
      [
        bytes(definition.actionDefinitionHash), definition.serviceSlug, definition.actionId,
        JSON.stringify(definition), bytes(wallet.actionCatalogHash),
      ],
    );
    recorded += inserted.rowCount ?? 0;
  }
  return recorded;
}

/**
 * The definition an execution was admitted under: from the current catalog,
 * else the retained record. Null when neither holds a verified definition.
 */
export async function admittedActionDefinition(
  wallet: Pick<ProviderWalletConfig, "catalog">,
  actionDefinitionHash: Hex,
  db: Queryable = pool,
): Promise<AssetActionDefinitionV1 | null> {
  const current = wallet.catalog.actions.find((action) => action.actionDefinitionHash === actionDefinitionHash);
  if (current) return current;
  const row = (await db.query<{ definition: AssetActionDefinitionV1 }>(
    "SELECT definition FROM standard_admitted_action_definitions WHERE action_definition_hash=$1",
    [bytes(actionDefinitionHash)],
  )).rows[0];
  if (!row || !verified(row.definition, actionDefinitionHash, wallet.catalog.providerAgentId)) return null;
  return row.definition;
}
