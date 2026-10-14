import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { getAddress, keccak256, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ERC1271_MAGIC_RETURN,
  ERC1271_RESPONSE_MAX_BYTES,
  httpPayerRpcEndpoint,
  isPayerSignatureShape,
  PAYER_CONTRACT_VERIFY_CONCURRENCY,
  PAYER_CONTRACT_VERIFY_PER_PAYER,
  payerAccountPolicy,
  PayerSignatureError,
  resetPayerSignatureDefaults,
  verifyPayerTypedData,
  type PayerRpcEndpoint,
  type PayerSignatureVerifierOptions,
  type PayerTypedData,
} from "../src/core/standardRail/payerSignature.js";
import { parsePayerAccountTypes } from "../src/core/config.js";

// F-T07: the bounded payer-signature verifier shared by lifecycle, wallet
// actions and asset queries. EOAs verify offline; configured contract
// accounts answer one bounded ERC-1271 read whose exact success value,
// counterfactual refusal and transport/explicit distinction are pinned here.
const payer = privateKeyToAccount(`0x${"61".repeat(32)}` as Hex);
const stranger = privateKeyToAccount(`0x${"62".repeat(32)}` as Hex);
const contractPayer = getAddress("0x5555555555555555555555555555555555555555");

const typedData: PayerTypedData = {
  domain: { name: "DaskiStandardOrder", version: "1", chainId: 84532 },
  types: {
    OrderActionAuthorizationV1: [
      { name: "orderIdHash", type: "bytes32" },
      { name: "nonce", type: "bytes32" },
      { name: "validBefore", type: "uint64" },
    ],
  },
  primaryType: "OrderActionAuthorizationV1",
  message: {
    orderIdHash: keccak256(stringToHex("ord_1")),
    nonce: keccak256(stringToHex("nonce")),
    validBefore: 2_000_000_000n,
  },
};

const sign = (account = payer) => account.signTypedData(typedData as never);
const contractSignature = `0x${"ab".repeat(96)}` as Hex;

interface ScriptedEndpoint extends PayerRpcEndpoint {
  calls: string[];
}

function endpoint(
  host: string,
  behaviour: {
    code?: () => Promise<Hex>;
    call?: () => Promise<{ kind: "returned"; data: Hex } | { kind: "reverted" }>;
  },
): ScriptedEndpoint {
  const calls: string[] = [];
  return {
    host,
    calls,
    async getCode() {
      calls.push("getCode");
      return behaviour.code ? behaviour.code() : "0x6080";
    },
    async isValidSignature() {
      calls.push("isValidSignature");
      return behaviour.call ? behaviour.call() : { kind: "returned", data: ERC1271_MAGIC_RETURN };
    },
  };
}

const contractPolicy = (endpoints: PayerRpcEndpoint[], verifyTimeoutMs = 2_000): Partial<PayerSignatureVerifierOptions> => ({
  accountTypes: new Set(["eoa", "contract"] as const),
  verifyTimeoutMs,
  endpoints,
});
const eoaOnly = (endpoints: PayerRpcEndpoint[] = []): Partial<PayerSignatureVerifierOptions> => ({
  accountTypes: new Set(["eoa"] as const),
  verifyTimeoutMs: 2_000,
  endpoints,
});

async function rejection(promise: Promise<unknown>): Promise<PayerSignatureError> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(PayerSignatureError);
  return error as PayerSignatureError;
}

beforeEach(() => resetPayerSignatureDefaults());

describe("payer signature shape and EOA path", () => {
  it("accepts an EOA offline without consulting any endpoint", async () => {
    const unused = endpoint("unused", {});
    await expect(verifyPayerTypedData({ payer: payer.address, typedData, signature: await sign() }, contractPolicy([unused])))
      .resolves.toEqual({ accountType: "eoa", verifiedVia: "recovery" });
    expect(unused.calls).toEqual([]);
  });

  it("bounds the signature shape before any recovery", async () => {
    for (const signature of ["0x", "0xabc", `0x${"zz".repeat(65)}`, `0x${"ab".repeat(4_097)}`, "ab".repeat(65)]) {
      expect(isPayerSignatureShape(signature)).toBe(false);
      expect((await rejection(verifyPayerTypedData({ payer: payer.address, typedData, signature: signature as Hex }, eoaOnly())))
        .code).toBe("SIGNATURE_INVALID");
    }
    expect(isPayerSignatureShape(`0x${"ab".repeat(4_096)}`)).toBe(true);
  });

  it("refuses another signer and a malleated high-s copy under the EOA-only default", async () => {
    const wrong = await rejection(verifyPayerTypedData({ payer: payer.address, typedData, signature: await sign(stranger) }));
    expect(wrong).toMatchObject({ code: "SIGNATURE_INVALID", retryable: false });
    const signature = await sign();
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const s = BigInt(`0x${signature.slice(66, 130)}`);
    const v = Number.parseInt(signature.slice(130), 16) === 27 ? "1c" : "1b";
    const malleated = `${signature.slice(0, 66)}${(n - s).toString(16).padStart(64, "0")}${v}` as Hex;
    expect((await rejection(verifyPayerTypedData({ payer: payer.address, typedData, signature: malleated }, eoaOnly())))
      .code).toBe("SIGNATURE_INVALID");
  });

  it("publishes the enforced account policy, never counterfactual accounts", () => {
    expect(payerAccountPolicy()).toEqual({ types: ["eoa"], counterfactual: false });
  });

  it("parses the account policy, which always includes eoa", () => {
    expect([...parsePayerAccountTypes("eoa")]).toEqual(["eoa"]);
    expect([...parsePayerAccountTypes(" EOA , contract ")]).toEqual(["eoa", "contract"]);
    for (const invalid of ["", "contract", "eoa,smart", " , "]) {
      expect(() => parsePayerAccountTypes(invalid)).toThrow(/PAYER_ACCOUNT_TYPES/);
    }
  });
});

describe("payer signature contract path", () => {
  const verify = (options: Partial<PayerSignatureVerifierOptions>, signature = contractSignature) =>
    verifyPayerTypedData({ payer: contractPayer, typedData, signature }, options);

  it("accepts only the exact zero-padded ERC-1271 magic value", async () => {
    await expect(verify(contractPolicy([endpoint("a", {})])))
      .resolves.toEqual({ accountType: "contract", verifiedVia: "erc1271" });
    for (const data of [
      `0x1626ba7e${"0".repeat(55)}1`, `0x1626ba7e${"f".repeat(56)}`, "0x1626ba7e", `0x${"0".repeat(64)}`,
      `${ERC1271_MAGIC_RETURN}00`, "0x",
    ] as Hex[]) {
      const error = await rejection(verify(contractPolicy([endpoint("a", { call: async () => ({ kind: "returned", data }) })])));
      expect(error).toMatchObject({ code: "SIGNATURE_INVALID", retryable: false });
    }
  });

  it("treats a revert, a missing contract and disabled contract accounts as final", async () => {
    const reverted = endpoint("a", { call: async () => ({ kind: "reverted" }) });
    const fallback = endpoint("b", {});
    expect((await rejection(verify(contractPolicy([reverted, fallback])))).code).toBe("SIGNATURE_INVALID");
    expect(fallback.calls).toEqual([]);
    const noCode = endpoint("a", { code: async () => "0x" });
    expect((await rejection(verify(contractPolicy([noCode])))).code).toBe("SIGNATURE_INVALID");
    expect(noCode.calls).toEqual(["getCode"]);
    const disabled = endpoint("a", {});
    expect((await rejection(verify(eoaOnly([disabled])))).code).toBe("SIGNATURE_INVALID");
    expect(disabled.calls).toEqual([]);
  });

  it("refuses an ERC-6492 counterfactual wrapper without any RPC", async () => {
    const unused = endpoint("a", {});
    const wrapped = `0x${"cd".repeat(64)}${"6492".repeat(16)}` as Hex;
    expect((await rejection(verify(contractPolicy([unused]), wrapped))).code).toBe("SIGNATURE_COUNTERFACTUAL_REJECTED");
    expect(unused.calls).toEqual([]);
  });

  it("fails over once on transport failure and keeps unavailability retryable", async () => {
    const down = endpoint("primary", { code: async () => { throw new Error("ECONNRESET"); } });
    const up = endpoint("fallback", {});
    await expect(verify(contractPolicy([down, up]))).resolves.toMatchObject({ verifiedVia: "erc1271" });
    const third = endpoint("third", {});
    const broken = endpoint("fallback", { call: async () => { throw new Error("socket hang up"); } });
    const error = await rejection(verify(contractPolicy([down, broken, third])));
    expect(error).toMatchObject({ code: "SIGNATURE_VERIFICATION_UNAVAILABLE", retryable: true });
    expect(third.calls).toEqual([]);
    expect((await rejection(verify(contractPolicy([]))))).toMatchObject({ retryable: true });
  });

  it("bounds the whole verification by one deadline", async () => {
    const hanging: PayerRpcEndpoint = {
      host: "slow",
      getCode: (_address: Address, signal: AbortSignal) => new Promise<Hex>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
      isValidSignature: async () => ({ kind: "reverted" }),
    };
    const started = Date.now();
    const error = await rejection(verify(contractPolicy([hanging], 50)));
    expect(error.code).toBe("SIGNATURE_VERIFICATION_UNAVAILABLE");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("refuses more concurrent contract verifications than its bound as busy", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = endpoint("held", { code: async () => { await gate; return "0x6080"; } });
    const payers = Array.from({ length: PAYER_CONTRACT_VERIFY_CONCURRENCY + 1 }, (_value, index) =>
      getAddress(`0x${(index + 1).toString(16).padStart(40, "7")}`));
    const verifyFor = (account: Address) =>
      verifyPayerTypedData({ payer: account, typedData, signature: contractSignature }, contractPolicy([held]));
    const pending = payers.slice(0, -1).map(verifyFor);
    await vi.waitFor(() => expect(held.calls.length).toBe(PAYER_CONTRACT_VERIFY_CONCURRENCY));
    expect(await rejection(verifyFor(payers.at(-1)!))).toMatchObject({
      code: "SIGNATURE_VERIFICATION_BUSY", retryable: true,
    });
    release();
    await expect(Promise.all(pending)).resolves.toHaveLength(PAYER_CONTRACT_VERIFY_CONCURRENCY);
  });

  it("lets one payer hold only its share of the verification budget", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = endpoint("held", { code: async () => { await gate; return "0x6080"; } });
    const pending = Array.from({ length: PAYER_CONTRACT_VERIFY_PER_PAYER }, () => verify(contractPolicy([held])));
    await vi.waitFor(() => expect(held.calls.length).toBe(PAYER_CONTRACT_VERIFY_PER_PAYER));
    // The same payer, in any letter case, is busy; another payer is not.
    expect(await rejection(verifyPayerTypedData({
      payer: contractPayer.toLowerCase() as Address, typedData, signature: contractSignature,
    }, contractPolicy([held])))).toMatchObject({ code: "SIGNATURE_VERIFICATION_BUSY", retryable: true });
    const other = verifyPayerTypedData({
      payer: getAddress("0x6666666666666666666666666666666666666666"), typedData, signature: contractSignature,
    }, contractPolicy([held]));
    await vi.waitFor(() => expect(held.calls.length).toBe(PAYER_CONTRACT_VERIFY_PER_PAYER + 1));
    release();
    await expect(Promise.all([...pending, other])).resolves.toHaveLength(PAYER_CONTRACT_VERIFY_PER_PAYER + 1);
    // Both shares are free again once the verifications ended.
    await expect(verify(contractPolicy([endpoint("free", {})]))).resolves.toMatchObject({ accountType: "contract" });
  });
});

describe("bounded JSON-RPC payer endpoint", () => {
  type Handler = (body: { method: string }, res: ServerResponse) => void;
  let server: Server;
  let url: string;
  let handler: Handler;

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => handler(JSON.parse(raw) as { method: string }, res));
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const reply = (res: ServerResponse, body: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  const answer = (code: unknown, call: unknown): Handler => (body, res) =>
    reply(res, body.method === "eth_getCode" ? code : call);
  const signal = () => new AbortController().signal;

  it("reads code and the call result, and classifies explicit node answers", async () => {
    const rpc = httpPayerRpcEndpoint(url);
    expect(rpc.host).toBe("127.0.0.1");
    handler = answer({ jsonrpc: "2.0", id: 1, result: "0x6080" }, { jsonrpc: "2.0", id: 1, result: ERC1271_MAGIC_RETURN });
    await expect(rpc.getCode(contractPayer, signal())).resolves.toBe("0x6080");
    await expect(rpc.isValidSignature(contractPayer, `0x${"11".repeat(32)}`, contractSignature, signal()))
      .resolves.toEqual({ kind: "returned", data: ERC1271_MAGIC_RETURN });
    for (const error of [{ code: 3, message: "execution reverted" }, { code: -32000, message: "out of gas" }]) {
      handler = answer({ result: "0x" }, { jsonrpc: "2.0", id: 1, error });
      await expect(rpc.isValidSignature(contractPayer, `0x${"11".repeat(32)}`, contractSignature, signal()))
        .resolves.toEqual({ kind: "reverted" });
    }
    handler = answer({ result: "0x" }, { jsonrpc: "2.0", id: 1, result: 42 });
    await expect(rpc.isValidSignature(contractPayer, `0x${"11".repeat(32)}`, contractSignature, signal()))
      .resolves.toEqual({ kind: "returned", data: "0x" });
  });

  it("treats an oversized call answer as malformed and other faults as transport failures", async () => {
    const rpc = httpPayerRpcEndpoint(url);
    handler = answer({ result: "0x" }, { jsonrpc: "2.0", id: 1, result: `0x${"00".repeat(ERC1271_RESPONSE_MAX_BYTES)}` });
    await expect(rpc.isValidSignature(contractPayer, `0x${"11".repeat(32)}`, contractSignature, signal()))
      .resolves.toEqual({ kind: "returned", data: "0x" });
    handler = (body, res) => {
      const text = JSON.stringify({ jsonrpc: "2.0", id: 1, result: `0x${"00".repeat(ERC1271_RESPONSE_MAX_BYTES)}` });
      res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) });
      res.end(body.method === "eth_call" ? text : "");
    };
    await expect(rpc.isValidSignature(contractPayer, `0x${"11".repeat(32)}`, contractSignature, signal()))
      .resolves.toEqual({ kind: "returned", data: "0x" });
    const transport: Handler[] = [
      (_body, res) => reply(res, { error: "busy" }, 503),
      (_body, res) => reply(res, "<html>gateway</html>"),
      (_body, res) => reply(res, "[]"),
      (_body, res) => reply(res, { jsonrpc: "2.0", id: 1, error: { code: -32005, message: "limit exceeded" } }),
    ];
    for (const failing of transport) {
      handler = failing;
      await expect(rpc.isValidSignature(contractPayer, `0x${"11".repeat(32)}`, contractSignature, signal()))
        .rejects.toThrow();
      await expect(rpc.getCode(contractPayer, signal())).rejects.toThrow();
    }
    handler = answer({ jsonrpc: "2.0", id: 1, result: "not-code" }, {});
    await expect(rpc.getCode(contractPayer, signal())).rejects.toThrow(/did not return code/);
    await expect(httpPayerRpcEndpoint("http://127.0.0.1:1").getCode(contractPayer, signal())).rejects.toThrow();
  });
});
