import { createPublicClient, createWalletClient, http, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { config } from "../config.js";
import { logWarn } from "../logger.js";
import { observeOutbound } from "../observability/outboundFailures.js";
import { withRpcFailover } from "./rpcFailover.js";
import { rpcOperation } from "./rpcOperation.js";

/**
 * When set via `CHAIN_MODE=mock`, every on-chain touchpoint
 * (wallet authorization, payment verification, reputation
 * recorder, service registrar, boot-time provider verification) must
 * short-circuit with synthesized values rather than calling into viem.
 *
 * The viem `publicClient` / `walletClient` exports below stay defined
 * for type continuity but point at an unroutable RPC, so any accidental
 * call from a code path that forgot to gate on this flag fails fast
 * with a connection error instead of silently hitting a real chain.
 */
export const CHAIN_MODE_MOCK = config.CHAIN_MODE === "mock";

/**
 * Buyer agentId reported by the mock paymentVerifier. Must match the
 * value the gateway's AutoMockChainReader uses for its
 * `defaultBuyerAgentId` and the tokenId baked into daski-test's local
 * buyer wallet — all three agree out of the box at `99`.
 */
export const MOCK_BUYER_AGENT_ID = BigInt(
  config.MOCK_BUYER_AGENT_ID ?? 99n,
);

const chain = config.CHAIN_ID === 8453
  ? base
  : config.CHAIN_ID === 84532
    ? baseSepolia
    : (() => {
        throw new Error(`Unsupported chain id: ${config.CHAIN_ID}`);
      })();

const transportUrl = CHAIN_MODE_MOCK
  ? "http://127.0.0.1:1"
  : config.BASE_RPC_URL;

// Ordered failover endpoints behind BASE_RPC_URL. Deliberately empty in
// mock mode: the unroutable transport above is a safety property, and a
// fallback would defeat it.
const fallbackUrls = CHAIN_MODE_MOCK
  ? []
  : config.BASE_RPC_FALLBACK_URLS.split(",")
      .map((url) => url.trim())
      .filter(Boolean);

const rpcUrls: [string, ...string[]] = [transportUrl, ...fallbackUrls];
const publicTransport: Transport = CHAIN_MODE_MOCK
  ? http(transportUrl, { retryCount: 0, timeout: 20_000 })
  : (parameters) => {
      const endpoints = rpcUrls.map((url) => ({
        host: new URL(url).hostname,
        client: http(url, { retryCount: 0, timeout: 20_000 })(parameters),
      }));
      const primary = endpoints[0]!.client;
      const request = ((...args: Parameters<typeof primary.request>) =>
        withRpcFailover(endpoints, ({ client }) => client.request(...args), {
          operation: rpcOperation(args),
          onFallback: ({ primaryHost, selectedHost }) => {
            logWarn("Provider RPC fallback selected", {
              primaryHost,
              selectedHost,
            });
          },
        })) as typeof primary.request;
      return { ...primary, request };
    };

// Signed writes remain primary-only; ambiguous broadcasts are reconciled by
// their owning workflow and must never be hidden behind transport failover.
// Failures still reach the outbound-failure log.
const primaryRpcHost = new URL(transportUrl).hostname;
const walletTransport: Transport = (parameters) => {
  const target = http(transportUrl, { retryCount: 0, timeout: 20_000 })(parameters);
  const request = ((...args: Parameters<typeof target.request>) =>
    observeOutbound(primaryRpcHost, rpcOperation(args), () => target.request(...args))
  ) as typeof target.request;
  return { ...target, request };
};

export const publicClient: any = createPublicClient({
  chain,
  transport: publicTransport,
});

const account = privateKeyToAccount(config.PROVIDER_WALLET_PRIVATE_KEY as `0x${string}`);

export const walletClient: any = createWalletClient({
  account,
  chain,
  transport: walletTransport,
});

export const providerAddress = account.address;
