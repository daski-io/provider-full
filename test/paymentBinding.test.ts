import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import {
  assertDepositWithinQuoteWindow,
  assertQuoteWindowPolicy,
  selectDepositAuthorization,
} from "../src/core/standardRail/paymentBinding.js";

const nonce = (byte: string) => `0x${byte.repeat(64)}` as Hex;

function authorization(logIndex: number, usedNonce: Hex = nonce("a")) {
  return { logIndex, args: { nonce: usedNonce } };
}

describe("deposit authorization binding", () => {
  it("accepts only the authorization emitted immediately before the settlement transfer", () => {
    const bound = authorization(6);
    expect(selectDepositAuthorization([bound], {
      depositLogIndex: 7,
      expectedNonce: null,
    })).toBe(bound);
  });

  it("rejects the splice of an unrelated authorization next to an allowance transfer", () => {
    // A wrapper executes the payer's unrelated EIP-3009 authorization at
    // logs 2/3 and pays the provider with transferFrom at log 7. The old
    // "any AuthorizationUsed from the payer" rule accepted this; positional
    // binding does not.
    expect(() => selectDepositAuthorization([authorization(2)], {
      depositLogIndex: 7,
      expectedNonce: null,
    })).toThrow("Deposit authorization does not bind the settlement transfer");
  });

  it("stays unambiguous when the transaction batches several payer authorizations", () => {
    const bound = authorization(6, nonce("b"));
    expect(selectDepositAuthorization([authorization(2), bound, authorization(9)], {
      depositLogIndex: 7,
      expectedNonce: null,
    })).toBe(bound);
  });

  it("still requires the recipe-bound nonce at the bound position", () => {
    expect(() => selectDepositAuthorization([authorization(6, nonce("b"))], {
      depositLogIndex: 7,
      expectedNonce: nonce("c"),
    })).toThrow("Deposit authorization does not bind the settlement transfer");
    expect(selectDepositAuthorization([authorization(6, nonce("c"))], {
      depositLogIndex: 7,
      expectedNonce: nonce("c"),
    }).args.nonce).toBe(nonce("c"));
  });

  it("rejects a transfer at log index zero, which cannot follow an authorization", () => {
    expect(() => selectDepositAuthorization([authorization(0)], {
      depositLogIndex: 0,
      expectedNonce: null,
    })).toThrow("Deposit authorization does not bind the settlement transfer");
  });

  it("rejects an authorization event with no decoded nonce", () => {
    expect(() => selectDepositAuthorization([{ logIndex: 6, args: {} }], {
      depositLogIndex: 7,
      expectedNonce: null,
    })).toThrow("Deposit authorization does not bind the settlement transfer");
  });
});

describe("deposit settlement window", () => {
  const quote = { issuedAt: 1_000, validBefore: 1_120 };

  it("accepts a deposit inside the quote payment window", () => {
    expect(() => assertDepositWithinQuoteWindow(1_050, quote)).not.toThrow();
    expect(() => assertDepositWithinQuoteWindow(1_120, quote)).not.toThrow();
  });

  it("tolerates thirty seconds of sequencer clock skew before issuance", () => {
    expect(() => assertDepositWithinQuoteWindow(970, quote)).not.toThrow();
    expect(() => assertDepositWithinQuoteWindow(969, quote))
      .toThrow("outside the quote payment window");
  });

  it("rejects a deposit settled after the quote expired", () => {
    expect(() => assertDepositWithinQuoteWindow(1_121, quote))
      .toThrow("outside the quote payment window");
  });

  it("rejects unusable block timestamps", () => {
    expect(() => assertDepositWithinQuoteWindow(0, quote))
      .toThrow("outside the quote payment window");
    expect(() => assertDepositWithinQuoteWindow(Number.NaN, quote))
      .toThrow("outside the quote payment window");
  });
});

describe("quote window policy", () => {
  const outcome = {
    pricingMode: "dynamic" as const,
    quoteMaximumLifetimeSeconds: 120,
    quoteMinimumPaymentWindowSeconds: 30,
  };

  it("accepts a window inside the reviewed policy bounds", () => {
    expect(() => assertQuoteWindowPolicy({ issuedAt: 1_000, validBefore: 1_120 }, outcome))
      .not.toThrow();
    expect(() => assertQuoteWindowPolicy({ issuedAt: 1_000, validBefore: 1_030 }, outcome))
      .not.toThrow();
  });

  it("enforces the configured minimum payment window", () => {
    expect(() => assertQuoteWindowPolicy({ issuedAt: 1_000, validBefore: 1_029 }, outcome))
      .toThrow("violates the outcome quote policy");
  });

  it("rejects a window longer than the quote lifetime policy", () => {
    expect(() => assertQuoteWindowPolicy({ issuedAt: 1_000, validBefore: 1_121 }, outcome))
      .toThrow("violates the outcome quote policy");
  });

  it("does not constrain fixed-price outcomes, which pin both bounds to zero", () => {
    expect(() => assertQuoteWindowPolicy({ issuedAt: 1_000, validBefore: 9_999 }, {
      pricingMode: "fixed",
      quoteMaximumLifetimeSeconds: 0,
      quoteMinimumPaymentWindowSeconds: 0,
    })).not.toThrow();
  });
});

