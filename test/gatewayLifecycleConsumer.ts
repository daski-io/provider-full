import { getAddress, recoverMessageAddress, type Hex } from "viem";
import { z } from "zod";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import { assertStrictJsonText } from "../src/core/standardRail/strictJson.js";
import { gatewayOperationsSchema } from "./gatewayConsumer.js";
import type { WireAnswer } from "./providerWireFixture.js";

/*
 * Port of the gateway lifecycle consumer at daski-io/gateway 1548cc0:
 * service.ts performAction/applyLifecycleResult/assertOrderStatusAdditions,
 * lifecycleRefusal.ts, supportRequest.ts, boundedJson.ts and
 * operationsStore.ts observeOperations/nextObservation. A provider answer is
 * judged exactly as the gateway judges it, against the gateway's stored
 * observation of the order, whose original terminal never changes. Not
 * modeled: the listing response-schema check (catalog.validateResponse) is
 * service-specific, and this starter never produces the optional order-status
 * views or a fulfillment-wait section, so the port treats either as a defect.
 */

export interface TerminalEvidence { payload: Record<string, unknown>; signature: string }

/** The gateway's stored observation of one order (standard_order_operations). */
export interface GatewayObservation {
  revision: number;
  observedAt: number;
  /** Hash of the operations without observedAt: the content its revision names. */
  projectionHash: Hex;
  originalTerminal: TerminalEvidence | null;
}

export type GatewayVerdict =
  | { verdict: "accepted"; stored: GatewayObservation }
  | { verdict: "refused"; code: string; status: number; requiresNewSignature?: boolean }
  | { verdict: "rejected"; message: string };

export interface LifecycleExchange {
  action: string;
  request: Record<string, unknown>;
  readCapability: boolean;
  orderId: string;
  providerTaskId: string;
  providerAuthorityKey: Hex;
  terminalAttestationKey: Hex;
  maxResponseBytes: number;
  receivedAt: number;
  stored: GatewayObservation | null;
}

type Operations = z.infer<typeof gatewayOperationsSchema>;
const STATES = ["submitted", "dispatching", "working", "input-required", "completed", "failed", "canceled"];
const TERMINAL = ["completed", "failed", "canceled"];
const REFUSAL_BODY_BYTES = 1_024;
const NAMED_REFUSALS: ReadonlyArray<{ status: number; error: string; code: string; actions?: readonly string[] }> = [
  { status: 409, error: "artifact_unavailable", code: "ARTIFACT_NOT_AVAILABLE", actions: ["artifact"] },
  { status: 409, error: "unsupported_action", code: "ORDER_ACTION_UNSUPPORTED" },
  { status: 409, error: "action_conflict", code: "ORDER_ACTION_CONFLICT" },
  { status: 503, error: "lifecycle_unavailable", code: "PROVIDER_LIFECYCLE_UNAVAILABLE" },
];
const supportResultSchema = z.object({
  supportReceipt: z.object({
    requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    messageId: z.string().uuid(),
    reviewId: z.string().uuid(),
    acceptedAt: z.string().datetime(),
  }).strict(),
}).strict();

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function exactKeys(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  if (Object.keys(value).sort().join() !== [...keys].sort().join()) throw new Error(`${label} fields are invalid`);
}

/** boundedJson.readBoundedJsonResponse over a received answer. */
export function readBoundedAnswer(answer: WireAnswer, maxBytes: number): unknown {
  const mediaType = answer.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  const encoding = answer.contentEncoding?.trim().toLowerCase();
  if (mediaType !== "application/json" || (encoding && encoding !== "identity")) {
    throw new Error("BOUNDED_JSON_MEDIA_TYPE_INVALID");
  }
  if (Buffer.byteLength(answer.text) > maxBytes) throw new Error("BOUNDED_JSON_TOO_LARGE");
  if (answer.text === "") throw new Error("BOUNDED_JSON_EMPTY");
  assertStrictJsonText(answer.text);
  return JSON.parse(answer.text);
}

/** operationsStore.observeOperations: observed at most 300 s before and 30 s after receipt. */
function observeOperations(operations: Operations, now: number): { operations: Operations; projectionHash: Hex } {
  if (operations.observedAt > now + 30 || operations.observedAt < now - 300) {
    throw new Error("provider_operations_observation_stale");
  }
  const { observedAt: _observedAt, ...semantic } = operations;
  return { operations, projectionHash: canonicalHash(semantic) };
}

const terminalIdentity = (evidence: TerminalEvidence) => {
  const { taskId, state, completedAt, resultHash } = evidence.payload;
  return canonicalHash({ taskId, state, completedAt, resultHash });
};

/** operationsStore.nextObservation: the observation the gateway keeps, or a provider defect. */
export function nextObservation(
  stored: GatewayObservation | null,
  observed: { operations: Operations; projectionHash: Hex },
  terminal: TerminalEvidence | null,
): GatewayObservation {
  const { operations, projectionHash } = observed;
  if (stored && operations.revision === stored.revision && projectionHash !== stored.projectionHash) {
    throw new Error("provider_operations_revision_conflict");
  }
  if (stored?.originalTerminal && terminal && terminalIdentity(stored.originalTerminal) !== terminalIdentity(terminal)) {
    throw new Error("provider_original_terminal_changed");
  }
  if (stored && (operations.revision < stored.revision || operations.observedAt < stored.observedAt)) return stored;
  const original = stored?.originalTerminal ?? terminal;
  const recovery = operations.recovery;
  if (recovery && (!original || original.payload.state !== "failed" ||
      recovery.originalTerminal.resultHash !== original.payload.resultHash ||
      recovery.originalTerminal.completedAt !== original.payload.completedAt ||
      (recovery.state === "completed" && (!recovery.completedAt || !recovery.resultHash)))) {
    throw new Error("provider_recovery_terminal_binding_invalid");
  }
  return { revision: operations.revision, observedAt: operations.observedAt, projectionHash, originalTerminal: original };
}

/** lifecycleRefusal.providerLifecycleRefusal: only exact named refusals reach the buyer. */
function refusal(answer: WireAnswer, exchange: LifecycleExchange): GatewayVerdict {
  const candidates = NAMED_REFUSALS.filter((named) =>
    named.status === answer.status && (!named.actions || named.actions.includes(exchange.action)));
  if (candidates.length > 0) {
    try {
      const body = readBoundedAnswer(answer, REFUSAL_BODY_BYTES);
      const named = isObject(body) && Object.keys(body).length === 1
        ? candidates.find((candidate) => body.error === candidate.error) : undefined;
      if (named) {
        return {
          verdict: "refused", code: named.code, status: named.status,
          ...(named.code === "PROVIDER_LIFECYCLE_UNAVAILABLE" ? { requiresNewSignature: !exchange.readCapability } : {}),
        };
      }
    } catch {
      // An unreadable refusal is not evidence of anything.
    }
  }
  return { verdict: "rejected", message: "PROVIDER_LIFECYCLE_REJECTED" };
}

async function signer(digest: Hex, signature: unknown): Promise<string> {
  return getAddress(await recoverMessageAddress({ message: { raw: digest }, signature: signature as Hex }));
}

/** service.applyLifecycleResult up to and including persistOperations. */
async function applyLifecycleResult(result: unknown, exchange: LifecycleExchange): Promise<GatewayObservation> {
  if (!isObject(result)) throw new Error("PROVIDER_LIFECYCLE_RESPONSE_INVALID");
  const response = result;
  const keys = ["orderId", "taskId", "state", "signature", "operations"];
  for (const optional of ["result", "terminalAttestation", "inputRequest", "documents"]) {
    if (optional in response) keys.push(optional);
  }
  exactKeys(response, keys, "provider lifecycle response");
  const operations = gatewayOperationsSchema.parse(response.operations);
  if ("inputRequest" in response || "documents" in response) throw new Error("PROVIDER_LIFECYCLE_UNEXPECTED_CONTENT");
  if (response.orderId !== exchange.orderId || response.taskId !== exchange.providerTaskId ||
      typeof response.signature !== "string" || !STATES.includes(String(response.state))) {
    throw new Error("PROVIDER_LIFECYCLE_BINDING_INVALID");
  }
  const { signature, ...signed } = response;
  if (await signer(canonicalHash(signed), signature) !== getAddress(exchange.providerAuthorityKey)) {
    throw new Error("PROVIDER_LIFECYCLE_SIGNATURE_INVALID");
  }
  const action = exchange.action;
  if ((action === "status" || action === "cancel") && "result" in response) {
    throw new Error("PROVIDER_LIFECYCLE_UNEXPECTED_CONTENT");
  }
  if (action === "artifact" && !("result" in response)) throw new Error("PROVIDER_ARTIFACT_MISSING");
  if (action === "artifact" && isObject(response.result) && "id" in response.result && "status" in response.result &&
      response.result.id !== exchange.providerTaskId) throw new Error("PROVIDER_ARTIFACT_TASK_BINDING_INVALID");
  if (action === "artifact" && response.state !== "completed" && operations.recovery?.state !== "completed") {
    throw new Error("PROVIDER_ARTIFACT_NOT_FULFILLED");
  }
  if (action === "support" &&
      supportResultSchema.parse(response.result).supportReceipt.requestId !== exchange.request.requestId) {
    throw new Error("PROVIDER_SUPPORT_RECEIPT_BINDING_INVALID");
  }
  if (!TERMINAL.includes(String(response.state))) {
    return nextObservation(exchange.stored, observeOperations(operations, exchange.receivedAt), null);
  }
  const attestation = response.terminalAttestation as { payload?: Record<string, unknown>; signature?: unknown } | undefined;
  if (!attestation?.payload || typeof attestation.signature !== "string") {
    throw new Error("PROVIDER_TERMINAL_ATTESTATION_MISSING");
  }
  exactKeys(attestation, ["payload", "signature"], "provider lifecycle attestation");
  const payload = attestation.payload;
  exactKeys(payload, ["orderId", "taskId", "state", "resultHash", "completedAt"], "provider lifecycle attestation payload");
  if (typeof payload.completedAt !== "number" || !Number.isSafeInteger(payload.completedAt) ||
      payload.completedAt <= 0 || payload.completedAt > exchange.receivedAt + 30) {
    throw new Error("PROVIDER_TERMINAL_ATTESTATION_TIME_INVALID");
  }
  if (await signer(canonicalHash(payload), attestation.signature) !== getAddress(exchange.terminalAttestationKey) ||
      payload.orderId !== exchange.orderId || payload.taskId !== exchange.providerTaskId ||
      payload.state !== response.state ||
      (action !== "artifact" && action !== "support" && "result" in response &&
        payload.resultHash !== canonicalHash(response.result))) {
    throw new Error("PROVIDER_TERMINAL_ATTESTATION_INVALID");
  }
  return nextObservation(exchange.stored, observeOperations(operations, exchange.receivedAt),
    { payload, signature: attestation.signature as string });
}

/** The gateway's verdict on one provider lifecycle answer. */
export async function judgeLifecycleAnswer(answer: WireAnswer, exchange: LifecycleExchange): Promise<GatewayVerdict> {
  if (answer.status < 200 || answer.status > 299) return refusal(answer, exchange);
  try {
    const result = readBoundedAnswer(answer, exchange.maxResponseBytes);
    return { verdict: "accepted", stored: await applyLifecycleResult(result, exchange) };
  } catch (error) {
    return { verdict: "rejected", message: error instanceof Error ? error.message : String(error) };
  }
}
