import type { ServiceRow } from "../db/queries/services.js";
import { canonicalHash } from "../standardRail/canonical.js";
import type { RegistrationContext } from "./chainContext.js";
import { postGatewayRegistration } from "./gatewayApi.js";
import {
  activate,
  cardMatchesRegistration,
  continueRegistration,
  verifyRegistrationView,
  type RegistrationOutcome,
  type RegistrationPhase,
} from "./progress.js";
import {
  markGatewayRegistrationAttention,
  savePreparedRegistration,
  type GatewayRegistrationRow,
} from "./store.js";
import type { GatewayRegistrationView } from "./types.js";
import { GatewayRegistrationHttpError } from "./wire.js";

// Posting a persisted intent: the only way to learn whether the gateway
// prepared it, and the step that decides whether a stale intent is replaced.

/** Why a persisted intent was abandoned before the gateway prepared it. */
export type StaleIntentReason = "expired" | "superseded" | "ended";

/**
 * What a persisted intent binds that the provider no longer serves, in the
 * order recovery reports it: the card, the gateway rail policy, the payee.
 */
export function staleIntentBindings(
  local: GatewayRegistrationRow,
  context: RegistrationContext,
): Array<"card" | "rail policy" | "payee"> {
  const payload = local.canonical_intent.payload;
  const stale: Array<"card" | "rail policy" | "payee"> = [];
  if (!cardMatchesRegistration(local, context)) stale.push("card");
  if (payload.railPolicyHash !== context.policy.railPolicyHash) stale.push("rail policy");
  if (payload.providerPayee.toLowerCase() !== context.providerPayee.toLowerCase()) {
    stale.push("payee");
  }
  return stale;
}

const STALE_BINDING_CODES = {
  card: "card_changed_during_registration",
  "rail policy": "rail_policy_changed_during_prepare",
  payee: "payee_changed_during_registration",
} as const;

// The gateway answers a replay of an intent it prepared before it checks the
// signature or the contract, so these refusals prove it never prepared this
// one, and a fresh intent can safely replace it.
function unpreparedIntent(
  error: unknown,
  local: GatewayRegistrationRow,
  context: RegistrationContext,
): { reason: StaleIntentReason; attention: string } | null {
  if (!(error instanceof GatewayRegistrationHttpError)) return null;
  if (
    error.status === 401 &&
    error.code === "REGISTRATION_AUTH_INVALID" &&
    local.canonical_intent.validBefore <= Math.floor(Date.now() / 1_000)
  ) return { reason: "expired", attention: "intent_expired_before_prepare" };
  if (
    error.status === 409 &&
    error.code === "REGISTRATION_CONTRACT_MISMATCH" &&
    staleIntentBindings(local, context).length > 0
  ) return { reason: "superseded", attention: "intent_superseded_before_prepare" };
  return null;
}

/**
 * Post a persisted intent. The gateway replays an intent it already prepared
 * under the same idempotency key, so a lost response is recovered here, and
 * posting it is the only way to learn whether the gateway prepared it. An
 * intent the gateway provably never prepared (expired, or refused for a card,
 * rail policy or payee the provider no longer serves), or one whose
 * registration the gateway has since ended, is reported to `onStaleIntent`,
 * which decides whether a fresh one is worth another attempt.
 */
export async function prepareRegistration(
  context: RegistrationContext,
  service: ServiceRow,
  local: GatewayRegistrationRow,
  phase: RegistrationPhase,
  onStaleIntent: (reason: StaleIntentReason) => Promise<RegistrationOutcome>,
): Promise<RegistrationOutcome> {
  const abandon = async (reason: StaleIntentReason, attention: string) => {
    if (!await markGatewayRegistrationAttention(local, attention)) {
      throw new Error(`${service.slug}: another registration run replaced the persisted intent`);
    }
    return onStaleIntent(reason);
  };
  let view: GatewayRegistrationView;
  let created: boolean;
  try {
    ({ view, created } = await postGatewayRegistration(
      context.gatewayOrigin,
      local.idempotency_key,
      local.canonical_intent,
    ));
  } catch (error) {
    const unprepared = unpreparedIntent(error, local, context);
    if (unprepared) return abandon(unprepared.reason, unprepared.attention);
    throw error;
  }
  if (view.prepared.providerIntentHash !== canonicalHash(local.canonical_intent)) {
    throw new Error(
      `${service.slug}: the gateway answered registration ${view.registrationId} (${view.state}) admitted under provider intent ${view.prepared.providerIntentHash}, which is not the intent this provider persisted`,
    );
  }
  if (view.state === "REJECTED" || view.state === "SUPERSEDED") {
    // Prepared under this intent earlier, then ended by the gateway.
    return abandon("ended", `gateway_registration_${view.state.toLowerCase()}`);
  }
  const stale = staleIntentBindings(local, context);
  if (stale.length > 0) {
    throw new Error(
      `${service.slug} registration ${STALE_BINDING_CODES[stale[0]!]}: the gateway holds registration ${view.registrationId} (${view.state}) for the persisted intent, which binds the previous ${stale.join(", ")}`,
    );
  }
  if (view.state !== "PREPARED" && view.state !== "ACTIVE") {
    throw new Error(
      `${service.slug}: the gateway answered registration ${view.registrationId} as ${view.state}${view.state === "EVIDENCE_PENDING" ? " with evidence this provider has not persisted" : ""}`,
    );
  }
  await verifyRegistrationView(context, view, local.canonical_intent, { freshPreparation: created });
  const prepared = await savePreparedRegistration(local, view);
  return view.state === "ACTIVE"
    ? activate(context, service, prepared, view)
    : continueRegistration(context, service, prepared, view, phase);
}
