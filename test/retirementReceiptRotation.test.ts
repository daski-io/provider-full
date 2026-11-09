import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  retirementReceiptDomain,
  verifyRetirementReceipt,
  type ListingRetirementScope,
} from "../src/core/gatewayRegistration/retirementReceipt.js";
import { signGatewayEnvelope } from "./gatewayConsumer.js";

/*
 * A retirement receipt is a runtime envelope the gateway re-signs on every
 * read, so during a gateway key rotation the previous runtime signer stays
 * accepted, while a signer trusted only for release artifacts never is.
 */
const previousKey = `0x${"61".repeat(32)}` as Hex;
const currentKey = `0x${"62".repeat(32)}` as Hex;
const artifactKey = `0x${"63".repeat(32)}` as Hex;
const previous = privateKeyToAccount(previousKey).address;
const current = privateKeyToAccount(currentKey).address;
const artifactOnly = privateKeyToAccount(artifactKey).address;
const audience = "https://provider.example";
const scope: ListingRetirementScope = {
  kind: "listing",
  providerAgentId: "1",
  serviceId: `0x${"6".repeat(64)}`,
  listingManifestHash: `0x${"7".repeat(64)}`,
};

function receipt(privateKey: Hex) {
  const issuedAt = Math.floor(Date.now() / 1_000);
  return signGatewayEnvelope({
    artifactType: "GatewayContractRetirementV1",
    environment: "testnet",
    chainId: 84532,
    audience,
    signerKeyId: "gateway-dispatch",
    privateKey,
    issuedAt,
    validBefore: issuedAt + 3_600,
    payload: {
      requestId: "retire-rotation-test",
      scope,
      retiredAt: new Date((issuedAt - 60) * 1_000).toISOString(),
    },
  });
}

function domain(extra: NodeJS.ProcessEnv = {}) {
  return retirementReceiptDomain({
    CHAIN_ID: "84532",
    STANDARD_RAIL_PROVIDER_AUDIENCE: audience,
    STANDARD_RAIL_GATEWAY_SIGNER: current,
    ...extra,
  });
}

describe("retirement receipts during a gateway signer rotation", () => {
  it("trusts the current signer by default", async () => {
    expect(domain().gatewaySigners).toEqual([current]);
    await expect(verifyRetirementReceipt(await receipt(currentKey), scope, domain()))
      .resolves.toMatchObject({ requestId: "retire-rotation-test" });
    await expect(verifyRetirementReceipt(await receipt(previousKey), scope, domain()))
      .rejects.toThrow(/signature/);
  });

  it("accepts the previous runtime signer, never an artifact-only signer", async () => {
    const rotating = domain({
      STANDARD_RAIL_GATEWAY_SIGNER_PREVIOUS: previous,
      STANDARD_RAIL_GATEWAY_ARTIFACT_SIGNERS: artifactOnly,
    });
    expect(rotating.gatewaySigners).toEqual([current, previous]);
    await expect(verifyRetirementReceipt(await receipt(previousKey), scope, rotating))
      .resolves.toMatchObject({ requestId: "retire-rotation-test" });
    await expect(verifyRetirementReceipt(await receipt(currentKey), scope, rotating))
      .resolves.toMatchObject({ requestId: "retire-rotation-test" });
    await expect(verifyRetirementReceipt(await receipt(artifactKey), scope, rotating))
      .rejects.toThrow(/signature/);
  });

  it("refuses a zero gateway signer", () => {
    expect(() => domain({ STANDARD_RAIL_GATEWAY_SIGNER: `0x${"0".repeat(40)}` })).toThrow(/non-zero address/);
  });
});
