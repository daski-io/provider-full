// One-shot script: register the provider wallet on the CANONICAL ERC-8004
// IdentityRegistry (the 0x8004A... per-chain singleton — Daski deploys no
// identity registry of its own), confirm its payment wallet, bind it in
// Daski's AgentIndex, then pay the ProviderRegistry listing fee. Idempotent —
// every step skips when its state is already on chain.
//
// An existing identity is found on the canonical registry itself. An
// explicit --agent-id is verified with ownerOf; otherwise a non-zero ERC-721
// balanceOf(wallet) means the wallet already owns an agent, and its id is
// recovered from the registry's Transfer events, scanned back from the head
// in windows the RPC accepts. The AgentIndex reverse lookup is only a fast
// path: it knows a wallet after claim(), a later step, so a run that crashed
// between register() and claim() must not mint again. A balance the scan
// cannot resolve aborts and asks for --agent-id; the script never mints
// while the registry shows a balance.
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

import { createPublicClient, createWalletClient, http, parseAbi, parseAbiItem, formatUnits, decodeEventLog, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

export const identityAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);
// ERC-721 mint/transfer: register() emits one with the registering wallet as
// `to`, which is how an existing id is recovered without a reverse lookup.
export const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
);
export const agentIndexAbi = parseAbi([
  "function resolve(address wallet) view returns (uint256)",
  "function claim(uint256 agentId)",
]);
export const provAbi = parseAbi([
  "function listingFee() view returns (uint256)",
  "function register(uint256 agentId)",
  "function isRegistered(uint256) view returns (bool)",
]);
export const usdcAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address,uint256) returns (bool)",
]);

// How far back from the head the Transfer scan looks before giving up and
// asking for --agent-id: about 11.5 days of Base blocks, which covers a rerun
// after a crashed or paused bootstrap without walking the whole chain.
export const DEFAULT_SCAN_BLOCKS = 500_000n;
// First eth_getLogs window; halved on an error down to the floor, since
// public Base nodes cap a query at 2,000 blocks and other providers differ.
const LOG_WINDOW_START = 50_000n;
const LOG_WINDOW_FLOOR = 500n;

/** A deliberate stop with the process exit code main() should use. */
export class RegistrationAbort extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = "RegistrationAbort";
    this.exitCode = exitCode;
  }
}

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

  // Public Base RPCs can serve stale reads (and thus stale gas-estimation
  // state) right after a write — retry calls that depend on the previous
  // transaction's state.
  async function retryOnLag(label, fn) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (attempt >= 4) throw err;
        log({ step: "retry", label, attempt: attempt + 1 });
        await sleep(3000);
      }
    }
  }

  async function sendTx(label, params) {
    const hash = await retryOnLag(label, () => wallet.writeContract(params));
    log({ step: `${label}.sent`, hash });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    log({ step: `${label}.receipt`, status: receipt.status, blockNumber: receipt.blockNumber.toString() });
    if (receipt.status !== "success") throw new RegistrationAbort(`${label} reverted`, 2);
    return receipt;
  }

  // null when the token does not exist (ownerOf reverts on the canonical
  // registry rather than answering the zero address).
  async function ownerOf(agentId) {
    try {
      return await readIdentity("ownerOf", [agentId]);
    } catch {
      return null;
    }
  }

  async function reconcileUri(agentId) {
    const currentURI = await readIdentity("tokenURI", [agentId]);
    if (currentURI === agentUri) return;
    if (!updateUri) {
      log({ step: "identity.uri.drift", onChain: currentURI, fromEnv: agentUri, note: "left unchanged — re-run with --update-uri to rewrite" });
      return;
    }
    log({ step: "identity.setAgentURI", from: currentURI, to: agentUri });
    await sendTx("identity.setAgentURI", {
      address: identity, abi: identityAbi, functionName: "setAgentURI", args: [agentId, agentUri],
    });
  }

  // Agent ids the wallet currently owns, recovered from the registry's
  // Transfer events to the wallet. Scans back from the head in windows the
  // RPC accepts (halving on a range error) until `balance` owned ids are in
  // hand or `scanBlocks` blocks have been covered.
  async function ownedAgentIds(balance) {
    const head = await pub.getBlockNumber();
    const floor = head > scanBlocks ? head - scanBlocks : 0n;
    log({ step: "identity.scan", fromBlock: floor.toString(), toBlock: head.toString(), note: "registry balance is non-zero; recovering the agent id from Transfer events" });
    const seen = new Set();
    const owned = [];
    let window = LOG_WINDOW_START;
    let toBlock = head;
    while (toBlock >= floor) {
      const fromBlock = toBlock - window + 1n > floor ? toBlock - window + 1n : floor;
      let entries;
      try {
        entries = await pub.getLogs({
          address: identity, event: transferEvent, args: { to: account.address }, fromBlock, toBlock,
        });
      } catch (err) {
        if (window <= LOG_WINDOW_FLOOR) throw err;
        window = window / 2n > LOG_WINDOW_FLOOR ? window / 2n : LOG_WINDOW_FLOOR;
        continue;
      }
      for (const entry of entries) {
        const id = entry.args.tokenId;
        if (seen.has(id)) continue;
        seen.add(id);
        const owner = await ownerOf(id);
        if (owner && sameAddress(owner, account.address)) owned.push(id);
      }
      if (BigInt(owned.length) >= balance || fromBlock === floor) break;
      toBlock = fromBlock - 1n;
    }
    return owned;
  }

  // Returns the provider's existing agentId — verified from --agent-id, the
  // AgentIndex fast path, or the canonical registry's own balance — or mints
  // a new one via the canonical registry's register(agentURI). `registeredAt`
  // is the mint block when this run minted, so later reads can pin to it.
  async function ensureAgent() {
    if (agentIdArg !== undefined) {
      const owner = await ownerOf(agentIdArg);
      if (!owner) throw new RegistrationAbort(`--agent-id ${agentIdArg}: no such agent on the canonical registry`, 1);
      if (!sameAddress(owner, account.address)) {
        throw new RegistrationAbort(`--agent-id ${agentIdArg} is owned by ${owner}, not the provider wallet ${account.address}`, 1);
      }
      log({ step: "identity.skip", agentId: agentIdArg.toString(), note: "--agent-id verified against ownerOf" });
      await reconcileUri(agentIdArg);
      return { agentId: agentIdArg };
    }

    const indexed = await pub.readContract({
      address: agentIndex, abi: agentIndexAbi, functionName: "resolve", args: [account.address],
    });
    if (indexed !== 0n) {
      log({ step: "identity.skip", agentId: indexed.toString(), note: "already registered (AgentIndex)" });
      await reconcileUri(indexed);
      return { agentId: indexed };
    }

    // The registry is the source of truth: the ERC-721 balance is non-zero
    // as soon as register() has mined, whether or not claim() ever ran.
    const balance = await readIdentity("balanceOf", [account.address]);
    if (balance > 0n) {
      const owned = await ownedAgentIds(balance);
      if (balance === 1n && owned.length === 1) {
        log({ step: "identity.skip", agentId: owned[0].toString(), note: "already registered (canonical registry balance; id recovered from Transfer events)" });
        await reconcileUri(owned[0]);
        return { agentId: owned[0] };
      }
      throw new RegistrationAbort(
        `the provider wallet already owns ${balance} agent(s) on the canonical registry, but the last ${scanBlocks} blocks of Transfer events resolved ` +
        `${owned.length ? owned.map(String).join(", ") : "none"}; re-run with --agent-id <id> (verified with ownerOf). Refusing to mint a second agent.`,
        1,
      );
    }

    log({ step: "identity.register", agentURI: agentUri });
    const receipt = await sendTx("identity.register", {
      address: identity, abi: identityAbi, functionName: "register", args: [agentUri],
    });

    // The receipt's Registered event is the authoritative source of the
    // minted agentId.
    for (const entry of receipt.logs) {
      if (entry.address.toLowerCase() !== identity.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: identityAbi, eventName: "Registered", data: entry.data, topics: entry.topics });
        log({ step: "identity.register.done", agentId: decoded.args.agentId.toString() });
        return { agentId: decoded.args.agentId, registeredAt: receipt.blockNumber };
      } catch {}
    }
    throw new RegistrationAbort("identity.register succeeded but emitted no Registered event", 3);
  }

  // The provider's payment wallet must be bound on the canonical registry;
  // register() binds the registering wallet, so this only verifies. A read
  // issued right after the registration receipt can land on a node that has
  // not seen that block yet and answer the zero address. Pin the read to the
  // registration block when this run minted the agent: a lagging node then
  // errors instead of answering stale, and retryOnLag covers the error.
  async function ensureAgentWallet(agentId, registeredAt) {
    const current = await retryOnLag("wallet.read", () =>
      readIdentity("getAgentWallet", [agentId], registeredAt === undefined ? {} : { blockNumber: registeredAt }));

    if (sameAddress(current, account.address)) {
      log({ step: "wallet.skip", agentWallet: current, note: "bound on the canonical registry" });
      return;
    }
    if (current !== zeroAddress) {
      // A different wallet is deliberately bound (e.g. a separate payout
      // wallet). Leave it — settles pay that wallet, not the provider key.
      log({ step: "wallet.mismatch", agentWallet: current, note: "differs from the provider wallet; leaving it — payouts go there" });
      return;
    }
    throw new RegistrationAbort(
      `agent ${agentId} has no agentWallet on the canonical registry. The registry binds the registering wallet in register() ` +
      "and no longer exposes walletRotationNonce(), which the former SetAgentWallet consent flow needed, so this script cannot " +
      "bind one; binding a wallet after the fact is a separate decision. Nothing was sent.",
      2,
    );
  }

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
    await ensureAgentWallet(agentId, registeredAt);
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

  return { retryOnLag, sendTx, ownedAgentIds, ensureAgent, ensureAgentWallet, ensureIndexed, ensureListed, run };
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
