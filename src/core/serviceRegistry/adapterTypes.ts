import type { AssetRow } from "../db/queries/assets.js";
import type { ScreeningSubject } from "../screening/types.js";
import type { Hex } from "viem";
import type { IntakeDetail, RequestReadiness, RequestReadinessContext } from "./quoteTypes.js";

export interface AdapterArtifact {
  name: string;
  data?: Record<string, unknown>;
  url?: string;
  mimeType?: string;
  /** Emit a synthetic task-scoped challenge alongside the URL. */
  accessAction?: "document-download";
}

export interface AdapterResult {
  status: "working" | "completed" | "failed" | "input-required";
  message?: string;
  /** Internal signal that a consumed task-input authorization needs a fresh challenge. */
  retryInputAuthorization?: true;
  artifacts?: AdapterArtifact[];
  /** First-time provisioning only; existing assets are mutated in place. */
  asset?: {
    assetType: string;
    assetIdentifier: string;
    assetData: Record<string, unknown>;
    expiresAt?: Date;
    /** Protected screening profile persisted atomically with a newly created asset. */
    screeningSubjects?: ScreeningSubject[];
  };
  error?: string;
  failureClass?: "retryable" | "terminal";
  autoRefundContext?: {
    class: "dispatch" | "precommit";
    supplier: string;
    kind:
      | "transient"
      | "supplier_rejected"
      | "provider_config"
      | "ambiguous"
      | "unclassified";
    attempts: number;
  };
}

export interface TaskContext {
  id: string;
  service_id: string;
  skill_id: string;
  status: string;
  supplierMutationStarted?: boolean;
  /**
   * The order's admitted, immutable supplier-spend ceiling (absent for a
   * no-spend quote). Compare every planned supplier operation with it before
   * spending: pass it as `spend.ceiling` to `runSupplierOperation`, or call
   * `assertSupplierSpendWithinCeiling`. Retries reuse this same value.
   */
  supplierCostCeiling?: SupplierCostCeiling;
}

interface TaskInputAuthorizationBase {
  requestHash: Hex;
}

export type TaskInputAuthorizationContext = TaskInputAuthorizationBase & {
  payer: Hex;
  standardOrderId: string;
};

/**
 * Immutable supplier-spend ceiling committed by a paid provider quote and
 * carried into fulfillment. Decimal strings avoid floating-point drift.
 */
export interface SupplierCostCeiling {
  kind: "supplier-cost-ceiling-v1";
  supplier: string;
  currency: string;
  maximumAmount: string;
}

export type QuoteResult =
  | {
      ok: true;
      amount: bigint;
      currency: "USDC";
      notes?: string[];
      supplierCostCeiling?: SupplierCostCeiling;
    }
  | {
      ok: false;
      errors: QuoteError[];
    };

export interface QuoteError {
  field: string;
  code: string;
  message: string;
}

export class CancellationRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "CancellationRefusedError";
  }
}

export class CancellationCleanupError extends Error {
  constructor(reason: string, readonly cause?: unknown) {
    super(reason);
    this.name = "CancellationCleanupError";
  }
}

export interface FulfillmentAdapter {
  execute(
    skillId: string,
    task: TaskContext,
    data: Record<string, unknown>,
    assetContext?: AssetRow,
  ): Promise<AdapterResult>;
  handleInput(
    task: TaskContext,
    inputText: string,
    data: Record<string, unknown>,
    authorization: TaskInputAuthorizationContext,
  ): Promise<AdapterResult>;
  cancel(task: TaskContext): Promise<void>;
  quote(
    skillId: string,
    serviceArgs: Record<string, unknown>,
  ): Promise<QuoteResult>;
  /**
   * Optional read-only request readiness, run before every new quote after
   * schema and quote validation. It must not reserve, purchase, or start
   * anything; core never consults it again after payment.
   */
  requestReadiness?(
    skillId: string,
    serviceArgs: Record<string, unknown>,
    context: RequestReadinessContext,
  ): Promise<RequestReadiness>;
  /** Optional authenticated intake discovery answered on the quote endpoint. */
  intake?(skillId: string, selectors: Record<string, unknown>): Promise<IntakeDetail>;
}
