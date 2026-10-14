import {
  concatHex,
  encodeAbiParameters,
  getAddress,
  getCreate2Address,
  keccak256,
} from "viem";
import { assertExactKeys } from "./canonical.js";
import type { ProviderOutcomeConfig } from "./types.js";

/**
 * Structural and cryptographic validation of one materialized outcome: every
 * field present and well formed, the pricing and binding policies coherent,
 * and the splitter provenance reproducible from its own creation code. The
 * same checks gate a boot-time head and a retained version admitted later.
 */
export function validateOutcome(outcome: ProviderOutcomeConfig, chainId: number): void {
  assertExactKeys(outcome, [
    "outcomeId", "serviceSlug", "serviceId", "skillId", "listingManifestHash", "providerOfferHash",
    "pricingMode", "fixedGrossAmount", "quoteMaximumLifetimeSeconds",
    "quoteMinimumPaymentWindowSeconds",
    "providerControlProfileHash", "activeRailProfileHash", "customerIdentityPolicyId", "token", "splitter", "splitterRuntimeCodeHash",
    "splitterFactory", "splitterFactoryRuntimeCodeHash", "splitterCreationCode", "splitterCreationCodeHash",
    "splitterInitCodeHash", "splitterDeploymentSalt", "splitterDeploymentTransaction",
    "splitterDeploymentBlockNumber", "splitterDeploymentBlockHash",
    "splitterActivationBlockNumber", "splitterActivationBlockHash", "splitterActivationPosition",
    "splitterStartingTokenBalance", "splitterStartingReleaseSequence", "tokenRuntimeCodeHash",
    "tokenImplementationAddress", "tokenImplementationRuntimeCodeHash", "tokenImplementationSlot",
    "tokenDomainSeparator",
    "sanctionsOracleRuntimeCodeHash", "providerControlledWallets",
    "maximumSourceLagBlocks", "maximumLogPageEvents", "listingCommitmentHash", "outcomeIdHash", "policyVersionHash",
    "listingEpoch", "providerPayee", "providerTerminalAttestationKey", "daskiCommissionReceiver",
    "commissionBps", "maxOpenOrders", "dispatchDeadlineSeconds",
    "bindingProfile", "requestSchema",
  ], `outcome ${outcome.outcomeId}`);
  const hex32 = /^0x[0-9a-fA-F]{64}$/;
  for (const field of [
    "outcomeId", "serviceSlug", "skillId", "listingEpoch",
  ] as const) {
    if (typeof outcome[field] !== "string" || outcome[field].length === 0) {
      throw new Error(`Standard outcome ${field} must be a non-empty string`);
    }
  }
  if (!/^\d+$/.test(outcome.listingEpoch)) {
    throw new Error(`Outcome ${outcome.outcomeId} listingEpoch must be an unsigned integer`);
  }
  if (
    (outcome.pricingMode !== "fixed" && outcome.pricingMode !== "dynamic") ||
    (outcome.pricingMode === "fixed" && !/^[1-9]\d*$/.test(outcome.fixedGrossAmount)) ||
    (outcome.pricingMode === "dynamic" && outcome.fixedGrossAmount !== "0") ||
    (outcome.pricingMode === "fixed" &&
      (outcome.quoteMaximumLifetimeSeconds !== 0 || outcome.quoteMinimumPaymentWindowSeconds !== 0)) ||
    (outcome.pricingMode === "dynamic" &&
      (!Number.isSafeInteger(outcome.quoteMaximumLifetimeSeconds) ||
        outcome.quoteMaximumLifetimeSeconds < 30 ||
        outcome.quoteMaximumLifetimeSeconds > 300 ||
        !Number.isSafeInteger(outcome.quoteMinimumPaymentWindowSeconds) ||
        outcome.quoteMinimumPaymentWindowSeconds < 15 ||
        outcome.quoteMinimumPaymentWindowSeconds >= outcome.quoteMaximumLifetimeSeconds)) ||
    (outcome.bindingProfile === "stock-fixed-v1" && outcome.pricingMode !== "fixed")
  ) throw new Error(`Outcome ${outcome.outcomeId} pricing policy is invalid`);
  const unsignedInteger = /^(0|[1-9]\d*)$/;
  if (
    !unsignedInteger.test(outcome.splitterDeploymentBlockNumber) ||
    !unsignedInteger.test(outcome.splitterActivationBlockNumber) ||
    !unsignedInteger.test(outcome.splitterStartingTokenBalance) ||
    !unsignedInteger.test(outcome.splitterStartingReleaseSequence) ||
    BigInt(outcome.splitterActivationBlockNumber) < BigInt(outcome.splitterDeploymentBlockNumber) ||
    BigInt(outcome.splitterStartingTokenBalance) >= 1n << 256n ||
    BigInt(outcome.splitterStartingReleaseSequence) >= 1n << 64n ||
    BigInt(outcome.listingEpoch) === 0n ||
    BigInt(outcome.listingEpoch) >= 1n << 64n ||
    outcome.splitterActivationPosition !== "END_OF_BLOCK"
  ) {
    throw new Error(`Outcome ${outcome.outcomeId} splitter activation checkpoint is invalid`);
  }
  for (const field of [
    "serviceId", "listingManifestHash", "providerOfferHash", "providerControlProfileHash", "activeRailProfileHash",
    "splitterFactoryRuntimeCodeHash", "splitterCreationCodeHash", "splitterInitCodeHash",
    "splitterDeploymentSalt", "splitterRuntimeCodeHash", "splitterDeploymentTransaction",
    "splitterDeploymentBlockHash", "splitterActivationBlockHash",
    "tokenRuntimeCodeHash", "listingCommitmentHash",
    "tokenImplementationRuntimeCodeHash", "tokenImplementationSlot", "tokenDomainSeparator",
    "sanctionsOracleRuntimeCodeHash", "outcomeIdHash", "policyVersionHash",
  ] as const) {
    if (!hex32.test(outcome[field])) throw new Error(`Outcome ${outcome.outcomeId} ${field} is invalid`);
  }
  for (const field of [
    "token", "tokenImplementationAddress", "splitter", "splitterFactory", "providerPayee",
    "providerTerminalAttestationKey", "daskiCommissionReceiver",
  ] as const) {
    getAddress(outcome[field]);
  }
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(outcome.splitterCreationCode)) {
    throw new Error(`Outcome ${outcome.outcomeId} splitter creation code is invalid`);
  }
  const constructorArgs = encodeAbiParameters(
    [
      { type: "uint256" }, { type: "address" }, { type: "address" },
      { type: "address" }, { type: "uint16" }, { type: "bytes32" },
      { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" },
    ],
    [
      BigInt(chainId), getAddress(outcome.token), getAddress(outcome.providerPayee),
      getAddress(outcome.daskiCommissionReceiver), outcome.commissionBps, outcome.policyVersionHash,
      outcome.outcomeIdHash, outcome.listingCommitmentHash, BigInt(outcome.listingEpoch),
    ],
  );
  const creationCodeHash = keccak256(outcome.splitterCreationCode);
  const initCodeHash = keccak256(concatHex([outcome.splitterCreationCode, constructorArgs]));
  if (
    creationCodeHash.toLowerCase() !== outcome.splitterCreationCodeHash.toLowerCase() ||
    initCodeHash.toLowerCase() !== outcome.splitterInitCodeHash.toLowerCase() ||
    getCreate2Address({
      from: getAddress(outcome.splitterFactory),
      salt: outcome.splitterDeploymentSalt,
      bytecodeHash: initCodeHash,
    }) !== getAddress(outcome.splitter)
  ) throw new Error(`Outcome ${outcome.outcomeId} splitter provenance is invalid`);
  if (
    !Array.isArray(outcome.providerControlledWallets) ||
    outcome.providerControlledWallets.some((value) => !/^0x[0-9a-fA-F]{40}$/.test(value)) ||
    new Set(outcome.providerControlledWallets.map((value) => getAddress(value).toLowerCase())).size !==
      outcome.providerControlledWallets.length
  ) throw new Error(`Outcome ${outcome.outcomeId} provider-controlled wallet set is invalid`);
  if (
    !Number.isSafeInteger(outcome.commissionBps) || outcome.commissionBps <= 0 ||
    outcome.commissionBps >= 10_000 ||
    !Number.isSafeInteger(outcome.maximumSourceLagBlocks) || outcome.maximumSourceLagBlocks < 0 ||
    !Number.isSafeInteger(outcome.maximumLogPageEvents) || outcome.maximumLogPageEvents < 1 ||
    outcome.maximumLogPageEvents > 100_000 ||
    !Number.isSafeInteger(outcome.dispatchDeadlineSeconds) || outcome.dispatchDeadlineSeconds < 30 ||
    outcome.dispatchDeadlineSeconds > 86_400 ||
    outcome.customerIdentityPolicyId !== "none" ||
    (outcome.bindingProfile !== "stock-fixed-v1" && outcome.bindingProfile !== "recipe-bound-v1" &&
      outcome.bindingProfile !== "recipe-bound-v2") ||
    !outcome.requestSchema || outcome.requestSchema.type !== "object" ||
    outcome.requestSchema.additionalProperties !== false ||
    !outcome.requestSchema.properties || typeof outcome.requestSchema.properties !== "object" ||
    (outcome.requestSchema.required !== undefined && !Array.isArray(outcome.requestSchema.required))
  ) throw new Error(`Outcome ${outcome.outcomeId} policy is invalid`);
  for (const required of outcome.requestSchema.required ?? []) {
    if (typeof required !== "string" || !(required in outcome.requestSchema.properties)) {
      throw new Error(`Outcome ${outcome.outcomeId} request schema has an invalid required field`);
    }
  }
  if (
    outcome.bindingProfile === "stock-fixed-v1" &&
    (Object.keys(outcome.requestSchema.properties).length !== 0 ||
      (outcome.requestSchema.required?.length ?? 0) !== 0)
  ) throw new Error(`Outcome ${outcome.outcomeId} stock-fixed policy cannot accept request fields`);
}
