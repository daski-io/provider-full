import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import {
  artifactGatewaySigners,
  parseGatewaySigners,
  registrationGatewaySigners,
  runtimeGatewaySigners,
  trustsGatewaySigner,
} from "../src/core/standardRail/gatewaySigners.js";

const current = getAddress("0x1111111111111111111111111111111111111111");
const previous = getAddress("0x2222222222222222222222222222222222222222");
const release = getAddress("0x3333333333333333333333333333333333333333");

describe("gateway signer rotation settings", () => {
  it("defaults to one signer for runtime envelopes and release artifacts", () => {
    const signers = parseGatewaySigners({ STANDARD_RAIL_GATEWAY_SIGNER: current.toLowerCase() });
    expect(signers).toEqual({ current, previous: null, artifacts: [current] });
    expect(runtimeGatewaySigners(signers.current, signers.previous)).toEqual([current]);
    expect(artifactGatewaySigners({ gatewayDispatchSigner: signers.current })).toEqual([current]);
  });

  it("keeps the previous runtime signer and the earlier artifact signers apart", () => {
    const signers = parseGatewaySigners({
      STANDARD_RAIL_GATEWAY_SIGNER: current,
      STANDARD_RAIL_GATEWAY_SIGNER_PREVIOUS: previous,
      STANDARD_RAIL_GATEWAY_ARTIFACT_SIGNERS: ` ${previous}, ${release} `,
    });
    const config = {
      gatewayDispatchSigner: signers.current,
      gatewayPreviousSigner: signers.previous,
      gatewayArtifactSigners: signers.artifacts,
    };
    expect(runtimeGatewaySigners(config.gatewayDispatchSigner, config.gatewayPreviousSigner)).toEqual([current, previous]);
    expect(artifactGatewaySigners(config)).toEqual([previous, release]);
    expect(trustsGatewaySigner(runtimeGatewaySigners(config.gatewayDispatchSigner, config.gatewayPreviousSigner), release))
      .toBe(false);
    expect(trustsGatewaySigner(artifactGatewaySigners(config), current)).toBe(false);
    expect(registrationGatewaySigners(signers)).toEqual([current, previous, release]);
  });

  it("accepts any letter case for a trusted signer", () => {
    expect(trustsGatewaySigner([current], current.toLowerCase() as `0x${string}`)).toBe(true);
  });

  it.each([
    [{}, /STANDARD_RAIL_GATEWAY_SIGNER is required/],
    [{ STANDARD_RAIL_GATEWAY_SIGNER: "0x1234" }, /non-zero address/],
    [{ STANDARD_RAIL_GATEWAY_SIGNER: `0x${"0".repeat(40)}` }, /non-zero address/],
    [{ STANDARD_RAIL_GATEWAY_SIGNER: current, STANDARD_RAIL_GATEWAY_SIGNER_PREVIOUS: current.toLowerCase() }, /repeats/],
    [{ STANDARD_RAIL_GATEWAY_SIGNER: current, STANDARD_RAIL_GATEWAY_SIGNER_PREVIOUS: "previous" }, /non-zero address/],
    [{ STANDARD_RAIL_GATEWAY_SIGNER: current, STANDARD_RAIL_GATEWAY_ARTIFACT_SIGNERS: `${previous},` }, /entry 2/],
    [{ STANDARD_RAIL_GATEWAY_SIGNER: current, STANDARD_RAIL_GATEWAY_ARTIFACT_SIGNERS: `${previous},${previous.toLowerCase()}` }, /duplicate/],
    [{
      STANDARD_RAIL_GATEWAY_SIGNER: current,
      STANDARD_RAIL_GATEWAY_ARTIFACT_SIGNERS: Array.from({ length: 9 }, (_, index) =>
        `0x${(index + 1).toString(16).padStart(40, "0")}`).join(","),
    }, /at most 8/],
  ])("refuses malformed settings %#", (env, message) => {
    expect(() => parseGatewaySigners(env as NodeJS.ProcessEnv)).toThrow(message);
  });
});
