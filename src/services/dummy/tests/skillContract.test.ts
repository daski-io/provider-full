import { describe, expect, it } from "vitest";
import { servedSkillContractHashes } from "../../../core/agentCards/contractExtension.js";
import { minimumFulfillmentSeconds, skillDeadlines } from "../../../core/serviceRegistry/deadlines.js";
import { dummyService } from "../index.js";

// The published dummy contracts are pinned: any change to a hashed field is a
// new contract version that must be re-registered through `daski:register`.
// These values include the gateway's purchaseReadiness key and both explicit
// deadlines (previously 0xb4c348ff…8ea4 for echo and 0x0163d987…a035 for
// create-note, which the gateway refuses to parse).
const PINNED_CONTRACT_HASHES = {
  echo: "0x5daf51e36e572620f0a376242d085e931bea9d1c7213e1b7da7e206e5041b4f9",
  "create-note": "0xe23243e34b3d25bd30ecf414babbcbb4e018202c7b7fc9f5e44a72b57993bef9",
};

describe("dummy published skill contracts", () => {
  it("are pinned to their reviewed hashes", () => {
    expect(Object.fromEntries(servedSkillContractHashes(dummyService, [])))
      .toEqual(PINNED_CONTRACT_HASHES);
  });

  it("leave a lost initial dispatch recoverable at the gateway", () => {
    for (const skill of dummyService.skills) {
      const deadlines = skillDeadlines(skill);
      expect(deadlines.fulfillmentSeconds)
        .toBeGreaterThanOrEqual(minimumFulfillmentSeconds(deadlines.dispatchSeconds));
    }
  });
});
