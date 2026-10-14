import type { PoolClient } from "pg";
import type { Hex } from "viem";
import { encryptString } from "../chain/encryption.js";
import { pool } from "../db/pool.js";
import { setCustomerLastKnownEmail, upsertCustomer } from "../db/queries/customers.js";
import type { ServiceRow } from "../db/queries/services.js";
import type { SupplierCostCeiling } from "../serviceRegistry/types.js";
import {
  DispatchAmbiguousError,
  DispatchCommitUncertainError,
  DispatchRejectedError,
} from "./dispatchErrors.js";
import { insertAdmittedFulfillmentJob, type FulfillmentJobLease } from "./fulfillmentJobs.js";
import { newStandardTaskId } from "./identifiers.js";
import { recordStandardSecurityIncident } from "./incidents.js";
import type { ProviderOutcomeConfig, StandardRailDispatchV2 } from "./types.js";

const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");

export interface ClaimKey {
  gatewayAudience: string;
  orderId: string;
}

export interface DispatchClaim {
  dispatchHash: Hex;
  transactionId: string | null;
}

interface ClaimRow {
  dispatch_hash: Buffer;
  transaction_id: string | null;
}

const toClaim = (row: ClaimRow): DispatchClaim => ({
  dispatchHash: `0x${row.dispatch_hash.toString("hex")}`,
  transactionId: row.transaction_id,
});

const CLAIM_SQL =
  "SELECT dispatch_hash,transaction_id FROM standard_dispatch_claims WHERE gateway_audience=$1 AND order_id=$2";

/**
 * One transaction-scoped advisory lock per (gateway audience, order). Every
 * admission holds it until commit, so a status read that acquires it knows no
 * admission is in flight and that any committed claim is already visible.
 */
const LOCK_SQL = "hashtextextended('standard-dispatch-claim:' || $1 || ':' || $2, 0)";

export async function findDispatchClaim(key: ClaimKey): Promise<DispatchClaim | null> {
  const row = (await pool.query<ClaimRow>(CLAIM_SQL, [key.gatewayAudience, key.orderId])).rows[0];
  return row ? toClaim(row) : null;
}

/**
 * Authoritative claim lookup. "absent" is proof that no claim exists and no
 * admission for the order is in flight; "busy" means one is in flight. The
 * probe writes nothing.
 */
export async function probeDispatchClaim(
  key: ClaimKey,
): Promise<{ kind: "claim"; claim: DispatchClaim } | { kind: "absent" } | { kind: "busy" }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    // Shared: concurrent probes never block each other, while an admission
    // holding the exclusive lock still makes the probe report "busy".
    const lock = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_xact_lock_shared(${LOCK_SQL}) AS acquired`, [key.gatewayAudience, key.orderId],
    );
    if (lock.rows[0]?.acquired !== true) {
      await client.query("ROLLBACK");
      return { kind: "busy" };
    }
    const row = (await client.query<ClaimRow>(CLAIM_SQL, [key.gatewayAudience, key.orderId])).rows[0];
    await client.query("ROLLBACK");
    return row ? { kind: "claim", claim: toClaim(row) } : { kind: "absent" };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function insertAdmission(client: PoolClient, args: AdmissionArgs): Promise<{ taskId: string; job: FulfillmentJobLease }> {
  const { dispatch } = args;
  const taskId = newStandardTaskId();
  const customer = await upsertCustomer(dispatch.payer, client);
  const contactEmail = typeof args.request.contactEmail === "string"
    ? args.request.contactEmail.trim().toLowerCase() : null;
  if (contactEmail) await setCustomerLastKnownEmail(customer.id, contactEmail, client);
  const encryptedRequest = encryptString(JSON.stringify(args.request), {
    purpose: "standard-order-request",
    table: "transactions",
    recordId: taskId,
    field: "metadata.standard_request_encrypted",
    recordVersion: 1,
  });
  await client.query(
    `INSERT INTO transactions (
      id,customer_id,service_id,skill_id,status,metadata,contact_email,canonical_request_hash,
      standard_order_id,standard_payer,standard_listing_manifest_hash,standard_order_key,
      standard_provider_offer_hash,standard_deposit_evidence_hash,standard_release_evidence_hash,
      standard_token,standard_gross_amount,standard_provider_net_amount,standard_daski_commission_amount)
     VALUES ($1,$2,$3,$4,'submitted',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      taskId, customer.id, args.service.id, args.outcome.skillId,
      JSON.stringify({
        standard_request_encrypted: encryptedRequest,
        ...(args.supplierCostCeiling ? { supplier_cost_ceiling: args.supplierCostCeiling } : {}),
      }),
      contactEmail ? encryptString(contactEmail, {
        purpose: "customer-contact", table: "transactions", recordId: taskId, field: "contact_email",
      }) : null,
      bytes(dispatch.canonicalRequestHash), dispatch.orderId, dispatch.payer,
      bytes(dispatch.listingManifestHash), bytes(dispatch.orderKey), bytes(dispatch.providerOfferHash),
      bytes(dispatch.depositEvidenceHash), bytes(dispatch.releaseEvidenceHash),
      args.outcome.token, dispatch.grossAmount, dispatch.providerNetAmount, dispatch.daskiCommissionAmount,
    ],
  );
  // The deadlines the order was sold with: the dispatch envelope's own
  // deadline and the version's fulfillment duration, from acceptance now.
  await client.query(
    `INSERT INTO standard_dispatch_claims
      (gateway_audience,order_id,dispatch_nonce,dispatch_hash,request_hash,payer,state,
       transaction_id,provider_quote_hash,admitted_dispatch_seconds,admitted_fulfillment_seconds)
     VALUES ($1,$2,$3,$4,$5,$6,'dispatching',$7,$8,$9,$10)`,
    [
      dispatch.gatewayAudience, dispatch.orderId, bytes(dispatch.dispatchNonce), bytes(args.dispatchHash),
      bytes(dispatch.canonicalProviderRequestHash), dispatch.payer, taskId, bytes(args.providerQuoteHash),
      dispatch.dispatchDeadlineSeconds, args.fulfillmentSeconds,
    ],
  );
  const job = await insertAdmittedFulfillmentJob(client, {
    taskId, orderId: dispatch.orderId, gatewayAudience: dispatch.gatewayAudience, capability: args.capability,
  });
  return { taskId, job };
}

export interface AdmissionArgs {
  dispatch: StandardRailDispatchV2;
  dispatchHash: Hex;
  request: Record<string, unknown>;
  outcome: ProviderOutcomeConfig;
  service: ServiceRow;
  supplierCostCeiling: SupplierCostCeiling | null;
  providerQuoteHash: Hex;
  /** The admitted fulfillment duration of the order's listing version. */
  fulfillmentSeconds: number;
  /** The executable definition a worker needs to resume the order; null for a configured head. */
  capability: Hex | null;
}

export type AdmissionOutcome =
  | { kind: "admitted"; taskId: string; job: FulfillmentJobLease }
  | { kind: "existing"; claim: DispatchClaim };

/**
 * Durably admit one paid order. Under the order's advisory lock it either
 * finds an existing claim or inserts the task and claim, then rechecks the
 * envelope's expiry against the database clock as the last statement before
 * commit, so no claim commits at or after `validBefore`, however slowly the
 * request arrived. A commit whose outcome is unknown is ambiguous. Capacity
 * is deliberately not counted here: the order is already funded.
 */
export async function admitDispatchClaim(args: AdmissionArgs): Promise<AdmissionOutcome> {
  const client = await pool.connect();
  let destroy = false;
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(${LOCK_SQL})`,
      [args.dispatch.gatewayAudience, args.dispatch.orderId]);
    const existing = (await client.query<ClaimRow>(`${CLAIM_SQL} FOR UPDATE`,
      [args.dispatch.gatewayAudience, args.dispatch.orderId])).rows[0];
    if (existing) {
      await client.query("ROLLBACK");
      return { kind: "existing", claim: toClaim(existing) };
    }
    const { taskId, job } = await insertAdmission(client, args);
    const fence = await client.query<{ open: boolean }>(
      "SELECT clock_timestamp() < to_timestamp($1) AS open", [args.dispatch.validBefore],
    );
    if (fence.rows[0]?.open !== true) {
      throw new DispatchRejectedError("envelope_lifetime", "Dispatch envelope expired before admission");
    }
    try {
      await client.query("COMMIT");
    } catch (error) {
      destroy = true;
      throw new DispatchCommitUncertainError(taskId, error, job);
    }
    return { kind: "admitted", taskId, job };
  } catch (error) {
    if (error instanceof DispatchAmbiguousError) throw error;
    await client.query("ROLLBACK").catch(() => { destroy = true; });
    const database = error as { code?: string; constraint?: string };
    if (database.code === "23505" && database.constraint?.includes("dispatch_nonce")) {
      await recordStandardSecurityIncident({
        kind: "dispatch_nonce_reuse",
        gatewayAudience: args.dispatch.gatewayAudience,
        orderId: args.dispatch.orderId,
        identity: { gatewayAudience: args.dispatch.gatewayAudience, dispatchNonce: args.dispatch.dispatchNonce },
      }).catch(() => undefined);
      throw new DispatchRejectedError("validator", "Dispatch nonce was already used");
    }
    throw error;
  } finally {
    client.release(destroy);
  }
}
