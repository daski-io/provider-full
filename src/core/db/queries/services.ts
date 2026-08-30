import { pool } from "../pool.js";
import { inTransaction } from "../queryable.js";
import { recordMandatoryAudit } from "../../events/emitter.js";

// Provider-side service grouping. One row per logical service, which maps
// 1:1 to a ServiceRegistry entry
// on-chain once registered. Skills (off-chain operations) live in the
// `skills` table; this row is their parent.
//
// `on_chain_id` is populated by the ServiceRegistrar bootstrap on first
// boot; NULL until then. `version` and `slug` together produce the
// on-chain id via keccak256(providerAgentId, slug, version).

export interface ServiceRow {
  id: string;
  name: string;
  slug: string;
  version: string;
  category_family: string;
  service_type: string;
  jurisdictions: string[];
  turnaround_estimate: string | null;
  service_lifecycle: string;
  service_description: string;
  adapter_name: string;
  agent_domain: string | null;
  supplier: string | null;
  outbound_email_from: string | null;
  inbound_email_address: string | null;
  on_chain_id: Buffer | null;
  service_wallet: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  config_revision: string;
  operator_updated_by: string | null;
  operator_updated_at: Date | null;
}

const COLUMNS = [
  "id",
  "name",
  "slug",
  "version",
  "category_family",
  "service_type",
  "jurisdictions",
  "turnaround_estimate",
  "service_lifecycle",
  "service_description",
  "adapter_name",
  "agent_domain",
  "supplier",
  "outbound_email_from",
  "inbound_email_address",
  "on_chain_id",
  "service_wallet",
  "is_active",
  "created_at",
  "updated_at",
  "config_revision",
  "operator_updated_by",
  "operator_updated_at",
].join(", ");

export async function getServiceById(id: string): Promise<ServiceRow | null> {
  const result = await pool.query(
    `SELECT ${COLUMNS} FROM services WHERE id = $1`,
    [id],
  );
  return (result.rows[0] as ServiceRow | undefined) ?? null;
}

export async function getServiceBySlug(
  slug: string,
  version = "1",
): Promise<ServiceRow | null> {
  const result = await pool.query(
    `SELECT ${COLUMNS} FROM services WHERE slug = $1 AND version = $2`,
    [slug, version],
  );
  return (result.rows[0] as ServiceRow | undefined) ?? null;
}

export async function getServiceByInboundEmail(
  email: string,
): Promise<ServiceRow | null> {
  const result = await pool.query(
    `SELECT ${COLUMNS} FROM services WHERE lower(inbound_email_address) = lower($1)`,
    [email],
  );
  return (result.rows[0] as ServiceRow | undefined) ?? null;
}

export async function getServiceByOnChainId(
  onChainId: Buffer,
): Promise<ServiceRow | null> {
  const result = await pool.query<ServiceRow>(
    `SELECT ${COLUMNS} FROM services WHERE on_chain_id = $1 AND is_active = true`,
    [onChainId],
  );
  return result.rows[0] ?? null;
}

export async function listActiveServices(): Promise<ServiceRow[]> {
  const result = await pool.query(
    `SELECT ${COLUMNS} FROM services WHERE is_active = true ORDER BY name`,
  );
  return result.rows as ServiceRow[];
}

export async function listAllServices(): Promise<ServiceRow[]> {
  const result = await pool.query(
    `SELECT ${COLUMNS} FROM services ORDER BY name`,
  );
  return result.rows as ServiceRow[];
}

export interface UpsertServiceArgs {
  name: string;
  slug: string;
  version?: string;
  category_family: string;
  service_type: string;
  jurisdictions: string[];
  turnaround_estimate?: string | null;
  service_lifecycle?: string;
  service_description: string;
  adapter_name: string;
  agent_domain?: string | null;
  supplier?: string | null;
  outbound_email_from?: string | null;
  inbound_email_address?: string | null;
  service_wallet?: string | null;
  is_active?: boolean;
}

/// Upsert by (slug, version). Used by the ServiceModule registry to seed
/// services from each module's manifest on boot.
export async function upsertService(args: UpsertServiceArgs): Promise<ServiceRow> {
  const result = await pool.query(
    `INSERT INTO services (
       name, slug, version, category_family, service_type, jurisdictions,
       turnaround_estimate, service_lifecycle,
       service_description, adapter_name, agent_domain,
       supplier, outbound_email_from, inbound_email_address, service_wallet,
       is_active, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
     ON CONFLICT (slug, version) DO UPDATE SET
       name                  = EXCLUDED.name,
       category_family       = EXCLUDED.category_family,
       service_type          = EXCLUDED.service_type,
       jurisdictions         = EXCLUDED.jurisdictions,
       turnaround_estimate   = EXCLUDED.turnaround_estimate,
       service_lifecycle     = EXCLUDED.service_lifecycle,
       service_description   = EXCLUDED.service_description,
       adapter_name          = EXCLUDED.adapter_name,
       agent_domain          = COALESCE(EXCLUDED.agent_domain, services.agent_domain),
       supplier              = services.supplier,
       outbound_email_from   = services.outbound_email_from,
       inbound_email_address = services.inbound_email_address,
       service_wallet        = services.service_wallet,
       is_active             = services.is_active,
       updated_at            = now()
     RETURNING ${COLUMNS}`,
    [
      args.name,
      args.slug,
      args.version ?? "1",
      args.category_family,
      args.service_type,
      JSON.stringify(args.jurisdictions),
      args.turnaround_estimate ?? null,
      args.service_lifecycle ?? "one-shot",
      args.service_description,
      args.adapter_name,
      args.agent_domain ?? null,
      args.supplier ?? null,
      args.outbound_email_from ?? null,
      args.inbound_email_address ?? null,
      args.service_wallet ?? null,
      args.is_active ?? true,
    ],
  );
  return result.rows[0] as ServiceRow;
}

export async function setServiceOnChainId(
  id: string,
  onChainId: Buffer,
): Promise<void> {
  await pool.query(
    `UPDATE services SET on_chain_id = $2, updated_at = now() WHERE id = $1`,
    [id, onChainId],
  );
}

export async function updateServiceConfig(
  id: string,
  patch: {
    supplier?: string | null;
    outbound_email_from?: string | null;
    inbound_email_address?: string | null;
    service_wallet?: string | null;
    is_active?: boolean;
  },
  actor = "operator",
): Promise<ServiceRow | null> {
  const sets: string[] = [];
  const args: unknown[] = [id];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    args.push(v);
    sets.push(`${k} = $${args.length}`);
  }
  if (sets.length === 0) return getServiceById(id);
  const changedFields = Object.entries(patch)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
  sets.push(`updated_at = now()`);
  sets.push(`operator_updated_at = now()`);
  args.push(actor);
  sets.push(`operator_updated_by = $${args.length}`);
  sets.push(`config_revision = config_revision + 1`);
  return inTransaction(pool, async (db) => {
    const result = await db.query<ServiceRow>(
      `UPDATE services SET ${sets.join(", ")} WHERE id = $1 RETURNING ${COLUMNS}`,
      args,
    );
    const row = result.rows[0];
    if (!row) return null;
    await db.query(
      `INSERT INTO operator_config_revisions
         (resource_type, resource_key, revision, actor, changed_fields)
       VALUES ('service',$1,$2,$3,$4)`,
      [id, row.config_revision, actor, changedFields],
    );
    await recordMandatoryAudit(db, {
      serviceId: id,
      source: "admin",
      type: "admin.service_config.updated",
      actor,
      message: `Operator-owned service configuration revision ${row.config_revision} saved.`,
      payload: { revision: row.config_revision, changedFields },
    });
    return row;
  });
}
