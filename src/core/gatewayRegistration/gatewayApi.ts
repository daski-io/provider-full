import { parseGatewayRegistrationView } from "./prepared.js";
import type {
  GatewayRegistrationView,
  ProviderServiceRegistrationEvidenceEnvelope,
  ProviderServiceRegistrationIntentEnvelope,
} from "./types.js";
import {
  GatewayRegistrationHttpError,
  requestBoundedJson,
  requestBoundedJsonResponse,
} from "./wire.js";

// The gateway's service-registration endpoints. Registration and evidence
// posts are idempotent at the gateway (idempotency key, exact replay); the
// read is the authoritative state every recovery decision starts from.

export async function getGatewayRegistrationView(
  gatewayOrigin: string,
  registrationId: string,
): Promise<GatewayRegistrationView> {
  return parseGatewayRegistrationView(await requestBoundedJson(
    `${gatewayOrigin}/v1/service-registrations/${encodeURIComponent(registrationId)}`,
  ));
}

/**
 * The live view of a registration, or "unknown" when the gateway answers
 * that it holds no such registration (its records were reset or lost). Any
 * other failure propagates.
 */
export async function findGatewayRegistrationView(
  gatewayOrigin: string,
  registrationId: string,
): Promise<GatewayRegistrationView | "unknown"> {
  try {
    return await getGatewayRegistrationView(gatewayOrigin, registrationId);
  } catch (error) {
    if (
      error instanceof GatewayRegistrationHttpError &&
      error.status === 404 &&
      error.code === "REGISTRATION_NOT_FOUND"
    ) return "unknown";
    throw error;
  }
}

/**
 * Post an intent. `created` is true only when the gateway prepared this
 * registration just now (201) from the card it fetched for this request; a
 * replay or a refreshed active registration answers 200 with the preparation
 * it stored earlier.
 */
export async function postGatewayRegistration(
  gatewayOrigin: string,
  idempotencyKey: string,
  intent: ProviderServiceRegistrationIntentEnvelope,
): Promise<{ view: GatewayRegistrationView; created: boolean }> {
  const response = await requestBoundedJsonResponse(
    `${gatewayOrigin}/v1/service-registrations`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(intent),
    },
  );
  return {
    view: parseGatewayRegistrationView(response.body),
    created: response.status === 201,
  };
}

export async function postGatewayEvidence(
  gatewayOrigin: string,
  registrationId: string,
  evidence: ProviderServiceRegistrationEvidenceEnvelope,
): Promise<GatewayRegistrationView> {
  return parseGatewayRegistrationView(await requestBoundedJson(
    `${gatewayOrigin}/v1/service-registrations/${encodeURIComponent(registrationId)}/evidence`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(evidence),
    },
  ));
}
