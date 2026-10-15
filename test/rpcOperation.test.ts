import { describe, expect, it } from "vitest";
import { rpcOperation } from "../src/core/chain/rpcOperation.js";

const request = (method: string, params?: unknown[]) => [{ method, params }];

describe("RPC operation labels", () => {
  it("labels state reads with the class of their block parameter, never its value", () => {
    const account = "0x49aee18e2736913f15bcdd3777081392055e87a3";
    expect(rpcOperation(request("eth_getTransactionCount", [account, "pending"])))
      .toBe("eth_getTransactionCount(pending)");
    expect(rpcOperation(request("eth_getTransactionCount", [account, "0x31e0c34"])))
      .toBe("eth_getTransactionCount(number)");
    expect(rpcOperation(request("eth_getStorageAt", [account, "0x0", "finalized"])))
      .toBe("eth_getStorageAt(finalized)");
    expect(rpcOperation(request("eth_call", [{ to: account }, { blockHash: "0xabc" }])))
      .toBe("eth_call(selector)");
    expect(rpcOperation(request("eth_getBlockByNumber", ["safe", false]))).toBe("eth_getBlockByNumber(safe)");
    expect(rpcOperation(request("eth_getBalance", [account, "tomorrow"]))).toBe("eth_getBalance(other)");
    expect(rpcOperation(request("eth_getCode", [account, "0xZZ"]))).not.toContain("0xZZ");
  });

  it("keeps the bare method when there is no block parameter", () => {
    const account = "0x49aee18e2736913f15bcdd3777081392055e87a3";
    expect(rpcOperation(request("eth_call", [{ to: account }]))).toBe("eth_call");
    expect(rpcOperation(request("eth_blockNumber", []))).toBe("eth_blockNumber");
    expect(rpcOperation(request("eth_fillTransaction", [{ to: account }]))).toBe("eth_fillTransaction");
    expect(rpcOperation(request("eth_sendRawTransaction", ["0x02f8"]))).toBe("eth_sendRawTransaction");
    expect(rpcOperation(request("eth_getTransactionCount"))).toBe("eth_getTransactionCount");
  });

  it("falls back to a generic label for an unrecognized request shape", () => {
    expect(rpcOperation([])).toBe("rpc");
    expect(rpcOperation(["eth_call"])).toBe("rpc");
    expect(rpcOperation([{ params: [] }])).toBe("rpc");
  });
});
