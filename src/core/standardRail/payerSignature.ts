import {
  encodeFunctionData,
  getAddress,
  hashTypedData,
  parseAbi,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type TypedData,
  type TypedDataDomain,
} from "viem";
import { withRpcFailover } from "../chain/rpcFailover.js";
import { config, parsePayerAccountTypes, type PayerAccountType } from "../config.js";
import { logWarn } from "../logger.js";

// One payer-signature verifier for every site that authenticates a payer's
// EIP-712 signature (lifecycle actions, wallet actions and asset queries):
//
//   1. shape: 0x plus 1 to 4,096 bytes of hex; anything else is invalid;
//   2. EOA: exactly 65 bytes with a canonical low s that recovers to the
//      payer, verified offline without any RPC;
//   3. contract, only when PAYER_ACCOUNT_TYPES includes `contract`: an
//      ERC-6492 counterfactual wrapper is refused; otherwise, within one
//      deadline, the payer must have deployed code and answer
//      isValidSignature(bytes32,bytes) with exactly the ABI-encoded magic
//      value (0x1626ba7e followed by 28 zero bytes) through a read-only
//      eth_call with a gas bound and a response byte bound. A revert, any
//      other value or a malformed result is final; transport failure on the
//      primary and one fallback is distinct and retryable.
//
// At most eight contract verifications run at once in the process, and at
// most two for one payer, so a single payer cannot occupy the whole budget.
// Every caller reaches this verifier only after the gateway's grant
// verified, so that payer is the one the grant attests.
//
// The policy is published exactly as enforced (payerAccountPolicy, in each
// AgentCard), never with counterfactual accounts. Signatures and typed data
// are never logged.

export const PAYER_SIGNATURE_MAX_BYTES = 4_096;
export const ERC1271_MAGIC_VALUE: Hex = "0x1626ba7e";
/** The whole ABI-encoded bytes4 answer: the selector right-padded with zeros. */
export const ERC1271_MAGIC_RETURN: Hex = `0x1626ba7e${"0".repeat(56)}`;
export const ERC1271_CALL_GAS = 1_000_000n;
export const ERC1271_RESPONSE_MAX_BYTES = 16 * 1024;
export const PAYER_CONTRACT_VERIFY_CONCURRENCY = 8;
export const PAYER_CONTRACT_VERIFY_PER_PAYER = 2;
const SIGNATURE_PATTERN = /^0x(?:[0-9a-fA-F]{2}){1,4096}$/;
const ERC6492_MAGIC_SUFFIX = "6492".repeat(16);
const SECP256K1_HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const GET_CODE_RESPONSE_MAX_BYTES = 1024 * 1024;
const MAX_VERIFICATION_ENDPOINTS = 2;
const erc1271Abi = parseAbi([
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);

export type PayerSignatureErrorCode =
  | "SIGNATURE_INVALID"
  | "SIGNATURE_COUNTERFACTUAL_REJECTED"
  | "SIGNATURE_VERIFICATION_UNAVAILABLE"
  | "SIGNATURE_VERIFICATION_BUSY";

const ERROR_MESSAGES: Record<PayerSignatureErrorCode, string> = {
  SIGNATURE_INVALID: "payer signature invalid",
  SIGNATURE_COUNTERFACTUAL_REJECTED: "payer signature invalid: counterfactual wallet rejected",
  SIGNATURE_VERIFICATION_UNAVAILABLE: "payer signature verification unavailable",
  SIGNATURE_VERIFICATION_BUSY: "payer signature verification capacity exceeded",
};

/** Retryable codes never mean the signature is wrong: the same one may verify later. */
export class PayerSignatureError extends Error {
  readonly retryable: boolean;

  constructor(readonly code: PayerSignatureErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "PayerSignatureError";
    this.retryable = code === "SIGNATURE_VERIFICATION_UNAVAILABLE" ||
      code === "SIGNATURE_VERIFICATION_BUSY";
  }
}

export interface PayerTypedData {
  domain: TypedDataDomain;
  types: TypedData;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface PayerSignatureVerification {
  accountType: PayerAccountType;
  verifiedVia: "recovery" | "erc1271";
}

/** One RPC endpoint the contract path may consult. Transport failures throw. */
export interface PayerRpcEndpoint {
  host: string;
  getCode(address: Address, signal: AbortSignal): Promise<Hex>;
  isValidSignature(
    address: Address,
    hash: Hex,
    signature: Hex,
    signal: AbortSignal,
  ): Promise<{ kind: "returned"; data: Hex } | { kind: "reverted" }>;
}

export interface PayerSignatureVerifierOptions {
  accountTypes: ReadonlySet<PayerAccountType>;
  verifyTimeoutMs: number;
  endpoints: readonly PayerRpcEndpoint[];
}

let contractVerificationsInFlight = 0;
const contractVerificationsByPayer = new Map<string, number>();
let defaultOptions: PayerSignatureVerifierOptions | null = null;

const fail = (code: PayerSignatureErrorCode): never => {
  throw new PayerSignatureError(code);
};
/** Discarding an unread RPC body is best effort. */
const ignore = (): undefined => undefined;

/** The size rule: 0x and an even number of hex characters, 1 to 4,096 bytes. */
export function isPayerSignatureShape(value: unknown): value is Hex {
  return typeof value === "string" && SIGNATURE_PATTERN.test(value);
}

function isCanonicalEoaSignature(signature: Hex): boolean {
  if (signature.length !== 132) return false;
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = Number.parseInt(signature.slice(130, 132), 16);
  return s > 0n && s <= SECP256K1_HALF_ORDER && [0, 1, 27, 28].includes(v);
}

function isErc6492Wrapper(signature: Hex): boolean {
  return signature.length >= 66 && signature.slice(-64).toLowerCase() === ERC6492_MAGIC_SUFFIX;
}

class RpcTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcTransportError";
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await response.body?.cancel().catch(ignore);
    throw new RpcTransportError("RPC response exceeds the byte bound");
  }
  if (!response.body) throw new RpcTransportError("RPC response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(ignore);
      throw new RpcTransportError("RPC response exceeds the byte bound");
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

type JsonRpcReply = { result?: unknown; error?: { code?: unknown; message?: unknown } };

async function jsonRpc(
  url: string,
  method: string,
  params: unknown[],
  signal: AbortSignal,
  maxBytes: number,
): Promise<JsonRpcReply> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal,
      redirect: "error",
    });
  } catch (error) {
    throw new RpcTransportError(error instanceof Error ? error.name : "fetch failed");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(ignore);
    throw new RpcTransportError(`HTTP ${response.status}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBoundedBody(response, maxBytes));
  } catch (error) {
    if (error instanceof RpcTransportError) throw error;
    throw new RpcTransportError("RPC response is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RpcTransportError("RPC response is malformed");
  }
  return parsed as JsonRpcReply;
}

/** A definitive node answer to the call, as opposed to an unreachable endpoint. */
function isExplicitCallFailure(error: JsonRpcReply["error"]): boolean {
  if (!error) return false;
  return error.code === 3 || (typeof error.message === "string" &&
    /revert|out of gas|invalid opcode|invalid jump|stack (?:under|over)flow/i.test(error.message));
}

/** A bounded JSON-RPC endpoint; explicit call results are returned, never thrown. */
export function httpPayerRpcEndpoint(url: string): PayerRpcEndpoint {
  return {
    host: new URL(url).hostname,
    async getCode(address, signal) {
      const reply = await jsonRpc(url, "eth_getCode", [address, "latest"], signal, GET_CODE_RESPONSE_MAX_BYTES);
      if (reply.error || typeof reply.result !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(reply.result)) {
        throw new RpcTransportError("eth_getCode did not return code");
      }
      return reply.result as Hex;
    },
    async isValidSignature(address, hash, signature, signal) {
      const data = encodeFunctionData({ abi: erc1271Abi, functionName: "isValidSignature", args: [hash, signature] });
      let reply: JsonRpcReply;
      try {
        reply = await jsonRpc(url, "eth_call", [
          { to: address, data, gas: `0x${ERC1271_CALL_GAS.toString(16)}` },
          "latest",
        ], signal, ERC1271_RESPONSE_MAX_BYTES);
      } catch (error) {
        // An oversized answer is an explicit malformed result, not an outage.
        if (error instanceof RpcTransportError && /byte bound/.test(error.message)) {
          return { kind: "returned", data: "0x" };
        }
        throw error;
      }
      if (reply.error) {
        if (isExplicitCallFailure(reply.error)) return { kind: "reverted" };
        throw new RpcTransportError("eth_call failed");
      }
      if (typeof reply.result !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(reply.result)) {
        return { kind: "returned", data: "0x" };
      }
      return { kind: "returned", data: reply.result as Hex };
    },
  };
}

function resolveOptions(overrides?: Partial<PayerSignatureVerifierOptions>): PayerSignatureVerifierOptions {
  if (!defaultOptions) {
    const urls = config.CHAIN_MODE === "mock"
      ? []
      : [config.BASE_RPC_URL, ...config.BASE_RPC_FALLBACK_URLS.split(",")]
        .map((url) => url.trim()).filter(Boolean);
    defaultOptions = {
      accountTypes: parsePayerAccountTypes(config.PAYER_ACCOUNT_TYPES),
      verifyTimeoutMs: config.PAYER_SIGNATURE_VERIFY_TIMEOUT_MS,
      endpoints: urls.map(httpPayerRpcEndpoint),
    };
  }
  return { ...defaultOptions, ...overrides };
}

type ContractObservation = { outcome: "no-code" } | { outcome: "reverted" } | { outcome: "returned"; data: Hex };

async function observeContract(
  payer: Address,
  hash: Hex,
  signature: Hex,
  options: PayerSignatureVerifierOptions,
): Promise<ContractObservation> {
  if (options.endpoints.length === 0) return fail("SIGNATURE_VERIFICATION_UNAVAILABLE");
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), options.verifyTimeoutMs);
  deadline.unref();
  try {
    const endpoints = options.endpoints.slice(0, MAX_VERIFICATION_ENDPOINTS)
      .map((endpoint) => ({ host: endpoint.host, client: endpoint }));
    return await Promise.race<ContractObservation>([
      // Explicit results are returned, never thrown, so failover happens only
      // on transport failure and at most once.
      withRpcFailover(endpoints, async ({ client }): Promise<ContractObservation> => {
        const code = await client.getCode(payer, controller.signal);
        if (!code || code === "0x") return { outcome: "no-code" };
        const call = await client.isValidSignature(payer, hash, signature, controller.signal);
        return call.kind === "reverted" ? { outcome: "reverted" } : { outcome: "returned", data: call.data };
      }, {
        attempts: 1,
        baseDelayMs: 0,
        onFallback: ({ primaryHost, selectedHost }) => {
          logWarn("Payer signature RPC fallback selected", { primaryHost, selectedHost });
        },
      }),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () =>
          reject(new RpcTransportError("payer signature verification deadline exceeded")));
      }),
    ]);
  } catch {
    controller.abort();
    return fail("SIGNATURE_VERIFICATION_UNAVAILABLE");
  } finally {
    clearTimeout(deadline);
  }
}

/** Verify a payer's EIP-712 signature under the configured account policy. */
export async function verifyPayerTypedData(
  args: { payer: Address; typedData: PayerTypedData; signature: Hex },
  overrides?: Partial<PayerSignatureVerifierOptions>,
): Promise<PayerSignatureVerification> {
  if (!isPayerSignatureShape(args.signature)) fail("SIGNATURE_INVALID");
  const payer = getAddress(args.payer);
  const typedData = { ...args.typedData } as Parameters<typeof hashTypedData>[0];
  if (isCanonicalEoaSignature(args.signature)) {
    let recovered: Address | null = null;
    try {
      recovered = await recoverTypedDataAddress({ ...typedData, signature: args.signature });
    } catch {
      // Not recoverable for this payer: the contract policy decides.
    }
    if (recovered && getAddress(recovered) === payer) return { accountType: "eoa", verifiedVia: "recovery" };
  }
  const options = resolveOptions(overrides);
  if (!options.accountTypes.has("contract")) fail("SIGNATURE_INVALID");
  if (isErc6492Wrapper(args.signature)) fail("SIGNATURE_COUNTERFACTUAL_REJECTED");
  const hash = hashTypedData(typedData);
  const payerKey = payer.toLowerCase();
  const payerInFlight = contractVerificationsByPayer.get(payerKey) ?? 0;
  if (
    contractVerificationsInFlight >= PAYER_CONTRACT_VERIFY_CONCURRENCY ||
    payerInFlight >= PAYER_CONTRACT_VERIFY_PER_PAYER
  ) fail("SIGNATURE_VERIFICATION_BUSY");
  contractVerificationsInFlight += 1;
  contractVerificationsByPayer.set(payerKey, payerInFlight + 1);
  let observation: ContractObservation;
  try {
    observation = await observeContract(payer, hash, args.signature, options);
  } finally {
    contractVerificationsInFlight -= 1;
    const remaining = (contractVerificationsByPayer.get(payerKey) ?? 1) - 1;
    if (remaining > 0) contractVerificationsByPayer.set(payerKey, remaining);
    else contractVerificationsByPayer.delete(payerKey);
  }
  if (observation.outcome === "returned" && observation.data.toLowerCase() === ERC1271_MAGIC_RETURN) {
    return { accountType: "contract", verifiedVia: "erc1271" };
  }
  return fail("SIGNATURE_INVALID");
}

/**
 * The payer account policy exactly as the verifier enforces it, for
 * publication: the admitted account types, and never counterfactual ones.
 */
export function payerAccountPolicy(): { types: PayerAccountType[]; counterfactual: false } {
  const admitted = resolveOptions().accountTypes;
  return {
    types: (["eoa", "contract"] as const).filter((type) => admitted.has(type)),
    counterfactual: false,
  };
}

/** Test seam: forget the process-wide options derived from the environment. */
export function resetPayerSignatureDefaults(): void {
  defaultOptions = null;
}
