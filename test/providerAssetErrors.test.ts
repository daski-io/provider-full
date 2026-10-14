import { describe, expect, it } from "vitest";
import { classifyProviderAssetError } from "../src/core/standardRail/routes.js";
import { AssetOwnerChangedError } from "../src/core/standardRail/assetOwnerFence.js";

describe("provider asset error boundary", () => {
  it("keeps validation failures bounded and non-retryable", () => {
    expect(classifyProviderAssetError(new Error("request schema mismatch"))).toEqual({
      status: 403,
      code: "PROVIDER_ASSET_QUERY_REJECTED",
      retryAfter: false,
      reasonClass: "request_rejected",
    });
  });

  it("returns retry guidance for capacity and unknown dependency failures", () => {
    expect(classifyProviderAssetError(new Error("capacity exceeded"))).toMatchObject({
      status: 429, code: "PROVIDER_ASSET_QUERY_UNAVAILABLE", retryAfter: true,
    });
    expect(classifyProviderAssetError(new Error("unexpected database failure"))).toMatchObject({
      status: 503, code: "PROVIDER_ASSET_QUERY_UNAVAILABLE", retryAfter: true,
    });
  });

  it("treats connection-class database codes and runtime fences as unavailable", () => {
    expect(
      classifyProviderAssetError(Object.assign(new Error("connection terminated"), { code: "08006" })),
    ).toMatchObject({ status: 503, reasonClass: "dependency_unavailable", retryAfter: true });
    expect(
      classifyProviderAssetError(Object.assign(new Error("terminating connection"), { code: "57P01" })),
    ).toMatchObject({ status: 503, reasonClass: "dependency_unavailable" });
    expect(classifyProviderAssetError(new Error("runtime fence active"))).toMatchObject({
      status: 503, reasonClass: "dependency_unavailable",
    });
  });

  it("keeps explicit rejection phrases non-retryable even with a database code", () => {
    expect(
      classifyProviderAssetError(Object.assign(new Error("signature expired"), { code: "22023" })),
    ).toEqual({
      status: 403,
      code: "PROVIDER_ASSET_QUERY_REJECTED",
      retryAfter: false,
      reasonClass: "request_rejected",
    });
  });

  it("refuses every changed or foreign asset owner definitively", () => {
    for (const detail of [
      undefined, "the wallet is not the asset's current owner", "the asset has no current owner",
    ]) {
      expect(classifyProviderAssetError(new AssetOwnerChangedError(detail))).toEqual({
        status: 403,
        code: "PROVIDER_ASSET_QUERY_REJECTED",
        retryAfter: false,
        reasonClass: "request_rejected",
      });
    }
  });

  it("lets rate limiting win over rejection phrasing", () => {
    expect(classifyProviderAssetError(new Error("rate limit: window invalid"))).toMatchObject({
      status: 429, code: "PROVIDER_ASSET_QUERY_UNAVAILABLE", reasonClass: "rate_limited", retryAfter: true,
    });
  });

  it("classifies non-Error values as unavailable via the fallback message", () => {
    expect(classifyProviderAssetError("boom")).toMatchObject({
      status: 503, reasonClass: "dependency_unavailable",
    });
  });
});
