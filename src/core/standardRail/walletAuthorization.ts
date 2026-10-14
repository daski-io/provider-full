import {
  encodeAbiParameters,
  getAddress,
  hashTypedData,
  keccak256,
  recoverMessageAddress,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { assertExactKeys, canonicalHash, SIGNED_ENVELOPE_KEYS, unsignedEnvelopeHash } from "./canonical.js";
import {
  isPayerSignatureShape,
  PayerSignatureError,
  verifyPayerTypedData,
  type PayerSignatureVerifierOptions,
} from "./payerSignature.js";
import type { ProviderWalletActionGrantV1, SignedEnvelope, WalletActionAuthorizationV1 } from "./types.js";

export const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;

export const WALLET_ACTION_FIELDS = [
  "payer", "providerAgentId", "serviceId", "providerControlProfileHash",
  "servicingAdmissionHash", "actionCatalogHash", "actionCatalogSchemaHash",
  "actionDefinitionHash", "actionCatalogEpoch", "actionHash", "methodHash",
  "absoluteResourceUriHash", "requestHash", "audienceHash", "nonce", "issuedAt",
  "validBefore",
] as const;

const walletActionTypes = {
  WalletActionAuthorizationV1: [
    { name: "payer", type: "address" },
    { name: "providerAgentId", type: "uint256" },
    { name: "serviceId", type: "bytes32" },
    { name: "providerControlProfileHash", type: "bytes32" },
    { name: "servicingAdmissionHash", type: "bytes32" },
    { name: "actionCatalogHash", type: "bytes32" },
    { name: "actionCatalogSchemaHash", type: "bytes32" },
    { name: "actionDefinitionHash", type: "bytes32" },
    { name: "actionCatalogEpoch", type: "uint64" },
    { name: "actionHash", type: "bytes32" },
    { name: "methodHash", type: "bytes32" },
    { name: "absoluteResourceUriHash", type: "bytes32" },
    { name: "requestHash", type: "bytes32" },
    { name: "audienceHash", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "validBefore", type: "uint64" },
  ],
} as const;

export interface WalletAuthorizationTransport {
  message: WalletActionAuthorizationV1;
  signature: Hex;
}

export const utf8Hash = (value: string): Hex => keccak256(stringToHex(value));

function typedWalletMessage(message: WalletActionAuthorizationV1) {
  return {
    ...message,
    providerAgentId: BigInt(message.providerAgentId),
    actionCatalogEpoch: BigInt(message.actionCatalogEpoch),
    issuedAt: BigInt(message.issuedAt),
    validBefore: BigInt(message.validBefore),
  };
}

export function walletAuthorizationHash(message: WalletActionAuthorizationV1, chainId: number): Hex {
  return hashTypedData({
    domain: { name: "DaskiStandardWallet", version: "1", chainId },
    primaryType: "WalletActionAuthorizationV1",
    types: walletActionTypes,
    message: typedWalletMessage(message),
  });
}

export async function verifyWalletAuthorization(args: {
  authorization: WalletAuthorizationTransport;
  chainId: number;
  expectedPayer: Address;
  expectedRequestHash?: Hex;
  expectedActionHash: Hex;
  expectedAudienceHash: Hex;
  now?: number;
  /** Test seam for the payer-signature policy and its RPC endpoints. */
  payerSignature?: Partial<PayerSignatureVerifierOptions>;
}): Promise<Hex> {
  assertExactKeys(args.authorization, ["message", "signature"], "wallet authorization");
  assertExactKeys(args.authorization.message, WALLET_ACTION_FIELDS, "wallet authorization message");
  const message = args.authorization.message;
  const now = args.now ?? Math.floor(Date.now() / 1_000);
  const hashes = [
    message.serviceId, message.providerControlProfileHash, message.servicingAdmissionHash,
    message.actionCatalogHash, message.actionCatalogSchemaHash, message.actionDefinitionHash,
    message.actionHash, message.methodHash, message.absoluteResourceUriHash, message.requestHash,
    message.audienceHash, message.nonce,
  ];
  if (
    !/^0x[0-9a-f]{40}$/.test(message.payer) || !/^(0|[1-9]\d*)$/.test(message.providerAgentId) ||
    hashes.some((value) => !/^0x[0-9a-f]{64}$/.test(value)) ||
    !Number.isSafeInteger(message.actionCatalogEpoch) || message.actionCatalogEpoch < 0 ||
    !Number.isSafeInteger(message.issuedAt) || !Number.isSafeInteger(message.validBefore) ||
    !isPayerSignatureShape(args.authorization.signature) ||
    getAddress(message.payer) !== getAddress(args.expectedPayer) ||
    (args.expectedRequestHash !== undefined && message.requestHash !== args.expectedRequestHash) ||
    message.actionHash !== args.expectedActionHash ||
    message.audienceHash !== args.expectedAudienceHash ||
    message.issuedAt > now + 30 || message.validBefore <= now ||
    message.validBefore - message.issuedAt > 300 || message.issuedAt >= message.validBefore
  ) throw new Error("wallet authorization denied");
  // Verified with no database lock or connection held; callers consume the
  // wallet nonce in their own atomic claim afterwards. An EOA recovers
  // offline (recoverTypedDataAddress); a configured contract account answers
  // one bounded isValidSignature read, whose transport failure stays
  // retryable instead of looking like a wrong signature.
  try {
    await verifyPayerTypedData({
      payer: getAddress(message.payer),
      typedData: {
        domain: { name: "DaskiStandardWallet", version: "1", chainId: args.chainId },
        primaryType: "WalletActionAuthorizationV1",
        types: walletActionTypes,
        message: typedWalletMessage(message),
      },
      signature: args.authorization.signature,
    }, args.payerSignature);
  } catch (error) {
    if (error instanceof PayerSignatureError && error.retryable) throw error;
    throw new Error("wallet authorization denied");
  }
  return walletAuthorizationHash(message, args.chainId);
}

export async function verifyProviderGrant(args: {
  envelope: SignedEnvelope<ProviderWalletActionGrantV1>;
  environment: string;
  chainId: number;
  providerAudience: string;
  gatewayLifecycleSigner: Address;
  now?: number;
}): Promise<Hex> {
  assertExactKeys(args.envelope, SIGNED_ENVELOPE_KEYS, "provider wallet grant envelope");
  assertExactKeys(args.envelope.payload, [
    "payer", "providerAgentId", "serviceId", "actionHash", "methodHash",
    "absoluteResourceUriHash", "requestHash", "walletAuthorizationHash",
    "providerControlProfileHash", "servicingAdmissionHash", "servicingProfileEpoch",
    "actionCatalogHash", "actionCatalogSchemaHash", "actionCatalogEpoch",
    "actionDefinitionHash", "gatewayAudienceHash", "providerAudienceHash", "grantNonce",
  ], "provider wallet grant payload");
  const now = args.now ?? Math.floor(Date.now() / 1_000);
  const envelope = args.envelope;
  const payload = envelope.payload;
  const hashes = [
    payload.serviceId, payload.actionHash, payload.methodHash, payload.absoluteResourceUriHash,
    payload.requestHash, payload.walletAuthorizationHash, payload.providerControlProfileHash,
    payload.servicingAdmissionHash, payload.actionCatalogHash, payload.actionCatalogSchemaHash,
    payload.actionDefinitionHash, payload.gatewayAudienceHash, payload.providerAudienceHash,
    payload.grantNonce,
  ];
  if (
    !/^0x[0-9a-f]{40}$/.test(payload.payer) || !/^[1-9]\d*$/.test(payload.providerAgentId) ||
    hashes.some((value) => !/^0x[0-9a-f]{64}$/.test(value)) ||
    !Number.isSafeInteger(payload.servicingProfileEpoch) || payload.servicingProfileEpoch < 1 ||
    !Number.isSafeInteger(payload.actionCatalogEpoch) || payload.actionCatalogEpoch < 0 ||
    envelope.artifactType !== "ProviderWalletActionGrantV1" || envelope.schemaVersion !== 1 ||
    envelope.environment !== args.environment || envelope.chainId !== args.chainId ||
    envelope.audience !== args.providerAudience || envelope.issuedAt > now + 30 ||
    envelope.validBefore <= now || envelope.validBefore - envelope.issuedAt > 300
  ) throw new Error("provider wallet grant denied");
  const digest = unsignedEnvelopeHash(envelope as unknown as Record<string, unknown>);
  const recovered = await recoverMessageAddress({ message: { raw: digest }, signature: envelope.signature });
  if (getAddress(recovered) !== getAddress(args.gatewayLifecycleSigner)) {
    throw new Error("provider wallet grant denied");
  }
  return digest;
}

export function deriveActionExecutionId(input: {
  walletAuthorizationHash: Hex;
  providerAgentId: bigint;
  serviceId: Hex;
  providerControlProfileHash: Hex;
  servicingAdmissionHash: Hex;
  actionCatalogHash: Hex;
  actionCatalogSchemaHash: Hex;
  actionCatalogEpoch: bigint;
  actionDefinitionHash: Hex;
  requestHash: Hex;
}): Hex {
  const typeHash = utf8Hash(
    "ActionExecutionV1(bytes32 walletAuthorizationHash,uint256 providerAgentId,bytes32 serviceId,bytes32 providerControlProfileHash,bytes32 servicingAdmissionHash,bytes32 actionCatalogHash,bytes32 actionCatalogSchemaHash,uint64 actionCatalogEpoch,bytes32 actionDefinitionHash,bytes32 requestHash)",
  );
  return keccak256(encodeAbiParameters([
    { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "bytes32" },
    { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
    { type: "uint64" }, { type: "bytes32" }, { type: "bytes32" },
  ], [
    typeHash, input.walletAuthorizationHash, input.providerAgentId, input.serviceId,
    input.providerControlProfileHash, input.servicingAdmissionHash, input.actionCatalogHash,
    input.actionCatalogSchemaHash, input.actionCatalogEpoch, input.actionDefinitionHash,
    input.requestHash,
  ]));
}

export const requestHash = (request: unknown): Hex => canonicalHash(request);
