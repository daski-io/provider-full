import { randomBytes } from "node:crypto";
import {
  getAddress,
  recoverMessageAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  assertNoDuplicateJsonKeys,
  canonicalHash,
  unsignedEnvelopeHash,
} from "../standardRail/canonical.js";
import type { SignedEnvelope } from "../standardRail/types.js";
import type {
  ProviderServiceRegistrationEvidenceV1,
  ProviderServiceRegistrationIntentV1,
  PublishedServiceContract,
  PublishedSkillContract,
  RegistrationPolicy,
} from "./types.js";

const POLICY_KEYS = [
  "schemaVersion", "environment", "chainId", "audience",
  "providerSignerKeyId", "serviceRegistry", "defaultMarketplaceEnabled",
  "railPolicyHash", "canonicalToken", "daskiCommissionReceiver",
  "commissionBps", "splitterFactory", "splitterCreationCodeHash",
  "splitterFactoryRuntimeCodeHash",
  "intentMaximumLifetimeSeconds",
] as const;
const V1_URI = "https://daski.io/a2a/v1";
const V2_URI = "https://daski.io/a2a/v2";

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  const found = object(value, label);
  if (
    Object.keys(found).length !== keys.length ||
    Object.keys(found).some((key) => !keys.includes(key))
  ) throw new Error(`${label} fields are invalid`);
  return found;
}

function hash(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must be bytes32`);
  }
  return value.toLowerCase() as Hex;
}

function address(value: unknown, label: string): Address {
  try {
    return getAddress(value as string);
  } catch {
    throw new Error(`${label} must be an address`);
  }
}

function text(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" || value.length < 1 ||
    value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)
  ) throw new Error(`${label} is invalid`);
  return value;
}

function normalizedId(value: unknown, label: string, maximum: number): string {
  const found = text(value, label, maximum);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(found)) throw new Error(`${label} is invalid`);
  return found;
}

function stringArray(value: unknown, label: string, maximum = 64): string[] {
  if (
    !Array.isArray(value) || value.length > maximum ||
    value.some((item) =>
      typeof item !== "string" || item.length < 1 || item.length > 256)
  ) throw new Error(`${label} is invalid`);
  return value as string[];
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function sameOriginUrl(value: unknown, label: string, origin: string): string {
  const parsed = new URL(text(value, label, 2_048));
  if (
    parsed.protocol !== "https:" || parsed.origin !== origin ||
    parsed.username || parsed.password || parsed.hash
  ) throw new Error(`${label} must be same-origin HTTPS`);
  return parsed.toString();
}

function httpsUrl(value: unknown, label: string): string {
  const parsed = new URL(text(value, label, 2_048));
  if (
    parsed.protocol !== "https:" ||
    parsed.username || parsed.password || parsed.hash
  ) throw new Error(`${label} must be credential-free HTTPS`);
  return parsed.toString();
}

export function normalizedGatewayOrigin(raw: string): string {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" || url.username || url.password ||
    url.pathname !== "/" || url.search || url.hash
  ) throw new Error("gateway must be a credential-free HTTPS origin");
  return url.origin;
}

export class GatewayRegistrationHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    detail: string | null = null,
  ) {
    super(`Gateway registration HTTP ${status}${code ? ` (${code})` : ""}${detail ? ` — ${detail}` : ""}`);
    this.name = "GatewayRegistrationHttpError";
  }
}

export async function requestBoundedJson(
  url: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    method: init.method ?? "GET",
    redirect: "error",
    headers: { accept: "application/json", ...init.headers },
    signal: AbortSignal.timeout(10_000),
  });
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error("registration endpoint did not return JSON");
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > 1_048_576) {
    throw new Error("registration response exceeds 1 MiB");
  }
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength > 1_048_576) throw new Error("registration response exceeds 1 MiB");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  assertNoDuplicateJsonKeys(text);
  const parsed = JSON.parse(text) as unknown;
  if (!response.ok) {
    const error = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { error?: { code?: unknown } }).error
      : undefined;
    const code = typeof error?.code === "string" &&
        /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
      ? error.code
      : null;
    const message = (error as { message?: unknown } | undefined)?.message;
    const detail = typeof message === "string" &&
        /^[\x20-\x7e]{1,240}$/.test(message)
      ? message
      : null;
    throw new GatewayRegistrationHttpError(response.status, code, detail);
  }
  return parsed;
}

export function fetchBoundedJson(url: string): Promise<unknown> {
  return requestBoundedJson(url);
}

export function parseRegistrationPolicy(
  raw: unknown,
  expected: {
    gatewayOrigin: string;
    chainId: number;
    serviceRegistry: Address;
    canonicalToken: Address;
  },
): RegistrationPolicy {
  const value = exact(raw, POLICY_KEYS, "registration policy");
  if (
    value.schemaVersion !== 1 ||
    typeof value.environment !== "string" ||
    value.environment.length < 1 ||
    value.chainId !== expected.chainId ||
    value.audience !== expected.gatewayOrigin ||
    value.providerSignerKeyId !== "provider-authority" ||
    typeof value.defaultMarketplaceEnabled !== "boolean" ||
    !Number.isSafeInteger(value.commissionBps) ||
    (value.commissionBps as number) < 1 ||
    (value.commissionBps as number) >= 10_000 ||
    !Number.isSafeInteger(value.intentMaximumLifetimeSeconds) ||
    (value.intentMaximumLifetimeSeconds as number) < 60 ||
    (value.intentMaximumLifetimeSeconds as number) > 600
  ) throw new Error("registration policy domain or limits are invalid");
  const policy: RegistrationPolicy = {
    ...value,
    schemaVersion: 1,
    environment: value.environment,
    chainId: value.chainId,
    audience: value.audience,
    providerSignerKeyId: "provider-authority",
    serviceRegistry: address(value.serviceRegistry, "service registry"),
    defaultMarketplaceEnabled: value.defaultMarketplaceEnabled,
    railPolicyHash: hash(value.railPolicyHash, "rail policy hash"),
    canonicalToken: address(value.canonicalToken, "canonical token"),
    daskiCommissionReceiver: address(
      value.daskiCommissionReceiver,
      "commission receiver",
    ),
    commissionBps: value.commissionBps,
    splitterFactory: address(value.splitterFactory, "splitter factory"),
    splitterCreationCodeHash: hash(
      value.splitterCreationCodeHash,
      "splitter creation-code hash",
    ),
    splitterFactoryRuntimeCodeHash: hash(
      value.splitterFactoryRuntimeCodeHash,
      "splitter factory runtime hash",
    ),
    intentMaximumLifetimeSeconds: value.intentMaximumLifetimeSeconds,
  } as RegistrationPolicy;
  if (
    policy.serviceRegistry !== getAddress(expected.serviceRegistry) ||
    policy.canonicalToken !== getAddress(expected.canonicalToken)
  ) throw new Error("gateway policy does not match the configured chain contracts");
  return policy;
}

export function parsePublishedServiceContract(
  raw: unknown,
  expected: {
    cardUrl: string;
    providerAgentId: string;
    serviceId: Hex;
    serviceSlug: string;
    serviceVersion: string;
  },
): PublishedServiceContract {
  const card = object(raw, "Agent Card");
  const extensions = object(card.extensions, "Agent Card extensions");
  const serviceExtension = object(extensions[V1_URI], "Daski v1 extension");
  const rawLegal = exact(serviceExtension.legal, [
    "marketplaceTermsUrl", "marketplacePrivacyUrl", "providerLegalName",
    "providerTermsUrl", "providerPrivacyUrl",
  ], "service legal metadata");
  const legal = {
    marketplaceTermsUrl: httpsUrl(rawLegal.marketplaceTermsUrl, "marketplace terms URL"),
    marketplacePrivacyUrl: httpsUrl(rawLegal.marketplacePrivacyUrl, "marketplace privacy URL"),
    providerLegalName: text(rawLegal.providerLegalName, "provider legal name", 512),
    providerTermsUrl: httpsUrl(rawLegal.providerTermsUrl, "provider terms URL"),
    providerPrivacyUrl: httpsUrl(rawLegal.providerPrivacyUrl, "provider privacy URL"),
  };
  const extension = exact(
    extensions[V2_URI],
    [
      "schemaVersion", "providerAgentId", "service", "standardRail",
      "skillContractSetHash", "skills",
    ],
    "Daski v2 extension",
  );
  const service = exact(extension.service, [
    "serviceId", "slug", "version", "categoryFamily", "serviceType",
    "jurisdictions", "lifecycle", "turnaroundEstimate", "acceptingNewOrders",
  ], "service contract");
  if (
    extension.schemaVersion !== 1 ||
    extension.providerAgentId !== expected.providerAgentId ||
    service.serviceId !== expected.serviceId ||
    service.slug !== expected.serviceSlug ||
    service.version !== expected.serviceVersion
  ) throw new Error("Agent Card does not match the finalized service identity");
  if (!Array.isArray(extension.skills) || extension.skills.length < 1 ||
      extension.skills.length > 128) {
    throw new Error("Agent Card skill set is invalid");
  }
  const skills = extension.skills.map((rawSkill): PublishedSkillContract => {
    const skill = exact(
      rawSkill,
      ["skillId", "skillContractHash", "acceptingNewOrders", "presentation", "contract"],
      "published skill",
    );
    if (
      typeof skill.skillId !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,95}$/.test(skill.skillId)
    ) throw new Error("published skill id is invalid");
    const contract = object(skill.contract, "published skill contract");
    const contractHash = hash(skill.skillContractHash, "skill contract hash");
    if (
      canonicalHash({
        schemaVersion: 1,
        serviceSlug: expected.serviceSlug,
        serviceVersion: expected.serviceVersion,
        skillId: skill.skillId,
        contract,
      }) !== contractHash ||
      typeof contract.paymentRequired !== "boolean" ||
      typeof skill.acceptingNewOrders !== "boolean" ||
      (contract.assetAction !== null &&
        (!contract.assetAction || typeof contract.assetAction !== "object" ||
          Array.isArray(contract.assetAction)))
    ) throw new Error("published skill contract is invalid");
    return {
      skillId: skill.skillId,
      skillContractHash: contractHash,
      acceptingNewOrders: skill.acceptingNewOrders as boolean,
      contract: contract as PublishedSkillContract["contract"],
    };
  }).sort((left, right) => left.skillId.localeCompare(right.skillId));
  if (new Set(skills.map((skill) => skill.skillId)).size !== skills.length) {
    throw new Error("published skill ids are not unique");
  }
  const skillContractSetHash = hash(
    extension.skillContractSetHash,
    "skill contract set hash",
  );
  const skillHashes = skills.map(({ skillId, skillContractHash }) => ({
    skillId,
    skillContractHash,
  }));
  if (canonicalHash(skillHashes) !== skillContractSetHash) {
    throw new Error("Agent Card skill-set hash is invalid");
  }
  const standardRail = exact(extension.standardRail, [
    "origin", "providerAudience", "quoteUrl", "dispatchUrl",
    "dispatchStatusUrl", "lifecycleUrl", "assetQueryUrl", "assetActionUrl",
  ], "standard rail profile");
  const cardOrigin = new URL(expected.cardUrl).origin;
  const origin = new URL(text(standardRail.origin, "provider origin", 2_048));
  if (
    origin.protocol !== "https:" || origin.origin !== cardOrigin ||
    origin.username || origin.password || origin.pathname !== "/" ||
    origin.search || origin.hash
  ) throw new Error("provider origin does not match Agent Card");
  const normalizedStandardRail = {
    origin: origin.origin,
    providerAudience: sameOriginUrl(
      standardRail.providerAudience,
      "provider audience",
      cardOrigin,
    ),
    quoteUrl: sameOriginUrl(standardRail.quoteUrl, "quote URL", cardOrigin),
    dispatchUrl: sameOriginUrl(standardRail.dispatchUrl, "dispatch URL", cardOrigin),
    dispatchStatusUrl: sameOriginUrl(
      standardRail.dispatchStatusUrl,
      "dispatch status URL",
      cardOrigin,
    ),
    lifecycleUrl: sameOriginUrl(standardRail.lifecycleUrl, "lifecycle URL", cardOrigin),
    assetQueryUrl: sameOriginUrl(standardRail.assetQueryUrl, "asset query URL", cardOrigin),
    assetActionUrl: sameOriginUrl(standardRail.assetActionUrl, "asset action URL", cardOrigin),
  };
  const serviceContractHash = canonicalHash({
    schemaVersion: 1,
    providerAgentId: expected.providerAgentId,
    service: {
      serviceId: expected.serviceId,
      slug: normalizedId(service.slug, "service slug", 64),
      version: text(service.version, "service version", 32),
      categoryFamily: normalizedId(service.categoryFamily, "category family", 128),
      serviceType: normalizedId(service.serviceType, "service type", 128),
      jurisdictions: stringArray(service.jurisdictions, "jurisdictions", 64),
      lifecycle: normalizedId(service.lifecycle, "service lifecycle", 128),
      acceptingNewOrders: booleanValue(
        service.acceptingNewOrders,
        "service acceptingNewOrders",
      ),
    },
    standardRail: normalizedStandardRail,
    legal,
    skillContractSetHash,
  });
  return {
    cardUrl: expected.cardUrl,
    serviceId: expected.serviceId,
    serviceSlug: expected.serviceSlug,
    serviceVersion: expected.serviceVersion,
    skillContractSetHash,
    skills,
    standardRail: normalizedStandardRail,
    legal,
    serviceContractHash,
  };
}

export async function signProviderEnvelope<T>(args: {
  artifactType: string;
  environment: string;
  chainId: number;
  audience: string;
  validForSeconds: number;
  privateKey: Hex;
  payload: T;
}): Promise<SignedEnvelope<T>> {
  const issuedAt = Math.floor(Date.now() / 1_000);
  const unsigned = {
    artifactType: args.artifactType,
    schemaVersion: 1 as const,
    environment: args.environment,
    chainId: args.chainId,
    audience: args.audience,
    signerKeyId: "provider-authority",
    issuedAt,
    validBefore: issuedAt + args.validForSeconds,
    payload: args.payload,
  };
  return {
    ...unsigned,
    signature: await privateKeyToAccount(args.privateKey).signMessage({
      message: { raw: unsignedEnvelopeHash(unsigned) },
    }),
  };
}

export async function verifyGatewayEnvelope<T>(args: {
  envelope: SignedEnvelope<T>;
  artifactType: string;
  policy: RegistrationPolicy;
  gatewaySigner: Address;
}): Promise<void> {
  const envelope = args.envelope;
  if (
    envelope.artifactType !== args.artifactType ||
    envelope.schemaVersion !== 1 ||
    envelope.environment !== args.policy.environment ||
    envelope.chainId !== args.policy.chainId ||
    envelope.audience !== args.policy.audience ||
    envelope.signerKeyId !== "gateway-protocol" ||
    !Number.isSafeInteger(envelope.issuedAt) ||
    !Number.isSafeInteger(envelope.validBefore) ||
    envelope.validBefore <= Math.floor(Date.now() / 1_000)
  ) throw new Error("gateway signed envelope domain is invalid");
  const signer = await recoverMessageAddress({
    message: { raw: unsignedEnvelopeHash(envelope as unknown as Record<string, unknown>) },
    signature: envelope.signature,
  });
  if (getAddress(signer) !== getAddress(args.gatewaySigner)) {
    throw new Error("gateway signed envelope has an untrusted signer");
  }
}

export function registrationNonce(): Hex {
  return `0x${randomBytes(32).toString("hex")}`;
}

export type RegistrationIntent = SignedEnvelope<ProviderServiceRegistrationIntentV1>;
export type RegistrationEvidence = SignedEnvelope<ProviderServiceRegistrationEvidenceV1>;
