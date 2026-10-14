// Finding, minting and verifying the provider's agent on the canonical
// ERC-8004 IdentityRegistry.

import { decodeEventLog, zeroAddress } from "viem";
import { agentIndexAbi, identityAbi, transferEvent } from "./abis.mjs";
import { RegistrationAbort } from "./transactions.mjs";

// How far back from the head the Transfer scan looks before giving up and
// asking for --agent-id: about 11.5 days of Base blocks, which covers a rerun
// after a crashed or paused bootstrap without walking the whole chain.
export const DEFAULT_SCAN_BLOCKS = 500_000n;
// First eth_getLogs window; halved on an error down to the floor, since
// public Base nodes cap a query at 2,000 blocks and other providers differ.
const LOG_WINDOW_START = 50_000n;
const LOG_WINDOW_FLOOR = 500n;

/**
 * The agent steps bound to one chain: `identity`/`agentIndex` are the
 * registry addresses, and `retryOnLag`, `sendTx` and `sentSummary` come from
 * createTransactions.
 */
export function agentSteps({
  pub, account, identity, agentIndex, agentUri, updateUri, agentIdArg, scanBlocks, log,
  mintNewAgent = false, retryOnLag, sendTx, sentSummary,
}) {
  const sameAddress = (a, b) => a.toLowerCase() === b.toLowerCase();
  const readIdentity = (functionName, args, extra = {}) =>
    pub.readContract({ address: identity, abi: identityAbi, functionName, args, ...extra });

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

  // The agents the wallet holds, recovered from the registry's Transfer
  // events to the wallet and split into those minted to it (its own
  // registrations: a Transfer from the zero address) and those transferred in
  // from someone else. Scans back from `head` in windows the RPC accepts
  // (halving on a range error); it stops early only once `balance` held
  // agents are found and all of them are its own, otherwise it covers
  // `scanBlocks` blocks so an earlier mint of a re-acquired agent is seen.
  async function heldAgents(balance, head) {
    const floor = head > scanBlocks ? head - scanBlocks : 0n;
    log({ step: "identity.scan", fromBlock: floor.toString(), toBlock: head.toString(), note: "registry balance is non-zero; recovering held agents from Transfer events" });
    const held = new Map();
    const checked = new Set();
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
        if (!checked.has(id)) {
          checked.add(id);
          const owner = await ownerOf(id);
          if (owner && sameAddress(owner, account.address)) held.set(id, false);
        }
        if (held.has(id) && sameAddress(entry.args.from, zeroAddress)) held.set(id, true);
      }
      const allOwn = [...held.values()].every(Boolean);
      if ((BigInt(held.size) >= balance && allOwn) || fromBlock === floor) break;
      toBlock = fromBlock - 1n;
    }
    const minted = [...held].filter(([, own]) => own).map(([id]) => id);
    const transferredIn = [...held].filter(([, own]) => !own).map(([id]) => id);
    return { minted, transferredIn };
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
      return { agentId: agentIdArg };
    }

    const indexed = await pub.readContract({
      address: agentIndex, abi: agentIndexAbi, functionName: "resolve", args: [account.address],
    });
    if (indexed !== 0n) {
      log({ step: "identity.skip", agentId: indexed.toString(), note: "already registered (AgentIndex)" });
      return { agentId: indexed };
    }

    // The registry is the source of truth: the ERC-721 balance is non-zero
    // as soon as register() has mined, whether or not claim() ever ran. The
    // balance and the wallet's nonce are read at one block, and a mint is
    // signed at exactly that nonce: a registration this wallet already sent
    // either shows in that balance or occupies that nonce, so at most one of
    // them can ever be mined.
    const head = await pub.getBlockNumber();
    const balance = await readIdentity("balanceOf", [account.address], { blockNumber: head });
    if (balance > 0n) {
      const { minted, transferredIn } = await heldAgents(balance, head);
      if (minted.length === 1) {
        log({ step: "identity.skip", agentId: minted[0].toString(), note: "already registered (minted to the provider wallet; id recovered from Transfer events)" });
        return { agentId: minted[0] };
      }
      if (minted.length > 1 || BigInt(transferredIn.length) !== balance) {
        const found = [...minted, ...transferredIn];
        throw new RegistrationAbort(
          `the provider wallet holds ${balance} agent(s) on the canonical registry; the last ${scanBlocks} blocks of Transfer events resolved ` +
          `${minted.length} minted to it (${minted.map(String).join(", ") || "none"}) of ${found.length} found; re-run with --agent-id <id> ` +
          "(verified with ownerOf) or a larger --scan-blocks. Refusing to mint a second agent.",
          1,
        );
      }
      // Every held agent was transferred in by someone else: none is this
      // wallet's registration, so none is adopted, and a second identity is
      // minted next to them only when the operator asks for one.
      const ids = transferredIn.map(String);
      if (!mintNewAgent) {
        throw new RegistrationAbort(
          `the provider wallet holds ${balance} agent(s) that another wallet transferred to it (${ids.join(", ")}); none is adopted as this provider's registration. ` +
          "Re-run with --agent-id <id> to register with one of them deliberately (its agentWallet binding must be restored first), " +
          "or with --mint-new-agent to register a new agent alongside them. Refusing to mint a second agent.",
          1,
        );
      }
      log({ step: "identity.foreign", agentIds: ids, note: "transferred-in agents are not this provider's registration; --mint-new-agent registers a new one" });
    }

    const [confirmedNonce, pendingNonce] = await Promise.all([
      pub.getTransactionCount({ address: account.address, blockNumber: head }),
      pub.getTransactionCount({ address: account.address, blockTag: "pending" }),
    ]);
    if (pendingNonce > confirmedNonce) {
      throw new RegistrationAbort(
        `the provider wallet has ${pendingNonce - confirmedNonce} transaction(s) not yet mined; one may be a registration in flight. ` +
        "Wait until they are mined and re-run. Refusing to mint a second agent.",
        1,
      );
    }

    log({ step: "identity.register", agentURI: agentUri, nonce: confirmedNonce });
    const receipt = await sendTx("identity.register", {
      address: identity, abi: identityAbi, functionName: "register", args: [agentUri],
      nonce: confirmedNonce,
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
      "bind one; binding a wallet after the fact is a separate decision. " +
      sentSummary(),
      2,
    );
  }

  return { ownerOf, reconcileUri, heldAgents, ensureAgent, ensureAgentWallet };
}
