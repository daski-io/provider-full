import { randomUUID } from "node:crypto";
import type { Hex } from "viem";
import { pool } from "../db/pool.js";
import { inTransaction } from "../db/queryable.js";
import { recordSplitterPreparations } from "./splitterRows.js";
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

/**
 * The local record a run acts on, fenced by the intent it holds. A record
 * keeps its id when a new intent replaces the old one, so every write after
 * beginGatewayRegistration also names the idempotency key it was planned
 * under: a run still working on a replaced intent writes nothing.
 */
export type RegistrationRef = Pick<GatewayRegistrationRow, "id" | "idempotency_key">;

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

/**
 * Record a freshly signed intent. A first admission inserts; otherwise the
 * caller passes the exact row it decided to replace, which must be a
 * promoted (ACTIVE) or settled ATTENTION record, and the replacement is a
 * compare-and-set on that row's state and intent. A record whose gateway
 * registration is still pending or active is never wiped here: recovery
 * decides that before any intent is signed.
 */
export async function beginGatewayRegistration(args: {
  gatewayOrigin: string;
  serviceRowId: string;
  serviceId: Hex;
  cardContractHash: Hex;
  idempotencyKey: string;
  intent: ProviderServiceRegistrationIntentEnvelope;
  replacing: GatewayRegistrationRow | null;
}): Promise<GatewayRegistrationRow> {
  const values = [
    args.gatewayOrigin,
    args.serviceRowId,
    bytes(args.serviceId),
    bytes(args.cardContractHash),
    args.idempotencyKey,
    args.intent,
  ];
  if (!args.replacing) {
    const inserted = await pool.query<GatewayRegistrationRow>(
      `INSERT INTO provider_gateway_registrations
        (id,gateway_origin,service_row_id,service_id,card_contract_hash,state,
         idempotency_key,canonical_intent)
       VALUES ($7,$1,$2,$3,$4,'INTENT_READY',$5,$6)
       ON CONFLICT (gateway_origin,service_id) DO NOTHING
       RETURNING *`,
      [...values, randomUUID()],
    );
    if (!inserted.rows[0]) {
      throw new Error("another registration run created this service's gateway record");
    }
    return inserted.rows[0];
  }
  if (!["ACTIVE", "ATTENTION"].includes(args.replacing.state)) {
    throw new Error(`a ${args.replacing.state} gateway registration cannot be replaced`);
  }
  const replaced = await pool.query<GatewayRegistrationRow>(
    `UPDATE provider_gateway_registrations SET
       service_row_id=$2,card_contract_hash=$4,state='INTENT_READY',
       idempotency_key=$5,gateway_registration_id=NULL,canonical_intent=$6,
       prepared_response=NULL,canonical_evidence=NULL,last_error_code=NULL,
       updated_at=now()
     WHERE id=$7 AND gateway_origin=$1 AND service_id=$3
       AND state=$8 AND idempotency_key=$9
     RETURNING *`,
    [
      ...values,
      args.replacing.id,
      args.replacing.state,
      args.replacing.idempotency_key,
    ],
  );
  if (!replaced.rows[0]) {
    throw new Error("the gateway registration record changed during recovery");
  }
  return replaced.rows[0];
}

/**
 * Leave ATTENTION to continue the persisted registration, keeping its
 * intent, preparation, splitter writes and evidence untouched.
 */
export async function resumeGatewayRegistration(
  ref: RegistrationRef,
): Promise<GatewayRegistrationRow> {
  const result = await pool.query<GatewayRegistrationRow>(
    `UPDATE provider_gateway_registrations
        SET state=CASE WHEN canonical_evidence IS NULL THEN 'PREPARED'
                       ELSE 'EVIDENCE_SUBMITTED' END,
            last_error_code=NULL,updated_at=now()
      WHERE id=$1 AND idempotency_key=$2 AND state='ATTENTION'
      RETURNING *`,
    [ref.id, ref.idempotency_key],
  );
  if (!result.rows[0]) throw new Error("the gateway registration left ATTENTION concurrently");
  return result.rows[0];
}

/**
 * Persist the gateway's preparation and every splitter row it requires in
 * one transaction, so no record is ever PREPARED without them.
 */
export async function savePreparedRegistration(
  ref: RegistrationRef,
  view: GatewayRegistrationView,
): Promise<GatewayRegistrationRow> {
  return inTransaction(pool, async (db) => {
    const result = await db.query<GatewayRegistrationRow>(
      `UPDATE provider_gateway_registrations
          SET state='PREPARED',gateway_registration_id=$2,
              prepared_response=$3,last_error_code=NULL,updated_at=now()
        WHERE id=$1 AND idempotency_key=$4
          AND state IN ('INTENT_READY','PREPARED')
          AND (prepared_response IS NULL OR prepared_response=$3::jsonb)
        RETURNING *`,
      [ref.id, view.registrationId, view, ref.idempotency_key],
    );
    if (!result.rows[0]) {
      throw new Error("gateway preparation changed after local persistence");
    }
    await recordSplitterPreparations(db, ref.id, view);
    return result.rows[0];
  });
}

export async function markRegistrationBroadcast(ref: RegistrationRef): Promise<void> {
  await pool.query(
    `UPDATE provider_gateway_registrations
        SET state='BROADCAST',updated_at=now()
      WHERE id=$1 AND idempotency_key=$2 AND state IN ('PREPARED','BROADCAST')`,
    [ref.id, ref.idempotency_key],
  );
}

/**
 * Persist signed evidence before it is posted. A compare-and-set on the
 * envelope it replaces (null for the first one) keeps a concurrent run from
 * overwriting evidence the gateway may already have accepted, and evidence
 * is only ever stored on the registration it binds.
 */
export async function saveRegistrationEvidence(
  ref: RegistrationRef,
  evidence: ProviderServiceRegistrationEvidenceEnvelope,
  replacing: ProviderServiceRegistrationEvidenceEnvelope | null,
): Promise<void> {
  const result = await pool.query(
    `UPDATE provider_gateway_registrations
        SET state='EVIDENCE_SUBMITTED',canonical_evidence=$2,
            last_error_code=NULL,updated_at=now()
      WHERE id=$1 AND idempotency_key=$4 AND gateway_registration_id=$5
        AND state IN ('PREPARED','BROADCAST','EVIDENCE_SUBMITTED')
        AND canonical_evidence IS NOT DISTINCT FROM $3::jsonb`,
    [ref.id, evidence, replacing, ref.idempotency_key, evidence.payload.registrationId],
  );
  if (result.rowCount !== 1) throw new Error("registration evidence persistence claim was lost");
}

export async function markGatewayRegistrationActive(
  ref: RegistrationRef,
  registrationId: string,
): Promise<void> {
  const result = await pool.query(
    `UPDATE provider_gateway_registrations
        SET state='ACTIVE',last_error_code=NULL,updated_at=now()
      WHERE id=$1 AND idempotency_key=$2 AND gateway_registration_id=$3`,
    [ref.id, ref.idempotency_key, registrationId],
  );
  if (result.rowCount !== 1) throw new Error("gateway registration did not activate");
}

/**
 * Park the record for an operator. Returns the updated row, or null when
 * another run replaced the intent this one was acting on, in which case
 * nothing is written.
 */
export async function markGatewayRegistrationAttention(
  ref: RegistrationRef,
  errorCode: string,
): Promise<GatewayRegistrationRow | null> {
  const result = await pool.query<GatewayRegistrationRow>(
    `UPDATE provider_gateway_registrations
        SET state='ATTENTION',last_error_code=$3,updated_at=now()
      WHERE id=$1 AND idempotency_key=$2
      RETURNING *`,
    [ref.id, ref.idempotency_key, errorCode.slice(0, 128)],
  );
  return result.rows[0] ?? null;
}
