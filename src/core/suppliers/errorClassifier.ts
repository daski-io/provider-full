export type SupplierFailureKind =
  | "transient"
  | "supplier_rejected"
  | "provider_config"
  | "ambiguous";

export type SupplierErrorCategory =
  | "transport"
  | "validation"
  | "auth"
  | "conflict"
  | "rate_limited"
  | "server"
  | "unexpected"
  | "rejected";

export interface SupplierFailureClassification {
  kind: SupplierFailureKind;
  supplier: string | null;
}

export interface SupplierClientErrorOptions {
  supplier: string;
  status?: number;
  category?: SupplierErrorCategory;
  cause?: unknown;
}

/** Stable error contract shared by supplier clients and dispatch policy. */
export class SupplierClientError extends Error {
  readonly supplier: string;
  readonly status?: number;
  readonly category?: SupplierErrorCategory;

  constructor(message: string, options: SupplierClientErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SupplierClientError";
    this.supplier = options.supplier;
    this.status = options.status;
    this.category = options.category;
  }
}

/** Marks an external mutation whose outcome cannot yet be proven. */
export class SupplierOutcomeAmbiguousError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupplierOutcomeAmbiguousError";
  }
}

/**
 * A read-only pre-mutation check proved that the intended supplier spend is
 * not authorized. The dispatch policy parks this for operator disposition.
 */
export class SupplierMutationAuthorizationError extends Error {
  readonly supplier: string;

  constructor(supplier: string, message: string) {
    super(message);
    this.name = "SupplierMutationAuthorizationError";
    this.supplier = supplier;
  }
}

const CATEGORY_KINDS: Readonly<Record<SupplierErrorCategory, SupplierFailureKind>> = {
  transport: "transient",
  validation: "supplier_rejected",
  auth: "provider_config",
  conflict: "ambiguous",
  rate_limited: "transient",
  server: "transient",
  unexpected: "ambiguous",
  rejected: "supplier_rejected",
};

/**
 * Classifies only errors carrying a trusted supplier-client contract.
 * Returning null leaves an unknown error to its caller's policy; after a
 * paid order started, an unknown error never proves it failed.
 */
export function classifySupplierError(
  error: unknown,
): SupplierFailureClassification | null {
  if (error instanceof SupplierOutcomeAmbiguousError) {
    return { kind: "ambiguous", supplier: null };
  }
  if (error instanceof SupplierMutationAuthorizationError) {
    return { kind: "provider_config", supplier: error.supplier };
  }
  if (!(error instanceof SupplierClientError)) return null;

  if (error.category) {
    return { kind: CATEGORY_KINDS[error.category], supplier: error.supplier };
  }

  const status = error.status;
  if (status === undefined) return null;
  if (status === 408 || status === 429 || status >= 500) {
    return { kind: "transient", supplier: error.supplier };
  }
  if (status === 401 || status === 403) {
    return { kind: "provider_config", supplier: error.supplier };
  }
  if (status >= 400 && status < 500) {
    return { kind: "supplier_rejected", supplier: error.supplier };
  }
  return null;
}
