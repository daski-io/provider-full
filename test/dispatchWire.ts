import { randomBytes, randomUUID } from "node:crypto";
import { getAddress, keccak256, stringToHex, type Hex } from "viem";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import type {
  ProviderOutcomeConfig,
  QuoteV1,
  SignedEnvelope,
  StandardEvidenceBundleV2,
  StandardRailDispatchV2,
} from "../src/core/standardRail/types.js";
import { signGatewayEnvelope } from "./gatewayConsumer.js";
import {
  CHAIN_ID, ENVIRONMENT, GATEWAY_AUDIENCE, gatewayKey, hash, PROVIDER_AUDIENCE,
} from "./standardRailFixture.js";

/*
 * Builds QuoteV1, StandardRailDispatchV2 and the evidence bundle the way the
 * gateway does at 8f15201 (service.ts issueChallenge, providerDispatch.ts
 * buildPayload, wireContracts.ts buildStandardEvidenceBundleV2).
 */

const random32 = (): Hex => `0x${randomBytes(32).toString("hex")}`;

export interface ProviderQuoteFacts {
  providerQuoteHash: Hex;
  grossAmount: string;
  issuedAt: number;
  validBefore: number;
}

export async function gatewayQuoteV1(args: {
  outcome: ProviderOutcomeConfig;
  request: Record<string, unknown>;
  providerQuote: ProviderQuoteFacts;
  /** The gateway's own challenge expiry; never later than the provider quote. */
  validBefore?: number;
}): Promise<SignedEnvelope<QuoteV1>> {
  const canonicalRequestHash = canonicalHash({
    method: "POST",
    resource: `${GATEWAY_AUDIENCE}/standard/outcomes/${args.outcome.outcomeId}`,
    providerAgentId: "1",
    outcomeId: args.outcome.outcomeId,
    body: args.request,
  });
  const validBefore = args.validBefore ?? args.providerQuote.validBefore;
  return signGatewayEnvelope<QuoteV1>({
    artifactType: "QuoteV1",
    environment: ENVIRONMENT,
    chainId: CHAIN_ID,
    audience: GATEWAY_AUDIENCE,
    signerKeyId: "gateway-quote",
    privateKey: gatewayKey,
    issuedAt: args.providerQuote.issuedAt,
    validBefore,
    payload: {
      listingManifestHash: args.outcome.listingManifestHash,
      providerOfferHash: args.outcome.providerOfferHash,
      providerQuoteHash: args.providerQuote.providerQuoteHash,
      canonicalRequestHash,
      grossAmount: args.providerQuote.grossAmount,
      token: args.outcome.token,
      splitter: args.outcome.splitter,
      orderNonce: random32(),
      issuedAt: args.providerQuote.issuedAt,
      validBefore,
    },
  }) as Promise<SignedEnvelope<QuoteV1>>;
}

export interface DispatchArgs {
  dispatch: SignedEnvelope<StandardRailDispatchV2, 2>;
  quote: SignedEnvelope<QuoteV1>;
  request: Record<string, unknown>;
  evidenceBundle: StandardEvidenceBundleV2;
}

/** A fresh dispatch envelope for one paid order; every call is a new nonce. */
export async function gatewayDispatch(args: {
  outcome: ProviderOutcomeConfig;
  quote: SignedEnvelope<QuoteV1>;
  request: Record<string, unknown>;
  payer: Hex;
  orderId?: string;
  issuedAt?: number;
  reputationContract: Hex;
  outcomeSchemaUid: Hex;
  evidence?: StandardEvidenceBundleV2;
}): Promise<DispatchArgs> {
  const orderId = args.orderId ?? `ord_${randomUUID()}`;
  const issuedAt = args.issuedAt ?? Math.floor(Date.now() / 1_000);
  const validBefore = issuedAt + args.outcome.dispatchDeadlineSeconds;
  const evidence = args.evidence ?? gatewayEvidenceBundle();
  const gross = BigInt(args.quote.payload.grossAmount);
  const commission = gross * BigInt(args.outcome.commissionBps) / 10_000n || 1n;
  const payload: StandardRailDispatchV2 = {
    environment: ENVIRONMENT,
    chainId: CHAIN_ID,
    gatewayAudience: GATEWAY_AUDIENCE,
    providerAudience: PROVIDER_AUDIENCE,
    providerControlProfileHash: args.outcome.providerControlProfileHash,
    orderId,
    orderKey: keccak256(stringToHex(orderId)),
    serviceId: args.outcome.serviceId,
    reputationEligible: true,
    reputationContract: args.reputationContract,
    outcomeSchemaUid: args.outcomeSchemaUid,
    dispatchNonce: random32(),
    payer: getAddress(args.payer),
    listingManifestHash: args.outcome.listingManifestHash,
    providerOfferHash: args.outcome.providerOfferHash,
    quoteHash: canonicalHash(args.quote),
    bindingProfile: args.outcome.bindingProfile,
    canonicalRequestHash: args.quote.payload.canonicalRequestHash,
    orderNonce: args.quote.payload.orderNonce,
    buyerIdentityProofHash: hash("0"),
    activeRailProfileHash: args.outcome.activeRailProfileHash,
    facilitatorConfirmationHash: random32(),
    settlementTxHash: evidence.deposit.transactionHash,
    depositBlockNumber: evidence.deposit.blockNumber,
    depositBlockHash: evidence.deposit.blockHash,
    depositTransactionIndex: evidence.deposit.transactionIndex,
    depositLogIndex: evidence.deposit.logIndex,
    depositEvidenceHash: evidence.deposit.evidenceHash,
    releaseTxHash: evidence.release.transactionHash,
    releaseBlockNumber: evidence.release.blockNumber,
    releaseBlockHash: evidence.release.blockHash,
    releaseTransactionIndex: evidence.release.transactionIndex,
    releaseLogIndex: evidence.release.logIndex,
    releaseSequence: evidence.release.releaseSequence,
    releaseEvidenceHash: evidence.release.evidenceHash,
    grossAmount: gross.toString(),
    providerNetAmount: (gross - commission).toString(),
    daskiCommissionAmount: commission.toString(),
    canonicalProviderRequestHash: canonicalHash(args.request),
    dispatchDeadlineSeconds: args.outcome.dispatchDeadlineSeconds,
    issuedAt,
    validBefore,
  };
  const dispatch = await signGatewayEnvelope<StandardRailDispatchV2>({
    artifactType: "StandardRailDispatchV2",
    schemaVersion: 2,
    environment: ENVIRONMENT,
    chainId: CHAIN_ID,
    audience: PROVIDER_AUDIENCE,
    signerKeyId: "gateway-dispatch",
    privateKey: gatewayKey,
    issuedAt,
    validBefore,
    payload,
  }) as SignedEnvelope<StandardRailDispatchV2, 2>;
  return { dispatch, quote: args.quote, request: structuredClone(args.request), evidenceBundle: evidence };
}

/** Synthetic, internally consistent deposit and release evidence. */
export function gatewayEvidenceBundle(): StandardEvidenceBundleV2 {
  const deposit = { kind: "deposit", id: randomUUID() };
  const release = { kind: "release", id: randomUUID() };
  return {
    deposit: {
      transactionHash: random32(), blockNumber: "200", blockHash: random32(), transactionIndex: 0,
      logIndex: 1, evidenceHash: canonicalHash(deposit), canonicalEvidence: deposit, sources: ["rpc-a"],
    },
    release: {
      transactionHash: random32(), blockNumber: "201", blockHash: random32(), transactionIndex: 0,
      logIndex: 2, releaseSequence: "1", evidenceHash: canonicalHash(release), canonicalEvidence: release,
      sources: ["rpc-a"],
    },
  };
}

/** Re-sign a dispatch after a test mutates its payload. */
export async function resignDispatch(
  dispatch: SignedEnvelope<StandardRailDispatchV2, 2>,
): Promise<SignedEnvelope<StandardRailDispatchV2, 2>> {
  const { signature: _signature, ...unsigned } = dispatch;
  return signGatewayEnvelope({ ...unsigned, privateKey: gatewayKey }) as Promise<SignedEnvelope<StandardRailDispatchV2, 2>>;
}
