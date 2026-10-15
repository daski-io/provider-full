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
   * quote that reported no supplier cost). Compare every planned supplier
   * operation with it before spending: pass it as `spend.ceiling` to
   * `runSupplierOperation`, or call `assertSupplierSpendWithinCeiling`.
   * Retries reuse this same value.
   */
  supplierCostCeiling?: SupplierCostCeiling;
  /** Present on handleInput() and cancel() calls for a buyer's standard-rail order action. */
  lifecycleAction?: LifecycleActionContext;
}

/**
 * The buyer order action a handleInput() or cancel() call performs. Core
 * calls at most one attempt of an action at a time, and never again once an
 * attempt's outcome is committed; after an attempt whose outcome is unknown,
 * the next attempt calls again with `resumed`.
 */
export interface LifecycleActionContext {
  /** Stable across every attempt of this one action: key supplier journal operations on it. */
  idempotencyKey: string;
  /** An earlier attempt may already have taken effect: reconcile supplier state before acting. */
  resumed: boolean;
}

interface TaskInputAuthorizationBase {
  requestHash: Hex;
}

export type TaskInputAuthorizationContext = TaskInputAuthorizationBase & {
  payer: Hex;
  standardOrderId: string;
};

/**
 * The supplier's current price for one quoted request, in the supplier's own
 * currency as a non-negative decimal string. A quote that may spend
 * externally reports it, for fixed and dynamic listings alike.
 */
export interface SupplierCost {
  supplier: string;
  currency: string;
  amount: string;
}

/**
 * Immutable supplier-spend ceiling core records with a paid provider quote
 * and carries into fulfillment: the supplier price quoted at quote time and
 * the provider's price tolerance then in force. A planned spend is admitted
 * while `amount * 100 <= quotedAmount * (100 + tolerancePercent)`. Decimal
 * strings avoid floating-point drift.
 */
export interface SupplierCostCeilingV2 {
  kind: "supplier-cost-ceiling-v2";
  supplier: string;
  currency: string;
  quotedAmount: string;
  /** SUPPLIER_PRICE_TOLERANCE_PERCENT when the quote was issued: 0 to 100, at most two decimals. */
  tolerancePercent: string;
}

/**
 * A ceiling recorded by an earlier release, still read for its orders: it
 * admits spend up to `maximumAmount` (a quoted amount with no tolerance).
 * Nothing records one any more.
 */
export interface SupplierCostCeilingV1 {
  kind: "supplier-cost-ceiling-v1";
  supplier: string;
  currency: string;
  maximumAmount: string;
}

export type SupplierCostCeiling = SupplierCostCeilingV2 | SupplierCostCeilingV1;

export type QuoteResult =
  | {
      ok: true;
      amount: bigint;
      currency: "USDC";
      notes?: string[];
      /** The supplier price this request would spend; core records the order's ceiling from it. */
      supplierCost?: SupplierCost;
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
