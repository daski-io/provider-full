import { describe, expect, it } from "vitest";
import {
  validatePricing,
} from "../src/core/pricing/index.js";

describe("provider pricing contracts", () => {
  it("rejects a fixed amount combined with another amount mechanism", () => {
    expect(() => validatePricing({
      USDC: {
        type: "one-time",
        fixed_amount: "0",
        min_amount: "1",
      },
    })).toThrow("fixed_amount cannot be combined");
  });

  it("requires canonical uint256 atomic amounts", () => {
    expect(() => validatePricing({
      USDC: { type: "one-time", fixed_amount: "00" },
    })).toThrow("canonical uint256");
    expect(() => validatePricing({
      USDC: { type: "one-time", fixed_amount: "1" },
    })).not.toThrow();
  });
});
