import type { Hex } from "viem";
import { config } from "../config.js";
import { canonicalHash } from "../standardRail/canonical.js";
import { getGatewayRegistrationView, postGatewayEvidence } from "./gatewayApi.js";
import { saveRegistrationEvidence, type RegistrationRef } from "./store.js";
import type {
  GatewayRegistrationView,
  ProviderServiceRegistrationEvidenceEnvelope,
  RegistrationPolicy,
} from "./types.js";
import {
  GatewayRegistrationHttpError,
  registrationNonce,
  signProviderEnvelope,
} from "./wire.js";

/** The gateway ended the registration; it can never activate. */
export class GatewayRegistrationEndedError extends Error {
  constructor(readonly registrationId: string, readonly state: "REJECTED" | "SUPERSEDED") {
    super(`gateway registration ${registrationId} is ${state}`);
    this.name = "GatewayRegistrationEndedError";
  }
}

export interface EvidenceArgs {
  gatewayOrigin: string;
  registration: RegistrationRef;
  /** The gateway's live view: its state decides replay versus refresh. */
  view: GatewayRegistrationView;
  existingEvidence: ProviderServiceRegistrationEvidenceEnvelope | null;
  /** Confirmed deployments; only used when no evidence was signed yet. */
  splitterHashes: Array<{ listingId: string; transactionHash: Hex }>;
  policy: RegistrationPolicy;
}

async function signEvidence(
  args: EvidenceArgs,
  binding: ProviderServiceRegistrationEvidenceEnvelope["payload"] | null,
): Promise<ProviderServiceRegistrationEvidenceEnvelope> {
  const evidence = await signProviderEnvelope({
    artifactType: "ProviderServiceRegistrationEvidenceV1",
    environment: args.policy.environment,
    chainId: args.policy.chainId,
    audience: args.policy.audience,
    validForSeconds: args.policy.intentMaximumLifetimeSeconds,
    privateKey: config.PROVIDER_WALLET_PRIVATE_KEY as Hex,
    payload: {
      registrationId: binding?.registrationId ?? args.view.registrationId,
      preparedRegistrationHash: binding?.preparedRegistrationHash ??
        canonicalHash(args.view.prepared),
      // Only a registration the gateway still holds as PREPARED is ever
      // signed for, and the live view, not a stored one, says so.
      expectedState: "PREPARED" as const,
      splitterTransactionHashes: binding?.splitterTransactionHashes ?? args.splitterHashes,
      evidenceNonce: registrationNonce(),
    },
  });
  await saveRegistrationEvidence(args.registration, evidence, args.existingEvidence);
  return evidence;
}

function assertBindsView(
  evidence: ProviderServiceRegistrationEvidenceEnvelope,
  view: GatewayRegistrationView,
): void {
  if (
    evidence.payload.registrationId !== view.registrationId ||
    evidence.payload.preparedRegistrationHash !== canonicalHash(view.prepared)
  ) throw new Error(`persisted evidence does not bind gateway registration ${view.registrationId}`);
}

/**
 * Submit activation evidence according to the gateway's live state.
 *
 * EVIDENCE_PENDING: the gateway accepted an envelope and accepts only its
 * exact replay, which it honors beyond expiry. The persisted envelope is
 * posted unchanged and never re-signed, refreshed or overwritten.
 *
 * PREPARED: no evidence was accepted. A persisted envelope that expired, or
 * that the gateway refuses as unauthenticated once, is re-signed over the
 * same registration, preparation and original splitter transaction hashes
 * and persisted before it is posted. Splitters are never redeployed here.
 */
export async function submitEvidence(args: EvidenceArgs): Promise<{
  view: GatewayRegistrationView;
  evidence: ProviderServiceRegistrationEvidenceEnvelope;
}> {
  const view = args.view;
  if (view.state !== "PREPARED" && view.state !== "EVIDENCE_PENDING") {
    throw new Error(`gateway registration ${view.registrationId} is ${view.state}; evidence is not accepted`);
  }
  const existing = args.existingEvidence;
  if (!existing) {
    if (view.state === "EVIDENCE_PENDING") {
      throw new Error(`gateway registration ${view.registrationId} accepted evidence this provider has not persisted`);
    }
    const evidence = await signEvidence(args, null);
    return { view: await postGatewayEvidence(args.gatewayOrigin, view.registrationId, evidence), evidence };
  }
  assertBindsView(existing, view);
  if (view.state === "EVIDENCE_PENDING") {
    return {
      view: await postGatewayEvidence(args.gatewayOrigin, view.registrationId, existing),
      evidence: existing,
    };
  }
  const expired = existing.validBefore <= Math.floor(Date.now() / 1_000);
  if (expired) {
    const evidence = await signEvidence(args, existing.payload);
    return { view: await postGatewayEvidence(args.gatewayOrigin, view.registrationId, evidence), evidence };
  }
  try {
    return {
      view: await postGatewayEvidence(args.gatewayOrigin, view.registrationId, existing),
      evidence: existing,
    };
  } catch (error) {
    if (
      !(error instanceof GatewayRegistrationHttpError) ||
      error.status !== 401 ||
      error.code !== "EVIDENCE_AUTH_INVALID"
    ) throw error;
    const evidence = await signEvidence(args, existing.payload);
    return { view: await postGatewayEvidence(args.gatewayOrigin, view.registrationId, evidence), evidence };
  }
}

function durationFromEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < minimum || Number(raw) > maximum) {
    throw new Error(`${name} must be an integer number of milliseconds from ${minimum} to ${maximum}`);
  }
  return Number(raw);
}

/** Activation polling cadence; read per run so an operator override applies. */
export function activationPolling(): { intervalMs: number; timeoutMs: number; rekickMs: number } {
  return {
    // 20 seconds keeps a multi-service run inside the gateway's shared
    // registration rate limit.
    intervalMs: durationFromEnv("REGISTRATION_ACTIVATION_POLL_MS", 20_000, 1_000, 600_000),
    timeoutMs: durationFromEnv("REGISTRATION_ACTIVATION_TIMEOUT_MS", 1_800_000, 60_000, 86_400_000),
    rekickMs: durationFromEnv("REGISTRATION_ACTIVATION_REKICK_MS", 60_000, 1_000, 3_600_000),
  };
}

/**
 * The gateway accepts evidence with 202 and verifies asynchronously. Poll the
 * live registration until it turns ACTIVE; when verification sits idle long
 * enough that a transient failure may have ended it, resubmit through
 * submitEvidence, which replays an accepted envelope exactly.
 */
export async function awaitActivation(
  args: EvidenceArgs,
  evidence: ProviderServiceRegistrationEvidenceEnvelope,
): Promise<GatewayRegistrationView> {
  const polling = activationPolling();
  const deadline = Date.now() + polling.timeoutMs;
  let lastKick = Date.now();
  let current = evidence;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, polling.intervalMs));
    if (Date.now() > deadline) throw new Error("gateway activation polling timed out");
    const view = await getGatewayRegistrationView(args.gatewayOrigin, args.view.registrationId);
    if (view.state === "ACTIVE") return view;
    if (view.state === "REJECTED" || view.state === "SUPERSEDED") {
      throw new GatewayRegistrationEndedError(view.registrationId, view.state);
    }
    if (Date.now() - lastKick >= polling.rekickMs) {
      const submitted = await submitEvidence({ ...args, view, existingEvidence: current });
      current = submitted.evidence;
      lastKick = Date.now();
      if (submitted.view.state === "ACTIVE") return submitted.view;
    }
  }
}
