import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });
vi.mock("../src/core/db/pool.js", async () => (await import("./assetActionHarness.js")).poolModule());
vi.mock("../src/core/serviceRegistry/registry.js", async () => (await import("./assetActionHarness.js")).registryModule());
vi.mock("../src/core/engine/preExecuteRunner.js", () => ({
  consultPreExecuteAgent: async () => ({ action: "proceed" }),
  applyPreExecuteDecision: async () => ({ terminal: false }),
}));

const {
  ACTIONS, CHAIN_ID, assetWire, lower, payerA, payerB, regrant, signedAction, signedQuery, standard,
  startAssetHarness, wallet,
} = await import("./assetActionHarness.js");
const { ProviderAssetActionService } = await import("../src/core/standardRail/assetAction.js");
const { ProviderAssetQueryService } = await import("../src/core/standardRail/assetQuery.js");
const { ERC1271_MAGIC_RETURN, resetPayerSignatureDefaults } = await import("../src/core/standardRail/payerSignature.js");
const { classifyProviderAssetError } = await import("../src/core/standardRail/routes.js");
const { config: coreConfig } = await import("../src/core/config.js");

// F-T07 at the asset entry points against PostgreSQL: EOA and ERC-1271
// payer signatures that are valid, invalid or unverifiable obey the account
// policy and the grant-first ordering, an outage never spends the payer's
// nonce, counterfactual wrappers never reach the chain, and a read
// authorization (an asset query) can never act on an asset.
let harness: Awaited<ReturnType<typeof startAssetHarness>>;
const actions = () => new ProviderAssetActionService(standard, wallet, CHAIN_ID);
const queries = () => new ProviderAssetQueryService(standard, wallet, CHAIN_ID);
const contractAccount = privateKeyToAccount(`0x${"35".repeat(32)}` as Hex);
// Not a 65-byte ECDSA signature: only the contract path could accept it.
const contractSignature = `0x${"ab".repeat(130)}` as Hex;
const counterfactualSignature = `0x${"cd".repeat(96)}${"6492".repeat(16)}` as Hex;
let rpc: Server;
let rpcCalls = 0;
let rpcAnswer: "magic" | "revert" | "down" = "magic";
let executed = 0;

assetWire.adapter = {
  execute: async () => {
    executed += 1;
    return { status: "completed", artifacts: [{ name: "note_receipt", data: { receipt: "touched" } }] };
  },
  handleInput: async () => ({ status: "working" }),
  cancel: async () => undefined,
  quote: async () => ({ ok: true, amount: 1n, currency: "USDC" }),
};

const count = async (table: string) =>
  Number((await harness.database.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);

async function rejection(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the request to be refused");
}

function admitContractAccounts(enabled: boolean): void {
  Object.assign(coreConfig, {
    PAYER_ACCOUNT_TYPES: enabled ? "eoa,contract" : "eoa",
    PAYER_SIGNATURE_VERIFY_TIMEOUT_MS: 2_000,
    BASE_RPC_URL: `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`,
    BASE_RPC_FALLBACK_URLS: "",
  });
  resetPayerSignatureDefaults();
}

beforeAll(async () => {
  harness = await startAssetHarness("asset_payer_accounts");
  rpc = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      rpcCalls += 1;
      const { method } = JSON.parse(raw) as { method: string };
      if (rpcAnswer === "down") { res.writeHead(503); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(method === "eth_getCode"
        ? { jsonrpc: "2.0", id: 1, result: "0x6080" }
        : rpcAnswer === "magic"
          ? { jsonrpc: "2.0", id: 1, result: ERC1271_MAGIC_RETURN }
          : { jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted" } }));
    });
  }).listen(0, "127.0.0.1");
  await once(rpc, "listening");
});

afterAll(async () => {
  Object.assign(coreConfig, { PAYER_ACCOUNT_TYPES: "eoa", BASE_RPC_URL: "https://sepolia.base.org" });
  resetPayerSignatureDefaults();
  await new Promise<void>((resolve) => rpc.close(() => resolve()));
  await harness?.close();
});

beforeEach(async () => {
  await harness.reset();
  rpcCalls = 0;
  rpcAnswer = "magic";
  executed = 0;
  assetWire.assets = {};
  admitContractAccounts(false);
});

afterEach(() => admitContractAccounts(false));

describe("EOA payers at the asset entry points (F-T07)", () => {
  it("acts on a valid signature and refuses another signer's before anything is consumed", async () => {
    const note = await harness.ownedNote(payerA);
    const forged = await rejection(actions().perform(await signedAction({
      action: ACTIONS.touch, providerAssetId: note, input: {}, signer: payerB,
    })));
    expect(forged.message).toBe("wallet authorization denied");
    expect(classifyProviderAssetError(forged).status).toBe(403);
    expect(await count("standard_wallet_action_nonces")).toBe(0);
    expect(await count("standard_provider_grant_nonces")).toBe(0);
    const answer = await actions().perform(await signedAction({
      action: ACTIONS.touch, providerAssetId: note, input: {},
    })) as { payload: { status: string } };
    expect(answer.payload.status).toBe("completed");
    expect(await count("standard_wallet_action_nonces")).toBe(1);
    expect(rpcCalls).toBe(0);
  });

  it("never lets a read authorization act on an asset", async () => {
    const note = await harness.ownedNote(payerA);
    const read = await signedQuery({});
    const listed = await queries().query(read) as { payload: { assets: Array<{ providerAssetId: string }> } };
    expect(listed.payload.assets.map((asset) => asset.providerAssetId)).toEqual([note]);
    // The same payer authorization, presented as an action on the asset it listed.
    const replayed = await signedAction({ action: ACTIONS.touch, providerAssetId: note, input: {} });
    const misused = { ...replayed, authorization: (await regrant(read)).authorization };
    const refused = await rejection(actions().perform(misused));
    expect(classifyProviderAssetError(refused).status).toBe(403);
    expect(executed).toBe(0);
    expect(await count("standard_asset_action_executions")).toBe(0);
  });
});

describe("contract-account payers at the asset entry points (F-T07)", () => {
  it("refuses a contract signature without any chain call while contract accounts are not admitted", async () => {
    const note = await harness.ownedNote(contractAccount);
    const refused = await rejection(actions().perform(await signedAction({
      action: ACTIONS.touch, providerAssetId: note, input: {}, payer: contractAccount, signature: contractSignature,
    })));
    expect(refused.message).toBe("wallet authorization denied");
    expect(rpcCalls).toBe(0);
    expect(await count("standard_wallet_action_nonces")).toBe(0);
  });

  it("acts on the exact magic value, refuses a revert, and keeps an outage retryable without spending the nonce", async () => {
    admitContractAccounts(true);
    const note = await harness.ownedNote(contractAccount);
    const body = await signedAction({
      action: ACTIONS.touch, providerAssetId: note, input: {}, payer: contractAccount, signature: contractSignature,
    });
    rpcAnswer = "down";
    const outage = await rejection(actions().perform(body));
    expect(outage).toMatchObject({ name: "PayerSignatureError", retryable: true });
    expect(classifyProviderAssetError(outage).status).toBe(503);
    expect(await count("standard_wallet_action_nonces")).toBe(0);
    expect(await count("standard_provider_grant_nonces")).toBe(0);
    rpcAnswer = "revert";
    const invalid = await rejection(actions().perform(await regrant(body)));
    expect(invalid.message).toBe("wallet authorization denied");
    expect(classifyProviderAssetError(invalid).status).toBe(403);
    expect(await count("standard_wallet_action_nonces")).toBe(0);
    rpcAnswer = "magic";
    // The very authorization the outage refused still acts once verification is back.
    const answer = await actions().perform(await regrant(body)) as { payload: { status: string; payer: string } };
    expect(answer.payload).toMatchObject({ status: "completed", payer: lower(contractAccount) });
    expect(executed).toBe(1);
  });

  it("refuses a counterfactual ERC-6492 wrapper without any chain call, even with contract accounts admitted", async () => {
    admitContractAccounts(true);
    const note = await harness.ownedNote(contractAccount);
    const refused = await rejection(actions().perform(await signedAction({
      action: ACTIONS.touch, providerAssetId: note, input: {}, payer: contractAccount, signature: counterfactualSignature,
    })));
    expect(refused.message).toBe("wallet authorization denied");
    expect(rpcCalls).toBe(0);
  });

  it("lists a contract payer's assets and keeps a query outage retryable without spending its nonce", async () => {
    admitContractAccounts(true);
    const note = await harness.ownedNote(contractAccount);
    await harness.ownedNote(payerA);
    const body = await signedQuery({ payer: contractAccount, signature: contractSignature });
    rpcAnswer = "down";
    const outage = await rejection(queries().query(body));
    expect(classifyProviderAssetError(outage).status).toBe(503);
    expect(await count("standard_wallet_action_nonces")).toBe(0);
    rpcAnswer = "magic";
    const listed = await queries().query(await regrant(body)) as { payload: { assets: Array<{ providerAssetId: string }> } };
    expect(listed.payload.assets.map((asset) => asset.providerAssetId)).toEqual([note]);
  });
});
