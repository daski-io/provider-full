import { encodeAbiParameters, getAddress, parseAbi, parseEventLogs, type Hex, type Log } from "viem";
import { pool } from "../db/pool.js";
import { providerAddress, publicClient } from "../chain/client.js";
import { assertCanonicalFinalReceipt } from "../chain/finality.js";
import {
  loadProviderWrite,
  prepareAndBroadcastProviderWrite,
} from "../chain/providerWriteCoordinator.js";
import type { Queryable } from "../db/queryable.js";
import { updateProviderWriteStatus } from "../db/queries/providerChainWrites.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { liveContractIntegrity } from "./contractIntegrity.js";
import { logWarn } from "../logger.js";
import { failWorker, heartbeatWorker, setWorkerStatus } from "../health.js";
import {
  reconcileReputationOutcomeReviews,
  surfaceReputationOutcomeReview,
} from "./reputationOutcomeReviews.js";

const easAbi = parseAbi([
  "function attest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value) data) request) payable returns (bytes32)",
]);
const easAttestedAbi = parseAbi([
  "event Attested(address indexed recipient,address indexed attester,bytes32 uid,bytes32 indexed schemaUID)",
]);
const easAttestationAbi = parseAbi([
  "function getAttestation(bytes32 uid) view returns ((bytes32 uid,bytes32 schema,uint64 time,uint64 expirationTime,uint64 revocationTime,bytes32 refUID,address recipient,address attester,bool revocable,bytes data))",
]);

interface OutcomeRow {
  order_key: Buffer;
  transaction_id: string;
  outcome: number;
  state: "pending" | "broadcast" | "final" | "operator_attention" | "aborted_unattested";
  provider_write_id: string | null;
  attempt_count: number;
  retry_once_used: boolean;
}

const keyHex = (row: OutcomeRow): Hex => `0x${row.order_key.toString("hex")}`;
let activeConfig: ProviderStandardRailConfig | null = null;

const outcomeAttestationData = (row: OutcomeRow): Hex => encodeAbiParameters(
  [{ type: "bytes32" }, { type: "uint8" }],
  [keyHex(row), row.outcome],
);

/// A successful receipt from the configured address is not proof of an
/// attestation: only the canonical EAS Attested event for the reviewed
/// schema, attested by and to the provider wallet, identifies the UID this
/// outcome may be finalized against.
function selectAttestedUid(
  logs: readonly Log[],
  config: ProviderStandardRailConfig,
): Hex | null {
  const attested = parseEventLogs({
    abi: easAttestedAbi,
    logs: logs as Log[],
    eventName: "Attested",
  }).filter((event) =>
    event.address.toLowerCase() === config.easAddress.toLowerCase() &&
    event.args.schemaUID?.toLowerCase() === config.reputationOutcomeSchemaUid &&
    event.args.recipient !== undefined &&
    getAddress(event.args.recipient) === getAddress(providerAddress) &&
    event.args.attester !== undefined &&
    getAddress(event.args.attester) === getAddress(providerAddress)
  );
  const uid = attested.length === 1 ? attested[0]!.args.uid : undefined;
  return uid && !/^0x0+$/.test(uid) ? uid : null;
}

async function verifyCanonicalAttestation(
  uid: Hex,
  row: OutcomeRow,
  config: ProviderStandardRailConfig,
): Promise<boolean> {
  const attestation = await publicClient.readContract({
    address: config.easAddress,
    abi: easAttestationAbi,
    functionName: "getAttestation",
    args: [uid],
  });
  return attestation.uid.toLowerCase() === uid.toLowerCase() &&
    attestation.schema.toLowerCase() === config.reputationOutcomeSchemaUid &&
    getAddress(attestation.recipient) === getAddress(providerAddress) &&
    getAddress(attestation.attester) === getAddress(providerAddress) &&
    attestation.data.toLowerCase() === outcomeAttestationData(row).toLowerCase();
}

async function parkUnattestedSuccess(row: OutcomeRow): Promise<void> {
  const updated = await pool.query(
    `UPDATE standard_reputation_outcomes SET state='operator_attention',next_attempt_at=NULL,
            last_error_class='contract_rejection',updated_at=now()
      WHERE order_key=$1 AND provider_write_id=$2 AND state<>'final'`,
    [row.order_key, row.provider_write_id],
  );
  if (updated.rowCount === 1) {
    await surfaceReputationOutcomeReview({
      row,
      reason: "contract_rejection",
    });
    logWarn("Standard reputation outcome requires provider attention", {
      transactionId: row.transaction_id,
      reason: "unverified_attestation",
    });
  }
}

async function dueOutcome(): Promise<OutcomeRow | null> {
  const result = await pool.query<OutcomeRow>(
    `SELECT * FROM standard_reputation_outcomes
      WHERE state IN ('pending','broadcast') AND next_attempt_at<=now()
      ORDER BY next_attempt_at,created_at LIMIT 1`,
  );
  return result.rows[0] ?? null;
}

type OutcomeFailureClass = "rpc_finality" | "balance_fee" | "nonce_conflict" |
  "contract_rejection" | "application_fault";

function classifyWriteFailure(value: unknown): OutcomeFailureClass {
  const message = value instanceof Error ? value.message : String(value ?? "");
  if (/insufficient.funds|fee|base.fee|underpriced/i.test(message)) return "balance_fee";
  if (/nonce/i.test(message)) return "nonce_conflict";
  if (/revert|contract|invalid opcode/i.test(message)) return "contract_rejection";
  if (/rpc|timeout|network|fetch|socket|receipt|final/i.test(message)) return "rpc_finality";
  return "application_fault";
}

async function scheduleFailure(
  row: OutcomeRow,
  config: ProviderStandardRailConfig,
  reason: OutcomeFailureClass,
): Promise<void> {
  const attempt = row.attempt_count + 1;
  if (attempt >= 5) {
    const updated = await pool.query(
      `UPDATE standard_reputation_outcomes SET state='operator_attention',attempt_count=$2,
              next_attempt_at=NULL,last_error_class=$3,updated_at=now()
        WHERE order_key=$1 AND state='pending'`,
      [row.order_key, attempt, reason],
    );
    if (updated.rowCount === 1) {
      await surfaceReputationOutcomeReview({
        row: { ...row, attempt_count: attempt },
        reason,
      });
      logWarn("Standard reputation outcome requires provider attention", {
        transactionId: row.transaction_id,
        attemptCount: attempt,
        reason,
      });
    }
    return;
  }
  const delay = config.reputationRetryDelaysSeconds[attempt - 1]!;
  await pool.query(
    `UPDATE standard_reputation_outcomes SET attempt_count=$2,
            next_attempt_at=now()+($3::text||' seconds')::interval,
            last_error_class=$4,updated_at=now()
      WHERE order_key=$1 AND state='pending'`,
    [row.order_key, attempt, delay, reason],
  );
}

async function reconcile(
  row: OutcomeRow,
  config: ProviderStandardRailConfig,
): Promise<"waiting" | "final" | "retry"> {
  if (!row.provider_write_id) return "retry";
  const write = await loadProviderWrite(row.provider_write_id);
  if (!write) {
    const updated = await pool.query(
      `UPDATE standard_reputation_outcomes SET state='operator_attention',next_attempt_at=NULL,
              last_error_class='application_fault',updated_at=now()
        WHERE order_key=$1 AND provider_write_id=$2`,
      [row.order_key, row.provider_write_id],
    );
    if (updated.rowCount === 1) {
      await surfaceReputationOutcomeReview({
        row,
        reason: "application_fault",
      });
      logWarn("Standard reputation outcome requires provider attention", {
        transactionId: row.transaction_id,
        reason: "application_fault",
      });
    }
    return "waiting";
  }
  if (["prepared", "broadcast", "confirmed"].includes(write.status)) {
    const receipt = await publicClient.getTransactionReceipt({ hash: write.transaction_hash })
      .catch(() => null);
    if (!receipt) return "waiting";
    try {
      await assertCanonicalFinalReceipt(receipt, write.transaction_hash);
    } catch {
      return "waiting";
    }
    if (receipt.status !== "success") {
      await updateProviderWriteStatus(write.id, "reverted", {
        errorCode: "canonical_receipt_reverted",
      });
      await pool.query(
        `UPDATE standard_reputation_outcomes SET state='pending',provider_write_id=NULL,
                next_attempt_at=now(),updated_at=now()
          WHERE order_key=$1 AND provider_write_id=$2`,
        [row.order_key, row.provider_write_id],
      );
      await scheduleFailure(row, config, "contract_rejection");
      return "waiting";
    }
    if (write.status !== "confirmed") {
      await updateProviderWriteStatus(write.id, "confirmed");
    }
    const attestationUid = selectAttestedUid(receipt.logs ?? [], config);
    if (!attestationUid) {
      await parkUnattestedSuccess(row);
      return "waiting";
    }
    let attested: boolean;
    try {
      attested = await verifyCanonicalAttestation(attestationUid, row, config);
    } catch {
      return "waiting";
    }
    if (!attested) {
      await parkUnattestedSuccess(row);
      return "waiting";
    }
    await pool.query(
      `UPDATE standard_reputation_outcomes SET state='final',final_block_number=$3,
              final_block_hash=$4,attestation_uid=$5,next_attempt_at=NULL,updated_at=now()
        WHERE order_key=$1 AND provider_write_id=$2`,
      [
        row.order_key, row.provider_write_id, receipt.blockNumber.toString(), receipt.blockHash,
        Buffer.from(attestationUid.slice(2), "hex"),
      ],
    );
    return "final";
  }
  if (write.status === "attention") {
    const reason = classifyWriteFailure(write.last_error_code);
    const updated = await pool.query(
      `UPDATE standard_reputation_outcomes SET state='operator_attention',next_attempt_at=NULL,
              last_error_class=$3,updated_at=now()
        WHERE order_key=$1 AND provider_write_id=$2`,
      [row.order_key, row.provider_write_id, reason],
    );
    if (updated.rowCount === 1) {
      await surfaceReputationOutcomeReview({ row, reason });
      logWarn("Standard reputation outcome requires provider attention", {
        transactionId: row.transaction_id,
        reason,
      });
    }
    return "waiting";
  }
  if (write.status === "replaced") return "waiting";
  await pool.query(
    `UPDATE standard_reputation_outcomes SET state='pending',provider_write_id=NULL,
            next_attempt_at=now(),updated_at=now()
      WHERE order_key=$1 AND provider_write_id=$2`,
    [row.order_key, row.provider_write_id],
  );
  await scheduleFailure(row, config, classifyWriteFailure(write.last_error_code));
  return "waiting";
}

async function submit(row: OutcomeRow, config: ProviderStandardRailConfig): Promise<void> {
  const orderKey = keyHex(row);
  const data = outcomeAttestationData(row);
  try {
    await prepareAndBroadcastProviderWrite({
      purpose: "standard_reputation_outcome",
      // A fresh proof of the rail contracts, under the signer lease, before signing.
      preflight: () => liveContractIntegrity(config)(),
      target: { type: "standard_reputation_outcome", id: orderKey },
      address: config.easAddress,
      abi: easAbi,
      functionName: "attest",
      callArgs: [{
        schema: config.reputationOutcomeSchemaUid,
        data: {
          recipient: providerAddress,
          expirationTime: 0n,
          revocable: false,
          refUID: `0x${"00".repeat(32)}`,
          data,
          value: 0n,
        },
      }],
      persist: async (prepared, db) => persistBroadcast(row, prepared.id, prepared.hash, db),
    });
  } catch (error) {
    const refreshed = await pool.query<OutcomeRow>(
      "SELECT * FROM standard_reputation_outcomes WHERE order_key=$1",
      [row.order_key],
    );
    if (!refreshed.rows[0]?.provider_write_id) {
      await scheduleFailure(row, config, classifyWriteFailure(error));
    }
  }
}

async function persistBroadcast(
  row: OutcomeRow,
  writeId: string,
  transactionHash: Hex,
  db: Queryable,
): Promise<boolean> {
  const updated = await db.query(
    `UPDATE standard_reputation_outcomes
        SET state='broadcast',provider_write_id=$2,transaction_hash=$3,updated_at=now()
      WHERE order_key=$1 AND state='pending' AND provider_write_id IS NULL`,
    [row.order_key, writeId, transactionHash],
  );
  return updated.rowCount === 1;
}

export function startReputationOutcomeWorker(config: ProviderStandardRailConfig): () => void {
  activeConfig = config;
  setWorkerStatus("standard-reputation-outcome", false);
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await reconcileReputationOutcomeReviews();
      const row = await dueOutcome();
      if (row) {
        if (!row.provider_write_id || await reconcile(row, config) === "retry") {
          await submit(row, config);
        }
      }
      heartbeatWorker("standard-reputation-outcome");
    } finally { running = false; }
  };
  const onFailure = () => failWorker("standard-reputation-outcome");
  const timer = setInterval(() => void run().catch(onFailure), 5_000);
  timer.unref();
  void run().catch(onFailure);
  return () => {
    clearInterval(timer);
    if (activeConfig === config) activeConfig = null;
  };
}

export async function getReputationOutcomeOperationalSummary(): Promise<{
  pending: number;
  attention: number;
  aborted: number;
  exhaustedAttempts: number;
  oldestPendingSeconds: number;
  causes: Record<string, number>;
}> {
  const [summary, causes] = await Promise.all([
    pool.query<{
      pending: number;
      attention: number;
      aborted: number;
      exhausted_attempts: number;
      oldest_pending_seconds: number;
    }>(
      `SELECT count(*) FILTER (WHERE state IN ('pending','broadcast'))::int AS pending,
              count(*) FILTER (WHERE state='operator_attention')::int AS attention,
              count(*) FILTER (WHERE state='aborted_unattested')::int AS aborted,
              count(*) FILTER (WHERE attempt_count>=5)::int AS exhausted_attempts,
              COALESCE(extract(epoch FROM now()-min(created_at) FILTER
                (WHERE state IN ('pending','broadcast'))),0)::int AS oldest_pending_seconds
         FROM standard_reputation_outcomes`,
    ),
    pool.query<{ last_error_class: string; count: number }>(
      `SELECT last_error_class,count(*)::int AS count FROM standard_reputation_outcomes
        WHERE last_error_class IS NOT NULL GROUP BY last_error_class`,
    ),
  ]);
  const row = summary.rows[0]!;
  return {
    pending: row.pending,
    attention: row.attention,
    aborted: row.aborted,
    exhaustedAttempts: row.exhausted_attempts,
    oldestPendingSeconds: row.oldest_pending_seconds,
    causes: Object.fromEntries(causes.rows.map((item) => [item.last_error_class, item.count])),
  };
}

export async function abortReputationOutcome(orderKey: Hex): Promise<void> {
  const result = await pool.query(
    `UPDATE standard_reputation_outcomes SET state='aborted_unattested',next_attempt_at=NULL,updated_at=now()
      WHERE order_key=$1 AND state='operator_attention' AND provider_write_id IS NULL`,
    [Buffer.from(orderKey.slice(2), "hex")],
  );
  if (result.rowCount !== 1) throw new Error("Outcome cannot be aborted before reconciliation");
}

export async function reconcileReputationOutcome(orderKey: Hex): Promise<string> {
  const result = await pool.query<OutcomeRow>(
    "SELECT * FROM standard_reputation_outcomes WHERE order_key=$1",
    [Buffer.from(orderKey.slice(2), "hex")],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Outcome not found");
  if (!row.provider_write_id) return row.state;
  if (!activeConfig) throw new Error("Provider reputation recovery is not running");
  return await reconcile(row, activeConfig);
}

export async function retryReputationOutcomeOnce(orderKey: Hex): Promise<void> {
  const result = await pool.query(
    `UPDATE standard_reputation_outcomes
        SET state='pending',attempt_count=4,retry_once_used=true,next_attempt_at=now(),updated_at=now()
      WHERE order_key=$1 AND state='operator_attention' AND provider_write_id IS NULL
        AND retry_once_used=false`,
    [Buffer.from(orderKey.slice(2), "hex")],
  );
  if (result.rowCount !== 1) throw new Error("Outcome is not eligible for retry-once");
}
