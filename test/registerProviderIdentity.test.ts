import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, zeroAddress } from "viem";
import {
  DEFAULT_SCAN_BLOCKS,
  RegistrationAbort,
  agentIndexAbi,
  identityAbi,
  parseAgentIdArg,
  parseMintNewAgentArg,
  parseScanBlocksArg,
  registrationSteps,
} from "../scripts/register-provider.mjs";

// The identity step of `npm run daski:register`, run against a stubbed chain.
// The fixture is a rerun after a crash between register() and claim(): the
// agent exists on the canonical registry and is owned by the provider
// wallet, register() bound its agentWallet, and the AgentIndex reverse lookup
// still answers 0. The stub RPC caps eth_getLogs at 2,000 blocks.
const WALLET = "0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF";
const OTHER = "0x1111111111111111111111111111111111111111";
const IDENTITY = "0x8004000000000000000000000000000000000001";
const AGENT_INDEX = "0x8004000000000000000000000000000000000002";
const PROVIDER_REGISTRY = "0x8004000000000000000000000000000000000003";
const USDC = "0x8004000000000000000000000000000000000004";
const AGENT_URI = "https://provider.example/.well-known/agent.json";
const AGENT_ID = 4242n;
const MINT_BLOCK = 7_000_000n;
const HEAD = 7_035_000n;

interface Transfer { blockNumber: bigint; tokenId: bigint; to: string; from?: string }

function chainStub(overrides: Partial<{
  balance: bigint;
  owners: Map<bigint, string>;
  agentWallets: Map<bigint, string>;
  transfers: Transfer[];
  indexResolve: bigint;
  laggingReads: number;
  receipt: unknown;
  nonces: { confirmed: number; pending: number };
  tokenUri: string;
  lostSends: number;
}> = {}) {
  const state = {
    head: HEAD,
    balance: 1n,
    owners: new Map([[AGENT_ID, WALLET]]),
    agentWallets: new Map([[AGENT_ID, WALLET]]),
    transfers: [{ blockNumber: MINT_BLOCK, tokenId: AGENT_ID, to: WALLET }] as Transfer[],
    indexResolve: 0n,
    logRangeLimit: 2_000n,
    // Pinned getAgentWallet reads that fail before a node that has the block answers.
    laggingReads: 0,
    receipt: null as unknown,
    nonces: { confirmed: 5, pending: 5 },
    tokenUri: AGENT_URI,
    // Sends the node accepts but whose answer is lost.
    lostSends: 0,
    reads: [] as Array<{ functionName: string; args?: readonly unknown[]; blockNumber?: bigint }>,
    nonceReads: [] as Array<{ blockNumber?: bigint; blockTag?: string }>,
    logQueries: [] as Array<{ fromBlock: bigint; toBlock: bigint }>,
    writes: [] as Array<{ functionName: string; nonce?: number }>,
    ...overrides,
  };
  const pub = {
    async getBlockNumber() { return state.head; },
    async readContract({ functionName, args, blockNumber }: {
      functionName: string; args?: readonly unknown[]; blockNumber?: bigint;
    }) {
      state.reads.push({ functionName, args, blockNumber });
      switch (functionName) {
        case "resolve": return state.indexResolve;
        case "balanceOf": return state.balance;
        case "ownerOf": {
          const owner = state.owners.get(args![0] as bigint);
          if (!owner) throw new Error("ERC721NonexistentToken");
          return owner;
        }
        case "getAgentWallet":
          if (blockNumber !== undefined && state.laggingReads > 0) {
            state.laggingReads -= 1;
            throw new Error("header not found");
          }
          return state.agentWallets.get(args![0] as bigint) ?? zeroAddress;
        case "tokenURI": return state.tokenUri;
        default: throw new Error(`unexpected read ${functionName}`);
      }
    },
    async getLogs({ args, fromBlock, toBlock }: {
      args: { to: string }; fromBlock: bigint; toBlock: bigint;
    }) {
      state.logQueries.push({ fromBlock, toBlock });
      if (toBlock - fromBlock + 1n > state.logRangeLimit) {
        throw new Error(`eth_getLogs is limited to a ${state.logRangeLimit} range`);
      }
      return state.transfers
        .filter((transfer) =>
          transfer.blockNumber >= fromBlock && transfer.blockNumber <= toBlock && transfer.to === args.to)
        .map((transfer) => ({
          blockNumber: transfer.blockNumber,
          args: { from: transfer.from ?? zeroAddress, to: transfer.to, tokenId: transfer.tokenId },
        }));
    },
    async waitForTransactionReceipt() { return state.receipt; },
    async getTransactionCount(query: { blockNumber?: bigint; blockTag?: string }) {
      state.nonceReads.push(query);
      return query.blockTag === "pending" ? state.nonces.pending : state.nonces.confirmed;
    },
  };
  const wallet = {
    async writeContract(params: { functionName: string; nonce?: number }) {
      state.writes.push(params);
      if (state.lostSends > 0) {
        // The node accepted the transaction; its answer never arrived.
        state.lostSends -= 1;
        if (params.nonce === state.nonces.pending) state.nonces.pending += 1;
        throw new Error("The request took too long to respond.");
      }
      if (params.nonce !== undefined && params.nonce < state.nonces.pending) {
        throw new Error("nonce too low");
      }
      if (!state.receipt) throw new Error("no transaction expected");
      return "0xtxhash";
    },
  };
  return { state, pub, wallet };
}

function stepsFor(stub: ReturnType<typeof chainStub>, extra: Record<string, unknown> = {}) {
  const logs: Array<Record<string, unknown>> = [];
  const steps = registrationSteps({
    pub: stub.pub,
    wallet: stub.wallet,
    account: { address: WALLET },
    identity: IDENTITY,
    agentIndex: AGENT_INDEX,
    providerRegistry: PROVIDER_REGISTRY,
    usdc: USDC,
    agentUri: AGENT_URI,
    log: (entry) => logs.push(entry),
    sleep: async () => undefined,
    ...extra,
  });
  return { steps, logs };
}

const readNames = (state: ReturnType<typeof chainStub>["state"]) =>
  state.reads.map((read) => read.functionName);

describe("existing provider identity on the canonical registry", () => {
  it("reuses the agent a crashed run minted instead of minting again", async () => {
    const stub = chainStub();
    const { steps, logs } = stepsFor(stub);
    await expect(steps.ensureAgent()).resolves.toEqual({ agentId: AGENT_ID });
    expect(stub.state.writes).toEqual([]);
    expect(logs.find((entry) => entry.step === "identity.skip")?.agentId).toBe(AGENT_ID.toString());
    expect(readNames(stub.state)).toContain("balanceOf");
    // The scan started wide, shrank to what the RPC accepts, and stopped once
    // the owned id was in hand rather than walking the whole cap.
    const first = stub.state.logQueries[0]!;
    expect(first.toBlock - first.fromBlock + 1n).toBeGreaterThan(2_000n);
    const served = stub.state.logQueries.filter((query) => query.toBlock - query.fromBlock + 1n <= 2_000n);
    expect(served.length).toBeGreaterThan(0);
    expect(served.length).toBeLessThan(40);
    expect(served.at(-1)!.fromBlock).toBeLessThanOrEqual(MINT_BLOCK);
    expect(served.at(-1)!.toBlock).toBeGreaterThanOrEqual(MINT_BLOCK);
  });

  it("verifies --agent-id with ownerOf and uses it without any lookup", async () => {
    const stub = chainStub();
    const { steps, logs } = stepsFor(stub, { agentIdArg: AGENT_ID });
    await expect(steps.ensureAgent()).resolves.toEqual({ agentId: AGENT_ID });
    expect(readNames(stub.state)).toEqual(["ownerOf"]);
    expect(stub.state.logQueries).toEqual([]);
    expect(String(logs.find((entry) => entry.step === "identity.skip")?.note)).toMatch(/--agent-id/);
  });

  it("aborts before sending anything when --agent-id is not the wallet's", async () => {
    const stub = chainStub({ owners: new Map([[AGENT_ID, OTHER]]) });
    await expect(stepsFor(stub, { agentIdArg: AGENT_ID }).steps.ensureAgent())
      .rejects.toThrow(/owned by/);
    await expect(stepsFor(stub, { agentIdArg: 7n }).steps.ensureAgent())
      .rejects.toThrow(/no such agent/);
    expect(stub.state.writes).toEqual([]);
  });

  it("keeps the AgentIndex binding as the fast path", async () => {
    const stub = chainStub({ indexResolve: AGENT_ID });
    await expect(stepsFor(stub).steps.ensureAgent()).resolves.toEqual({ agentId: AGENT_ID });
    expect(readNames(stub.state)).not.toContain("balanceOf");
    expect(stub.state.logQueries).toEqual([]);
  });

  it("refuses to mint while a registry balance the scan cannot resolve remains", async () => {
    const stub = chainStub({ transfers: [] });
    const attempt = stepsFor(stub, { scanBlocks: 10_000n }).steps.ensureAgent();
    await expect(attempt).rejects.toBeInstanceOf(RegistrationAbort);
    await expect(attempt).rejects.toThrow(/--agent-id[\s\S]*Refusing to mint a second agent/);
    expect(stub.state.writes).toEqual([]);
    // The whole cap was covered before giving up.
    expect(stub.state.logQueries.at(-1)!.fromBlock).toBe(HEAD - 10_000n);
  });

  it("names several owned agents and leaves the choice to --agent-id", async () => {
    const stub = chainStub({
      balance: 2n,
      owners: new Map([[AGENT_ID, WALLET], [AGENT_ID + 1n, WALLET]]),
      transfers: [
        { blockNumber: MINT_BLOCK, tokenId: AGENT_ID, to: WALLET },
        { blockNumber: MINT_BLOCK + 10n, tokenId: AGENT_ID + 1n, to: WALLET },
      ],
    });
    await expect(stepsFor(stub).steps.ensureAgent()).rejects.toThrow(/4242, 4243|4243, 4242/);
    expect(stub.state.writes).toEqual([]);
  });

  it("does not mistake a transferred-away token for the wallet's agent", async () => {
    const stub = chainStub({
      owners: new Map([[AGENT_ID, WALLET], [9_000n, OTHER]]),
      transfers: [
        { blockNumber: MINT_BLOCK, tokenId: AGENT_ID, to: WALLET },
        { blockNumber: MINT_BLOCK + 5n, tokenId: 9_000n, to: WALLET },
      ],
    });
    await expect(stepsFor(stub).steps.ensureAgent()).resolves.toEqual({ agentId: AGENT_ID });
  });

  it("mints only at a zero balance and reads the id from the Registered event", async () => {
    const topics = encodeEventTopics({
      abi: identityAbi,
      eventName: "Registered",
      args: { agentId: AGENT_ID, owner: WALLET },
    } as never);
    const data = encodeAbiParameters([{ type: "string" }], [AGENT_URI]);
    const stub = chainStub({
      balance: 0n,
      owners: new Map(),
      transfers: [],
      receipt: { status: "success", blockNumber: MINT_BLOCK, logs: [{ address: IDENTITY, data, topics }] },
    });
    const { steps, logs } = stepsFor(stub);
    await expect(steps.ensureAgent()).resolves.toEqual({ agentId: AGENT_ID, registeredAt: MINT_BLOCK });
    expect(stub.state.writes.map((write) => write.functionName)).toEqual(["register"]);
    expect(logs.map((entry) => entry.step)).toContain("identity.register.done");
    // Signed at the nonce read at the very block whose balance was zero.
    expect(stub.state.writes[0]!.nonce).toBe(5);
    expect(stub.state.reads.find((read) => read.functionName === "balanceOf")?.blockNumber).toBe(HEAD);
    expect(stub.state.nonceReads).toContainEqual({ address: WALLET, blockNumber: HEAD });
  });

  it("refuses to mint while a transaction from the wallet is not yet mined", async () => {
    const stub = chainStub({
      balance: 0n, owners: new Map(), transfers: [],
      nonces: { confirmed: 5, pending: 6 },
    });
    await expect(stepsFor(stub).steps.ensureAgent())
      .rejects.toThrow(/1 transaction\(s\) not yet mined[\s\S]*Refusing to mint a second agent/);
    expect(stub.state.writes).toEqual([]);
  });

  it("neither adopts an agent transferred in by someone else nor mints a second one beside it", async () => {
    const stub = chainStub({
      owners: new Map([[9_000n, WALLET]]),
      transfers: [{ blockNumber: MINT_BLOCK, tokenId: 9_000n, to: WALLET, from: OTHER }],
      tokenUri: "https://elsewhere.example/agent.json",
      receipt: { status: "success", blockNumber: HEAD, logs: [] },
    });
    const attempt = stepsFor(stub, { updateUri: true }).steps.ensureAgent();
    await expect(attempt).rejects.toThrow(
      /holds 1 agent\(s\) that another wallet transferred to it \(9000\)[\s\S]*--mint-new-agent[\s\S]*Refusing to mint a second agent/,
    );
    await expect(attempt).rejects.toMatchObject({ exitCode: 1 });
    expect(stub.state.writes).toEqual([]);
  });

  it("mints beside transferred-in agents only when --mint-new-agent asks for it", async () => {
    const topics = encodeEventTopics({
      abi: identityAbi,
      eventName: "Registered",
      args: { agentId: 5_000n, owner: WALLET },
    } as never);
    const data = encodeAbiParameters([{ type: "string" }], [AGENT_URI]);
    const stub = chainStub({
      owners: new Map([[9_000n, WALLET]]),
      transfers: [{ blockNumber: MINT_BLOCK, tokenId: 9_000n, to: WALLET, from: OTHER }],
      tokenUri: "https://elsewhere.example/agent.json",
      receipt: { status: "success", blockNumber: HEAD, logs: [{ address: IDENTITY, data, topics }] },
    });
    const { steps, logs } = stepsFor(stub, { updateUri: true, mintNewAgent: true });
    await expect(steps.ensureAgent()).resolves.toEqual({ agentId: 5_000n, registeredAt: HEAD });
    // The foreign agent's URI is never rewritten and it is never adopted.
    expect(stub.state.writes.map((write) => write.functionName)).toEqual(["register"]);
    expect(logs).toContainEqual(expect.objectContaining({ step: "identity.foreign", agentIds: ["9000"] }));
  });

  it("still finds its own agent after it was transferred away and back", async () => {
    const stub = chainStub({
      transfers: [
        { blockNumber: MINT_BLOCK, tokenId: AGENT_ID, to: WALLET },
        { blockNumber: MINT_BLOCK + 30_000n, tokenId: AGENT_ID, to: WALLET, from: OTHER },
      ],
    });
    await expect(stepsFor(stub).steps.ensureAgent()).resolves.toEqual({ agentId: AGENT_ID });
    expect(stub.state.writes).toEqual([]);
  });

  it("refuses to mint while held agents remain unaccounted for", async () => {
    const stub = chainStub({
      balance: 2n,
      owners: new Map([[9_000n, WALLET], [AGENT_ID, WALLET]]),
      transfers: [{ blockNumber: MINT_BLOCK, tokenId: 9_000n, to: WALLET, from: OTHER }],
    });
    await expect(stepsFor(stub, { scanBlocks: 100_000n }).steps.ensureAgent())
      .rejects.toThrow(/holds 2 agent\(s\)[\s\S]*0 minted to it \(none\) of 1 found/);
    expect(stub.state.writes).toEqual([]);
  });
});

describe("transaction sends", () => {
  it("retry a send whose answer was lost at its own nonce, never as a second transaction", async () => {
    const stub = chainStub({
      lostSends: 1,
      receipt: { status: "success", blockNumber: HEAD, logs: [] },
    });
    const attempt = stepsFor(stub).steps.ensureIndexed(AGENT_ID);
    await expect(attempt).rejects.toThrow(
      /index\.claim may already have been sent at nonce 5[\s\S]*Nothing was sent before it\./,
    );
    await expect(attempt).rejects.toMatchObject({ exitCode: 2 });
    expect(stub.state.writes.length).toBeGreaterThan(1);
    expect(new Set(stub.state.writes.map((write) => write.nonce))).toEqual(new Set([5]));
  });

  it("signs every transaction at the wallet's next nonce", async () => {
    const stub = chainStub({ receipt: { status: "success", blockNumber: HEAD, logs: [] } });
    await stepsFor(stub).steps.ensureIndexed(AGENT_ID);
    expect(stub.state.writes).toEqual([expect.objectContaining({ functionName: "claim", nonce: 5 })]);
  });
});

describe("payment wallet binding", () => {
  it("skips when register() bound the wallet, reading at the mint block through the lag retry", async () => {
    const stub = chainStub({ laggingReads: 2 });
    const { steps, logs } = stepsFor(stub);
    await steps.ensureAgentWallet(AGENT_ID, MINT_BLOCK);
    expect(logs.map((entry) => entry.step)).toEqual(["retry", "retry", "wallet.skip"]);
    const reads = stub.state.reads.filter((read) => read.functionName === "getAgentWallet");
    expect(reads).toHaveLength(3);
    expect(reads.every((read) => read.blockNumber === MINT_BLOCK)).toBe(true);
    expect(stub.state.writes).toEqual([]);
  });

  it("fails an unbound wallet naming walletRotationNonce and sends nothing", async () => {
    const stub = chainStub({ agentWallets: new Map() });
    const attempt = stepsFor(stub).steps.ensureAgentWallet(AGENT_ID, undefined);
    await expect(attempt).rejects.toThrow(/walletRotationNonce/);
    await expect(attempt).rejects.toMatchObject({ exitCode: 2 });
    expect(stub.state.writes).toEqual([]);
  });

  it("verifies the wallet binding before rewriting any agent's URI", async () => {
    // A transferred-in agent: owned by the wallet, binding cleared at transfer.
    const stub = chainStub({
      agentWallets: new Map(),
      tokenUri: "https://elsewhere.example/agent.json",
      receipt: { status: "success", blockNumber: HEAD, logs: [] },
    });
    const { steps } = stepsFor(stub, { agentIdArg: AGENT_ID, updateUri: true });
    await expect(steps.run()).rejects.toThrow(/walletRotationNonce[\s\S]*Nothing was sent\./);
    expect(stub.state.writes).toEqual([]);
  });

  it("names what the run already sent when it stops on an unbound wallet", async () => {
    const topics = encodeEventTopics({
      abi: identityAbi,
      eventName: "Registered",
      args: { agentId: AGENT_ID, owner: WALLET },
    } as never);
    const data = encodeAbiParameters([{ type: "string" }], [AGENT_URI]);
    const stub = chainStub({
      balance: 0n,
      owners: new Map(),
      transfers: [],
      agentWallets: new Map(),
      receipt: { status: "success", blockNumber: MINT_BLOCK, logs: [{ address: IDENTITY, data, topics }] },
    });
    await expect(stepsFor(stub).steps.run())
      .rejects.toThrow(/This run already sent: identity\.register\./);
  });

  it("leaves a deliberately bound payout wallet alone", async () => {
    const stub = chainStub({ agentWallets: new Map([[AGENT_ID, OTHER]]) });
    const { steps, logs } = stepsFor(stub);
    await steps.ensureAgentWallet(AGENT_ID, undefined);
    expect(logs.map((entry) => entry.step)).toEqual(["wallet.mismatch"]);
    expect(stub.state.writes).toEqual([]);
  });

  it("has no wallet-rotation consent calls left in the registration ABIs", () => {
    const names = [...identityAbi, ...agentIndexAbi]
      .map((item) => ("name" in item ? item.name : ""));
    expect(names).not.toContain("walletRotationNonce");
    expect(names).not.toContain("setAgentWallet");
    expect(names).toEqual(expect.arrayContaining(["ownerOf", "balanceOf", "getAgentWallet"]));
  });
});

describe("arguments", () => {
  it("parses --agent-id and --scan-blocks strictly", () => {
    expect(parseAgentIdArg([])).toBeUndefined();
    expect(parseAgentIdArg(["--update-uri", "--agent-id", "4242"])).toBe(4242n);
    expect(() => parseAgentIdArg(["--agent-id", "abc"])).toThrow(RegistrationAbort);
    expect(() => parseAgentIdArg(["--agent-id"])).toThrow(RegistrationAbort);
    expect(parseScanBlocksArg([])).toBe(DEFAULT_SCAN_BLOCKS);
    expect(parseScanBlocksArg(["--scan-blocks", "4000"])).toBe(4000n);
    expect(() => parseScanBlocksArg(["--scan-blocks", "0"])).toThrow(RegistrationAbort);
    expect(parseMintNewAgentArg([])).toBe(false);
    expect(parseMintNewAgentArg(["--mint-new-agent"])).toBe(true);
    expect(() => parseMintNewAgentArg(["--mint-new-agent", "--agent-id", "7"])).toThrow(RegistrationAbort);
  });
});
