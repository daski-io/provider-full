import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  keccak256,
  padHex,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import type { ProviderStandardRailConfig } from "../src/core/standardRail/config.js";
import { ProviderEvidenceVerifier } from "../src/core/standardRail/evidence.js";
import type { ProviderOutcomeConfig } from "../src/core/standardRail/types.js";

const h = vi.hoisted(() => ({
  getBlockNumber: vi.fn(),
  getBlock: vi.fn(),
  getCode: vi.fn(),
  getStorageAt: vi.fn(),
  getTransaction: vi.fn(),
  getTransactionReceipt: vi.fn(),
  readContract: vi.fn(),
}));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      getBlockNumber: h.getBlockNumber,
      getBlock: h.getBlock,
      getCode: h.getCode,
      getStorageAt: h.getStorageAt,
      getTransaction: h.getTransaction,
      getTransactionReceipt: h.getTransactionReceipt,
      readContract: h.readContract,
    })),
  };
});

const token = "0x1111111111111111111111111111111111111111" as Address;
const implementation = "0x2222222222222222222222222222222222222222" as Address;
const oracle = "0x3333333333333333333333333333333333333333" as Address;
const eas = "0x4444444444444444444444444444444444444444" as Address;
const tokenCode = "0x6001" as Hex;
const implementationCode = "0x6002" as Hex;
const oracleCode = "0x6003" as Hex;
const easCode = "0x6004" as Hex;
const domainSeparator = `0x${"55".repeat(32)}` as Hex;
const implementationSlot = `0x${"66".repeat(32)}` as Hex;

function liveOutcome(outcomeId: string): ProviderOutcomeConfig {
  return {
    outcomeId,
    token,
    tokenRuntimeCodeHash: keccak256(tokenCode),
    tokenImplementationAddress: implementation,
    tokenImplementationRuntimeCodeHash: keccak256(implementationCode),
    tokenImplementationSlot: implementationSlot,
    tokenDomainSeparator: domainSeparator,
    sanctionsOracleRuntimeCodeHash: keccak256(oracleCode),
  } as ProviderOutcomeConfig;
}

const outcomes = new Map([
  "paid-alpha",
  "paid-beta",
  "form-wyoming-llc",
].map((outcomeId) => [outcomeId, liveOutcome(outcomeId)]));
const config = {
  evidenceRpcUrls: ["https://rpc.example"],
  outcomes,
  globalPolicy: {
    chainEvidencePolicy: {
      payload: {
        canonicalToken: token,
        canonicalTokenRuntimeCodeHash: keccak256(tokenCode),
        tokenImplementationAddress: implementation,
        tokenImplementationRuntimeCodeHash: keccak256(implementationCode),
        tokenImplementationSlot: implementationSlot,
        tokenDomainSeparator: domainSeparator,
      },
    },
    sanctionsOracleRuntimeCodeHash: keccak256(oracleCode),
  },
  sanctionsOracleAddress: oracle,
  easAddress: eas,
  easRuntimeCodeHash: keccak256(easCode),
} as unknown as ProviderStandardRailConfig;

beforeEach(() => {
  for (const mock of Object.values(h)) mock.mockReset();
  h.getBlockNumber.mockResolvedValue(1_234n);
  h.getCode.mockImplementation(async ({ address }: { address: Address }) => {
    return new Map<Address, Hex>([
      [oracle, oracleCode],
      [eas, easCode],
      [token, tokenCode],
      [implementation, implementationCode],
    ]).get(address);
  });
  h.getStorageAt.mockResolvedValue(padHex(implementation, { size: 32 }));
  h.readContract.mockResolvedValue(domainSeparator);
});

describe("standard-rail live readiness", () => {
  it("uses seven RPC calls regardless of the number of reviewed outcomes", async () => {
    const verifier = new ProviderEvidenceVerifier(config, baseSepolia);

    await verifier.verifyLiveReadiness();

    expect(h.getBlockNumber).toHaveBeenCalledTimes(1);
    expect(h.getCode).toHaveBeenCalledTimes(4);
    expect(h.getStorageAt).toHaveBeenCalledTimes(1);
    expect(h.readContract).toHaveBeenCalledTimes(1);
    expect(h.getBlock).not.toHaveBeenCalled();
    expect(h.getTransaction).not.toHaveBeenCalled();
    expect(h.getTransactionReceipt).not.toHaveBeenCalled();
    expect(h.getCode.mock.calls.map(([request]) => request.address)).toEqual([
      oracle,
      eas,
      token,
      implementation,
    ]);
  });
});
