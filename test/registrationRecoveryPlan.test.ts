import { describe, expect, it } from "vitest";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import { planRegistration } from "../src/core/gatewayRegistration/recovery.js";
import type { GatewayRegistrationRow } from "../src/core/gatewayRegistration/store.js";
import type { GatewayRegistrationView } from "../src/core/gatewayRegistration/types.js";

// The recovery decision both the runner and the read-only forecast act on.
// A record is replaced by a new intent only for a first admission, a changed
// card of a promoted registration, a registration the gateway ended, or an
// intent the gateway never prepared.

const RAIL = `0x${"6".repeat(64)}` as const;
const NOW = 1_800_000_000;
const prepared = { registrationId: "registration-1", listings: [] } as unknown as
  GatewayRegistrationView["prepared"];

function row(patch: Partial<GatewayRegistrationRow> = {}): GatewayRegistrationRow {
  return {
    id: "local-1",
    gateway_origin: "https://gateway.example",
    service_row_id: "service-1",
    service_id: Buffer.alloc(32, 1),
    card_contract_hash: Buffer.alloc(32, 2),
    state: "EVIDENCE_SUBMITTED",
    idempotency_key: "svc-key",
    gateway_registration_id: "registration-1",
    canonical_intent: { payload: { railPolicyHash: RAIL } } as GatewayRegistrationRow["canonical_intent"],
    prepared_response: { prepared } as GatewayRegistrationView,
    canonical_evidence: { validBefore: NOW + 60 } as GatewayRegistrationRow["canonical_evidence"],
    last_error_code: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...patch,
  };
}

const live = (state: GatewayRegistrationView["state"], patch: Partial<GatewayRegistrationView> = {}) =>
  ({ registrationId: "registration-1", state, prepared, ...patch }) as GatewayRegistrationView;

const plan = (
  local: GatewayRegistrationRow | null,
  view: GatewayRegistrationView | null,
  cardMatches = true,
) => planRegistration({ local, cardMatches, live: view, railPolicyHash: RAIL, nowSeconds: NOW });

describe("registration recovery plan", () => {
  it("signs a first intent, keeps an unchanged promoted registration, re-registers a changed card", () => {
    expect(plan(null, null)).toEqual({ kind: "sign-intent", reason: "first-admission" });
    expect(plan(row({ state: "ACTIVE" }), null)).toEqual({ kind: "unchanged" });
    expect(plan(row({ state: "ACTIVE" }), null, false))
      .toEqual({ kind: "sign-intent", reason: "card-changed" });
  });

  it("posts a persisted intent the gateway may already hold, and replaces one it never prepared", () => {
    const unprepared = { gateway_registration_id: null, prepared_response: null, canonical_evidence: null };
    expect(plan(row({ state: "INTENT_READY", ...unprepared }), null)).toEqual({ kind: "post-intent" });
    expect(plan(row({ state: "ATTENTION", ...unprepared }), null))
      .toEqual({ kind: "sign-intent", reason: "never-prepared" });
    expect(plan(row({
      state: "INTENT_READY",
      ...unprepared,
      canonical_intent: { payload: { railPolicyHash: `0x${"7".repeat(64)}` } } as GatewayRegistrationRow["canonical_intent"],
    }), null)).toMatchObject({
      kind: "blocked",
      attention: "rail_policy_changed_during_prepare",
    });
  });

  it("resumes promotion from ATTENTION when the gateway reports the registration ACTIVE", () => {
    const active = live("ACTIVE");
    expect(plan(row({ state: "ATTENTION", last_error_code: "runtime_commitment_mismatch" }), active))
      .toEqual({ kind: "promote", view: active });
    expect(plan(row(), active)).toEqual({ kind: "promote", view: active });
  });

  it("replays accepted evidence while pending, from any local state and after expiry", () => {
    const pending = live("EVIDENCE_PENDING");
    for (const state of ["ATTENTION", "EVIDENCE_SUBMITTED"] as const) {
      expect(plan(row({
        state,
        canonical_evidence: { validBefore: NOW - 600 } as GatewayRegistrationRow["canonical_evidence"],
      }), pending)).toEqual({ kind: "continue", view: pending, evidence: "replay-accepted" });
    }
  });

  it("refreshes only unaccepted evidence, and signs it only after the splitters", () => {
    const preparedView = live("PREPARED");
    expect(plan(row({
      canonical_evidence: { validBefore: NOW } as GatewayRegistrationRow["canonical_evidence"],
    }), preparedView)).toEqual({ kind: "continue", view: preparedView, evidence: "refresh-unaccepted" });
    expect(plan(row(), preparedView))
      .toEqual({ kind: "continue", view: preparedView, evidence: "resubmit-unaccepted" });
    expect(plan(row({ state: "BROADCAST", canonical_evidence: null }), preparedView))
      .toEqual({ kind: "continue", view: preparedView, evidence: "sign-new" });
  });

  it("refuses to replace accepted evidence it never persisted", () => {
    expect(plan(row({ canonical_evidence: null }), live("EVIDENCE_PENDING"))).toMatchObject({
      kind: "blocked",
      code: "accepted_evidence_not_persisted",
    });
  });

  it("restarts only after the gateway ended the registration, recording why", () => {
    expect(plan(row(), live("REJECTED"))).toEqual({
      kind: "sign-intent",
      reason: "gateway-terminal",
      attention: "gateway_registration_rejected",
    });
    expect(plan(row({ state: "ATTENTION" }), live("SUPERSEDED"))).toMatchObject({
      kind: "sign-intent",
      attention: "gateway_registration_superseded",
    });
  });

  it("blocks a changed card or a changed policy while the gateway holds the registration", () => {
    expect(plan(row(), live("PREPARED"), false)).toMatchObject({
      kind: "blocked",
      code: "card_changed_during_registration",
    });
    expect(plan(row({ state: "ATTENTION" }), live("ACTIVE"), false)).toMatchObject({
      kind: "blocked",
      code: "activated_registration_unpromoted",
    });
    expect(plan(row({
      canonical_intent: { payload: { railPolicyHash: `0x${"7".repeat(64)}` } } as GatewayRegistrationRow["canonical_intent"],
    }), live("PREPARED"))).toMatchObject({
      kind: "blocked",
      attention: "rail_policy_changed_during_prepare",
    });
  });

  it("blocks a gateway answer that no longer matches the persisted preparation", () => {
    const changed = live("ACTIVE", {
      prepared: { ...prepared, registrationId: "registration-1", listings: [{}] } as unknown as GatewayRegistrationView["prepared"],
    });
    expect(canonicalHash(changed.prepared)).not.toBe(canonicalHash(prepared));
    expect(plan(row(), changed)).toMatchObject({ kind: "blocked", code: "prepared_registration_changed" });
    expect(plan(row(), live("PREPARED", { registrationId: "registration-2" }))).toMatchObject({
      kind: "blocked",
      code: "gateway_registration_mismatch",
    });
  });
});
