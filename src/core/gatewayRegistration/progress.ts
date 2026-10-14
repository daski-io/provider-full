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
import { verifyPreparedRegistration } from "./prepared.js";
import { promoteActiveRuntimeListings } from "./promotion.js";
import { confirmSplitterDeployments, ensureSplitterBroadcasts } from "./splitters.js";
import {
  markGatewayRegistrationActive,
  markGatewayRegistrationAttention,
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
// resume: broadcast and confirm splitters, submit evidence, await
// activation, and promote. Posting an intent is in intentPreparation.ts.

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
  options: { freshPreparation?: boolean } = {},
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
    checkAvailability: options.freshPreparation === true,
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
  // Promotion rebuilds every expected commitment from the activation it is
  // given, so it is only ever given the preparation verified above.
  if (
    active.registrationId !== view.registrationId ||
    canonicalHash(active.prepared) !== canonicalHash(view.prepared)
  ) {
    await markGatewayRegistrationAttention(local, "prepared_registration_changed");
    throw new Error(
      `${service.slug}: gateway registration ${view.registrationId} answered its activation with a preparation other than the one this provider verified`,
    );
  }
  return activate(context, service, local, active);
}
