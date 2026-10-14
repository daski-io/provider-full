import type { ValidateFunction } from "ajv";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getServiceBySlug } from "../db/queries/services.js";
import { getAdapter } from "../serviceRegistry/registry.js";
import { contractHandler } from "../serviceRegistry/retainedHandlers.js";
import type { IntakeDetail } from "../serviceRegistry/types.js";
import { canonicalHash } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { verifyGatewayEnvelope } from "./gatewayEnvelope.js";
import {
  assertBoundedJsonValue,
  INTAKE_RESPONSE_JSON_BUDGET,
  REQUEST_JSON_BUDGET,
} from "./jsonBounds.js";
import { headListingVersion } from "./listingVersions.js";
import { QuoteRefusedError, quoteEnvelopeRefusal } from "./quoteErrors.js";
import { MAX_QUOTE_FIELD_ERRORS, providerSchemaFieldErrors, serviceFieldErrors } from "./quoteFieldErrors.js";

interface IntakeRequest {
  outcomeId: string;
  listingManifestHash: Hex;
  requestHash: Hex;
  request: Record<string, unknown>;
}

/** The gateway accepts intake answers valid for at most 120 s. */
const INTAKE_RESPONSE_LIFETIME_SECONDS = 60;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** A request the gateway could not have canonicalized never matches its hash. */
export function requestMatchesHash(request: unknown, requestHash: Hex): boolean {
  try {
    return canonicalHash(request) === requestHash;
  } catch {
    return false;
  }
}

function parseIntakeDetail(value: unknown): IntakeDetail {
  if (
    !isRecord(value) || !isRecord(value.requiredFields) || !isRecord(value.normalizedSelectors) ||
    !Array.isArray(value.selectorsRequired) || value.selectorsRequired.length > 64 ||
    !value.selectorsRequired.every((entry) => typeof entry === "string" && entry.length <= 128) ||
    !Array.isArray(value.fieldErrors) || ![true, false, null].includes(value.supported as boolean | null)
  ) throw new QuoteRefusedError(503, "service_unavailable");
  return {
    requiredFields: value.requiredFields,
    selectorsRequired: value.selectorsRequired as string[],
    fieldErrors: serviceFieldErrors(value.fieldErrors as unknown[]),
    supported: value.supported as boolean | null,
    normalizedSelectors: value.normalizedSelectors,
  };
}

/**
 * Authenticated intake discovery on the admitted quote endpoint. It is
 * independent of quote creation: nothing is stored, priced, or started.
 */
export async function describeIntake(args: {
  config: ProviderStandardRailConfig;
  chainId: number;
  envelope: unknown;
  validatorFor: (outcomeId: string) => ValidateFunction | undefined;
}): Promise<Record<string, unknown>> {
  const { config } = args;
  const envelope = await verifyGatewayEnvelope<IntakeRequest>(args.envelope, {
    artifactType: "ProviderIntakeRequestV1",
    schemaVersion: 1,
    payloadKeys: ["outcomeId", "listingManifestHash", "requestHash", "request"],
    environment: config.environment,
    chainId: args.chainId,
    audience: config.providerAudience,
    signer: config.gatewayDispatchSigner,
    lifetime: { maxRemainingSeconds: 120, maxAgeSeconds: 120 },
  }).catch((error: unknown) => { throw quoteEnvelopeRefusal(error); });
  const payload = envelope.payload;
  if (!isRecord(payload.request)) throw new QuoteRefusedError(400, "envelope");
  try {
    assertBoundedJsonValue(payload.request, REQUEST_JSON_BUDGET, "Intake request");
  } catch {
    throw new QuoteRefusedError(422, "request_invalid");
  }
  if (!requestMatchesHash(payload.request, payload.requestHash)) throw new QuoteRefusedError(400, "envelope");
  const outcome = config.outcomes.get(payload.outcomeId);
  const validate = args.validatorFor(payload.outcomeId);
  if (!outcome || !validate || outcome.listingManifestHash !== payload.listingManifestHash) {
    throw new QuoteRefusedError(409, "outcome_policy");
  }
  const service = await getServiceBySlug(outcome.serviceSlug);
  if (!service?.is_active) throw new QuoteRefusedError(503, "service_unavailable");
  const version = headListingVersion(config, outcome);
  const handler = contractHandler(version.serviceSlug, version.skillId, version.contract);
  if (!handler) throw new QuoteRefusedError(503, "service_unavailable");
  const adapter = handler.kind === "retained" ? handler.adapter : getAdapter(service.adapter_name);
  let detail: IntakeDetail | null = null;
  if (adapter.intake) {
    try {
      detail = parseIntakeDetail(await adapter.intake(outcome.skillId, structuredClone(payload.request)));
    } catch {
      throw new QuoteRefusedError(503, "service_unavailable");
    }
  }
  // Normalized selectors may complete the request; only published fields
  // participate, and the base schema stays authoritative.
  const properties = outcome.requestSchema.properties;
  const normalized = Object.fromEntries(Object.entries(detail?.normalizedSelectors ?? {})
    .filter(([key]) => Object.prototype.hasOwnProperty.call(properties, key)));
  validate({ ...payload.request, ...normalized });
  const fieldErrors = [...providerSchemaFieldErrors(validate.errors), ...(detail?.fieldErrors ?? [])]
    .filter((entry, index, all) =>
      all.findIndex((other) => other.path === entry.path && other.rule === entry.rule) === index)
    .slice(0, MAX_QUOTE_FIELD_ERRORS);
  const issuedAt = Math.floor(Date.now() / 1_000);
  const response = {
    outcomeId: outcome.outcomeId,
    listingManifestHash: outcome.listingManifestHash,
    requestHash: payload.requestHash,
    requestSchema: outcome.requestSchema,
    requiredFields: detail?.requiredFields ?? {},
    selectorsRequired: detail?.selectorsRequired ?? [],
    normalizedSelectors: detail?.normalizedSelectors ?? {},
    fieldErrors,
    supported: detail?.supported ?? null,
    issuedAt,
    validBefore: issuedAt + INTAKE_RESPONSE_LIFETIME_SECONDS,
  };
  try {
    assertBoundedJsonValue(response, INTAKE_RESPONSE_JSON_BUDGET, "Intake response");
  } catch {
    throw new QuoteRefusedError(503, "service_unavailable");
  }
  const signature = await privateKeyToAccount(config.providerAuthorityPrivateKey).signMessage({
    message: { raw: canonicalHash(response) },
  });
  return { ...response, signature };
}
