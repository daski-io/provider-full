---
title: "Standard rail evidence V2"
status: canonical
authority: current repository implementation and approved maintainer workflow
owner: repository maintainers
effective-date: 2026-10-21 (payout interval checkpoint); other sections unchanged
last-verified: 2026-10-21 (payout interval against releaseInterval.ts and evidence.ts; no live release verification)
supersedes: the payout interval scanned from the activation or a full search for release N - 1
superseded-by: none
sensitivity: public-safe
related-repositories: daski-io/provider-full; daski-io/provider; daski-io/gateway; daski-io/contracts
review-trigger: evidence verification, splitter contract or gateway evidence change
---

# Standard rail evidence V2

The provider accepts only StandardRailDispatchV2 envelopes with schema version
2. The signed dispatch, submitted StandardEvidenceBundleV2, and eventual
StandardRailReceiptV2 bind the same mined deposit and release coordinates.

## Signed coordinates

The V2 dispatch and receipt contain these flat settlement fields:

    settlementTxHash: 0x...
    depositBlockNumber: "123"
    depositBlockHash: 0x...
    depositTransactionIndex: 4
    depositLogIndex: 7
    depositEvidenceHash: 0x...
    releaseTxHash: 0x...
    releaseBlockNumber: "125"
    releaseBlockHash: 0x...
    releaseTransactionIndex: 2
    releaseLogIndex: 11
    releaseSequence: "9"
    releaseEvidenceHash: 0x...

Block numbers and the release sequence are canonical unsigned decimal strings.
Transaction and log indexes are nonnegative safe integers. The release position
must be strictly after the deposit position. Same-block and same-transaction
hashes and coordinates must agree.

The nested bundle repeats the exact transaction hash, block number/hash,
transaction index, and log index under deposit and release. Release also
repeats releaseSequence. Each side includes evidenceHash, canonicalEvidence,
and sources. The provider rejects any mismatch between this bundle, its
canonical hashes, and the signed dispatch.

## Receipt and log semantics

Settlement proof is based on finalized receipts and ordered token/splitter
logs. It does not depend on the outer transaction target or calldata. A
facilitator may call the token or splitter through a wrapper, append inert
calldata accepted by the called ABI, or include multiple releases in one
transaction. Signed log coordinates and releaseSequence select one exact
deposit and one exact release.

The selected canonical-token Transfer must move the signed gross amount from
the payer to the splitter. The same receipt must contain the payer's
AuthorizationUsed event. Recipe-bound orders require the locally derived
recipe nonce; stock-fixed orders require one unambiguous payer authorization
in that receipt.

The selected Released event must match the outcome, listing epoch, policy,
listing commitment, gross amount, provider net, and commission. Exactly two
splitter-origin token transfers may occur between the previous and selected
release positions: provider payout first, then the Daski commission payout.
Transfers after the selected release are outside that interval.

## Activation checkpoint and intervals

Every outcome pins a finalized end-of-block checkpoint:

- splitterActivationBlockNumber
- splitterActivationBlockHash
- splitterActivationPosition, exactly END_OF_BLOCK
- splitterStartingTokenBalance
- splitterStartingReleaseSequence

Deposits and releases must be in blocks strictly after activation, and the
release sequence N must exceed startingReleaseSequence. Accounting starts at a
second end-of-block checkpoint, read from the selected evidence source at the
block before the deposit: the splitter's canonical-token balance and its
releaseSequence. The splitter's reviewed runtime code pays out its whole
balance on each release, moves the token at no other time and numbers releases
one by one, so:

- A checkpoint sequence of N - 1 (startingReleaseSequence for the first
  release) means no release happened between the checkpoint and release N.
  Accounting begins with the checkpoint balance, which is the signed starting
  balance or zero plus every credit since the activation or release N - 1, and
  scanning begins at the deposit block.
- A checkpoint sequence from startingReleaseSequence to N - 2 puts release
  N - 1 in the deposit block or later. The exact N - 1 release must appear once
  between the deposit block and release N; scanning continues strictly after
  its position and the interval gross amount is computed from zero.
- Any other checkpoint sequence is rejected.

The scan therefore covers the deposit block through the release block,
however old the listing or long since its previous release. Validation is
interval-based: it does not rely on a cumulative gross value or an
end-of-release-block balance snapshot.

maximumLogPageEvents is a per-RPC-page density target. Dense multi-block
queries are subdivided adaptively. It is not a lifetime-history cap; a single
dense block is indivisible and is processed as one page.

## Splitter provenance

Outcome configuration independently hashes the raw splitter creation code,
reconstructs the constructor encoding and full init-code hash, and derives the
CREATE2 address locally. It does not trust the factory address helper.

Readiness verifies:

- the pinned deployment transaction hash, factory target, zero value, and exact
  canonical deploy calldata;
- the successful receipt and pinned deployment block number/hash;
- the exact OutcomeSplitterDeployed event;
- reviewed factory and splitter runtime hashes at deployment and current state;
- every splitter immutable getter; and
- the activation block hash, token balance, release sequence, and token,
  splitter, and factory runtime hashes.

Each configured evidence source performs these queries independently. Sources
must agree within the approved head lag.
