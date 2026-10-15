import { getAddress, keccak256, stringToHex, type Hex } from "viem";
import { canonicalHash } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { servesControlProfile } from "./controlProfiles.js";
import { STANDARD_DISPATCH_PAYLOAD_KEYS } from "./dispatchContract.js";
import { DispatchRejectedError, dispatchEnvelopeRejection } from "./dispatchErrors.js";
import { verifyGatewayEnvelope } from "./gatewayEnvelope.js";
import type { ProviderOutcomeConfig, SignedEnvelope, StandardRailDispatchV2 } from "./types.js";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ZERO_HASH = `0x${"00".repeat(32)}`;
export const ORDER_ID = /^ord_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Authenticate a dispatch envelope and its payload bindings without reading
 * any state. Its lifetime is checked later: an exact replay of an admitted
 * envelope is answered even after the envelope expired.
 */
export async function verifyDispatchEnvelope(args: {
  config: ProviderStandardRailConfig;
  chainId: number;
  envelope: unknown;
  request: Record<string, unknown>;
}): Promise<SignedEnvelope<StandardRailDispatchV2, 2>> {
  const { config } = args;
  const envelope = await verifyGatewayEnvelope<StandardRailDispatchV2>(args.envelope, {
    artifactType: "StandardRailDispatchV2",
    schemaVersion: 2,
    payloadKeys: STANDARD_DISPATCH_PAYLOAD_KEYS,
    environment: config.environment,
    chainId: args.chainId,
    audience: config.providerAudience,
    signer: config.gatewayDispatchSigner,
    lifetime: null,
  }).catch((error: unknown) => { throw dispatchEnvelopeRejection(error); });
  const dispatch = envelope.payload;
  const hashes = [
    dispatch.providerControlProfileHash, dispatch.dispatchNonce, dispatch.listingManifestHash,
    dispatch.orderKey, dispatch.serviceId, dispatch.outcomeSchemaUid,
    dispatch.providerOfferHash, dispatch.quoteHash, dispatch.canonicalRequestHash,
    dispatch.orderNonce, dispatch.buyerIdentityProofHash, dispatch.activeRailProfileHash,
    dispatch.facilitatorConfirmationHash, dispatch.settlementTxHash, dispatch.depositBlockHash,
    dispatch.depositEvidenceHash, dispatch.releaseTxHash, dispatch.releaseBlockHash,
    dispatch.releaseEvidenceHash, dispatch.canonicalProviderRequestHash,
  ];
  const unsignedDecimal = /^(0|[1-9]\d*)$/;
  const depositBlockNumber = typeof dispatch.depositBlockNumber === "string" &&
    unsignedDecimal.test(dispatch.depositBlockNumber) ? BigInt(dispatch.depositBlockNumber) : -1n;
  const releaseBlockNumber = typeof dispatch.releaseBlockNumber === "string" &&
    unsignedDecimal.test(dispatch.releaseBlockNumber) ? BigInt(dispatch.releaseBlockNumber) : -1n;
  const releaseAfterDeposit = releaseBlockNumber > depositBlockNumber ||
    (releaseBlockNumber === depositBlockNumber &&
      dispatch.releaseTransactionIndex > dispatch.depositTransactionIndex) ||
    (releaseBlockNumber === depositBlockNumber &&
      dispatch.releaseTransactionIndex === dispatch.depositTransactionIndex &&
      dispatch.releaseLogIndex > dispatch.depositLogIndex);
  let requestHash: string | null = null;
  try {
    requestHash = canonicalHash(args.request);
  } catch {
    requestHash = null;
  }
  const decimal = (value: unknown) => typeof value === "string" && /^[1-9]\d*$/.test(value);
  if (
    dispatch.environment !== config.environment || dispatch.chainId !== args.chainId ||
    dispatch.gatewayAudience !== config.gatewayAudience ||
    dispatch.providerAudience !== config.providerAudience ||
    dispatch.reputationEligible !== true ||
    typeof dispatch.reputationContract !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(dispatch.reputationContract) ||
    getAddress(dispatch.reputationContract) !== config.reputationContract ||
    dispatch.outcomeSchemaUid !== config.reputationOutcomeSchemaUid ||
    dispatch.issuedAt !== envelope.issuedAt || dispatch.validBefore !== envelope.validBefore ||
    requestHash === null || dispatch.canonicalProviderRequestHash !== requestHash ||
    typeof dispatch.payer !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(dispatch.payer) ||
    typeof dispatch.orderId !== "string" || !ORDER_ID.test(dispatch.orderId) ||
    dispatch.orderKey !== keccak256(stringToHex(dispatch.orderId)) ||
    hashes.some((hash) => typeof hash !== "string" || !HASH.test(hash)) ||
    dispatch.facilitatorConfirmationHash.toLowerCase() === ZERO_HASH ||
    depositBlockNumber < 0n || releaseBlockNumber < 0n ||
    !Number.isSafeInteger(dispatch.depositTransactionIndex) || dispatch.depositTransactionIndex < 0 ||
    !Number.isSafeInteger(dispatch.depositLogIndex) || dispatch.depositLogIndex < 0 ||
    !Number.isSafeInteger(dispatch.releaseTransactionIndex) || dispatch.releaseTransactionIndex < 0 ||
    !Number.isSafeInteger(dispatch.releaseLogIndex) || dispatch.releaseLogIndex < 0 ||
    !decimal(dispatch.releaseSequence) || BigInt(dispatch.releaseSequence) >= 1n << 64n ||
    !releaseAfterDeposit ||
    (depositBlockNumber === releaseBlockNumber &&
      dispatch.depositBlockHash.toLowerCase() !== dispatch.releaseBlockHash.toLowerCase()) ||
    (depositBlockNumber === releaseBlockNumber &&
      dispatch.depositTransactionIndex === dispatch.releaseTransactionIndex &&
      dispatch.settlementTxHash.toLowerCase() !== dispatch.releaseTxHash.toLowerCase()) ||
    !decimal(dispatch.grossAmount) || !decimal(dispatch.providerNetAmount) ||
    !decimal(dispatch.daskiCommissionAmount) ||
    BigInt(dispatch.providerNetAmount) + BigInt(dispatch.daskiCommissionAmount) !== BigInt(dispatch.grossAmount) ||
    !Number.isSafeInteger(dispatch.dispatchDeadlineSeconds) || dispatch.dispatchDeadlineSeconds < 30
  ) throw new DispatchRejectedError("validator", "Dispatch payload binding is invalid");
  return envelope as SignedEnvelope<StandardRailDispatchV2, 2>;
}

/** A new claim needs a current envelope with the listing's exact deadline. */
export function assertFreshClaimEnvelope(
  envelope: SignedEnvelope<StandardRailDispatchV2, 2>,
  outcome: ProviderOutcomeConfig,
  now = Math.floor(Date.now() / 1_000),
): void {
  if (
    envelope.validBefore <= now ||
    envelope.payload.dispatchDeadlineSeconds !== outcome.dispatchDeadlineSeconds ||
    envelope.validBefore !== envelope.issuedAt + outcome.dispatchDeadlineSeconds
  ) throw new DispatchRejectedError("envelope_lifetime", "Dispatch envelope lifetime is invalid for a new claim");
}

/**
 * The dispatched order must match the policy of the listing version it
 * names. Its control profile is the one its checkout snapshot committed:
 * the outcome's own, or an earlier profile this deployment retains.
 */
export function assertDispatchOutcomePolicy(
  dispatch: StandardRailDispatchV2,
  outcome: ProviderOutcomeConfig,
  retainedControlProfiles: readonly Hex[] = [],
): void {
  if (
    typeof dispatch.providerControlProfileHash !== "string" ||
    !servesControlProfile(dispatch.providerControlProfileHash, outcome.providerControlProfileHash, retainedControlProfiles) ||
    outcome.serviceId !== dispatch.serviceId ||
    outcome.activeRailProfileHash !== dispatch.activeRailProfileHash ||
    outcome.customerIdentityPolicyId !== "none" ||
    dispatch.buyerIdentityProofHash.toLowerCase() !== ZERO_HASH ||
    outcome.bindingProfile !== dispatch.bindingProfile
  ) throw new DispatchRejectedError("outcome_policy", "Dispatch conflicts with the provider outcome policy");
}

export function assertNotSelfPurchase(
  config: ProviderStandardRailConfig,
  dispatch: StandardRailDispatchV2,
  outcome: ProviderOutcomeConfig,
): void {
  const forbidden = [
    config.providerAuthorityKey, config.terminalAttestationKey, outcome.providerPayee,
    outcome.providerTerminalAttestationKey,
    outcome.daskiCommissionReceiver, outcome.splitter, ...outcome.providerControlledWallets,
  ].map((address) => getAddress(address).toLowerCase());
  if (forbidden.includes(getAddress(dispatch.payer).toLowerCase())) {
    throw new DispatchRejectedError("self_purchase", "Known provider or operational self-purchase is forbidden");
  }
}
