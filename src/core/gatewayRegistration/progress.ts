import { getAddress, type Hex } from "viem";
import { config } from "../config.js";
import type { ServiceRow } from "../db/queries/services.js";
import { publicClient } from "../chain/client.js";
import { canonicalHash } from "../standardRail/canonical.js";
import { gatewaySigner, type RegistrationContext } from "./chainContext.js";
import {
  GatewayRegistrationEndedError,
  awaitActivation,
  submitEvidence,
} from "./evidence.js";
import { postGatewayRegistration } from "./gatewayApi.js";
import { verifyPreparedRegistration } from "./prepared.js";
import { promoteActiveRuntimeListings } from "./promotion.js";
import { confirmSplitterDeployments, ensureSplitterBroadcasts } from "./splitters.js";
import {
  markGatewayRegistrationActive,
  markGatewayRegistrationAttention,
  savePreparedRegistration,
  type GatewayRegistrationRow,
} from "./store.js";
import type {
  GatewayRegistrationView,
  ProviderServiceRegistrationIntentEnvelope,
} from "./types.js";
import {
  GatewayRegistrationHttpError,
  registrationNonce,
  signProviderEnvelope,
} from "./wire.js";

// The steps a registration run executes once recovery has decided where to
// resume: post an intent, broadcast and confirm splitters, submit evidence,
// await activation, and promote.

export interface RegistrationOutcome {
  serviceSlug: string;
  state: string;
  registrationId: string;
}

export type RegistrationPhase = "broadcast" | "full";

export function cardMatchesRegistration(
  local: GatewayRegistrationRow | null,
  context: RegistrationContext,
): boolean {
  return local !== null && local.card_contract_hash.equals(
    Buffer.from(context.published.serviceContractHash.slice(2), "hex"),
  );
}

export async function verifyRegistrationView(
  context: RegistrationContext,
  view: GatewayRegistrationView,
  intent: ProviderServiceRegistrationIntentEnvelope,
): Promise<void> {
  await verifyPreparedRegistration({
    view,
    intent,
    service: context.published,
    providerAgentId: config.PROVIDER_AGENT_ID.toString(),
    providerPayee: context.providerPayee,
    serviceWallet: getAddress(context.record.serviceWallet),
    policy: context.policy,
    gatewaySigner: gatewaySigner(),
    publicClient,
    finalizedBlock: context.finalizedBlock,
  });
}

export async function signRegistrationIntent(
  context: RegistrationContext,
): Promise<ProviderServiceRegistrationIntentEnvelope> {
  const { policy, record, published } = context;
  return signProviderEnvelope({
    artifactType: "ProviderServiceRegistrationIntentV1",
    environment: policy.environment,
    chainId: policy.chainId,
    audience: policy.audience,
    validForSeconds: policy.intentMaximumLifetimeSeconds,
    privateKey: config.PROVIDER_WALLET_PRIVATE_KEY as Hex,
    payload: {
      providerAgentId: config.PROVIDER_AGENT_ID.toString(),
      serviceId: record.serviceId,
      serviceSlug: record.serviceSlug,
      serviceVersion: record.version,
      providerPayee: context.providerPayee,
      serviceContractHash: published.serviceContractHash,
      skillContractSetHash: published.skillContractSetHash,
      skills: published.skills.map(({ skillId, skillContractHash }) => ({
        skillId,
        skillContractHash,
      })),
      railPolicyHash: policy.railPolicyHash,
      registrationNonce: registrationNonce(),
    },
  });
}

export async function activate(
  context: RegistrationContext,
  service: ServiceRow,
  local: GatewayRegistrationRow,
  view: GatewayRegistrationView,
): Promise<RegistrationOutcome> {
  await promoteActiveRuntimeListings({
    registration: local,
    gatewayOrigin: context.gatewayOrigin,
    view,
    policy: context.policy,
    published: context.published,
    intent: local.canonical_intent,
    finalizedBlock: context.finalizedBlock,
  });
  await markGatewayRegistrationActive(local, view.registrationId);
  return { serviceSlug: service.slug, state: "ACTIVE", registrationId: view.registrationId };
}

// Continue a registration the gateway still holds as pending. Saved evidence
// means every splitter was confirmed before it was signed, so recovery never
// touches the chain again; it only replays or refreshes that evidence.
export async function continueRegistration(
  context: RegistrationContext,
  service: ServiceRow,
  local: GatewayRegistrationRow,
  view: GatewayRegistrationView,
  phase: RegistrationPhase,
): Promise<RegistrationOutcome> {
  const evidence = local.canonical_evidence;
  if (phase === "broadcast") {
    if (!evidence) await ensureSplitterBroadcasts(local, view);
    return {
      serviceSlug: service.slug,
      state: evidence ? "EVIDENCE_SUBMITTED" : "BROADCAST",
      registrationId: view.registrationId,
    };
  }
  const evidenceArgs = {
    gatewayOrigin: context.gatewayOrigin,
    registration: local,
    view,
    existingEvidence: evidence,
    splitterHashes: evidence?.payload.splitterTransactionHashes ??
      await confirmSplitterDeployments(local, view),
    policy: context.policy,
  };
  let active: GatewayRegistrationView;
  try {
    const submitted = await submitEvidence(evidenceArgs);
    active = submitted.view.state === "ACTIVE"
      ? submitted.view
      : await awaitActivation(evidenceArgs, submitted.evidence);
  } catch (error) {
    if (
      error instanceof GatewayRegistrationHttpError &&
      error.code === "PREPARED_REGISTRATION_DRIFT"
    ) {
      await markGatewayRegistrationAttention(local, "prepared_registration_drift");
    } else if (error instanceof GatewayRegistrationEndedError) {
      await markGatewayRegistrationAttention(
        local,
        `gateway_registration_${error.state.toLowerCase()}`,
      );
    }
    throw error;
  }
  return activate(context, service, local, active);
}

/**
 * Post a persisted intent. The gateway replays an intent it already prepared
 * under the same idempotency key, so a lost response is recovered here. An
 * expired intent the gateway never accepted is reported to `onExpiredIntent`,
 * which decides whether a fresh one is worth another attempt.
 */
export async function prepareRegistration(
  context: RegistrationContext,
  service: ServiceRow,
  local: GatewayRegistrationRow,
  phase: RegistrationPhase,
  onExpiredIntent: () => Promise<RegistrationOutcome>,
): Promise<RegistrationOutcome> {
  let view: GatewayRegistrationView;
  try {
    view = await postGatewayRegistration(
      context.gatewayOrigin,
      local.idempotency_key,
      local.canonical_intent,
    );
  } catch (error) {
    if (
      local.canonical_intent.validBefore <= Math.floor(Date.now() / 1_000) &&
      error instanceof GatewayRegistrationHttpError &&
      error.status === 401 &&
      error.code === "REGISTRATION_AUTH_INVALID"
    ) {
      if (!await markGatewayRegistrationAttention(local, "intent_expired_before_prepare")) {
        throw new Error(`${service.slug}: another registration run replaced the expired intent`);
      }
      return onExpiredIntent();
    }
    throw error;
  }
  if (view.prepared.providerIntentHash !== canonicalHash(local.canonical_intent)) {
    throw new Error(
      `${service.slug}: the gateway answered registration ${view.registrationId} (${view.state}) admitted under provider intent ${view.prepared.providerIntentHash}, which is not the intent this provider persisted`,
    );
  }
  if (!cardMatchesRegistration(local, context)) {
    throw new Error(
      `${service.slug} registration card_changed_during_registration: the served card changed while gateway registration ${view.registrationId} is ${view.state}`,
    );
  }
  if (view.state !== "PREPARED" && view.state !== "ACTIVE") {
    throw new Error(
      `${service.slug}: the gateway answered registration ${view.registrationId} as ${view.state}${view.state === "EVIDENCE_PENDING" ? " with evidence this provider has not persisted" : ""}`,
    );
  }
  await verifyRegistrationView(context, view, local.canonical_intent);
  const prepared = await savePreparedRegistration(local, view);
  return view.state === "ACTIVE"
    ? activate(context, service, prepared, view)
    : continueRegistration(context, service, prepared, view, phase);
}
