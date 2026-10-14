import {
  getAddress,
  keccak256,
  recoverMessageAddress,
  stringToHex,
  type Hex,
} from "viem";
import { PayerSignatureError, verifyPayerTypedData } from "./payerSignature.js";
import { privateKeyToAccount } from "viem/accounts";
import { pool } from "../db/pool.js";
import { getAdapter } from "../serviceRegistry/registry.js";
import { admittedSupplierCostCeiling } from "../serviceRegistry/supplierCostCeiling.js";
import { getServiceById } from "../db/queries/services.js";
import { processAdapterResult } from "../engine/taskFinalization.js";
import { validateTransition } from "../engine/stateMachine.js";
import { emitEvent } from "../events/emitter.js";
import { fetchStandardTaskResponse } from "../a2a/responseBuilder.js";
import type { TransactionStatus } from "../db/queries/transactions.js";
import { decryptString } from "../chain/encryption.js";
import { getTransactionById } from "../db/queries/transactions.js";
import { enqueueReputationOutcome } from "./reputationOutcomeStore.js";
import {
  assertExactKeys,
  canonicalHash,
  SIGNED_ENVELOPE_KEYS,
  unsignedEnvelopeHash,
} from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import type { SignedEnvelope } from "./types.js";

interface StandardTaskRow {
  id: string;
  service_id: string;
  skill_id: string;
  status: TransactionStatus;
  standard_order_id: string;
  standard_payer: Hex;
  metadata: Record<string, unknown>;
  completed_at: Date | null;
  version: string;
}

interface ActionAuthorization {
  orderId: string;
  action: string;
  method: "POST";
  absoluteResourceUri: string;
  requestHash: Hex;
  nonce: Hex;
  issuedAt: number;
  validBefore: number;
  signature: Hex;
}

interface LifecycleGrantPayload {
  orderId: string;
  providerTaskId: string;
  action: string;
  requestHash: Hex;
  authorizationHash: Hex;
  payer: Hex;
}

export class StandardLifecycleService {
  constructor(private readonly config: ProviderStandardRailConfig, private readonly chainId: number) {}

  async perform(args: {
    orderId: string;
    providerTaskId: string;
    action: string;
    request: Record<string, unknown>;
    authorization: ActionAuthorization;
    grant: SignedEnvelope<LifecycleGrantPayload>;
    payer: Hex;
    gatewayAudience: string;
  }): Promise<unknown> {
    await this.verifyGatewayGrant(args);
    assertExactKeys(args.authorization, [
      "orderId", "action", "method", "absoluteResourceUri", "requestHash",
      "nonce", "issuedAt", "validBefore", "signature",
    ], "lifecycle authorization");
    if (!["status", "artifact", "support", "cancel", "input"].includes(args.action)) {
      throw new Error("Unsupported lifecycle action");
    }
    const task = await this.loadTask(args.orderId, args.providerTaskId);
    if (
      getAddress(task.standard_payer) !== getAddress(args.payer) ||
      args.gatewayAudience !== this.config.gatewayAudience ||
      args.authorization.orderId !== task.standard_order_id ||
      args.authorization.action !== args.action || args.authorization.method !== "POST" ||
      args.authorization.requestHash !== canonicalHash(args.request)
    ) throw new Error("Lifecycle authority does not match the task");
    const actionUri = new URL(args.authorization.absoluteResourceUri);
    if (
      actionUri.origin !== this.config.gatewayOrigin || actionUri.search || actionUri.hash ||
      !actionUri.pathname.endsWith(`/actions/${encodeURIComponent(args.action)}`)
    ) throw new Error("Lifecycle action URI is invalid");
    await this.verifyAuthorization(task, args.action, args.request, args.authorization);
    this.validateActionRequest(args.action, args.request);
    if (args.action === "input") {
      this.assertInputMatchesCommittedRequest(
        task,
        args.request.data as Record<string, unknown>,
      );
    }
    const nonceClient = await pool.connect();
    try {
      await nonceClient.query("BEGIN");
      await nonceClient.query(
        `DELETE FROM standard_action_nonces
          WHERE consumed_at < now() - interval '10 minutes'`,
      );
      const result = await nonceClient.query(
        `INSERT INTO standard_action_nonces (payer,nonce,order_id,action)
         VALUES ($1,$2,$3,$4) ON CONFLICT (payer,nonce) DO NOTHING`,
        [task.standard_payer, Buffer.from(args.authorization.nonce.slice(2), "hex"), task.standard_order_id, args.action],
      );
      if (result.rowCount !== 1) throw new Error("Lifecycle authorization replayed");
      await nonceClient.query("COMMIT");
    } catch (error) {
      await nonceClient.query("ROLLBACK");
      throw error;
    } finally {
      nonceClient.release();
    }

    if (args.action === "support") {
      await emitEvent({
        transactionId: task.id,
        serviceId: task.service_id,
        source: "system",
        type: "transaction.message.user",
        message: String(args.request.message),
        payload: { content: String(args.request.message), channel: "standard-order-support" },
        actor: task.standard_payer,
        mandatory: true,
      });
    }
    if (args.action === "status" || args.action === "artifact" || args.action === "support") {
      const stableResult = await fetchStandardTaskResponse(task);
      if (args.action === "artifact") {
        if (task.status !== "completed") throw new Error("Artifacts are available only after completion");
        const result = await fetchStandardTaskResponse(task, true);
        return this.signedResult({
          orderId: task.standard_order_id,
          taskId: task.id,
          state: task.status,
          result,
        }, task.completed_at, stableResult);
      }
      return this.signedResult({
        orderId: task.standard_order_id,
        taskId: task.id,
        state: task.status,
      }, task.completed_at, stableResult);
    }
    const service = await getServiceById(task.service_id);
    if (!service) throw new Error("Task service is unavailable");
    const adapter = getAdapter(service.adapter_name);
    if (args.action === "cancel") {
      if (!["submitted", "dispatching", "working", "input-required"].includes(task.status)) {
        throw new Error("Task cannot be canceled from its current state");
      }
      const claimed = await this.claimLifecycleMutation(task);
      await adapter.cancel({
        ...claimed,
        supplierMutationStarted: claimed.metadata.supplier_mutation_started === true,
        supplierCostCeiling: admittedSupplierCostCeiling(claimed.metadata),
      });
      const completedAt = new Date();
      await this.persistTaskState(claimed, "canceled", null, completedAt);
      const stableResult = await fetchStandardTaskResponse({ ...claimed, status: "canceled" });
      return this.signedResult(
        { orderId: claimed.standard_order_id, taskId: claimed.id, state: "canceled" },
        completedAt,
        stableResult,
      );
    }
    if (args.action === "input") {
      if (task.status !== "input-required") throw new Error("Task is not awaiting buyer input");
      const inputText = args.request.inputText;
      const data = args.request.data;
      if (typeof inputText !== "string" || !data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("Lifecycle input request is invalid");
      }
      const claimed = await this.claimLifecycleMutation(task);
      const adapterResult = await adapter.handleInput(
        {
          ...claimed,
          supplierMutationStarted: claimed.metadata.supplier_mutation_started === true,
          supplierCostCeiling: admittedSupplierCostCeiling(claimed.metadata),
        },
        inputText,
        data as Record<string, unknown>,
        {
          requestHash: canonicalHash(args.request),
          payer: claimed.standard_payer,
          standardOrderId: claimed.standard_order_id,
        },
      );
      const processed = await processAdapterResult(claimed.id, adapterResult, service.id);
      await this.persistTaskState(
        { ...claimed, status: processed.status, version: processed.version },
        processed.status,
        null,
        processed.completed_at,
      );
      const stableResult = await fetchStandardTaskResponse({ ...claimed, status: processed.status });
      return this.signedResult({
        orderId: claimed.standard_order_id,
        taskId: claimed.id,
        state: processed.status,
        ...(processed.status === "completed" ? { result: stableResult } : {}),
      }, processed.completed_at, stableResult);
    }
    throw new Error("Unsupported lifecycle action");
  }

  private async verifyGatewayGrant(args: {
    orderId: string;
    providerTaskId: string;
    action: string;
    request: Record<string, unknown>;
    authorization: ActionAuthorization;
    grant: SignedEnvelope<LifecycleGrantPayload>;
    payer: Hex;
  }): Promise<void> {
    assertExactKeys(args.grant, SIGNED_ENVELOPE_KEYS, "provider lifecycle grant");
    assertExactKeys(args.grant.payload, [
      "orderId", "providerTaskId", "action", "requestHash", "authorizationHash", "payer",
    ], "provider lifecycle grant payload");
    const now = Math.floor(Date.now() / 1_000);
    const payload = args.grant.payload;
    if (
      args.grant.artifactType !== "ProviderLifecycleGrantV1" || args.grant.schemaVersion !== 1 ||
      args.grant.environment !== this.config.environment || args.grant.chainId !== this.chainId ||
      args.grant.audience !== this.config.providerAudience || args.grant.issuedAt > now + 30 ||
      args.grant.validBefore <= now || args.grant.validBefore > now + 120 ||
      payload.orderId !== args.orderId || payload.providerTaskId !== args.providerTaskId ||
      payload.action !== args.action || payload.requestHash !== canonicalHash(args.request) ||
      payload.authorizationHash !== canonicalHash(args.authorization) ||
      getAddress(payload.payer) !== getAddress(args.payer)
    ) throw new Error("Provider lifecycle grant binding is invalid");
    const signer = await recoverMessageAddress({
      message: { raw: unsignedEnvelopeHash(args.grant as unknown as Record<string, unknown>) },
      signature: args.grant.signature,
    });
    if (getAddress(signer) !== this.config.gatewayLifecycleSigner) {
      throw new Error("Provider lifecycle grant signature is invalid");
    }
  }

  private async signedResult(
    payload: Record<string, unknown>,
    completedAt: Date | null,
    terminalResult: unknown = payload.result ?? null,
  ): Promise<Record<string, unknown>> {
    const state = payload.state;
    let response: Record<string, unknown> = payload;
    if (state === "completed" || state === "failed" || state === "canceled") {
      if (!completedAt) throw new Error("Terminal task completion time is missing");
      const terminalPayload = {
        orderId: payload.orderId,
        taskId: payload.taskId,
        state,
        resultHash: canonicalHash(terminalResult),
        completedAt: Math.floor(completedAt.getTime() / 1_000),
      };
      response = {
        ...payload,
        terminalAttestation: {
          payload: terminalPayload,
          signature: await privateKeyToAccount(this.config.terminalAttestationPrivateKey).signMessage({
            message: { raw: canonicalHash(terminalPayload) },
          }),
        },
      };
    }
    return {
      ...response,
      signature: await privateKeyToAccount(this.config.providerAuthorityPrivateKey).signMessage({
        message: { raw: canonicalHash(response) },
      }),
    };
  }

  private async loadTask(orderId: string, taskId: string): Promise<StandardTaskRow> {
    const result = await pool.query<StandardTaskRow>(
      `SELECT id,service_id,skill_id,status,standard_order_id,standard_payer,metadata,completed_at,version
       FROM transactions WHERE id=$1 AND standard_order_id=$2 AND standard_payer IS NOT NULL`,
      [taskId, orderId],
    );
    if (!result.rows[0]) throw new Error("Standard task not found");
    return result.rows[0];
  }

  /// Fence a supplier-facing lifecycle mutation before the adapter runs:
  /// the version bump invalidates every claim other actors hold from the
  /// pre-claim snapshot, and RETURNING yields the row the adapter must
  /// act on (fresh supplier_mutation_started, not the load-time copy).
  private async claimLifecycleMutation(task: StandardTaskRow): Promise<StandardTaskRow> {
    const result = await pool.query<StandardTaskRow>(
      `UPDATE transactions
          SET version=version+1,updated_at=now()
        WHERE id=$1 AND standard_order_id=$2 AND status=$3 AND version=$4
        RETURNING id,service_id,skill_id,status,standard_order_id,standard_payer,metadata,completed_at,version`,
      [task.id, task.standard_order_id, task.status, task.version],
    );
    if (!result.rows[0]) {
      throw new Error("Task state changed while authorizing the lifecycle action");
    }
    return result.rows[0];
  }

  /// task must be the claimed snapshot the mutation ran against: the
  /// update is conditional on that exact status and version, so a worker
  /// or competing lifecycle call that finalized in between loses nothing —
  /// this write fails instead of overwriting a terminal state.
  private async persistTaskState(
    task: StandardTaskRow,
    state: TransactionStatus,
    metadata: Record<string, unknown> | null,
    completedAt: Date | null,
  ): Promise<void> {
    if (state !== task.status) validateTransition(task.status, state);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE transactions
            SET status=$2,updated_at=now(),version=version+1,
                metadata=metadata || COALESCE($3::jsonb,'{}'::jsonb),
                completed_at=COALESCE(completed_at,$4)
          WHERE id=$1 AND standard_order_id=$5 AND status=$6 AND version=$7`,
        [
          task.id, state, metadata ? JSON.stringify(metadata) : null, completedAt,
          task.standard_order_id, task.status, task.version,
        ],
      );
      if (updated.rowCount !== 1) throw new Error("Standard task state update lost its fence");
      const persisted = await getTransactionById(task.id, client);
      if (!persisted) throw new Error("Standard task disappeared after state update");
      await enqueueReputationOutcome(persisted, client);
      await client.query(
        `UPDATE standard_dispatch_claims SET state=$2,
            resolved_at=CASE WHEN $2 IN ('completed','failed','canceled') THEN now() ELSE resolved_at END
          WHERE order_id=$1 AND transaction_id=$3`,
        [task.standard_order_id, state, task.id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async verifyAuthorization(
    task: StandardTaskRow,
    action: string,
    request: Record<string, unknown>,
    authorization: ActionAuthorization,
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1_000);
    if (authorization.issuedAt > now + 30 || authorization.validBefore <= now || authorization.validBefore > now + 300) {
      throw new Error("Lifecycle authorization expired");
    }
    try {
      await verifyPayerTypedData({
        payer: getAddress(task.standard_payer),
        typedData: {
          domain: { name: "DaskiStandardOrder", version: "1", chainId: this.chainId },
          types: {
            OrderActionAuthorizationV1: [
              { name: "orderIdHash", type: "bytes32" },
              { name: "actionHash", type: "bytes32" },
              { name: "methodHash", type: "bytes32" },
              { name: "absoluteResourceUriHash", type: "bytes32" },
              { name: "requestHash", type: "bytes32" },
              { name: "audienceHash", type: "bytes32" },
              { name: "nonce", type: "bytes32" },
              { name: "issuedAt", type: "uint64" },
              { name: "validBefore", type: "uint64" },
            ],
          },
          primaryType: "OrderActionAuthorizationV1",
          message: {
            orderIdHash: keccak256(stringToHex(task.standard_order_id)),
            actionHash: keccak256(stringToHex(action)),
            methodHash: keccak256(stringToHex(authorization.method)),
            absoluteResourceUriHash: keccak256(stringToHex(authorization.absoluteResourceUri)),
            requestHash: canonicalHash(request),
            audienceHash: keccak256(stringToHex(this.config.gatewayAudience)),
            nonce: authorization.nonce,
            issuedAt: BigInt(authorization.issuedAt),
            validBefore: BigInt(authorization.validBefore),
          },
        },
        signature: authorization.signature,
      });
    } catch (error) {
      if (error instanceof PayerSignatureError && error.retryable) throw error;
      throw new Error("Lifecycle authorization is invalid");
    }
  }

  private validateActionRequest(action: string, request: Record<string, unknown>): void {
    const keys = Object.keys(request).sort();
    if (action === "status" || action === "artifact") {
      if (keys.length !== 0) throw new Error(`${action} request must be empty`);
      return;
    }
    if (action === "support") {
      if (
        keys.join(",") !== "message" || typeof request.message !== "string" ||
        request.message.trim().length === 0 || request.message.length > 4_000
      ) throw new Error("Support request must contain only a non-empty message");
      return;
    }
    if (action === "input") {
      if (
        keys.join(",") !== "data,inputText" || typeof request.inputText !== "string" ||
        request.inputText.length > 4_000 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(request.inputText) ||
        !request.data || typeof request.data !== "object" || Array.isArray(request.data) ||
        Object.keys(request.data).length === 0
      ) throw new Error("Input request has an open or invalid shape");
      return;
    }
    if (keys.some((key) => key !== "reason") ||
        (request.reason !== undefined &&
          (typeof request.reason !== "string" || request.reason.length > 1_000))) {
      throw new Error(`${action} request has an open or invalid shape`);
    }
  }

  private assertInputMatchesCommittedRequest(
    task: StandardTaskRow,
    revealed: Record<string, unknown>,
  ): void {
    const encrypted = task.metadata.standard_request_encrypted;
    if (typeof encrypted !== "string") throw new Error("Committed standard request is unavailable");
    let committed: unknown;
    try {
      committed = JSON.parse(decryptString(encrypted, {
        purpose: "standard-order-request",
        table: "transactions",
        recordId: task.id,
        field: "metadata.standard_request_encrypted",
        recordVersion: 1,
      }));
    } catch {
      throw new Error("Committed standard request cannot be authenticated");
    }
    if (!committed || typeof committed !== "object" || Array.isArray(committed)) {
      throw new Error("Committed standard request is invalid");
    }
    const original = committed as Record<string, unknown>;
    for (const [field, value] of Object.entries(revealed)) {
      if (
        field === "__proto__" || field === "constructor" || field === "prototype" ||
        !Object.prototype.hasOwnProperty.call(original, field) ||
        canonicalHash(original[field]) !== canonicalHash(value)
      ) throw new Error("Lifecycle input changes the payer-committed request");
    }
  }
}
