import { getAddress, recoverMessageAddress, type Address, type Hex } from "viem";
import { assertExactKeys, SIGNED_ENVELOPE_KEYS, unsignedEnvelopeHash } from "./canonical.js";
import type { SignedEnvelope } from "./types.js";

/** The gateway signs every request envelope with this key id. */
export const GATEWAY_DISPATCH_KEY_ID = "gateway-dispatch";
/** Accepted clock skew for an envelope issued "in the future". */
export const GATEWAY_CLOCK_SKEW_SECONDS = 30;

export type GatewayEnvelopeFailure = "shape" | "domain" | "lifetime" | "signature";

export class GatewayEnvelopeError extends Error {
  constructor(readonly failure: GatewayEnvelopeFailure, message: string) {
    super(message);
    this.name = "GatewayEnvelopeError";
  }
}

export interface ExpectedGatewayEnvelope {
  artifactType: string;
  schemaVersion: 1 | 2;
  payloadKeys: readonly string[];
  environment: string;
  chainId: number;
  audience: string;
  signer: Address;
  signerKeyId?: string;
  /**
   * Freshness window, or null to defer lifetime checks to the caller (an
   * exact dispatch replay may be answered after its envelope expired).
   */
  lifetime: { maxRemainingSeconds: number; maxAgeSeconds?: number } | null;
}

/**
 * Verify a gateway-signed request envelope. The exact shape, artifact type
 * and schema version are checked first, then the domain and freshness, and
 * only then the signature, so a payload is trusted only after this returns.
 * Several envelope types share the gateway dispatch key; the artifact type
 * check is what keeps one type from being replayed as another.
 */
export async function verifyGatewayEnvelope<T>(
  value: unknown,
  expected: ExpectedGatewayEnvelope,
  now = Math.floor(Date.now() / 1_000),
): Promise<SignedEnvelope<T, 1 | 2>> {
  const label = expected.artifactType;
  try {
    assertExactKeys(value, SIGNED_ENVELOPE_KEYS, `${label} envelope`);
    assertExactKeys((value as { payload?: unknown }).payload, expected.payloadKeys, `${label} payload`);
  } catch {
    throw new GatewayEnvelopeError("shape", `${label} shape is invalid`);
  }
  const envelope = value as SignedEnvelope<T, 1 | 2>;
  if (envelope.artifactType !== expected.artifactType || envelope.schemaVersion !== expected.schemaVersion) {
    throw new GatewayEnvelopeError("shape", `${label} artifact type or schema version is invalid`);
  }
  if (
    envelope.environment !== expected.environment || envelope.chainId !== expected.chainId ||
    envelope.audience !== expected.audience ||
    envelope.signerKeyId !== (expected.signerKeyId ?? GATEWAY_DISPATCH_KEY_ID)
  ) throw new GatewayEnvelopeError("domain", `${label} domain is invalid`);
  if (
    !Number.isSafeInteger(envelope.issuedAt) || !Number.isSafeInteger(envelope.validBefore) ||
    envelope.validBefore <= envelope.issuedAt ||
    envelope.issuedAt > now + GATEWAY_CLOCK_SKEW_SECONDS ||
    (expected.lifetime !== null && (
      envelope.validBefore <= now ||
      envelope.validBefore > now + expected.lifetime.maxRemainingSeconds ||
      (expected.lifetime.maxAgeSeconds !== undefined &&
        envelope.issuedAt < now - expected.lifetime.maxAgeSeconds)
    ))
  ) throw new GatewayEnvelopeError("lifetime", `${label} lifetime is invalid`);
  let signer: Address;
  try {
    if (typeof envelope.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(envelope.signature)) {
      throw new Error("malformed signature");
    }
    signer = await recoverMessageAddress({
      message: { raw: unsignedEnvelopeHash(envelope as unknown as Record<string, unknown>) },
      signature: envelope.signature as Hex,
    });
  } catch {
    throw new GatewayEnvelopeError("signature", `${label} signature is invalid`);
  }
  if (getAddress(signer) !== getAddress(expected.signer)) {
    throw new GatewayEnvelopeError("signature", `${label} signature is invalid`);
  }
  return envelope;
}
