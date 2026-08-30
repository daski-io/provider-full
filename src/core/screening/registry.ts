import type { Queryable } from "../db/queryable.js";
import type { AssetRow } from "../db/queries/assets.js";
import type {
  ScreeningDecision,
  ScreeningEvaluationRequest,
  ScreeningProviderExtension,
  ScreeningSubject,
  ScreeningVendorEntry,
} from "./types.js";

let installed: ScreeningProviderExtension | null = null;

export function registerScreeningExtension(extension: ScreeningProviderExtension): void {
  if (installed && installed !== extension) {
    throw new Error(`Screening extension already registered: ${installed.id}`);
  }
  installed = extension;
}

export function getScreeningExtension(): ScreeningProviderExtension | null {
  return installed;
}

export function requireScreeningScopes(scopes: readonly string[]): ScreeningProviderExtension {
  const extension = installed;
  if (!extension) throw new Error("Required screening extension is not installed");
  const missing = scopes.filter((scope) => !extension.scopes.includes(scope));
  if (missing.length > 0) {
    throw new Error(`Screening extension is missing required scope(s): ${missing.join(", ")}`);
  }
  return extension;
}

export async function evaluateScreening(
  request: ScreeningEvaluationRequest,
  requiredScopes: readonly string[],
): Promise<ScreeningDecision> {
  return requireScreeningScopes(requiredScopes).evaluate(request);
}

export async function screenVendorSubject(
  subject: ScreeningSubject,
  requiredScope = "dilisense",
): Promise<ScreeningVendorEntry[]> {
  return requireScreeningScopes([requiredScope]).screenVendorSubject(subject);
}

export function screeningPolicy() {
  return requireScreeningScopes(["policy"]).policy;
}

export function normalizeScreeningCountry(value: string) {
  return requireScreeningScopes(["policy"]).normalizeCountry(value);
}

export function screeningPhoneCountryCandidates(phone: string | null | undefined): string[] | null {
  return requireScreeningScopes(["policy"]).phoneCountryCandidates(phone);
}

export async function storeScreeningAssetProfile(args: {
  asset: AssetRow;
  serviceSlug: string;
  subjects: ScreeningSubject[];
  db: Queryable;
}): Promise<void> {
  return requireScreeningScopes(["asset-profiles"]).storeAssetProfile(args);
}

export async function bindScreeningTransactionAsset(args: {
  transactionId: string;
  assetId: string;
  db?: Queryable;
}): Promise<void> {
  return requireScreeningScopes(["asset-profiles"]).bindTransactionAsset(args);
}

export async function hasActiveScreeningRestriction(args: {
  serviceSlug: string;
  assetId?: string | null;
  assetIdentifier?: string | null;
  transactionId?: string | null;
  db?: Queryable;
}): Promise<boolean> {
  return requireScreeningScopes(["restrictions"]).hasActiveRestriction(args);
}

export async function hasBlockingScreeningTransaction(
  transactionId: string,
  db?: Queryable,
  options?: { includeRetryable?: boolean },
): Promise<boolean> {
  return requireScreeningScopes(["restrictions"]).hasBlockingTransaction(
    transactionId,
    db,
    options,
  );
}
