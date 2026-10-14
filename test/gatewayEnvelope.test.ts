import type { Request } from "express";
import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import {
  GatewayEnvelopeError,
  isCanonicalSignature,
  verifyGatewayEnvelope,
} from "../src/core/standardRail/gatewayEnvelope.js";
import { createStatusFailureBudget } from "../src/core/standardRail/transport.js";
import { signGatewayEnvelope } from "./gatewayConsumer.js";
import { CHAIN_ID, ENVIRONMENT, gateway, gatewayKey, PROVIDER_AUDIENCE } from "./standardRailFixture.js";

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

async function envelope() {
  const issuedAt = Math.floor(Date.now() / 1_000);
  return signGatewayEnvelope({
    artifactType: "DispatchStatusQueryV1", environment: ENVIRONMENT, chainId: CHAIN_ID,
    audience: PROVIDER_AUDIENCE, signerKeyId: "gateway-dispatch", privateKey: gatewayKey,
    issuedAt, validBefore: issuedAt + 60,
    payload: { orderId: "ord_x", dispatchHash: `0x${"1".repeat(64)}`, issuedAt, validBefore: issuedAt + 60 },
  });
}

const verify = (value: unknown) => verifyGatewayEnvelope(value, {
  artifactType: "DispatchStatusQueryV1", schemaVersion: 1,
  payloadKeys: ["orderId", "dispatchHash", "issuedAt", "validBefore"],
  environment: ENVIRONMENT, chainId: CHAIN_ID, audience: PROVIDER_AUDIENCE, signer: gateway.address,
  lifetime: { maxRemainingSeconds: 120, maxAgeSeconds: 120 },
});

/** Encodings of the same signature that ecrecover would also accept. */
function reencodings(signature: Hex): Hex[] {
  const r = signature.slice(2, 66);
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = signature.slice(130);
  const flipped = v === "1b" ? "1c" : "1b";
  return [
    `0x${signature.slice(2).toUpperCase()}` as Hex,
    `0x${r}${signature.slice(66, 130)}${v === "1b" ? "00" : "01"}` as Hex,
    `0x${r}${(N - s).toString(16).padStart(64, "0")}${flipped}` as Hex,
  ];
}

describe("gateway envelope signatures", () => {
  it("accepts the canonical encoding the gateway signer emits", async () => {
    const signed = await envelope();
    expect(isCanonicalSignature(signed.signature)).toBe(true);
    await expect(verify(signed)).resolves.toMatchObject({ artifactType: "DispatchStatusQueryV1" });
  });

  it("refuses every re-encoding of the same signature", async () => {
    const signed = await envelope();
    for (const signature of reencodings(signed.signature)) {
      expect(isCanonicalSignature(signature)).toBe(false);
      await expect(verify({ ...signed, signature })).rejects.toMatchObject({ failure: "signature" });
    }
  });

  it("checks the artifact type before trusting a shared-key signature", async () => {
    const signed = await envelope();
    const error = await verify({ ...signed, artifactType: "ProviderQuoteRequestV1" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(GatewayEnvelopeError);
    expect(error).toMatchObject({ failure: "shape" });
  });
});

describe("status authentication failure budget", () => {
  const request = (ip: string) => ({ ip }) as unknown as Request;
  const budget = () => createStatusFailureBudget({
    bypassIps: ["10.0.0.9"], failuresPerMinute: 3,
    clientIp: (req) => (req as unknown as { ip: string }).ip,
    matches: (ip, ranges) => ranges.includes(ip),
  });

  it("refuses a client once it spends its failures, and only for a minute", () => {
    const failures = budget();
    const now = 1_000_000;
    for (let count = 0; count < 3; count += 1) {
      expect(failures.exhausted(request("192.0.2.1"), now)).toBe(false);
      failures.recordFailure(request("192.0.2.1"), now);
    }
    expect(failures.exhausted(request("192.0.2.1"), now)).toBe(true);
    expect(failures.exhausted(request("192.0.2.2"), now)).toBe(false);
    expect(failures.exhausted(request("192.0.2.1"), now + 60_001)).toBe(false);
  });

  it("never limits a reviewed bypass address", () => {
    const failures = budget();
    for (let count = 0; count < 5; count += 1) failures.recordFailure(request("10.0.0.9"));
    expect(failures.exhausted(request("10.0.0.9"))).toBe(false);
  });
});
