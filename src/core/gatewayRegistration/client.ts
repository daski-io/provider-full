import type { ServiceRow } from "../db/queries/services.js";
import { logInfo } from "../logger.js";
import { canonicalHash } from "../standardRail/canonical.js";
import { loadRegistrationContext, type RegistrationContext } from "./chainContext.js";
import { getGatewayRegistrationView } from "./gatewayApi.js";
import {
  activate,
  cardMatchesRegistration,
  continueRegistration,
  prepareRegistration,
  signRegistrationIntent,
  verifyRegistrationView,
  type RegistrationOutcome,
  type RegistrationPhase,
} from "./progress.js";
import {
  needsLiveRegistrationView,
  planRegistration,
  type RegistrationPlan,
} from "./recovery.js";
import {
  beginGatewayRegistration,
  getGatewayRegistration,
  markGatewayRegistrationAttention,
  resumeGatewayRegistration,
  type GatewayRegistrationRow,
} from "./store.js";

export type { RegistrationOutcome } from "./progress.js";

// Persistent clock skew or repeated gateway auth rejection must not churn
// forever: the intent-expiry retry re-enters the whole idempotent workflow,
// so it carries a local attempt budget.
const MAX_REGISTRATION_INTENT_ATTEMPTS = 3;

async function registrationRetryDelay(attempt: number): Promise<void> {
  const jitter = Math.floor(Math.random() * 250);
  await new Promise((resolve) => setTimeout(resolve, attempt * 500 + jitter));
}

/** Read local state and the gateway's live view, then decide the next step. */
export async function planServiceRegistration(context: RegistrationContext): Promise<{
  local: GatewayRegistrationRow | null;
  plan: RegistrationPlan;
}> {
  const local = await getGatewayRegistration(context.gatewayOrigin, context.record.serviceId);
  const live = needsLiveRegistrationView(local)
    ? await getGatewayRegistrationView(context.gatewayOrigin, local.gateway_registration_id)
    : null;
  return {
    local,
    plan: planRegistration({
      local,
      cardMatches: cardMatchesRegistration(local, context),
      live,
      railPolicyHash: context.policy.railPolicyHash,
      nowSeconds: Math.floor(Date.now() / 1_000),
    }),
  };
}

async function execute(
  gateway: string,
  context: RegistrationContext,
  service: ServiceRow,
  local: GatewayRegistrationRow | null,
  plan: RegistrationPlan,
  attempt: number,
  phase: RegistrationPhase,
): Promise<RegistrationOutcome> {
  const onExpiredIntent = async () => {
    if (attempt >= MAX_REGISTRATION_INTENT_ATTEMPTS) {
      throw new Error(
        `${service.slug} registration intent expired ${attempt} times before the gateway accepted it`,
      );
    }
    await registrationRetryDelay(attempt);
    return registerServiceWithGateway(gateway, service, attempt + 1, phase);
  };
  switch (plan.kind) {
    case "unchanged":
      return {
        serviceSlug: service.slug,
        state: "ACTIVE",
        registrationId: local!.gateway_registration_id!,
      };
    case "blocked":
      if (plan.attention && local) {
        await markGatewayRegistrationAttention(local.id, plan.attention);
      }
      throw new Error(`${service.slug} registration ${plan.code}: ${plan.detail}`);
    case "promote":
      // The gateway already activated the persisted registration: resume at
      // promotion with the persisted intent. Nothing is signed or broadcast.
      await verifyRegistrationView(context, plan.view, local!.canonical_intent);
      return activate(context, service, local!, plan.view);
    case "continue": {
      // Continue the registration the gateway still holds under its
      // persisted intent; ATTENTION is left only once it verifies.
      await verifyRegistrationView(context, plan.view, local!.canonical_intent);
      const resumed = local!.state === "ATTENTION"
        ? await resumeGatewayRegistration(local!.id)
        : local!;
      return continueRegistration(context, service, resumed, plan.view, phase);
    }
    case "post-intent":
      return prepareRegistration(context, service, local!, phase, onExpiredIntent);
    case "sign-intent": {
      let replacing = local;
      if (plan.attention && local) {
        await markGatewayRegistrationAttention(local.id, plan.attention);
        replacing = await getGatewayRegistration(context.gatewayOrigin, context.record.serviceId);
      }
      if (plan.reason !== "first-admission" && plan.reason !== "card-changed") {
        logInfo("Gateway registration restarts with a new intent", {
          serviceSlug: service.slug,
          reason: plan.reason,
          priorRegistrationId: local?.gateway_registration_id ?? null,
          priorErrorCode: plan.attention ?? local?.last_error_code ?? null,
        });
      }
      const intent = await signRegistrationIntent(context);
      const begun = await beginGatewayRegistration({
        gatewayOrigin: context.gatewayOrigin,
        serviceRowId: service.id,
        serviceId: context.record.serviceId,
        cardContractHash: context.published.serviceContractHash,
        idempotencyKey: `svc-${canonicalHash(intent).slice(2, 50)}`,
        intent,
        replacing,
      });
      return prepareRegistration(context, service, begun, phase, onExpiredIntent);
    }
  }
}

/**
 * Drive one service's gateway registration to ACTIVE, resuming whatever a
 * previous run left behind. `phase` "broadcast" stops after submitting the
 * splitter deployments so every service's transactions share one finality
 * window; "full" (default) confirms them, submits evidence, and activates.
 */
export async function registerServiceWithGateway(
  gateway: string,
  service: ServiceRow,
  attempt = 1,
  phase: RegistrationPhase = "full",
): Promise<RegistrationOutcome> {
  const context = await loadRegistrationContext(gateway, service);
  const { local, plan } = await planServiceRegistration(context);
  return execute(gateway, context, service, local, plan, attempt, phase);
}
