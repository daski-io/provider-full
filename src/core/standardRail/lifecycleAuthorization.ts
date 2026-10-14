import { getAddress, isAddress, keccak256, stringToHex, type Address, type Hex } from "viem";
import { canonicalHash } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { GatewayEnvelopeError, verifyGatewayEnvelope } from "./gatewayEnvelope.js";
import { lifecycleRejected, unsupportedAction } from "./lifecycleErrors.js";
import { assertLifecycleRequest, isLifecycleAction, READ_ACTIONS, type LifecycleAction } from "./lifecycleRequests.js";
import { isPayerSignatureShape, PayerSignatureError, verifyPayerTypedData } from "./payerSignature.js";

const BODY_KEYS = "action,authorization,gatewayAudience,grant,orderId,payer,providerTaskId,request";
const PAYER_SIGNED_KEYS = "absoluteResourceUri,action,issuedAt,method,nonce,orderId,requestHash,signature,validBefore";
const NONCE = /^0x[0-9a-fA-F]{64}$/;

interface LifecycleGrantPayload {
  orderId: string;
  providerTaskId: string;
  action: string;
  requestHash: Hex;
  authorizationHash: Hex;
  payer: Hex;
}

/** One authenticated lifecycle call: the gateway grant verified, then its authorization. */
export interface LifecycleCall {
  orderId: string;
  providerTaskId: string;
  action: LifecycleAction;
  request: Record<string, unknown>;
  /** The payer the gateway grant attests, checksummed. */
  payer: Address;
  authorization: { form: "read-capability" } | { form: "payer-signed"; nonce: Hex };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const hashOf = (value: unknown): Hex | null => {
  try {
    return canonicalHash(value);
  } catch {
    return null;
  }
};

/**
 * Authenticate a lifecycle POST without reading any state. The gateway's
 * ProviderLifecycleGrantV1 is verified first (artifact type, schema version,
 * domain, the `gateway-lifecycle` key, freshness and its bindings to this
 * exact body); only then is the authorization interpreted. A read capability
 * stub is authority for status and artifact reads alone; a payer-signed
 * authorization is verified against the payer the grant attests, through the
 * bounded verifier, before anything is looked up or consumed.
 */
export async function authenticateLifecycleCall(
  config: ProviderStandardRailConfig,
  chainId: number,
  body: unknown,
  now = Math.floor(Date.now() / 1_000),
): Promise<LifecycleCall> {
  if (!isRecord(body) || Object.keys(body).sort().join() !== BODY_KEYS) throw lifecycleRejected("Lifecycle body shape is invalid");
  const grant = await verifyGatewayEnvelope<LifecycleGrantPayload>(body.grant, {
    artifactType: "ProviderLifecycleGrantV1",
    schemaVersion: 1,
    payloadKeys: ["orderId", "providerTaskId", "action", "requestHash", "authorizationHash", "payer"],
    environment: config.environment,
    chainId,
    audience: config.providerAudience,
    signer: config.gatewayLifecycleSigner,
    signerKeyId: "gateway-lifecycle",
    lifetime: { maxRemainingSeconds: 120, maxAgeSeconds: 120 },
  }, now).catch((error: unknown) => {
    throw lifecycleRejected(error instanceof GatewayEnvelopeError ? error.message : "Lifecycle grant is invalid");
  });
  const payload = grant.payload;
  const request = body.request;
  if (
    !isRecord(request) || typeof body.orderId !== "string" || typeof body.providerTaskId !== "string" ||
    payload.orderId !== body.orderId || payload.providerTaskId !== body.providerTaskId ||
    payload.action !== body.action || payload.requestHash !== hashOf(request) ||
    payload.authorizationHash !== hashOf(body.authorization) ||
    typeof payload.payer !== "string" || !isAddress(payload.payer) ||
    typeof body.payer !== "string" || !isAddress(body.payer) ||
    getAddress(payload.payer) !== getAddress(body.payer) ||
    body.gatewayAudience !== config.gatewayAudience
  ) throw lifecycleRejected("Lifecycle grant does not bind this request");
  if (!isLifecycleAction(body.action)) throw unsupportedAction("Lifecycle action is not offered");
  const action = body.action;
  const payer = getAddress(payload.payer);
  const authorization = body.authorization;
  if (isRecord(authorization) && authorization.type === "DaskiReadCap") {
    if (Object.keys(authorization).sort().join() !== "scope,type" || authorization.scope !== action ||
        !READ_ACTIONS.has(action)) {
      throw lifecycleRejected("A read capability authorizes only its own status or artifact read");
    }
    assertLifecycleRequest(action, request);
    return { orderId: body.orderId, providerTaskId: body.providerTaskId, action, request, payer,
      authorization: { form: "read-capability" } };
  }
  if (!isRecord(authorization) || Object.keys(authorization).sort().join() !== PAYER_SIGNED_KEYS) {
    throw lifecycleRejected("Lifecycle authorization shape is invalid");
  }
  const signed = authorization as Record<string, unknown> & { nonce: Hex; signature: Hex };
  let uri: URL | null = null;
  try {
    uri = new URL(String(signed.absoluteResourceUri));
  } catch {
    uri = null;
  }
  if (
    signed.orderId !== body.orderId || signed.action !== action || signed.method !== "POST" ||
    signed.requestHash !== payload.requestHash || typeof signed.nonce !== "string" || !NONCE.test(signed.nonce) ||
    !Number.isSafeInteger(signed.issuedAt) || !Number.isSafeInteger(signed.validBefore) ||
    (signed.issuedAt as number) > now + 30 || (signed.validBefore as number) <= now ||
    (signed.validBefore as number) > now + 300 || !isPayerSignatureShape(signed.signature) ||
    !uri || uri.origin !== config.gatewayOrigin || uri.search || uri.hash ||
    !uri.pathname.endsWith(`/actions/${encodeURIComponent(action)}`)
  ) throw lifecycleRejected("Lifecycle authorization binding is invalid");
  assertLifecycleRequest(action, request);
  try {
    await verifyPayerTypedData({
      payer,
      typedData: {
        domain: { name: "DaskiStandardOrder", version: "1", chainId },
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
          orderIdHash: keccak256(stringToHex(body.orderId)),
          actionHash: keccak256(stringToHex(action)),
          methodHash: keccak256(stringToHex("POST")),
          absoluteResourceUriHash: keccak256(stringToHex(String(signed.absoluteResourceUri))),
          requestHash: payload.requestHash,
          audienceHash: keccak256(stringToHex(config.gatewayAudience)),
          nonce: signed.nonce,
          issuedAt: BigInt(signed.issuedAt as number),
          validBefore: BigInt(signed.validBefore as number),
        },
      },
      signature: signed.signature,
    });
  } catch (error) {
    // A verification outage stays retryable; anything else is a wrong signature.
    if (error instanceof PayerSignatureError && error.retryable) throw error;
    throw lifecycleRejected("Lifecycle authorization signature is invalid");
  }
  return { orderId: body.orderId, providerTaskId: body.providerTaskId, action, request, payer,
    authorization: { form: "payer-signed", nonce: signed.nonce } };
}
