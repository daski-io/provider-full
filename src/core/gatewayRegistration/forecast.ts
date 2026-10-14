import type { ServiceRow } from "../db/queries/services.js";
import { redactSensitiveText } from "../security/redaction.js";
import { ReusedListingDriftError, describeCrossCheck } from "./activationIdentity.js";
import { loadRegistrationContext } from "./chainContext.js";
import { planServiceRegistration } from "./client.js";
import { verifyRegistrationView } from "./progress.js";
import { crossCheckActivation, priorHeadsFor } from "./promotion.js";
import type { EvidenceStep, RegistrationPlan } from "./recovery.js";
import { listGatewaySplitterWrites, type GatewayRegistrationRow } from "./store.js";

export type RegistrationForecastState =
  /** Registered and unchanged: a run would do nothing. */
  | "ACTIVE"
  /** The gateway activated it: a run would promote; crossCheck says whether that passes. */
  | "RESUME"
  /** A pending gateway registration: a run would continue it under its persisted intent. */
  | "IN_PROGRESS"
  /** A run would sign a new intent (first admission, changed card, ended registration). */
  | "RE-REGISTER"
  /** A run would refuse; detail names the reason. */
  | "BLOCKED";

export interface RegistrationForecast {
  serviceSlug: string;
  state: RegistrationForecastState;
  /** The next step a registration run would take. */
  action: string;
  detail: string;
  registrationId?: string;
  gatewayState?: string;
  changedSkills?: string[];
  crossCheck?: { ok: boolean; matched: number; total: number; reused: number; detail: string };
  splitters?: { required: number; journaled: number; confirmed: number };
}

const EVIDENCE_ACTIONS: Record<EvidenceStep, string> = {
  "replay-accepted": "replay-accepted-evidence",
  "refresh-unaccepted": "refresh-unaccepted-evidence",
  "resubmit-unaccepted": "resubmit-unaccepted-evidence",
  "sign-new": "confirm-splitters-and-submit-evidence",
};

function safeDetail(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .slice(0, 512);
}

async function splitterSummary(
  local: GatewayRegistrationRow,
  plan: Extract<RegistrationPlan, { kind: "continue" }>,
): Promise<NonNullable<RegistrationForecast["splitters"]>> {
  const required = new Set(plan.view.prepared.listings
    .filter((listing) => listing.deploymentRequired)
    .map((listing) => listing.listingId));
  const rows = (await listGatewaySplitterWrites(local.id))
    .filter((row) => required.has(row.listing_id));
  return {
    required: required.size,
    journaled: rows.filter((row) => row.provider_write_id !== null).length,
    confirmed: rows.filter((row) => row.state === "CONFIRMED").length,
  };
}

/**
 * Read-only forecast of what registerServiceWithGateway would do for one
 * service: the same chain, card, local-record, gateway and catalog reads, the
 * same recovery decision, verification and promotion cross-check, and no
 * write. Nothing is signed, broadcast, posted, promoted or persisted; gateway
 * access is GET only.
 */
export async function checkServiceRegistration(
  gateway: string,
  service: ServiceRow,
): Promise<RegistrationForecast> {
  const base = { serviceSlug: service.slug };
  if (!service.on_chain_id) {
    return {
      ...base,
      state: "RE-REGISTER",
      action: "register-service-on-chain",
      detail: "the service has no ServiceRegistry id yet; a run would register it on chain before gateway admission",
    };
  }
  const context = await loadRegistrationContext(gateway, service);
  const { local, plan } = await planServiceRegistration(context);
  const heads = await priorHeadsFor(context.gatewayOrigin, context.record.serviceId);
  const changedSkills = context.published.skills
    .filter((skill) => heads.get(skill.skillId)?.runtimeCommitment.skillContractHash
      .toLowerCase() !== skill.skillContractHash.toLowerCase())
    .map((skill) => skill.skillId);
  const registrationId = local?.gateway_registration_id ?? undefined;
  switch (plan.kind) {
    case "unchanged":
      return { ...base, state: "ACTIVE", action: "none", detail: "registered and unchanged", registrationId };
    case "blocked":
      return {
        ...base,
        state: "BLOCKED",
        action: plan.code,
        detail: plan.attention
          ? `${plan.detail}; a run would record ATTENTION ${plan.attention} and stop`
          : plan.detail,
        registrationId,
      };
    case "sign-intent":
      return {
        ...base,
        state: "RE-REGISTER",
        action: "sign-new-intent",
        detail: `${plan.reason}; skills with a changed contract: ${changedSkills.join(", ") || "none"}`,
        changedSkills,
        registrationId,
      };
    case "post-intent":
      return {
        ...base,
        state: "IN_PROGRESS",
        action: "post-persisted-intent",
        detail: "a signed intent awaits gateway preparation; a run would post it under its idempotency key",
      };
    case "promote":
    case "continue": {
      const gatewayState = plan.view.state;
      try {
        await verifyRegistrationView(context, plan.view, local!.canonical_intent);
      } catch (error) {
        return {
          ...base,
          state: "BLOCKED",
          action: "prepared-registration-verification",
          detail: safeDetail(error),
          registrationId,
          gatewayState,
        };
      }
      if (plan.kind === "continue") {
        return {
          ...base,
          state: "IN_PROGRESS",
          action: EVIDENCE_ACTIONS[plan.evidence],
          detail: `gateway registration ${plan.view.registrationId} ${gatewayState}; local ${local!.state}`,
          registrationId,
          gatewayState,
          splitters: await splitterSummary(local!, plan),
        };
      }
      try {
        const check = crossCheckActivation({ view: plan.view, policy: context.policy, priorHeads: heads });
        return {
          ...base,
          state: "RESUME",
          action: "promote",
          detail: `gateway registration ${plan.view.registrationId} ACTIVE; local ${local!.state}; promotion cross-check ${check.ok ? "passes" : "FAILS"}`,
          registrationId,
          gatewayState,
          crossCheck: {
            ok: check.ok,
            matched: check.verdicts.filter((verdict) => verdict.match).length,
            total: check.verdicts.length,
            reused: check.verdicts.filter((verdict) => verdict.reused).length,
            detail: describeCrossCheck(check),
          },
        };
      } catch (error) {
        if (!(error instanceof ReusedListingDriftError)) throw error;
        return {
          ...base,
          state: "BLOCKED",
          action: "reused_listing_drift",
          detail: error.message,
          registrationId,
          gatewayState,
        };
      }
    }
  }
}

/** True when a forecast predicts a refused or failing run. */
export function forecastFails(forecast: RegistrationForecast): boolean {
  return forecast.state === "BLOCKED" || forecast.crossCheck?.ok === false;
}
