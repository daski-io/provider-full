import { keccak256, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import { signGatewayEnvelope } from "./gatewayConsumer.js";
import { context, keys, order } from "./providerWireFixture.js";

/*
 * Lifecycle POSTs built the way the gateway builds them (service.ts
 * performAction): a read-capability stub or the payer's nine-field
 * OrderActionAuthorizationV1, bound by a ProviderLifecycleGrantV1 signed by
 * the gateway-lifecycle key. Defaults are the provider-wire fixture order.
 */
export interface LifecycleRequestOptions {
  action: string;
  request?: Record<string, unknown>;
  form?: "read-capability" | "payer-signed";
  now: number;
  orderId?: string;
  taskId?: string;
  payerKey?: Hex;
  grantKey?: Hex;
  nonce?: Hex;
  authorization?: unknown;
  /** The payer EIP-712 signature, when it is not an EOA signature. */
  signature?: Hex;
}

export async function payerAuthorization(options: LifecycleRequestOptions) {
  const orderId = options.orderId ?? order.orderId;
  const request = options.request ?? {};
  const authorization = {
    orderId,
    action: options.action,
    method: "POST" as const,
    absoluteResourceUri: `${context.gateway.publicUrl}/orders/${context.order.orderHandle}/actions/${options.action}`,
    requestHash: canonicalHash(request),
    nonce: options.nonce ?? (`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}` as Hex),
    issuedAt: options.now - 5,
    validBefore: options.now + 295,
  };
  const signature = options.signature ?? await privateKeyToAccount(options.payerKey ?? keys.payer!.privateKey).signTypedData({
    domain: { name: "DaskiStandardOrder", version: "1", chainId: context.chainId },
    types: {
      OrderActionAuthorizationV1: [
        { name: "orderIdHash", type: "bytes32" }, { name: "actionHash", type: "bytes32" },
        { name: "methodHash", type: "bytes32" }, { name: "absoluteResourceUriHash", type: "bytes32" },
        { name: "requestHash", type: "bytes32" }, { name: "audienceHash", type: "bytes32" },
        { name: "nonce", type: "bytes32" }, { name: "issuedAt", type: "uint64" }, { name: "validBefore", type: "uint64" },
      ],
    },
    primaryType: "OrderActionAuthorizationV1",
    message: {
      orderIdHash: keccak256(stringToHex(orderId)),
      actionHash: keccak256(stringToHex(options.action)),
      methodHash: keccak256(stringToHex("POST")),
      absoluteResourceUriHash: keccak256(stringToHex(authorization.absoluteResourceUri)),
      requestHash: authorization.requestHash,
      audienceHash: keccak256(stringToHex(context.gateway.audience)),
      nonce: authorization.nonce,
      issuedAt: BigInt(authorization.issuedAt),
      validBefore: BigInt(authorization.validBefore),
    },
  });
  return { ...authorization, signature };
}

export async function lifecycleBody(options: LifecycleRequestOptions) {
  const request = options.request ?? {};
  const authorization = options.authorization ?? (options.form === "payer-signed"
    ? await payerAuthorization(options)
    : { type: "DaskiReadCap", scope: options.action });
  const grant = await signGatewayEnvelope({
    artifactType: "ProviderLifecycleGrantV1", environment: context.environment, chainId: context.chainId,
    audience: context.provider.audience, signerKeyId: "gateway-lifecycle",
    privateKey: options.grantKey ?? keys.gatewayLifecycle!.privateKey, issuedAt: options.now, validBefore: options.now + 120,
    payload: {
      orderId: options.orderId ?? order.orderId,
      providerTaskId: options.taskId ?? order.providerTaskId,
      action: options.action,
      requestHash: canonicalHash(request),
      authorizationHash: canonicalHash(authorization),
      payer: order.payer,
    },
  });
  return {
    orderId: options.orderId ?? order.orderId, providerTaskId: options.taskId ?? order.providerTaskId,
    action: options.action, request, authorization, grant, payer: order.payer, gatewayAudience: context.gateway.audience,
  };
}

export const LIFECYCLE_HTTP = {
  url: context.provider.controlProfile.lifecycleUrl,
  headers: { "content-type": "application/json", "daski-order-status-view": "1" },
};
