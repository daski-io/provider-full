import { pool } from "../db/pool.js";
import { decryptString, encryptString } from "../chain/encryption.js";
import { inTransaction } from "../db/queryable.js";
import { recordMandatoryAudit } from "../events/emitter.js";

// Encrypted-at-rest credential store for service "suppliers" — the
// external backing services (APIs, MCP servers, fulfillment platforms, …) that a Daski service
// uses to fulfil skills. Note: "supplier" is operator terminology distinct
// from the on-chain "Provider" entity (PROVIDER_AGENT_ID env). One row per
// supplier identifier, keyed by string.
//
// Each row holds:
//   - `credentials_encrypted` (TEXT): an opaque JSON blob from the
//     supplier client's perspective, e.g. { apiUser, apiToken }. Encrypted with
//     PROVIDER_DATA_ENCRYPTION_KEY via core/chain/encryption.ts.
//   - `config` (JSONB): operator-tunable knobs that don't deserve their
//     own column — markup_pct, rate limits, regional flags, etc. Shape
//     is per-supplier.
//   - `sandbox` (bool): whether to point at the supplier's sandbox
//     endpoint. Clients consult this; this module just persists it.
//
// Reads are intentionally uncached: each supplier operation observes the
// latest database revision across replicas before sending credentials or
// spending with an external supplier.

export interface SupplierConfigRow {
  supplier: string;
  credentials: Record<string, string>;
  sandbox: boolean;
  notes: string | null;
  config: Record<string, unknown>;
  updated_by: string | null;
  updated_at: Date;
  config_revision: string;
}

export interface SupplierConfigUpdate {
  credentials?: Record<string, string>;
  sandbox?: boolean;
  notes?: string | null;
  configPatch?: Record<string, unknown>;
}

function assertLockedConfigKeys(
  existing: SupplierConfigRow | null,
  patch: Record<string, unknown> | undefined,
  actor: string,
): void {
  if (!patch || actor.startsWith("system:")) return;
  const locked = existing?.config.locked_config_keys;
  if (!Array.isArray(locked)) return;
  for (const key of locked) {
    if (typeof key !== "string" || !(key in patch)) continue;
    if (JSON.stringify(patch[key]) !== JSON.stringify(existing?.config[key])) {
      throw new Error(`Configuration key '${key}' is bound to an immutable policy version`);
    }
  }
}

function supplierNotesContext(supplier: string) {
  return {
    purpose: "supplier-metadata",
    table: "supplier_configs",
    recordId: supplier,
    field: "notes",
    service: supplier,
  } as const;
}

function fromRow(row: {
  supplier: string;
  credentials_encrypted: string;
  sandbox: boolean;
  notes: string | null;
  config: Record<string, unknown>;
  updated_by: string | null;
  updated_at: Date;
  config_revision: string;
}): SupplierConfigRow {
  return {
    supplier: row.supplier,
    credentials: JSON.parse(decryptString(row.credentials_encrypted, {
      purpose: "supplier-credentials",
      table: "supplier_configs",
      recordId: row.supplier,
      field: "credentials_encrypted",
      service: row.supplier,
    })) as Record<
      string,
      string
    >,
    sandbox: row.sandbox,
    notes: row.notes
      ? decryptString(row.notes, supplierNotesContext(row.supplier))
      : null,
    config: row.config,
    updated_by: row.updated_by,
    updated_at: row.updated_at,
    config_revision: row.config_revision,
  };
}

/// Load the full supplier config (decrypted credentials + config + flags)
/// by identifier. Returns null if not configured.
export async function getSupplierConfig(
  supplier: string,
): Promise<SupplierConfigRow | null> {
  const result = await pool.query(
    `SELECT supplier, credentials_encrypted, sandbox, notes, config,
            updated_by, updated_at, config_revision
       FROM supplier_configs
      WHERE supplier = $1`,
    [supplier],
  );
  if (result.rows.length === 0) return null;

  return fromRow(result.rows[0]);
}

/// Upsert a supplier row. Pass only the fields you want to change;
/// undefined fields are preserved and configPatch is merged while the row
/// lock is held. Encrypts credentials at rest. Returns the freshly persisted row.
///
/// Note: this is pure data access — the caller is responsible for
/// emitting any audit event (admin UI emits `admin.supplier_credentials.updated`,
/// service seeders emit their own provenance event). Keeping the event
/// out of this module avoids reaching from `core/suppliers/` into
/// `core/events/` and forces every callsite to make an explicit decision.
export async function setSupplierConfig(
  supplier: string,
  update: SupplierConfigUpdate,
  actor: string,
): Promise<SupplierConfigRow> {
  return inTransaction(pool, async (db) => {
    const locked = await db.query(
      `SELECT supplier, credentials_encrypted, sandbox, notes, config,
              updated_by, updated_at, config_revision
         FROM supplier_configs WHERE supplier = $1 FOR UPDATE`,
      [supplier],
    );
    const existing = locked.rows[0]
      ? fromRow(locked.rows[0] as Parameters<typeof fromRow>[0])
      : null;
    assertLockedConfigKeys(existing, update.configPatch, actor);
    const merged = {
      credentials: update.credentials ?? existing?.credentials ?? {},
      sandbox: update.sandbox ?? existing?.sandbox ?? false,
      notes: update.notes !== undefined ? update.notes : existing?.notes ?? null,
      config: {
        ...(existing?.config ?? {}),
        ...(update.configPatch ?? {}),
      },
    };
    const encrypted = encryptString(JSON.stringify(merged.credentials), {
      purpose: "supplier-credentials",
      table: "supplier_configs",
      recordId: supplier,
      field: "credentials_encrypted",
      service: supplier,
    });
    const encryptedNotes = merged.notes
      ? encryptString(merged.notes, supplierNotesContext(supplier))
      : null;
    const result = await db.query(
      `INSERT INTO supplier_configs
         (supplier, credentials_encrypted, sandbox, notes, config, updated_by,
          updated_at, config_revision)
       VALUES ($1,$2,$3,$4,$5,$6,now(),1)
       ON CONFLICT (supplier) DO UPDATE
         SET credentials_encrypted = EXCLUDED.credentials_encrypted,
             sandbox = EXCLUDED.sandbox,
             notes = EXCLUDED.notes,
             config = supplier_configs.config || EXCLUDED.config,
             updated_by = EXCLUDED.updated_by,
             updated_at = now(),
             config_revision = supplier_configs.config_revision + 1
       RETURNING supplier, credentials_encrypted, sandbox, notes, config,
                 updated_by, updated_at, config_revision`,
      [supplier, encrypted, merged.sandbox, encryptedNotes, merged.config, actor],
    );
    const row = fromRow(result.rows[0] as Parameters<typeof fromRow>[0]);
    const changedFields = Object.entries(update)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key === "configPatch" ? "config" : key);
    await db.query(
      `INSERT INTO operator_config_revisions
         (resource_type, resource_key, revision, actor, changed_fields)
       VALUES ('supplier',$1,$2,$3,$4)`,
      [supplier, row.config_revision, actor, changedFields],
    );
    await recordMandatoryAudit(db, {
      source: "admin",
      type: "admin.supplier_config.updated",
      actor,
      message: `Supplier '${supplier}' configuration revision ${row.config_revision} saved.`,
      payload: { supplier, revision: row.config_revision, changedFields },
    });
    if (update.credentials !== undefined) {
      // Keep supplier client imports lightweight: the recovery service pulls
      // in protected execution snapshots and is only needed on credential writes.
      const { queueProviderConfigHoldRetries } = await import(
        "../engine/escalationResolutionStore.js"
      );
      await queueProviderConfigHoldRetries({ supplier, actor, db });
    }
    return row;
  });
}
