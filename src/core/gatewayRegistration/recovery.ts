import type { Hex } from "viem";
import { canonicalHash } from "../standardRail/canonical.js";
import type { GatewayRegistrationRow } from "./store.js";
import type { GatewayRegistrationView } from "./types.js";

/** How a continued registration treats its activation evidence. */
export type EvidenceStep =
  /** EVIDENCE_PENDING: post the exact accepted envelope; never re-sign it. */
  | "replay-accepted"
  /** PREPARED with an expired stored envelope: re-sign the same binding. */
  | "refresh-unaccepted"
  /** PREPARED with a still-valid stored envelope: post it again. */
  | "resubmit-unaccepted"
  /** PREPARED with nothing stored: confirm the splitters, then sign. */
  | "sign-new";

export type FreshIntentReason =
  | "first-admission"
  | "card-changed"
  | "gateway-terminal"
  | "never-prepared";

/**
 * The next step of one service's registration, decided from durable local
 * state and the gateway's live view of the same registration. The runner and
 * the read-only forecast both act on this decision, so a forecast cannot
 * disagree with what a run would do.
 */
export type RegistrationPlan =
  | { kind: "unchanged" }
  /** The gateway activated the persisted registration: promote it. */
  | { kind: "promote"; view: GatewayRegistrationView }
  /** The gateway still holds the persisted registration as pending. */
  | { kind: "continue"; view: GatewayRegistrationView; evidence: EvidenceStep }
  /** A signed intent the gateway may not have seen: post it idempotently. */
  | { kind: "post-intent" }
  | { kind: "sign-intent"; reason: FreshIntentReason; attention?: string }
  | { kind: "blocked"; code: string; detail: string; attention?: string };

/** Whether planning needs the gateway's live view of the local registration. */
export function needsLiveRegistrationView(
  local: GatewayRegistrationRow | null,
): local is GatewayRegistrationRow & { gateway_registration_id: string } {
  return local !== null &&
    local.state !== "ACTIVE" &&
    local.gateway_registration_id !== null;
}

function storedPreparationMatches(
  local: GatewayRegistrationRow,
  live: GatewayRegistrationView,
): boolean {
  return local.prepared_response !== null &&
    canonicalHash(local.prepared_response.prepared) === canonicalHash(live.prepared);
}

/**
 * State-aware recovery. A local record is never replaced while the gateway
 * still holds its registration as pending or active: its intent, preparation,
 * splitter writes and accepted evidence are what the gateway admitted. Only a
 * first admission, a changed card of a promoted registration, a registration
 * the gateway ended, or an intent the gateway never prepared gets a new
 * intent.
 */
export function planRegistration(args: {
  local: GatewayRegistrationRow | null;
  cardMatches: boolean;
  live: GatewayRegistrationView | null;
  railPolicyHash: Hex;
  nowSeconds: number;
}): RegistrationPlan {
  const { local, cardMatches, live } = args;
  if (!local) return { kind: "sign-intent", reason: "first-admission" };
  if (local.state === "ACTIVE") {
    return cardMatches
      ? { kind: "unchanged" }
      : { kind: "sign-intent", reason: "card-changed" };
  }
  const railPolicyChanged =
    local.canonical_intent.payload.railPolicyHash !== args.railPolicyHash;
  if (!needsLiveRegistrationView(local)) {
    if (local.state !== "INTENT_READY") return { kind: "sign-intent", reason: "never-prepared" };
    return railPolicyChanged
      ? {
        kind: "blocked",
        code: "rail_policy_changed_during_prepare",
        attention: "rail_policy_changed_during_prepare",
        detail: "the gateway rail policy changed before the persisted intent was prepared",
      }
      : { kind: "post-intent" };
  }
  if (!live) throw new Error("registration recovery requires the gateway's live view");
  if (live.registrationId !== local.gateway_registration_id) {
    return {
      kind: "blocked",
      code: "gateway_registration_mismatch",
      detail: `gateway answered registration ${live.registrationId} for ${local.gateway_registration_id}`,
    };
  }
  if (live.state === "REJECTED" || live.state === "SUPERSEDED") {
    return {
      kind: "sign-intent",
      reason: "gateway-terminal",
      attention: `gateway_registration_${live.state.toLowerCase()}`,
    };
  }
  if (!storedPreparationMatches(local, live)) {
    return {
      kind: "blocked",
      code: "prepared_registration_changed",
      attention: "prepared_registration_changed",
      detail: `gateway registration ${live.registrationId} no longer matches the persisted preparation`,
    };
  }
  if (!cardMatches) {
    return {
      kind: "blocked",
      code: live.state === "ACTIVE"
        ? "activated_registration_unpromoted"
        : "card_changed_during_registration",
      detail: live.state === "ACTIVE"
        ? `gateway registration ${live.registrationId} is ACTIVE for the card it was registered with, but its runtime promotion is unresolved; publish that card again to promote it before registering a changed card`
        : `the served card changed while gateway registration ${live.registrationId} is ${live.state}`,
    };
  }
  if (live.state === "ACTIVE") return { kind: "promote", view: live };
  if (railPolicyChanged) {
    return {
      kind: "blocked",
      code: "rail_policy_changed_during_prepare",
      attention: "rail_policy_changed_during_prepare",
      detail: `the gateway rail policy changed while registration ${live.registrationId} is ${live.state}`,
    };
  }
  const evidence = local.canonical_evidence;
  if (evidence) {
    if (live.state === "EVIDENCE_PENDING") {
      return { kind: "continue", view: live, evidence: "replay-accepted" };
    }
    return {
      kind: "continue",
      view: live,
      evidence: evidence.validBefore <= args.nowSeconds
        ? "refresh-unaccepted"
        : "resubmit-unaccepted",
    };
  }
  if (live.state === "EVIDENCE_PENDING") {
    return {
      kind: "blocked",
      code: "accepted_evidence_not_persisted",
      detail: `gateway registration ${live.registrationId} accepted activation evidence this provider has not persisted; it cannot be replayed or replaced`,
    };
  }
  return { kind: "continue", view: live, evidence: "sign-new" };
}
