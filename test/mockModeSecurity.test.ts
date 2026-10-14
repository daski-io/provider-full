import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/core/config.js";

const wallet = "0x1111111111111111111111111111111111111111";

function mockEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: "test",
    CHAIN_MODE: "mock",
    BASE_URL: "http://127.0.0.1:4000",
    MOCK_BUYER_AGENT_ID: "99",
    MOCK_BUYER_WALLET_ADDRESS: wallet,
    ...overrides,
  };
}

describe("mock-mode security boundary", () => {
  it("requires a loopback origin", () => {
    expect(() =>
      parseConfig(mockEnvironment({ BASE_URL: "https://provider.example" })),
    ).toThrow(/loopback/);
  });

  it("refuses contract payer accounts, which only a live chain RPC can verify", () => {
    expect(() => parseConfig(mockEnvironment({ PAYER_ACCOUNT_TYPES: "eoa,contract" })))
      .toThrow(/PAYER_ACCOUNT_TYPES/);
    expect(() => parseConfig(mockEnvironment({ PAYER_ACCOUNT_TYPES: "eoa" }))).not.toThrow();
    expect(() => parseConfig(mockEnvironment({ PAYER_ACCOUNT_TYPES: "contract" })))
      .toThrow(/PAYER_ACCOUNT_TYPES/);
    expect(() => parseConfig({
      ...mockEnvironment({ PAYER_ACCOUNT_TYPES: "eoa,contract" }),
      CHAIN_MODE: "live",
      BASE_URL: "https://provider.example",
    })).not.toThrow();
  });

  it("requires an explicit mock buyer wallet", () => {
    const env = mockEnvironment();
    delete env.MOCK_BUYER_WALLET_ADDRESS;
    expect(() => parseConfig(env)).toThrow(/MOCK_BUYER_WALLET_ADDRESS/);
  });
});
