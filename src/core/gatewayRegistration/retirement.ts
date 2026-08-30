import type { Hex } from "viem";
import { pool } from "../db/pool.js";
import { recordMandatoryAudit } from "../events/emitter.js";

const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");

export interface ServiceRetirementBlockers {
  openTransactions: number;
  liveAssets: number;
  openEscalations: number;
  openAssetActions: number;
  openSupplierOperations: number;
  pendingStandardReputation: number;
  pendingGatewayRegistration: number;
  pendingSplitterWrites: number;
  pendingChainWrites: number;
  otherGatewayRegistrations: number;
}

export interface ServiceRetirementResult {
  gatewayOrigin: string;
  serviceId: Hex;
  serviceSlug: string;
  serviceVersion: string;
  alreadyRetired: boolean;
  serviceDeactivated: boolean;
  supersededListings: Array<{ listingId: string; skillId: string }>;
  blockers: ServiceRetirementBlockers;
}

interface ServiceRow {
  id: string;
  slug: string;
  version: string;
  is_active: boolean;
}

interface BlockerRow {
  open_transactions: number;
  live_assets: number;
  open_escalations: number;
  open_asset_actions: number;
  open_supplier_operations: number;
  pending_standard_reputation: number;
  pending_gateway_registration: number;
  pending_splitter_writes: number;
  pending_chain_writes: number;
  other_gateway_registrations: number;
}

export class ServiceRetirementBlockedError extends Error {
  constructor(readonly blockers: ServiceRetirementBlockers) {
    super(`service retirement blocked: ${JSON.stringify(blockers)}`);
    this.name = "ServiceRetirementBlockedError";
  }
}

function mapBlockers(row: BlockerRow): ServiceRetirementBlockers {
  return {
    openTransactions: row.open_transactions,
    liveAssets: row.live_assets,
    openEscalations: row.open_escalations,
    openAssetActions: row.open_asset_actions,
    openSupplierOperations: row.open_supplier_operations,
    pendingStandardReputation: row.pending_standard_reputation,
    pendingGatewayRegistration: row.pending_gateway_registration,
    pendingSplitterWrites: row.pending_splitter_writes,
    pendingChainWrites: row.pending_chain_writes,
    otherGatewayRegistrations: row.other_gateway_registrations,
  };
}

function hasBlockers(blockers: ServiceRetirementBlockers): boolean {
  return Object.values(blockers)
    .some((count) => !Number.isInteger(count) || count !== 0);
}

/**
 * Permanently retires one exact provider service from one gateway catalog.
 *
 * Visibility and gateway-order draining are deliberately proved by the
 * coordination workflow before this provider-local transaction begins. This
 * transaction then serializes against catalog promotion, rechecks every
 * provider-side obligation, deactivates the service row, and supersedes all
 * of its runtime heads atomically. Historical registrations, versions, tasks,
 * and assets are retained.
 */
export async function retireGatewayService(
  gatewayOrigin: string,
  serviceId: Hex,
): Promise<ServiceRetirementResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`${gatewayOrigin}\n${serviceId.toLowerCase()}`],
    );
    const serviceResult = await client.query<ServiceRow>(
      `SELECT id,slug,version,is_active
         FROM services
        WHERE on_chain_id=$1
        FOR UPDATE`,
      [bytes(serviceId)],
    );
    const service = serviceResult.rows[0];
    if (!service) throw new Error("exact provider service was not found");

    const registration = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM provider_gateway_registrations
        WHERE gateway_origin=$1 AND service_id=$2`,
      [gatewayOrigin, bytes(serviceId)],
    );
    if (registration.rows[0]?.count !== 1) {
      throw new Error("exact provider gateway registration was not found");
    }

    const blockerResult = await client.query<BlockerRow>(
      `SELECT
        (SELECT count(*)::int FROM transactions
          WHERE service_id=$1
            AND status IN ('submitted','working','input-required')) AS open_transactions,
        (SELECT count(*)::int FROM assets WHERE service_id=$1
          AND status NOT IN ('transferred_out','deleted')) AS live_assets,
        (SELECT count(*)::int FROM escalations e
          LEFT JOIN transactions t ON t.id=e.transaction_id
          WHERE (t.service_id=$1 OR e.snapshot_service_id=$1)
            AND e.status NOT IN ('resolved','rejected','approved','edited')) AS open_escalations,
        (SELECT count(*)::int FROM standard_asset_action_executions x
          JOIN assets a ON a.id=x.provider_asset_id
          WHERE a.service_id=$1
            AND x.state NOT IN ('completed','failed','canceled','expired')) AS open_asset_actions,
        (SELECT count(*)::int FROM supplier_operations
          WHERE service_id=$1 AND state IN ('intent','ambiguous')) AS open_supplier_operations,
        (SELECT count(*)::int FROM standard_reputation_outcomes r
          JOIN transactions t ON t.id=r.transaction_id
          WHERE t.service_id=$1
            AND r.state IN ('pending','broadcast','operator_attention')) AS pending_standard_reputation,
        (SELECT count(*)::int FROM provider_gateway_registrations
          WHERE gateway_origin=$2 AND service_id=$3
            AND state<>'ACTIVE') AS pending_gateway_registration,
        (SELECT count(*)::int FROM provider_gateway_splitter_writes w
          JOIN provider_gateway_registrations r
            ON r.id=w.gateway_registration_local_id
          WHERE r.gateway_origin=$2 AND r.service_id=$3
            AND w.state NOT IN ('CONFIRMED','REVERTED')) AS pending_splitter_writes,
        (SELECT count(DISTINCT w.id)::int FROM provider_chain_writes w
          WHERE w.status NOT IN ('confirmed','reverted','replaced') AND (
            (w.target_type='service' AND w.target_id=$1::text)
            OR (w.target_type='gateway_listing' AND EXISTS (
              SELECT 1 FROM provider_runtime_listing_versions v
               WHERE v.gateway_origin=$2 AND v.service_id=$3
                 AND v.listing_id::text=w.target_id
            ))
            OR EXISTS (
              SELECT 1 FROM standard_reputation_outcomes r
              JOIN transactions t ON t.id=r.transaction_id
               WHERE t.service_id=$1 AND r.provider_write_id=w.id
            )
          )) AS pending_chain_writes,
        (SELECT count(*)::int FROM provider_gateway_registrations
          WHERE service_id=$3 AND gateway_origin<>$2)
          AS other_gateway_registrations`,
      [service.id, gatewayOrigin, bytes(serviceId)],
    );
    const blockers = mapBlockers(blockerResult.rows[0]!);
    if (hasBlockers(blockers)) throw new ServiceRetirementBlockedError(blockers);

    const heads = await client.query<{ listing_id: string; skill_id: string }>(
      `UPDATE provider_runtime_listing_versions
          SET superseded_at=now()
        WHERE gateway_origin=$1 AND service_id=$2 AND superseded_at IS NULL
        RETURNING listing_id,skill_id`,
      [gatewayOrigin, bytes(serviceId)],
    );
    let serviceDeactivated = false;
    if (service.is_active) {
      const updated = await client.query<{ config_revision: string }>(
        `UPDATE services
            SET is_active=false,updated_at=now(),operator_updated_at=now(),
                operator_updated_by='service-retirement',
                config_revision=config_revision+1
          WHERE id=$1 AND is_active=true
          RETURNING config_revision`,
        [service.id],
      );
      if (!updated.rows[0]) throw new Error("provider service retirement lost its row lock");
      serviceDeactivated = true;
      await client.query(
        `INSERT INTO operator_config_revisions
          (resource_type,resource_key,revision,actor,changed_fields)
         VALUES ('service',$1,$2,'service-retirement',$3)`,
        [service.id, updated.rows[0].config_revision, ["is_active"]],
      );
    }
    if (serviceDeactivated || heads.rows.length > 0) {
      await recordMandatoryAudit(client, {
        serviceId: service.id,
        source: "admin",
        type: "admin.service.retired",
        actor: "service-retirement",
        message: `Retired ${service.slug} v${service.version} from the gateway runtime catalog.`,
        payload: {
          gatewayOrigin,
          onChainServiceId: serviceId.toLowerCase(),
          serviceDeactivated,
          supersededListingCount: heads.rows.length,
        },
      });
    }
    await client.query("COMMIT");
    return {
      gatewayOrigin,
      serviceId: serviceId.toLowerCase() as Hex,
      serviceSlug: service.slug,
      serviceVersion: service.version,
      alreadyRetired: !serviceDeactivated && heads.rows.length === 0,
      serviceDeactivated,
      supersededListings: heads.rows.map((row) => ({
        listingId: row.listing_id,
        skillId: row.skill_id,
      })),
      blockers,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
