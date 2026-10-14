import { getAddress, recoverMessageAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import { assertStrictJsonText } from "../src/core/standardRail/strictJson.js";
import type { SignedEnvelope } from "../src/core/standardRail/types.js";

/*
 * Minimal port of the gateway consumer checks at daski-io/gateway 8f15201
 * (src/standardRail/service.ts resolveGrossAmount, intake.ts, boundedJson.ts,
 * signing.ts). Tests construct envelopes and judge provider answers exactly
 * as the gateway does; the gateway itself is never imported or called.
 */

export const FIXED_READINESS_QUOTE_MAX_SECONDS = 300;

export async function signGatewayEnvelope<T>(args: {
  artifactType: string;
  schemaVersion?: 1 | 2;
  environment: string;
  chainId: number;
  audience: string;
  signerKeyId: string;
  privateKey: Hex;
  issuedAt: number;
  validBefore: number;
  payload: T;
}): Promise<SignedEnvelope<T, 1 | 2>> {
  const unsigned = {
    artifactType: args.artifactType,
    schemaVersion: args.schemaVersion ?? 1,
    environment: args.environment,
    chainId: args.chainId,
    audience: args.audience,
    signerKeyId: args.signerKeyId,
    issuedAt: args.issuedAt,
    validBefore: args.validBefore,
    payload: args.payload,
  };
  const signature = await privateKeyToAccount(args.privateKey).signMessage({
    message: { raw: canonicalHash(unsigned) },
  });
  return { ...unsigned, signature } as SignedEnvelope<T, 1 | 2>;
}

/** boundedJson.readBoundedJsonResponse: media type, encoding, duplicates. */
export async function readGatewayJson(response: Response): Promise<unknown> {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  if (mediaType !== "application/json" || (encoding && encoding !== "identity")) {
    throw new Error("BOUNDED_JSON_MEDIA_TYPE_INVALID");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(await response.arrayBuffer());
  assertStrictJsonText(text);
  return JSON.parse(text);
}

function exactKeys(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join() !== [...keys].sort().join()) {
    throw new Error("PROVIDER_QUOTE_UNAVAILABLE");
  }
}

export interface QuoteExpectation {
  outcomeId: string;
  listingManifestHash: Hex;
  requestHash: Hex;
  payer: Hex | null;
  fixed: boolean;
  fixedGrossAmount: string;
  providerAuthorityKey: Hex;
  minimumPaymentWindowSeconds: number;
  maximumLifetimeSeconds: number | null;
  commissionBps: number;
  receivedAt: number;
}

/** service.ts resolveGrossAmount success path: exact keys, time bounds, signer. */
export async function acceptProviderQuote(value: unknown, expected: QuoteExpectation): Promise<{
  grossAmount: string;
  providerQuoteHash: Hex;
  issuedAt: number;
  validBefore: number;
}> {
  exactKeys(value, [
    "outcomeId", "listingManifestHash", "requestHash", "grossAmount", "payer", "issuedAt",
    "validBefore", "signature",
  ]);
  const quote = value;
  if (
    quote.outcomeId !== expected.outcomeId || quote.payer !== expected.payer ||
    quote.listingManifestHash !== expected.listingManifestHash ||
    quote.requestHash !== expected.requestHash || typeof quote.grossAmount !== "string" ||
    !/^[1-9][0-9]*$/.test(quote.grossAmount) || typeof quote.issuedAt !== "number" ||
    !Number.isSafeInteger(quote.issuedAt) || typeof quote.validBefore !== "number" ||
    !Number.isSafeInteger(quote.validBefore) || typeof quote.signature !== "string"
  ) throw new Error("PROVIDER_QUOTE_UNAVAILABLE");
  const receivedAt = expected.receivedAt;
  if (
    quote.issuedAt > receivedAt + 30 || quote.issuedAt < receivedAt - 30 ||
    quote.validBefore <= receivedAt + expected.minimumPaymentWindowSeconds ||
    (!expected.fixed && expected.maximumLifetimeSeconds === null) ||
    quote.validBefore > quote.issuedAt +
      (expected.fixed ? FIXED_READINESS_QUOTE_MAX_SECONDS : expected.maximumLifetimeSeconds!)
  ) throw new Error("PROVIDER_QUOTE_UNAVAILABLE");
  const bps = BigInt(expected.commissionBps);
  if (BigInt(quote.grossAmount) < (10_000n + bps - 1n) / bps) throw new Error("PROVIDER_QUOTE_UNAVAILABLE");
  const providerQuoteHash = canonicalHash({
    outcomeId: quote.outcomeId,
    listingManifestHash: quote.listingManifestHash,
    requestHash: quote.requestHash,
    grossAmount: quote.grossAmount,
    payer: quote.payer,
    issuedAt: quote.issuedAt,
    validBefore: quote.validBefore,
  });
  const signer = await recoverMessageAddress({
    message: { raw: providerQuoteHash },
    signature: quote.signature as Hex,
  });
  if (getAddress(signer) !== getAddress(expected.providerAuthorityKey)) {
    throw new Error("PROVIDER_QUOTE_UNAVAILABLE");
  }
  if (expected.fixed && quote.grossAmount !== expected.fixedGrossAmount) {
    throw new Error("PROVIDER_QUOTE_UNAVAILABLE");
  }
  return {
    grossAmount: quote.grossAmount,
    providerQuoteHash,
    issuedAt: quote.issuedAt,
    validBefore: quote.validBefore,
  };
}

/** service.ts 4xx branch: the structured field errors the gateway keeps. */
export function gatewayQuoteFieldErrors(body: unknown): Array<{
  path: string; rule: string; message: string; allowedValues?: readonly string[];
}> | undefined {
  const rejection = body as { fieldErrors?: unknown } | null;
  if (!rejection || !Array.isArray(rejection.fieldErrors)) return undefined;
  return rejection.fieldErrors.slice(0, 32).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const value = item as Record<string, unknown>;
    if (typeof value.path !== "string" || typeof value.rule !== "string" ||
        typeof value.message !== "string") return [];
    const allowedValues = Array.isArray(value.allowedValues) &&
      value.allowedValues.every((entry) => typeof entry === "string")
      ? value.allowedValues as string[] : undefined;
    return [{ path: value.path, rule: value.rule, message: value.message, ...(allowedValues ? { allowedValues } : {}) }];
  });
}

/** intake.ts getIntakeRequirements response validation. */
export async function acceptIntakeResponse(value: unknown, expected: {
  outcomeId: string;
  listingManifestHash: Hex;
  requestHash: Hex;
  requestSchema: unknown;
  providerAuthorityKey: Hex;
  now: number;
}): Promise<Record<string, unknown>> {
  const keys = ["outcomeId", "listingManifestHash", "requestHash", "requestSchema", "requiredFields",
    "selectorsRequired", "normalizedSelectors", "fieldErrors", "supported", "issuedAt", "validBefore", "signature"];
  exactKeys(value, keys);
  const result = value;
  const now = expected.now;
  if (
    result.outcomeId !== expected.outcomeId || result.listingManifestHash !== expected.listingManifestHash ||
    result.requestHash !== expected.requestHash || typeof result.signature !== "string" ||
    !Number.isSafeInteger(result.issuedAt) || Number(result.issuedAt) > now + 30 ||
    Number(result.issuedAt) < now - 120 || !Number.isSafeInteger(result.validBefore) ||
    Number(result.validBefore) <= now || Number(result.validBefore) > now + 120 ||
    !Array.isArray(result.selectorsRequired) ||
    !result.selectorsRequired.every((entry) => typeof entry === "string") ||
    !Array.isArray(result.fieldErrors) || result.fieldErrors.length > 32 ||
    !result.fieldErrors.every((entry) => entry && typeof entry === "object" &&
      ["path", "rule", "message"].every((key) => typeof (entry as Record<string, unknown>)[key] === "string")) ||
    ![true, false, null].includes(result.supported as boolean | null)
  ) throw new Error("Intake binding is invalid");
  for (const key of ["requestSchema", "requiredFields", "normalizedSelectors"]) {
    if (!result[key] || typeof result[key] !== "object" || Array.isArray(result[key])) {
      throw new Error("Invalid intake contract");
    }
  }
  if (canonicalHash(result.requestSchema) !== canonicalHash(expected.requestSchema)) {
    throw new Error("Intake schema mismatch");
  }
  const { signature, ...payload } = result;
  const signer = await recoverMessageAddress({ message: { raw: canonicalHash(payload) }, signature: signature as Hex });
  if (getAddress(signer) !== getAddress(expected.providerAuthorityKey)) throw new Error("Invalid intake signer");
  return payload;
}

/*
 * providerDispatch.ts validateDispatchResponse + terminalEvidence,
 * operationsSchema.ts and operationsStore.ts persistOperations rules. The
 * gateway-defined fulfillment-wait section is only ever null from this
 * starter, so the port models it as null.
 */
const time = z.number().int().nonnegative();
const id = z.string().min(1).max(128);
const resultHashPattern = z.string().regex(/^0x[0-9a-f]{64}$/);
export const gatewayOperationsSchema = z.object({
  schemaVersion: z.literal(1), revision: time, observedAt: time,
  fulfillment: z.null(),
  support: z.object({
    reviewId: id, status: z.enum(["open", "closed"]),
    lastAcceptedRequest: z.object({ requestId: id, messageId: id, acceptedAt: time }).strict(),
    lastReply: z.object({ messageId: id, repliedAt: time, message: z.string().min(1).max(4_000) }).strict().optional(),
  }).strict().nullable(),
  recovery: z.object({
    recoveryId: id, reviewId: id,
    state: z.enum(["queued", "pending", "running", "attention", "completed", "stopped"]),
    originalTerminal: z.object({ state: z.literal("failed"), completedAt: time, resultHash: resultHashPattern }).strict(),
    startedAt: time.nullable(), completedAt: time.nullable(), resultHash: resultHashPattern.nullable(),
  }).strict().nullable(),
}).strict();

const DISPATCH_STATES = ["dispatching", "submitted", "working", "input-required", "completed", "failed", "canceled"];

export interface AcceptedDispatchResponse {
  body: Record<string, unknown> & { taskId: string; state: string };
  responseHash: Hex;
  terminal: boolean;
  operations: z.infer<typeof gatewayOperationsSchema>;
  evidence: { payload: Record<string, unknown>; signature: string } | null;
}

export async function acceptDispatchResponse(value: unknown, expected: {
  dispatchHash: Hex;
  providerAuthorityKey: Hex;
  terminalAttestationKey: Hex;
  now: number;
}): Promise<AcceptedDispatchResponse> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("provider_dispatch_response_malformed");
  const body = value as Record<string, unknown> & { taskId: string; state: string };
  const terminal = ["completed", "failed", "canceled"].includes(String(body.state));
  const keys = terminal
    ? ["taskId", "dispatchHash", "signature", "state", "operations", "terminalAttestation"]
    : ["taskId", "dispatchHash", "signature", "state", "operations"];
  if (Object.keys(body).sort().join() !== keys.sort().join()) throw new Error("provider dispatch response fields are invalid");
  if (
    typeof body.taskId !== "string" || body.taskId.length === 0 || body.taskId.length > 128 ||
    body.dispatchHash !== expected.dispatchHash || typeof body.signature !== "string" ||
    !DISPATCH_STATES.includes(String(body.state))
  ) throw new Error("provider_dispatch_response_malformed");
  const operations = gatewayOperationsSchema.parse(body.operations);
  const responseHash = canonicalHash({ taskId: body.taskId, dispatchHash: expected.dispatchHash, state: body.state, operations });
  const signer = await recoverMessageAddress({ message: { raw: responseHash }, signature: body.signature as Hex });
  if (getAddress(signer) !== getAddress(expected.providerAuthorityKey)) {
    throw new Error("provider_dispatch_response_signature_invalid");
  }
  if (operations.observedAt > expected.now + 30 || operations.observedAt < expected.now - 300) {
    throw new Error("provider_operations_observation_stale");
  }
  let evidence: AcceptedDispatchResponse["evidence"] = null;
  if (terminal) {
    const attestation = body.terminalAttestation as { payload?: Record<string, unknown>; signature?: unknown } | undefined;
    if (!attestation?.payload || typeof attestation.signature !== "string") throw new Error("provider_terminal_attestation_missing");
    if (Object.keys(attestation).sort().join() !== "payload,signature" ||
        Object.keys(attestation.payload).sort().join() !== "completedAt,dispatchHash,resultHash,state,taskId") {
      throw new Error("provider terminal attestation fields are invalid");
    }
    const completedAt = attestation.payload.completedAt;
    if (typeof completedAt !== "number" || !Number.isSafeInteger(completedAt) || completedAt <= 0 ||
        completedAt > expected.now + 30 || typeof attestation.payload.resultHash !== "string" ||
        !/^0x[0-9a-fA-F]{64}$/.test(attestation.payload.resultHash)) {
      throw new Error("provider_terminal_attestation_time_invalid");
    }
    const terminalSigner = await recoverMessageAddress({
      message: { raw: canonicalHash(attestation.payload) }, signature: attestation.signature as Hex,
    });
    if (getAddress(terminalSigner) !== getAddress(expected.terminalAttestationKey) ||
        attestation.payload.taskId !== body.taskId || attestation.payload.dispatchHash !== expected.dispatchHash ||
        attestation.payload.state !== body.state) {
      throw new Error("provider_terminal_attestation_invalid");
    }
    evidence = { payload: attestation.payload, signature: attestation.signature };
  }
  return { body, responseHash, terminal, operations, evidence };
}

/** persistOperations: one revision names one projection; older reads are ignored. */
export function gatewayOperationsDecision(
  stored: { revision: number; observedAt: number; projectionHash: Hex } | null,
  next: z.infer<typeof gatewayOperationsSchema>,
): "store" | "ignore" | "conflict" {
  const { observedAt: _observedAt, ...semantic } = next;
  const projectionHash = canonicalHash(semantic);
  if (stored && next.revision === stored.revision && projectionHash !== stored.projectionHash) return "conflict";
  if (stored && (next.revision < stored.revision || next.observedAt < stored.observedAt)) return "ignore";
  return "store";
}

export function semanticOperationsHash(operations: z.infer<typeof gatewayOperationsSchema>): Hex {
  const { observedAt: _observedAt, ...semantic } = operations;
  return canonicalHash(semantic);
}

/**
 * providerDispatch.ts dispatch(): a 4xx/5xx JSON body with a non-null `error`
 * is a definite refusal (the gateway deletes its claim and later sends a new
 * envelope); anything else that is not ok is ambiguous and is reconciled by
 * status with the original hash.
 */
export async function classifyDispatchAnswer(response: Response): Promise<"accepted" | "refused" | "ambiguous"> {
  let body: unknown;
  try {
    body = await readGatewayJson(response);
  } catch {
    return "ambiguous";
  }
  if (response.ok) return "accepted";
  if (response.status >= 400 && response.status < 600 && body && typeof body === "object" &&
      !Array.isArray(body) && "error" in body && (body as { error: unknown }).error != null) {
    return "refused";
  }
  return "ambiguous";
}

/**
 * providerDispatch.ts queryProviderDispatchStatus(): only a 404 whose JSON has
 * a non-null `error` and `reason: "outcome_policy"` proves the provider holds
 * no claim; every other failure leaves the dispatch unknown.
 */
export async function classifyStatusAnswer(response: Response): Promise<"snapshot" | "no_claim" | "unknown"> {
  if (response.ok) return "snapshot";
  if (response.status !== 404) return "unknown";
  const body = await readGatewayJson(response).catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) && "error" in body &&
    (body as { error: unknown }).error != null && (body as { reason?: unknown }).reason === "outcome_policy"
    ? "no_claim" : "unknown";
}
