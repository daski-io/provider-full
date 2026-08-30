import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/core/config.js";
import { BASE_MAINNET_EXTERNAL_CONTRACTS } from "../src/core/chain/reviewedDeployments.js";

function productionTestnetEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: "production",
    CHAIN_ID: "84532",
    CHAIN_MODE: "live",
    BASE_URL: "https://provider.test",
    GATEWAY_BASE_URL: "https://gateway.test",
    DATABASE_SSL_MODE: "verify-full",
    MIGRATION_DATABASE_URL: "postgresql://localhost/daski_provider_migrations",
    POSTMARK_INBOUND_WEBHOOK_SECRET: "p".repeat(32),
  };
}

function mainnetEnv(): NodeJS.ProcessEnv {
  return {
    ...productionTestnetEnv(),
    CHAIN_ID: "8453",
    TRUST_PROXY_HOPS: "1",
    TRUST_PROXY_CIDRS: "10.20.30.40/32",
    EDGE_RATE_LIMIT_VERIFIED: "true",
    POSTMARK_TEST_MODE: "false",
    IDENTITY_REGISTRY_ADDRESS: BASE_MAINNET_EXTERNAL_CONTRACTS.identityRegistry,
    USDC_ADDRESS: BASE_MAINNET_EXTERNAL_CONTRACTS.usdc,
  };
}

describe("production database security", () => {
  it("requires HTTPS for the chain RPC", () => {
    expect(() => parseConfig({
      ...productionTestnetEnv(),
      BASE_RPC_URL: "http://rpc.example.test",
    })).toThrow(/HTTPS URL/);
  });

  it("rejects a documented or low-entropy admin token", () => {
    expect(() => parseConfig({
      ...productionTestnetEnv(),
      ADMIN_TOKEN: "replace-with-a-long-random-string",
    })).toThrow(/high-entropy/);
    expect(() => parseConfig({
      ...productionTestnetEnv(),
      ADMIN_TOKEN: "x".repeat(32),
    })).toThrow(/high-entropy/);
  });

  it("requires verified TLS on production testnet", () => {
    expect(() => parseConfig({
      ...productionTestnetEnv(),
      DATABASE_SSL_MODE: "disable",
    })).toThrow(/verified TLS/);
  });

  it("requires a distinct migration principal on production testnet", () => {
    const env = productionTestnetEnv();
    expect(() => parseConfig({
      ...env,
      MIGRATION_DATABASE_URL: env.DATABASE_URL,
    })).toThrow(/distinct privileged migration database role/);
  });

  it("accepts the documented production database posture", () => {
    expect(() => parseConfig(productionTestnetEnv())).not.toThrow();
  });

  it("rejects unsafe HTTP concurrency and timeout relationships", () => {
    expect(() => parseConfig({
      ...productionTestnetEnv(),
      HTTP_MAX_CONCURRENCY: "10",
      HTTP_MAX_CONCURRENCY_PER_IP: "11",
    })).toThrow(/per-IP HTTP concurrency/);
    expect(() => parseConfig({
      ...productionTestnetEnv(),
      HTTP_HEADERS_TIMEOUT_MS: "20000",
      HTTP_REQUEST_TIMEOUT_MS: "10000",
    })).toThrow(/header timeout/);
  });
});

describe("Base Mainnet configuration contract", () => {
  it("accepts the standard-rail mainnet core contract", () => {
    expect(() => parseConfig(mainnetEnv())).not.toThrow();
  });

  it.each([
    ["IDENTITY_REGISTRY_ADDRESS", "0x1111111111111111111111111111111111111111", /canonical ERC-8004/],
    ["USDC_ADDRESS", "0x2222222222222222222222222222222222222222", /canonical USDC/],
  ])("rejects a non-canonical Mainnet %s", (name, value, message) => {
    expect(() => parseConfig({ ...mainnetEnv(), [name]: value })).toThrow(message);
  });

  it.each([
    ["NODE_ENV", "test", /NODE_ENV/],
    ["CHAIN_MODE", "mock", /mock chain mode/],
    ["TRUST_PROXY_HOPS", "0", /trusted reverse-proxy CIDRs/],
    ["TRUST_PROXY_CIDRS", "", /trusted reverse-proxy CIDRs/],
    ["EDGE_RATE_LIMIT_VERIFIED", "false", /edge-level request limiting/],
    ["POSTMARK_TEST_MODE", "true", /Postmark test mode/],
  ])("fails closed when %s is invalid", (name, value, message) => {
    expect(() => parseConfig({ ...mainnetEnv(), [name]: value })).toThrow(message);
  });

  it("rejects the retired payment-rail selector", () => {
    expect(() => parseConfig({ ...productionTestnetEnv(), PAYMENT_RAIL: "standard" }))
      .toThrow(/PAYMENT_RAIL is retired/);
  });
});
