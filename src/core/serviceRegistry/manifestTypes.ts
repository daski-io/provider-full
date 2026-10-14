import type { SkillPricing } from "../pricing/index.js";
import type { FulfillmentAdapter } from "./adapterTypes.js";

export interface AssetTypeLifecycle {
  states: string[];
  terminalStates: string[];
  transitions: Array<{ from: string | null; to: string; skill: string }>;
}

/** Open normalized identifier; recommended values live in public docs. */
export type CategoryFamily = string;

export type FulfillmentMode = "automated" | "human" | "hybrid";
export type TaskDurability = "persistent" | "ephemeral";

export type AssetActionEffect = "read" | "mutate" | "destructive";
export type AssetActionReplayPolicy =
  | "stable-result"
  | "regenerate-ephemeral"
  | "redacted-after-window";
export type ClosedJsonSchema = Record<string, unknown>;

export interface SkillAssetActionContract {
  ownershipPolicy: "owner-only";
  effect: AssetActionEffect;
  replayPolicy: AssetActionReplayPolicy;
  retentionSeconds: number;
  confirmationSummarySchema?: ClosedJsonSchema;
  confirmationSummaryTemplate?: Record<string, unknown>;
}

export interface SkillContractDefinition {
  inputSchema: ClosedJsonSchema;
  resultSchema: ClosedJsonSchema;
  acceptingNewOrders?: boolean;
  capacity?: { maxOpenOrders: number };
  deadlines?: {
    dispatchSeconds?: number;
    fulfillmentSeconds?: number;
  };
  assetAction?: SkillAssetActionContract;
}
export interface ServiceManifest {
  slug: string;
  version?: string;
  name: string;
  categoryFamily: CategoryFamily;
  serviceType: string;
  jurisdictions: string[];
  description: string;
  agentDomain?: string;
  turnaroundEstimate: string;
  serviceLifecycle: "one-shot" | "asset-lifecycle";
  dispatchMode: "one-shot" | "durable";
  defaultFulfillmentMode: FulfillmentMode;
  supplier?: string;
  outboundEmailFrom?: string;
  inboundEmailAddress?: string;
  serviceWallet?: string;
  support?: {
    emailAuthoritativeFor: string[];
    skillRequiredFor: string[];
  };
  assetLifecycle?: Record<string, AssetTypeLifecycle>;
}

/**
 * An earlier published contract of a skill whose admitted work this build
 * still serves. Orders, jobs and lifecycle calls admitted under it run with
 * this handler; new sales use the skill's current contract. Keep it until
 * every listing version that published it is retired.
 */
export interface RetainedSkillContract {
  /** The contract exactly as the earlier version's agent card published it. */
  contract: Record<string, unknown>;
  /** The handler that honors that contract's input and result schemas. */
  adapter: FulfillmentAdapter;
}

export interface SkillDefinition extends SkillContractDefinition {
  id: string;
  name: string;
  description: string;
  examples: string[];
  pricing: SkillPricing;
  /**
   * Opt-in short retention for open, free, automated reads that create no
   * service-owned durable state. All other skills remain persistent.
   */
  taskDurability?: "ephemeral";
  fulfillmentMode?: FulfillmentMode;
  requiresAssetOwnership: boolean;
  assetType?: string;
  requiredFields?: string[];
  optionalFields?: string[];
  tags?: string[];
  sortOrder?: number;
  humanParties?: "required" | "varies" | "none";
  documentationUrl?: string;
  /** Earlier contracts with admitted work outstanding; see RetainedSkillContract. */
  previousContracts?: readonly RetainedSkillContract[];
}
