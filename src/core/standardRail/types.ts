import type { Hex } from "viem";

export interface SignedEnvelope<T, V extends 1 | 2 = 1> {
  artifactType: string;
  schemaVersion: V;
  environment: string;
  chainId: number;
  audience: string;
  signerKeyId: string;
  issuedAt: number;
  validBefore: number;
  payload: T;
  signature: Hex;
}

export interface WalletActionAuthorizationV1 {
  payer: Hex;
  providerAgentId: string;
  serviceId: Hex;
  providerControlProfileHash: Hex;
  servicingAdmissionHash: Hex;
  actionCatalogHash: Hex;
  actionCatalogSchemaHash: Hex;
  actionDefinitionHash: Hex;
  actionCatalogEpoch: number;
  actionHash: Hex;
  methodHash: Hex;
  absoluteResourceUriHash: Hex;
  requestHash: Hex;
  audienceHash: Hex;
  nonce: Hex;
  issuedAt: number;
  validBefore: number;
}

export interface ProviderWalletActionGrantV1 {
  payer: Hex;
  providerAgentId: string;
  serviceId: Hex;
  actionHash: Hex;
  methodHash: Hex;
  absoluteResourceUriHash: Hex;
  requestHash: Hex;
  walletAuthorizationHash: Hex;
  providerControlProfileHash: Hex;
  servicingAdmissionHash: Hex;
  servicingProfileEpoch: number;
  actionCatalogHash: Hex;
  actionCatalogSchemaHash: Hex;
  actionCatalogEpoch: number;
  actionDefinitionHash: Hex;
  gatewayAudienceHash: Hex;
  providerAudienceHash: Hex;
  grantNonce: Hex;
}

export interface ProviderAssetSummaryV1 {
  providerAssetId: string;
  serviceSlug: string;
  type: string;
  identifier: string;
  status: string;
  createdAt: string;
  expiresAt: string | null;
}

export interface ProviderAssetQueryResponseV1 {
  providerAgentId: string;
  payer: Hex;
  assets: ProviderAssetSummaryV1[];
  nextCursor: string | null;
  responseNonce: Hex;
  requestHash: Hex;
  walletAuthorizationHash: Hex;
  grantHash: Hex;
  providerControlProfileHash: Hex;
  servicingAdmissionHash: Hex;
  servicingProfileEpoch: number;
}

export interface ProviderAssetActionResponseV1 {
  providerAgentId: string;
  payer: Hex;
  actionExecutionId: Hex;
  status: "completed" | "failed";
  responseNonce: Hex;
  requestHash: Hex;
  walletAuthorizationHash: Hex;
  grantHash: Hex;
  providerControlProfileHash: Hex;
  servicingAdmissionHash: Hex;
  servicingProfileEpoch: number;
  actionCatalogHash: Hex;
  actionCatalogSchemaHash: Hex;
  actionCatalogEpoch: number;
  actionDefinitionHash: Hex;
  result: Record<string, unknown> | null;
  errorClass: string | null;
}

export interface ProviderAssetActionStageResponseV1 {
  providerAgentId: string;
  payer: Hex;
  actionExecutionId: Hex;
  status: "staged" | "canceled";
  effectSummary: Record<string, unknown>;
  confirmationHash: Hex;
  earliestExecutionAt: number;
  stageValidBefore: number;
  responseNonce: Hex;
  requestHash: Hex;
  walletAuthorizationHash: Hex;
  grantHash: Hex;
  providerControlProfileHash: Hex;
  servicingAdmissionHash: Hex;
  servicingProfileEpoch: number;
  actionCatalogHash: Hex;
  actionCatalogSchemaHash: Hex;
  actionCatalogEpoch: number;
  actionDefinitionHash: Hex;
}

export interface StandardRailDispatchV2 {
  environment: string;
  chainId: number;
  gatewayAudience: string;
  providerAudience: string;
  providerControlProfileHash: Hex;
  orderId: string;
  orderKey: Hex;
  serviceId: Hex;
  reputationEligible: boolean;
  reputationContract: Hex;
  outcomeSchemaUid: Hex;
  dispatchNonce: Hex;
  payer: Hex;
  listingManifestHash: Hex;
  providerOfferHash: Hex;
  quoteHash: Hex;
  bindingProfile: "stock-fixed-v1" | "recipe-bound-v1" | "recipe-bound-v2";
  canonicalRequestHash: Hex;
  orderNonce: Hex;
  buyerIdentityProofHash: Hex;
  activeRailProfileHash: Hex;
  facilitatorConfirmationHash: Hex;
  settlementTxHash: Hex;
  depositBlockNumber: string;
  depositBlockHash: Hex;
  depositTransactionIndex: number;
  depositLogIndex: number;
  depositEvidenceHash: Hex;
  releaseTxHash: Hex;
  releaseBlockNumber: string;
  releaseBlockHash: Hex;
  releaseTransactionIndex: number;
  releaseLogIndex: number;
  releaseSequence: string;
  releaseEvidenceHash: Hex;
  grossAmount: string;
  providerNetAmount: string;
  daskiCommissionAmount: string;
  canonicalProviderRequestHash: Hex;
  dispatchDeadlineSeconds: number;
  issuedAt: number;
  validBefore: number;
}

export interface StandardRailReceiptV2 {
  orderId: string;
  state: "RELEASE_FINAL";
  payer: Hex;
  providerAgentId: string;
  outcomeId: string;
  bindingProfile: "stock-fixed-v1" | "recipe-bound-v1" | "recipe-bound-v2";
  activeRailProfileHash: Hex;
  listingManifestHash: Hex;
  providerOfferHash: Hex;
  quoteHash: Hex;
  canonicalRequestHash: Hex;
  orderNonce: Hex;
  authorizationKey: Hex;
  paymentPayloadHash: Hex;
  grossAmount: string;
  providerNetAmount: string;
  daskiCommissionAmount: string;
  facilitatorConfirmationHash: Hex;
  settlementTxHash: Hex;
  depositBlockNumber: string;
  depositBlockHash: Hex;
  depositTransactionIndex: number;
  depositLogIndex: number;
  depositEvidenceHash: Hex;
  releaseTxHash: Hex;
  releaseBlockNumber: string;
  releaseBlockHash: Hex;
  releaseTransactionIndex: number;
  releaseLogIndex: number;
  releaseSequence: string;
  releaseEvidenceHash: Hex;
}

export interface DispatchStatusQueryV1 {
  orderId: string;
  dispatchHash: Hex;
  issuedAt: number;
  validBefore: number;
}

export interface ProviderOutcomeOfferV1 {
  listingManifestHash: Hex;
  outcomeId: string;
  skillId: string;
  providerAgentId: string;
  providerPayee: Hex;
  pricingMode: "fixed" | "dynamic";
  fixedGrossAmount: string;
  quotePolicyHash: Hex;
  capacityPolicyHash: Hex;
  deadlinePolicyHash: Hex;
  deliveryCommitment: Hex;
  termsHash: Hex;
  issuedAt: number;
  validBefore: number;
  offerNonce: Hex;
}

export interface QuoteV1 {
  listingManifestHash: Hex;
  providerOfferHash: Hex;
  providerQuoteHash: Hex;
  canonicalRequestHash: Hex;
  grossAmount: string;
  token: Hex;
  splitter: Hex;
  orderNonce: Hex;
  issuedAt: number;
  validBefore: number;
}

export interface StandardEvidenceBundleV2 {
  deposit: {
    transactionHash: Hex;
    blockNumber: string;
    blockHash: Hex;
    transactionIndex: number;
    logIndex: number;
    evidenceHash: Hex;
    canonicalEvidence: Record<string, unknown>;
    sources: string[];
  };
  release: {
    transactionHash: Hex;
    blockNumber: string;
    blockHash: Hex;
    transactionIndex: number;
    logIndex: number;
    releaseSequence: string;
    evidenceHash: Hex;
    canonicalEvidence: Record<string, unknown>;
    sources: string[];
  };
}

export interface ProviderOutcomeConfig {
  outcomeId: string;
  serviceSlug: string;
  serviceId: Hex;
  skillId: string;
  listingManifestHash: Hex;
  providerOfferHash: Hex;
  pricingMode: "fixed" | "dynamic";
  fixedGrossAmount: string;
  quoteMaximumLifetimeSeconds: number;
  quoteMinimumPaymentWindowSeconds: number;
  providerControlProfileHash: Hex;
  activeRailProfileHash: Hex;
  customerIdentityPolicyId: "none";
  token: Hex;
  splitter: Hex;
  splitterFactory: Hex;
  splitterFactoryRuntimeCodeHash: Hex;
  splitterCreationCode: Hex;
  splitterCreationCodeHash: Hex;
  splitterInitCodeHash: Hex;
  splitterDeploymentSalt: Hex;
  splitterRuntimeCodeHash: Hex;
  splitterDeploymentTransaction: Hex;
  splitterDeploymentBlockNumber: string;
  splitterDeploymentBlockHash: Hex;
  splitterActivationBlockNumber: string;
  splitterActivationBlockHash: Hex;
  splitterActivationPosition: "END_OF_BLOCK";
  splitterStartingTokenBalance: string;
  splitterStartingReleaseSequence: string;
  tokenRuntimeCodeHash: Hex;
  tokenImplementationAddress: Hex;
  tokenImplementationRuntimeCodeHash: Hex;
  tokenImplementationSlot: Hex;
  tokenDomainSeparator: Hex;
  sanctionsOracleRuntimeCodeHash: Hex;
  providerControlledWallets: Hex[];
  maximumSourceLagBlocks: number;
  maximumLogPageEvents: number;
  listingCommitmentHash: Hex;
  outcomeIdHash: Hex;
  policyVersionHash: Hex;
  listingEpoch: string;
  providerPayee: Hex;
  providerTerminalAttestationKey: Hex;
  daskiCommissionReceiver: Hex;
  commissionBps: number;
  maxOpenOrders: number;
  dispatchDeadlineSeconds: number;
  /**
   * recipe-bound-v2 reuses the V1 slot layout: listingManifestHash carries
   * the runtime listing commitment hash and providerOfferHash carries the
   * provider intent hash (the approved Option A binding). The intent hash
   * is additionally required to equal the one embedded in the runtime
   * commitment at materialization time.
   */
  bindingProfile: "stock-fixed-v1" | "recipe-bound-v1" | "recipe-bound-v2";
  requestSchema: {
    type: "object";
    properties: Record<string, { type?: string }>;
    required?: string[];
    additionalProperties: false;
  };
}
