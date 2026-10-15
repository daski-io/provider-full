import { describe, expect, it } from "vitest";
import {
  controlProfilesFromEnv,
  parseRetainedControlProfiles,
  servesControlProfile,
} from "../src/core/standardRail/controlProfiles.js";

const current = `0x${"c1".repeat(32)}` as const;
const earlier = `0x${"e0".repeat(32)}` as const;

describe("retained provider control profiles", () => {
  it("parses distinct bytes32 hashes other than the current profile", () => {
    expect(parseRetainedControlProfiles(undefined, current)).toEqual([]);
    expect(parseRetainedControlProfiles(` ${earlier.toUpperCase().replace("0X", "0x")} `, current)).toEqual([earlier]);
    expect(() => parseRetainedControlProfiles("0x1234", current)).toThrow(/entry 1 must be bytes32/);
    expect(() => parseRetainedControlProfiles(current, current)).toThrow(/repeats the current profile/);
    expect(() => parseRetainedControlProfiles(`${earlier},${earlier}`, current)).toThrow(/duplicate/);
    expect(() => parseRetainedControlProfiles(Array(17).fill(earlier).join(","), current)).toThrow(/at most 16/);
  });

  it("serves the outcome's own profile and the retained ones only", () => {
    expect(servesControlProfile(current, current)).toBe(true);
    expect(servesControlProfile(earlier, current)).toBe(false);
    expect(servesControlProfile(earlier, current, [earlier])).toBe(true);
    expect(servesControlProfile(`0x${"0f".repeat(32)}`, current, [earlier])).toBe(false);
  });

  it("reads the deployment's set from its environment", () => {
    expect(controlProfilesFromEnv({})).toBeNull();
    expect(controlProfilesFromEnv({
      STANDARD_RAIL_PROVIDER_CONTROL_PROFILE_HASH: current,
      STANDARD_RAIL_RETAINED_CONTROL_PROFILE_HASHES: earlier,
    })).toEqual({ current, retained: [earlier] });
    expect(() => controlProfilesFromEnv({ STANDARD_RAIL_PROVIDER_CONTROL_PROFILE_HASH: "0x12" })).toThrow(/bytes32/);
  });
});
