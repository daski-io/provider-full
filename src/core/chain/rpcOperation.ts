// The operation label of one JSON-RPC transport request in the outbound
// failure log. State reads carry the class of their block parameter, so a
// failing `eth_getTransactionCount(pending)` is distinguishable from the same
// read at a finalized block number. Only the class is kept, never the
// parameter itself.

/** Position of the block parameter in each state-reading method's params. */
const BLOCK_PARAMETER_INDEX: Readonly<Record<string, number>> = {
  eth_getTransactionCount: 1,
  eth_getBalance: 1,
  eth_getCode: 1,
  eth_getStorageAt: 2,
  eth_call: 1,
  eth_getBlockByNumber: 0,
};

const BLOCK_TAGS = new Set(["latest", "pending", "safe", "finalized", "earliest"]);

function blockParameterClass(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    if (BLOCK_TAGS.has(value)) return value;
    return /^0x[0-9a-f]+$/i.test(value) ? "number" : "other";
  }
  // EIP-1898 block selectors: `{ blockHash }` or `{ blockNumber }`.
  return typeof value === "object" ? "selector" : "other";
}

/** The JSON-RPC method of a viem transport request, with its block class. */
export function rpcOperation(args: readonly unknown[]): string {
  const first = args[0];
  if (!first || typeof first !== "object") return "rpc";
  const { method, params } = first as { method?: unknown; params?: unknown };
  if (typeof method !== "string") return "rpc";
  const index = BLOCK_PARAMETER_INDEX[method];
  if (index === undefined || !Array.isArray(params)) return method;
  const block = blockParameterClass(params[index]);
  return block ? `${method}(${block})` : method;
}
