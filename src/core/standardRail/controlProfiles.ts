import type { Hex } from "viem";

/*
 * The provider control profiles this deployment serves first dispatches
 * under. The gateway's dispatch of a paid order carries the control-profile
 * hash its checkout snapshot committed: the provider's profile at checkout,
 * even when the provider rotated its profile since and the gateway retries
 * the first dispatch long after (its recovery window outlives the quote).
 * An earlier profile therefore stays listed here while quotes or orders sold
 * under it can still be dispatched; each quote records the profile it was
 * issued under, so the compatibility check names a profile still owed but
 * no longer accepted. Only the hash is retained: an earlier profile is
 * served on this deployment's own audience and endpoints. The rail profile a
 * dispatch carries is always the gateway's current one, compared with the
 * current global policy, so no rail profile is retained.
 */

export const RETAINED_CONTROL_PROFILES_VARIABLE = "STANDARD_RAIL_RETAINED_CONTROL_PROFILE_HASHES";
const MAX_RETAINED_PROFILES = 16;
const BYTES32 = /^0x[0-9a-f]{64}$/;

/** The profiles a deployment accepts: its current one and those it retains. */
export interface ControlProfileSet {
  current: Hex;
  retained: readonly Hex[];
}

/**
 * Parse the retained control-profile hashes: comma-separated bytes32 values
 * of earlier profiles, distinct from each other and from the current one.
 */
export function parseRetainedControlProfiles(raw: string | undefined, current: Hex): Hex[] {
  const entries = (raw ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (entries.length > MAX_RETAINED_PROFILES) {
    throw new Error(`${RETAINED_CONTROL_PROFILES_VARIABLE} accepts at most ${MAX_RETAINED_PROFILES} hashes`);
  }
  const retained: Hex[] = [];
  for (const [index, entry] of entries.entries()) {
    if (!BYTES32.test(entry)) throw new Error(`${RETAINED_CONTROL_PROFILES_VARIABLE} entry ${index + 1} must be bytes32`);
    if (entry === current.toLowerCase()) {
      throw new Error(`${RETAINED_CONTROL_PROFILES_VARIABLE} entry ${index + 1} repeats the current profile`);
    }
    if (retained.includes(entry as Hex)) throw new Error(`${RETAINED_CONTROL_PROFILES_VARIABLE} entry ${index + 1} is a duplicate`);
    retained.push(entry as Hex);
  }
  return retained;
}

/** The deployment's profile set from its environment; null without a current profile. */
export function controlProfilesFromEnv(env: NodeJS.ProcessEnv = process.env): ControlProfileSet | null {
  const current = env.STANDARD_RAIL_PROVIDER_CONTROL_PROFILE_HASH?.trim().toLowerCase();
  if (!current) return null;
  if (!BYTES32.test(current)) throw new Error("STANDARD_RAIL_PROVIDER_CONTROL_PROFILE_HASH must be bytes32");
  return {
    current: current as Hex,
    retained: parseRetainedControlProfiles(env[RETAINED_CONTROL_PROFILES_VARIABLE], current as Hex),
  };
}

/** Whether a dispatch's control profile is the outcome's own or one this deployment retains. */
export function servesControlProfile(dispatched: string, outcome: string, retained: readonly Hex[] = []): boolean {
  const hash = dispatched.toLowerCase();
  return hash === outcome.toLowerCase() || retained.includes(hash as Hex);
}
