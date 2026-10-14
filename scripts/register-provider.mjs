// One-shot script: register the provider wallet on the CANONICAL ERC-8004
// IdentityRegistry (the 0x8004A... per-chain singleton — Daski deploys no
// identity registry of its own), confirm its payment wallet, bind it in
// Daski's AgentIndex, then pay the ProviderRegistry listing fee. Idempotent —
// every step skips when its state is already on chain.
//
// An existing identity is found on the canonical registry itself. An
// explicit --agent-id is verified with ownerOf; otherwise a non-zero ERC-721
// balanceOf(wallet) is resolved from the registry's Transfer events, scanned
// back from the head in windows the RPC accepts. The AgentIndex reverse
// lookup is only a fast path: it knows a wallet after claim(), a later step,
// so a run that crashed between register() and claim() must not mint again.
// Only an agent minted to the wallet is adopted; agents transferred in by
// someone else are never this provider's registration. A balance the scan
// cannot account for aborts and asks for --agent-id. A mint is refused while
// the wallet has a transaction not yet mined, and it is signed at the nonce
// read with the zero balance, so a registration already sent and a new one
// can never both be mined.
//
// The canonical registry binds the registering wallet as the agentWallet in
// register() itself, and provider identity checks reject providers without a
// bound agentWallet, so the wallet step only verifies the binding. Its read
// goes through the lag retry, pinned to the registration block when this run
// minted the agent, because a node that has not seen that block answers the
// zero address. The registry no longer exposes walletRotationNonce(), which
// the former SetAgentWallet consent flow needed, so an unbound wallet fails
// with a message naming it instead of calling it; binding a wallet after the
// fact is a separate decision.
//
// If the agent already exists but its on-chain agentURI differs from
// BASE_URL's, the script only WARNS — pass --update-uri to rewrite it.
// This keeps a locally-sourced .env (BASE_URL=http://localhost:4000) from
// clobbering the live agent's URI.
//
// Usage: node scripts/register-provider.mjs [--update-uri] [--agent-id <id>]
//        [--scan-blocks <n>]
// Reads PROVIDER_WALLET_PRIVATE_KEY + contract addresses from env. The step
// functions are exported for test/registerProviderIdentity.test.ts, which
// runs them against a stubbed chain; main() runs only when invoked directly.

import { createPublicClient, createWalletClient, http, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { agentIndexAbi, identityAbi, provAbi, usdcAbi } from "./register-provider/abis.mjs";
import { DEFAULT_SCAN_BLOCKS, agentSteps } from "./register-provider/agent.mjs";
import { RegistrationAbort, createTransactions } from "./register-provider/transactions.mjs";

export { agentIndexAbi, identityAbi, provAbi, transferEvent, usdcAbi } from "./register-provider/abis.mjs";
export { DEFAULT_SCAN_BLOCKS } from "./register-provider/agent.mjs";
export { RegistrationAbort } from "./register-provider/transactions.mjs";

function argValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new RegistrationAbort(`${name} requires a value`, 1);
  }
  return value;
}

export function parseAgentIdArg(argv) {
  const value = argValue(argv, "--agent-id");
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new RegistrationAbort("--agent-id must be a decimal agent id", 1);
  return BigInt(value);
}

export function parseScanBlocksArg(argv) {
  const value = argValue(argv, "--scan-blocks");
  if (value === undefined) return DEFAULT_SCAN_BLOCKS;
  if (!/^\d+$/.test(value) || BigInt(value) === 0n) {
    throw new RegistrationAbort("--scan-blocks must be a positive block count", 1);
  }
  return BigInt(value);
}

/**
 * The registration steps bound to one chain. `pub`/`wallet` are viem
 * clients (or stubs), `account` the provider account, the addresses the
 * contracts from env. `log` receives one JSON-able entry per event and
 * `sleep` paces the lag retry; tests replace both.
 */
export function registrationSteps({
  pub, wallet, account, identity, agentIndex, providerRegistry, usdc, agentUri,
  updateUri = false, agentIdArg, scanBlocks = DEFAULT_SCAN_BLOCKS,
  log = (entry) => console.log(JSON.stringify(entry)),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const sameAddress = (a, b) => a.toLowerCase() === b.toLowerCase();
  const readIdentity = (functionName, args, extra = {}) =>
    pub.readContract({ address: identity, abi: identityAbi, functionName, args, ...extra });
  const { retryOnLag, sendTx, sentSummary } = createTransactions({ pub, wallet, account, log, sleep });
  const { heldAgents, ensureAgent, ensureAgentWallet, reconcileUri } = agentSteps({
    pub, account, identity, agentIndex, agentUri, updateUri, agentIdArg, scanBlocks, log,
    retryOnLag, sendTx, sentSummary,
  });

  // Bind the provider wallet in Daski's AgentIndex. Optional for settlement
  // (payouts key off the bound agentWallet), but it keeps the provider
  // resolvable through the same wallet-to-agentId lookup buyers use, and
  // this script's own fast path reads it.
  async function ensureIndexed(agentId) {
    const resolved = await pub.readContract({
      address: agentIndex, abi: agentIndexAbi, functionName: "resolve", args: [account.address],
    });
    if (resolved === agentId) {
      log({ step: "index.skip", agentId: agentId.toString(), note: "AgentIndex already binds wallet" });
      return;
    }
    log({ step: "index.claim", agentId: agentId.toString() });
    await sendTx("index.claim", {
      address: agentIndex, abi: agentIndexAbi, functionName: "claim", args: [agentId],
    });
  }

  async function ensureListed(agentId) {
    const isProv = await pub.readContract({
      address: providerRegistry, abi: provAbi, functionName: "isRegistered", args: [agentId],
    });
    if (isProv) {
      log({ step: "provider.skip", note: "already registered on ProviderRegistry" });
      return;
    }

    const fee = await pub.readContract({ address: providerRegistry, abi: provAbi, functionName: "listingFee" });
    const usdcDec = await pub.readContract({ address: usdc, abi: usdcAbi, functionName: "decimals" });
    const usdcBal = await pub.readContract({ address: usdc, abi: usdcAbi, functionName: "balanceOf", args: [account.address] });
    log({ step: "fee.check", listingFee: formatUnits(fee, usdcDec), usdcBalance: formatUnits(usdcBal, usdcDec) });
    if (usdcBal < fee) {
      // Circle's testnet USDC has no public mint; surface the faucet rather
      // than reverting inside ProviderRegistry.register.
      throw new RegistrationAbort(
        `insufficient USDC for listing fee: top up at https://faucet.circle.com (Base Sepolia, USDC), wallet ${account.address}`,
        4,
      );
    }

    const allowance = await pub.readContract({
      address: usdc, abi: usdcAbi, functionName: "allowance", args: [account.address, providerRegistry],
    });
    if (allowance < fee) {
      log({ step: "usdc.approve", amount: formatUnits(fee, usdcDec) });
      await sendTx("usdc.approve", {
        address: usdc, abi: usdcAbi, functionName: "approve", args: [providerRegistry, fee],
      });
    } else {
      log({ step: "usdc.approve.skip", note: "sufficient allowance" });
    }

    log({ step: "provider.register", agentId: agentId.toString() });
    await sendTx("provider.register", {
      address: providerRegistry, abi: provAbi, functionName: "register", args: [agentId],
    });
  }

  async function run() {
    log({ step: "start", wallet: account.address, agentURI: agentUri, identity, agentIndex, providerRegistry });
    const { agentId, registeredAt } = await ensureAgent();
    // The wallet binding is verified before anything is written for the
    // agent: a transferred-in agent, whose binding the registry cleared,
    // stops here instead of having its URI rewritten first.
    await ensureAgentWallet(agentId, registeredAt);
    await reconcileUri(agentId);
    await ensureIndexed(agentId);
    await ensureListed(agentId);

    // Final verify
    const finalResolved = await pub.readContract({
      address: agentIndex, abi: agentIndexAbi, functionName: "resolve", args: [account.address],
    });
    const finalWallet = await readIdentity("getAgentWallet", [agentId]);
    const finalProv = await pub.readContract({
      address: providerRegistry, abi: provAbi, functionName: "isRegistered", args: [agentId],
    });
    const summary = {
      step: "done",
      agentId: agentId.toString(),
      agentWallet: finalWallet,
      agentWalletVerified: sameAddress(finalWallet, account.address),
      indexResolves: finalResolved === agentId,
      providerRegistered: finalProv,
      agentURI: agentUri,
      note: "set PROVIDER_AGENT_ID to this agentId in the runtime env and redeploy",
    };
    log(summary);
    return summary;
  }

  return { retryOnLag, sendTx, heldAgents, ensureAgent, ensureAgentWallet, reconcileUri, ensureIndexed, ensureListed, run };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const CHAIN_ID = Number(env.CHAIN_ID);
  if (CHAIN_ID !== base.id && CHAIN_ID !== baseSepolia.id) {
    throw new RegistrationAbort("CHAIN_ID must be Base (8453) or Base Sepolia (84532)", 1);
  }
  const CHAIN = CHAIN_ID === base.id ? base : baseSepolia;
  const DEFAULT_RPC = CHAIN_ID === base.id ? "https://mainnet.base.org" : "https://sepolia.base.org";

  const PROVIDER_KEY = env.PROVIDER_WALLET_PRIVATE_KEY;
  const IDENTITY = env.IDENTITY_REGISTRY_ADDRESS;
  const AGENT_INDEX = env.AGENT_INDEX_ADDRESS;
  const PROVIDER_REGISTRY = env.PROVIDER_REGISTRY_ADDRESS;
  const USDC = env.USDC_ADDRESS;
  const BASE_URL = env.BASE_URL?.trim();
  const RPC = env.BASE_RPC_URL ?? DEFAULT_RPC;

  if (!PROVIDER_KEY || !IDENTITY || !AGENT_INDEX || !PROVIDER_REGISTRY || !USDC || !BASE_URL) {
    throw new RegistrationAbort("missing env: PROVIDER_WALLET_PRIVATE_KEY, IDENTITY_REGISTRY_ADDRESS, AGENT_INDEX_ADDRESS, PROVIDER_REGISTRY_ADDRESS, USDC_ADDRESS, BASE_URL", 1);
  }
  const providerOrigin = new URL(BASE_URL);
  if (providerOrigin.protocol !== "https:" || providerOrigin.username || providerOrigin.password ||
      providerOrigin.pathname !== "/" || providerOrigin.search || providerOrigin.hash) {
    throw new RegistrationAbort("BASE_URL must be a credential-free HTTPS origin", 1);
  }
  const agentUri = `${providerOrigin.origin}/.well-known/agent.json`;
  const agentIdArg = parseAgentIdArg(argv);
  const scanBlocks = parseScanBlocksArg(argv);

  console.error(`[chain] ${CHAIN.name} (${CHAIN.id}) - RPC: ${RPC}`);

  const account = privateKeyToAccount(PROVIDER_KEY);
  const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });
  const wallet = createWalletClient({ chain: CHAIN, transport: http(RPC), account });
  if (await pub.getChainId() !== CHAIN_ID) {
    throw new RegistrationAbort(`BASE_RPC_URL does not serve configured CHAIN_ID ${CHAIN_ID}`, 1);
  }

  const steps = registrationSteps({
    pub, wallet, account,
    identity: IDENTITY, agentIndex: AGENT_INDEX, providerRegistry: PROVIDER_REGISTRY, usdc: USDC,
    agentUri, updateUri: argv.includes("--update-uri"), agentIdArg, scanBlocks,
  });
  return steps.run();
}

if (process.argv[1] && /register-provider\.mjs$/.test(process.argv[1])) {
  main().catch((err) => {
    if (err instanceof RegistrationAbort) {
      console.error(err.message);
      process.exit(err.exitCode);
    }
    console.error(err);
    process.exit(1);
  });
}
