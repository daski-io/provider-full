import { getAddress, recoverMessageAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import { assertStrictJsonText } from "../src/core/standardRail/strictJson.js";
import type { SignedEnvelope } from "../src/core/standardRail/types.js";

/*
 * Minimal port of the gateway consumer checks at daski-io/gateway 8f15201
 * (src/standardRail/service.ts resolveGrossAmount, intake.ts, boundedJson.ts,
 * signing.ts). Tests construct envelopes and judge provider answers exactly
 * as the gateway does; the gateway itself is never imported or called.
 */

export const FIXED_READINESS_QUOTE_MAX_SECONDS = 300;

export async function signGatewayEnvelope<T>(args: {
  artifactType: string;
  schemaVersion?: 1 | 2;
  environment: string;
  chainId: number;
  audience: string;
  signerKeyId: string;
  privateKey: Hex;
  issuedAt: number;
  validBefore: number;
  payload: T;
}): Promise<SignedEnvelope<T, 1 | 2>> {
  const unsigned = {
    artifactType: args.artifactType,
    schemaVersion: args.schemaVersion ?? 1,
    environment: args.environment,
    chainId: args.chainId,
    audience: args.audience,
    signerKeyId: args.signerKeyId,
    issuedAt: args.issuedAt,
    validBefore: args.validBefore,
    payload: args.payload,
  };
  const signature = await privateKeyToAccount(args.privateKey).signMessage({
    message: { raw: canonicalHash(unsigned) },
  });
  return { ...unsigned, signature } as SignedEnvelope<T, 1 | 2>;
}

/** boundedJson.readBoundedJsonResponse: media type, encoding, duplicates. */
export async function readGatewayJson(response: Response): Promise<unknown> {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  if (mediaType !== "application/json" || (encoding && encoding !== "identity")) {
    throw new Error("BOUNDED_JSON_MEDIA_TYPE_INVALID");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(await response.arrayBuffer());
  assertStrictJsonText(text);
  return JSON.parse(text);
}

function exactKeys(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join() !== [...keys].sort().join()) {
    throw new Error("PROVIDER_QUOTE_UNAVAILABLE");
  }
}

export interface QuoteExpectation {
  outcomeId: string;
  listingManifestHash: Hex;
  requestHash: Hex;
  payer: Hex | null;
  fixed: boolean;
  fixedGrossAmount: string;
  providerAuthorityKey: Hex;
  minimumPaymentWindowSeconds: number;
  maximumLifetimeSeconds: number | null;
  commissionBps: number;
  receivedAt: number;
}

/** service.ts resolveGrossAmount success path: exact keys, time bounds, signer. */
export async function acceptProviderQuote(value: unknown, expected: QuoteExpectation): Promise<{
  grossAmount: string;
  providerQuoteHash: Hex;
  issuedAt: number;
  validBefore: number;
}> {
  exactKeys(value, [
    "outcomeId", "listingManifestHash", "requestHash", "grossAmount", "payer", "issuedAt",
    "validBefore", "signature",
  ]);
  const quote = value;
  if (
    quote.outcomeId !== expected.outcomeId || quote.payer !== expected.payer ||
    quote.listingManifestHash !== expected.listingManifestHash ||
    quote.requestHash !== expected.requestHash || typeof quote.grossAmount !== "string" ||
    !/^[1-9][0-9]*$/.test(quote.grossAmount) || typeof quote.issuedAt !== "number" ||
    !Number.isSafeInteger(quote.issuedAt) || typeof quote.validBefore !== "number" ||
    !Number.isSafeInteger(quote.validBefore) || typeof quote.signature !== "string"
  ) throw new Error("PROVIDER_QUOTE_UNAVAILABLE");
  const receivedAt = expected.receivedAt;
  if (
    quote.issuedAt > receivedAt + 30 || quote.issuedAt < receivedAt - 30 ||
    quote.validBefore <= receivedAt + expected.minimumPaymentWindowSeconds ||
    (!expected.fixed && expected.maximumLifetimeSeconds === null) ||
    quote.validBefore > quote.issuedAt +
      (expected.fixed ? FIXED_READINESS_QUOTE_MAX_SECONDS : expected.maximumLifetimeSeconds!)
  ) throw new Error("PROVIDER_QUOTE_UNAVAILABLE");
  const bps = BigInt(expected.commissionBps);
  if (BigInt(quote.grossAmount) < (10_000n + bps - 1n) / bps) throw new Error("PROVIDER_QUOTE_UNAVAILABLE");
  const providerQuoteHash = canonicalHash({
    outcomeId: quote.outcomeId,
    listingManifestHash: quote.listingManifestHash,
    requestHash: quote.requestHash,
    grossAmount: quote.grossAmount,
    payer: quote.payer,
    issuedAt: quote.issuedAt,
    validBefore: quote.validBefore,
  });
  const signer = await recoverMessageAddress({
    message: { raw: providerQuoteHash },
    signature: quote.signature as Hex,
  });
  if (getAddress(signer) !== getAddress(expected.providerAuthorityKey)) {
    throw new Error("PROVIDER_QUOTE_UNAVAILABLE");
  }
  if (expected.fixed && quote.grossAmount !== expected.fixedGrossAmount) {
    throw new Error("PROVIDER_QUOTE_UNAVAILABLE");
  }
  return {
    grossAmount: quote.grossAmount,
    providerQuoteHash,
    issuedAt: quote.issuedAt,
    validBefore: quote.validBefore,
  };
}

/** service.ts 4xx branch: the structured field errors the gateway keeps. */
export function gatewayQuoteFieldErrors(body: unknown): Array<{
  path: string; rule: string; message: string; allowedValues?: readonly string[];
}> | undefined {
  const rejection = body as { fieldErrors?: unknown } | null;
  if (!rejection || !Array.isArray(rejection.fieldErrors)) return undefined;
  return rejection.fieldErrors.slice(0, 32).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const value = item as Record<string, unknown>;
    if (typeof value.path !== "string" || typeof value.rule !== "string" ||
        typeof value.message !== "string") return [];
    const allowedValues = Array.isArray(value.allowedValues) &&
      value.allowedValues.every((entry) => typeof entry === "string")
      ? value.allowedValues as string[] : undefined;
    return [{ path: value.path, rule: value.rule, message: value.message, ...(allowedValues ? { allowedValues } : {}) }];
  });
}

/** intake.ts getIntakeRequirements response validation. */
export async function acceptIntakeResponse(value: unknown, expected: {
  outcomeId: string;
  listingManifestHash: Hex;
  requestHash: Hex;
  requestSchema: unknown;
  providerAuthorityKey: Hex;
  now: number;
}): Promise<Record<string, unknown>> {
  const keys = ["outcomeId", "listingManifestHash", "requestHash", "requestSchema", "requiredFields",
    "selectorsRequired", "normalizedSelectors", "fieldErrors", "supported", "issuedAt", "validBefore", "signature"];
  exactKeys(value, keys);
  const result = value;
  const now = expected.now;
  if (
    result.outcomeId !== expected.outcomeId || result.listingManifestHash !== expected.listingManifestHash ||
    result.requestHash !== expected.requestHash || typeof result.signature !== "string" ||
    !Number.isSafeInteger(result.issuedAt) || Number(result.issuedAt) > now + 30 ||
    Number(result.issuedAt) < now - 120 || !Number.isSafeInteger(result.validBefore) ||
    Number(result.validBefore) <= now || Number(result.validBefore) > now + 120 ||
    !Array.isArray(result.selectorsRequired) ||
    !result.selectorsRequired.every((entry) => typeof entry === "string") ||
    !Array.isArray(result.fieldErrors) || result.fieldErrors.length > 32 ||
    !result.fieldErrors.every((entry) => entry && typeof entry === "object" &&
      ["path", "rule", "message"].every((key) => typeof (entry as Record<string, unknown>)[key] === "string")) ||
    ![true, false, null].includes(result.supported as boolean | null)
  ) throw new Error("Intake binding is invalid");
  for (const key of ["requestSchema", "requiredFields", "normalizedSelectors"]) {
    if (!result[key] || typeof result[key] !== "object" || Array.isArray(result[key])) {
      throw new Error("Invalid intake contract");
    }
  }
  if (canonicalHash(result.requestSchema) !== canonicalHash(expected.requestSchema)) {
    throw new Error("Intake schema mismatch");
  }
  const { signature, ...payload } = result;
  const signer = await recoverMessageAddress({ message: { raw: canonicalHash(payload) }, signature: signature as Hex });
  if (getAddress(signer) !== getAddress(expected.providerAuthorityKey)) throw new Error("Invalid intake signer");
  return payload;
}
