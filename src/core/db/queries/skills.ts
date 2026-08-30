import { pool } from "../pool.js";
import { inTransaction } from "../queryable.js";
import { recordMandatoryAudit } from "../../events/emitter.js";
import type { SkillPricing } from "../../pricing/index.js";
import type { FulfillmentMode } from "../../serviceRegistry/types.js";

// Off-chain skill rows. One row per (service_id, skill_id). Pricing
// scheme lives in `pricing` JSONB (see src/core/pricing/). Runtime
// knobs (LLM model / timeout / enabled) live in `config.llm`.

export interface SkillRow {
  id: string;
  service_id: string;
  skill_id: string;
  name: string;
  description: string;
  tags: string[] | null;
  pricing: SkillPricing;
  required_fields: string[] | null;
  optional_fields: string[] | null;
  requires_asset_ownership: boolean;
  asset_type: string | null;
  sort_order: number;
  is_active: boolean;
  /// Agent-first human-representative marker:
  /// 'required' | 'varies' | 'none' | null (unspecified). See the migration
  /// for semantics. Declared per skill; surfaced on the AgentCard.
  human_parties: string | null;
  fulfillment_mode: FulfillmentMode;
  config: Record<string, unknown>;
  examples: unknown[] | null;
  documentation_url: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = [
  "id",
  "service_id",
  "skill_id",
  "name",
  "description",
  "tags",
  "pricing",
  "required_fields",
  "optional_fields",
  "requires_asset_ownership",
  "asset_type",
  "sort_order",
  "is_active",
  "human_parties",
  "fulfillment_mode",
  "config",
  "examples",
  "documentation_url",
  "created_at",
  "updated_at",
].join(", ");

export async function getSkillByServiceAndSkillId(
  serviceId: string,
  skillId: string,
): Promise<SkillRow | null> {
  const result = await pool.query(
    `SELECT ${COLUMNS} FROM skills WHERE service_id = $1 AND skill_id = $2`,
    [serviceId, skillId],
  );
  return (result.rows[0] as SkillRow | undefined) ?? null;
}

export async function getSkillsByServiceId(serviceId: string): Promise<SkillRow[]> {
  const result = await pool.query(
    `SELECT ${COLUMNS} FROM skills WHERE service_id = $1 ORDER BY sort_order, skill_id`,
    [serviceId],
  );
  return result.rows as SkillRow[];
}

export async function getActiveSkillsByServiceId(serviceId: string): Promise<SkillRow[]> {
  const result = await pool.query(
    `SELECT ${COLUMNS} FROM skills
      WHERE service_id = $1 AND is_active = true
      ORDER BY sort_order, skill_id`,
    [serviceId],
  );
  return result.rows as SkillRow[];
}

export interface UpsertSkillArgs {
  service_id: string;
  skill_id: string;
  name: string;
  description: string;
  pricing: SkillPricing;
  tags?: string[];
  required_fields?: string[];
  optional_fields?: string[];
  requires_asset_ownership?: boolean;
  asset_type?: string | null;
  sort_order?: number;
  is_active?: boolean;
  human_parties?: "required" | "varies" | "none" | null;
  fulfillment_mode: FulfillmentMode;
  config?: Record<string, unknown>;
  examples?: unknown[];
  documentation_url?: string | null;
}

/// Update every paid skill in one service and record the operator audit in the
/// same transaction. Pricing is seed-only in upsertSkill, so this is the only
/// writer after first boot.
export async function updateServiceSkillPricing(args: {
  serviceId: string;
  actor: string;
  fixedAmountAtomic: bigint;
  updates: Array<{
    id: string;
    skillId: string;
    pricing: SkillPricing;
  }>;
}): Promise<void> {
  await inTransaction(pool, async (db) => {
    for (const update of args.updates) {
      const result = await db.query(
        `UPDATE skills
            SET pricing = $3, updated_at = now()
          WHERE id = $1 AND service_id = $2
          RETURNING id`,
        [update.id, args.serviceId, JSON.stringify(update.pricing)],
      );
      if (result.rows.length !== 1) {
        throw new Error(`Skill '${update.skillId}' was not found for this service`);
      }
    }
    await recordMandatoryAudit(db, {
      source: "admin",
      serviceId: args.serviceId,
      type: "admin.skill_pricing.updated",
      actor: args.actor,
      message:
        `Fixed price set to ${args.fixedAmountAtomic.toString()} atomic USDC ` +
        `on ${args.updates.length} paid skill(s).`,
      payload: {
        fixedAmountAtomic: args.fixedAmountAtomic.toString(),
        skillIds: args.updates.map((update) => update.skillId),
      },
    });
  });
}

/// Upsert a skill row. Used by the ServiceModule registry to seed skills
/// from each module's manifest. Unique by (service_id, skill_id).
export async function upsertSkill(args: UpsertSkillArgs): Promise<SkillRow> {
  const result = await pool.query(
    `INSERT INTO skills (
       service_id, skill_id, name, description, tags, pricing, required_fields,
       optional_fields, requires_asset_ownership, asset_type, sort_order,
       is_active, human_parties,
       fulfillment_mode, config, examples, documentation_url, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now())
     ON CONFLICT (service_id, skill_id) DO UPDATE SET
       name                     = EXCLUDED.name,
       description              = EXCLUDED.description,
       tags                     = EXCLUDED.tags,
       -- Pricing is SEED-ONLY: the manifest value applies on first insert;
       -- after that the skill row's pricing belongs to the operator (Config
       -- page). Overwriting here would silently revert an operator-set
       -- price on every deploy.
       pricing                  = skills.pricing,
       required_fields          = EXCLUDED.required_fields,
       optional_fields          = EXCLUDED.optional_fields,
       requires_asset_ownership = EXCLUDED.requires_asset_ownership,
       asset_type               = EXCLUDED.asset_type,
       sort_order               = EXCLUDED.sort_order,
       is_active                = EXCLUDED.is_active,
       -- Manifest-declared fact (like optional_fields): always reflect the
       -- current manifest, not operator-tunable.
       human_parties            = EXCLUDED.human_parties,
       fulfillment_mode         = EXCLUDED.fulfillment_mode,
       -- Config precedence (audit 3.14): manifest defaults fill in only
       -- keys the row does not already carry — OPERATOR-set values win on
       -- every re-registration. (jsonb || is right-biased, so the existing
       -- row must be the right operand.)
       config                   = EXCLUDED.config || skills.config,
       examples                 = EXCLUDED.examples,
       documentation_url        = EXCLUDED.documentation_url,
       updated_at               = now()
     RETURNING ${COLUMNS}`,
    [
      args.service_id,
      args.skill_id,
      args.name,
      args.description,
      args.tags ? JSON.stringify(args.tags) : null,
      JSON.stringify(args.pricing),
      args.required_fields ? JSON.stringify(args.required_fields) : null,
      args.optional_fields ? JSON.stringify(args.optional_fields) : null,
      args.requires_asset_ownership ?? false,
      args.asset_type ?? null,
      args.sort_order ?? 0,
      args.is_active ?? true,
      args.human_parties ?? null,
      args.fulfillment_mode,
      JSON.stringify(args.config ?? {}),
      args.examples ? JSON.stringify(args.examples) : null,
      args.documentation_url ?? null,
    ],
  );
  return result.rows[0] as SkillRow;
}
