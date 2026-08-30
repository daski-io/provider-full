import { randomUUID } from "node:crypto";
import type { Hex } from "viem";
import { pool } from "../db/pool.js";
import type { Queryable } from "../db/queryable.js";
import type { PreparedProviderWrite } from "../chain/providerWriteCoordinator.js";
import type {
  GatewayRegistrationView,
  ProviderServiceRegistrationEvidenceEnvelope,
  ProviderServiceRegistrationIntentEnvelope,
} from "./types.js";

export type GatewayRegistrationState =
  | "INTENT_READY"
  | "PREPARED"
  | "BROADCAST"
  | "EVIDENCE_SUBMITTED"
  | "ACTIVE"
  | "ATTENTION";

export interface GatewayRegistrationRow {
  id: string;
  gateway_origin: string;
  service_row_id: string;
  service_id: Buffer;
  card_contract_hash: Buffer;
  state: GatewayRegistrationState;
  idempotency_key: string;
  gateway_registration_id: string | null;
  canonical_intent: ProviderServiceRegistrationIntentEnvelope;
  prepared_response: GatewayRegistrationView | null;
  canonical_evidence: ProviderServiceRegistrationEvidenceEnvelope | null;
  last_error_code: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface GatewaySplitterWriteRow {
  listing_id: string;
  gateway_registration_local_id: string;
  expected_splitter_address: string;
  canonical_transaction: Record<string, unknown>;
  provider_write_id: string | null;
  transaction_hash: Hex | null;
  state: "PREPARED" | "BROADCAST" | "CONFIRMED" | "REVERTED" | "ATTENTION";
  last_error_code: string | null;
  created_at: Date;
  updated_at: Date;
}

const bytes = (hex: string): Buffer => Buffer.from(hex.slice(2), "hex");

export async function getGatewayRegistration(
  gatewayOrigin: string,
  serviceId: Hex,
): Promise<GatewayRegistrationRow | null> {
  const result = await pool.query<GatewayRegistrationRow>(
    `SELECT * FROM provider_gateway_registrations
      WHERE gateway_origin=$1 AND service_id=$2`,
    [gatewayOrigin, bytes(serviceId)],
  );
  return result.rows[0] ?? null;
}

export async function beginGatewayRegistration(args: {
  gatewayOrigin: string;
  serviceRowId: string;
  serviceId: Hex;
  cardContractHash: Hex;
  idempotencyKey: string;
  intent: ProviderServiceRegistrationIntentEnvelope;
}): Promise<GatewayRegistrationRow> {
  const existing = await getGatewayRegistration(args.gatewayOrigin, args.serviceId);
  if (existing && !["ACTIVE", "ATTENTION"].includes(existing.state)) return existing;
  if (
    existing &&
    existing.card_contract_hash.equals(bytes(args.cardContractHash)) &&
    existing.state === "ACTIVE"
  ) return existing;
  const id = existing?.id ?? randomUUID();
  const result = await pool.query<GatewayRegistrationRow>(
    `INSERT INTO provider_gateway_registrations
      (id,gateway_origin,service_row_id,service_id,card_contract_hash,state,
       idempotency_key,canonical_intent)
     VALUES ($1,$2,$3,$4,$5,'INTENT_READY',$6,$7)
     ON CONFLICT (gateway_origin,service_id) DO UPDATE SET
       service_row_id=EXCLUDED.service_row_id,
       card_contract_hash=EXCLUDED.card_contract_hash,
       state='INTENT_READY',
       idempotency_key=EXCLUDED.idempotency_key,
       gateway_registration_id=NULL,
       canonical_intent=EXCLUDED.canonical_intent,
       prepared_response=NULL,
       canonical_evidence=NULL,
       last_error_code=NULL,
       updated_at=now()
     RETURNING *`,
    [
      id,
      args.gatewayOrigin,
      args.serviceRowId,
      bytes(args.serviceId),
      bytes(args.cardContractHash),
      args.idempotencyKey,
      args.intent,
    ],
  );
  return result.rows[0]!;
}

export async function savePreparedRegistration(
  localId: string,
  view: GatewayRegistrationView,
): Promise<void> {
  const result = await pool.query(
    `UPDATE provider_gateway_registrations
        SET state='PREPARED',gateway_registration_id=$2,
            prepared_response=$3,last_error_code=NULL,updated_at=now()
      WHERE id=$1 AND state IN ('INTENT_READY','PREPARED')
        AND (prepared_response IS NULL OR prepared_response=$3::jsonb)`,
    [localId, view.registrationId, view],
  );
  if (result.rowCount !== 1) {
    throw new Error("gateway preparation changed after local persistence");
  }
  for (const listing of view.prepared.listings) {
    if (!listing.deploymentRequired || !listing.transaction || !listing.splitterAddress) {
      continue;
    }
    await pool.query(
      `INSERT INTO provider_gateway_splitter_writes
        (listing_id,gateway_registration_local_id,expected_splitter_address,
         canonical_transaction,state)
       VALUES ($1,$2,$3,$4,'PREPARED')
       ON CONFLICT (listing_id) DO UPDATE SET
         expected_splitter_address=EXCLUDED.expected_splitter_address,
         canonical_transaction=EXCLUDED.canonical_transaction,
         updated_at=now()
       WHERE provider_gateway_splitter_writes.gateway_registration_local_id=$2
         AND provider_gateway_splitter_writes.provider_write_id IS NULL`,
      [
        listing.listingId,
        localId,
        listing.splitterAddress.toLowerCase(),
        listing.transaction,
      ],
    );
  }
}

export async function listGatewaySplitterWrites(
  localId: string,
): Promise<GatewaySplitterWriteRow[]> {
  const result = await pool.query<GatewaySplitterWriteRow>(
    `SELECT * FROM provider_gateway_splitter_writes
      WHERE gateway_registration_local_id=$1 ORDER BY listing_id`,
    [localId],
  );
  return result.rows;
}

export async function claimSplitterProviderWrite(
  listingId: string,
  prepared: PreparedProviderWrite,
  db: Queryable,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE provider_gateway_splitter_writes
        SET provider_write_id=$2,transaction_hash=$3,state='BROADCAST',
            last_error_code=NULL,updated_at=now()
      WHERE listing_id=$1 AND provider_write_id IS NULL`,
    [listingId, prepared.id, prepared.hash.toLowerCase()],
  );
  return result.rowCount === 1;
}

export async function confirmSplitterWrite(
  listingId: string,
  providerWriteId: string,
): Promise<void> {
  const result = await pool.query(
    `UPDATE provider_gateway_splitter_writes
        SET state='CONFIRMED',last_error_code=NULL,updated_at=now()
      WHERE listing_id=$1 AND provider_write_id=$2`,
    [listingId, providerWriteId],
  );
  if (result.rowCount !== 1) throw new Error("splitter write persistence claim was lost");
}

export async function markRegistrationBroadcast(localId: string): Promise<void> {
  await pool.query(
    `UPDATE provider_gateway_registrations
        SET state='BROADCAST',updated_at=now()
      WHERE id=$1 AND state IN ('PREPARED','BROADCAST')`,
    [localId],
  );
}

export async function saveRegistrationEvidence(
  localId: string,
  evidence: ProviderServiceRegistrationEvidenceEnvelope,
): Promise<void> {
  const result = await pool.query(
    `UPDATE provider_gateway_registrations
        SET state='EVIDENCE_SUBMITTED',canonical_evidence=$2,
            last_error_code=NULL,updated_at=now()
      WHERE id=$1 AND state IN ('PREPARED','BROADCAST','EVIDENCE_SUBMITTED')`,
    [localId, evidence],
  );
  if (result.rowCount !== 1) throw new Error("registration evidence persistence claim was lost");
}

export async function markGatewayRegistrationActive(localId: string): Promise<void> {
  const result = await pool.query(
    `UPDATE provider_gateway_registrations
        SET state='ACTIVE',last_error_code=NULL,updated_at=now()
      WHERE id=$1`,
    [localId],
  );
  if (result.rowCount !== 1) throw new Error("gateway registration did not activate");
}

export async function markGatewayRegistrationAttention(
  localId: string,
  errorCode: string,
): Promise<void> {
  await pool.query(
    `UPDATE provider_gateway_registrations
        SET state='ATTENTION',last_error_code=$2,updated_at=now()
      WHERE id=$1`,
    [localId, errorCode.slice(0, 128)],
  );
}
