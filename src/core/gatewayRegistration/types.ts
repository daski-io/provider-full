import type { Address, Hex } from "viem";
import type { SignedEnvelope } from "../standardRail/types.js";

export interface RegistrationPolicy {
  schemaVersion: 1;
  environment: string;
  chainId: number;
  audience: string;
  providerSignerKeyId: "provider-authority";
  serviceRegistry: Address;
  defaultMarketplaceEnabled: boolean;
  railPolicyHash: Hex;
  canonicalToken: Address;
  daskiCommissionReceiver: Address;
  commissionBps: number;
  splitterFactory: Address;
  splitterCreationCodeHash: Hex;
  splitterFactoryRuntimeCodeHash: Hex;
  intentMaximumLifetimeSeconds: number;
}

export interface PublishedAssetActionContract {
  ownershipPolicy: "owner-only";
  effect: "read" | "mutate" | "destructive";
  replayPolicy:
    | "stable-result"
    | "regenerate-ephemeral"
    | "redacted-after-window";
  retentionSeconds: number;
  confirmationSummarySchema?: Record<string, unknown>;
  confirmationSummaryTemplate?: Record<string, unknown>;
}

export interface PublishedSkillContract {
  skillId: string;
  skillContractHash: Hex;
  /** Mutable availability outside the hashed contract. */
  acceptingNewOrders: boolean;
  contract: {
    paymentRequired: boolean;
    assetAction: PublishedAssetActionContract | null;
    [key: string]: unknown;
  };
}

export interface PublishedServiceContract {
  cardUrl: string;
  serviceId: Hex;
  serviceSlug: string;
  serviceVersion: string;
  skillContractSetHash: Hex;
  skills: PublishedSkillContract[];
  legal: {
    marketplaceTermsUrl: string;
    marketplacePrivacyUrl: string;
    providerLegalName: string;
    providerTermsUrl: string;
    providerPrivacyUrl: string;
  };
  standardRail: {
    assetActionUrl: string;
    [key: string]: unknown;
  };
  serviceContractHash: Hex;
}

export interface ProviderServiceRegistrationIntentV1 {
  providerAgentId: string;
  serviceId: Hex;
  serviceSlug: string;
  serviceVersion: string;
  providerPayee: Address;
  serviceContractHash: Hex;
  skillContractSetHash: Hex;
  skills: Array<{ skillId: string; skillContractHash: Hex }>;
  railPolicyHash: Hex;
  registrationNonce: Hex;
}

export type ProviderServiceRegistrationIntentEnvelope =
  SignedEnvelope<ProviderServiceRegistrationIntentV1>;

export interface ProviderServiceRegistrationEvidenceV1 {
  registrationId: string;
  preparedRegistrationHash: Hex;
  expectedState: "PREPARED" | "EVIDENCE_PENDING";
  splitterTransactionHashes: Array<{
    listingId: string;
    transactionHash: Hex;
  }>;
  evidenceNonce: Hex;
}

export type ProviderServiceRegistrationEvidenceEnvelope =
  SignedEnvelope<ProviderServiceRegistrationEvidenceV1>;

export interface GatewayListingPreparationV1 {
  registrationId: string;
  listingId: string;
  listingKey: Hex;
  providerAgentId: string;
  serviceId: Hex;
  serviceSlug: string;
  serviceVersion: string;
  skillId: string;
  skillContractHash: Hex;
  skillContractSetHash: Hex;
  providerIntentHash: Hex;
  canonicalToken: Address;
  providerPayee: Address;
  daskiCommissionReceiver: Address;
  commissionBps: number;
  splitterFactory: Address;
  splitterDeploymentSalt: Hex;
  policyVersionHash: Hex;
  listingEpoch: string;
}

export interface GatewaySkillControlProfileV1 {
  registrationId: string;
  providerAgentId: string;
  providerIntentHash: Hex;
  serviceId: Hex;
  serviceSlug: string;
  skillId: string;
  skillContractHash: Hex;
  policyVersionHash: Hex;
  providerEndpoint: string;
  ownershipPolicy: "owner-only";
  effect: "read" | "mutate" | "destructive";
  replayPolicy:
    | "stable-result"
    | "regenerate-ephemeral"
    | "redacted-after-window";
  retentionSeconds: number;
  walletAuthorizationRequired: true;
  delayedConfirmationRequired: boolean;
  confirmationSummarySchemaHash: Hex | null;
  confirmationSummaryTemplateHash: Hex | null;
}

export interface PreparedListing {
  listingId: string;
  listingKey: Hex;
  skillId: string;
  skillContractHash: Hex;
  paymentRequired: boolean;
  acceptingNewOrders: boolean;
  deploymentRequired: boolean;
  reused: boolean;
  splitterAddress: Address | null;
  preparation: SignedEnvelope<GatewayListingPreparationV1> | null;
  controlProfile: SignedEnvelope<GatewaySkillControlProfileV1> | null;
  transaction: {
    kind: "splitter-deployment";
    listingId: string;
    to: Address;
    data: Hex;
    value: "0";
  } | null;
}

export interface PreparedServiceRegistration {
  registrationId: string;
  state: "PREPARED";
  providerAgentId: string;
  serviceId: Hex;
  serviceSlug: string;
  serviceVersion: string;
  agentCardUrl: string;
  serviceWallet: Address;
  providerPayee: Address;
  providerIntentHash: Hex;
  railPolicyHash: Hex;
  /**
   * Gateway-owned Daski visibility decision (the gateway's
   * marketplace_enabled flag). Distinct from the provider-declared
   * per-skill acceptingNewOrders.
   */
  marketplaceEnabled: boolean;
  listings: PreparedListing[];
}

export interface GatewayRegistrationView {
  registrationId: string;
  state: "PREPARED" | "EVIDENCE_PENDING" | "ACTIVE" | "SUPERSEDED" | "REJECTED";
  providerAgentId: string;
  serviceId: Hex;
  serviceSlug: string;
  serviceVersion: string;
  agentCardUrl: string;
  providerPayee: Address;
  marketplaceEnabled: boolean;
  registrationHealthy: boolean;
  nextAction: "submit-splitter-evidence" | null;
  prepared: PreparedServiceRegistration;
  activatedAt: string | null;
  updatedAt: string;
  /** Present on activation responses: the gateway's per-listing runtime
   *  commitment hashes, cross-checked against locally recomputed values. */
  runtimeCommitments?: Array<{
    listingId: string;
    runtimeCommitmentHash: Hex;
  }>;
}
