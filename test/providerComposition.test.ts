import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveProviderLaunchPolicy } from "../src/core/standardRail/launchPolicy.js";
import { providerScreeningExtensions } from "../src/providerScreening.js";
import { providerServices } from "../src/providerServices.js";
import { assertDummyServiceAllowed } from "../src/services/dummy/config.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("generic provider composition", () => {
  it("ships only the dummy reference service", () => {
    expect(providerServices.map((service) => service.manifest.slug)).toEqual([
      "dummy",
    ]);
    expect(readdirSync(join(ROOT, "src", "services"), {
      withFileTypes: true,
    }).filter((entry) => entry.isDirectory()).map((entry) => entry.name))
      .toEqual(["dummy"]);
    expect(providerServices[0]?.manifest.supplier).toBeUndefined();
  });

  it("derives the exact paid-skill and action policy from the installed service", () => {
    expect(deriveProviderLaunchPolicy(providerServices)).toEqual({
      paidSkills: [{ serviceSlug: "dummy", skillId: "create-note" }],
      assetActions: [],
    });
  });

  it("bundles no provider-specific screening implementation", () => {
    expect(providerScreeningExtensions).toEqual([]);
  });

  it("fails closed if the dummy service reaches Base mainnet", () => {
    expect(() => assertDummyServiceAllowed(8453)).toThrow(
      "Replace the dummy service before deploying on Base mainnet",
    );
    expect(() => assertDummyServiceAllowed(84532)).not.toThrow();
  });
});
