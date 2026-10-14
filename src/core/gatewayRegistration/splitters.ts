import { getAddress, type Hex } from "viem";
import { config } from "../config.js";
import {
  confirmProviderWrite,
  loadProviderWrite,
  prepareAndBroadcastProviderWrite,
  rebroadcastProviderWrite,
  replaceProviderWrite,
  revertProviderWrite,
} from "../chain/providerWriteCoordinator.js";
import { finalizedReadBlockNumber, waitForCanonicalFinalReceipt } from "../chain/finality.js";
import { receiptOf, walletNonceAt } from "../chain/writeOutcome.js";
import { canonicalHash } from "../standardRail/canonical.js";
import {
  claimSplitterProviderWrite,
  confirmSplitterWrite,
  ensureSplitterPreparations,
  listGatewaySplitterWrites,
  releaseSplitterClaim,
} from "./splitterRows.js";
import { markRegistrationBroadcast, type RegistrationRef } from "./store.js";
import { factoryAbi } from "./prepared.js";
import type { GatewayRegistrationView } from "./types.js";

type PreparedListing = GatewayRegistrationView["prepared"]["listings"][number];

// Broadcast one listing's splitter deployment (no confirmation wait). The
// chain-write journal persists the signed transaction and the listing's
// claim in one transaction before anything is sent, and the claim holds only
// while the registration still carries the intent this run acts on.
async function deployListingSplitter(registration: RegistrationRef, listing: PreparedListing) {
  const preparation = listing.preparation!;
  const transaction = listing.transaction!;
  const payload = preparation.payload;
  return prepareAndBroadcastProviderWrite({
    purpose: "splitter_deployment",
    target: { type: "gateway_listing", id: listing.listingId },
    address: getAddress(transaction.to),
    abi: factoryAbi,
    functionName: "deploy",
    callArgs: [
      payload.splitterDeploymentSalt,
      BigInt(config.CHAIN_ID),
      getAddress(payload.canonicalToken),
      getAddress(payload.providerPayee),
      getAddress(payload.daskiCommissionReceiver),
      payload.commissionBps,
      payload.policyVersionHash,
      payload.listingKey,
      canonicalHash(preparation),
      BigInt(payload.listingEpoch),
    ],
    persist: (prepared, db) =>
      claimSplitterProviderWrite(registration, listing.listingId, prepared, db),
  });
}

// Resend a journaled deployment whose first send was not confirmed, with its
// original signed bytes. A node that already has it, or already mined it,
// refuses the resend ("already known", "nonce too low"); the receipt wait
// decides then.
async function resend(writeId: string): Promise<boolean> {
  try {
    await rebroadcastProviderWrite(writeId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Close a journaled deployment another transaction displaced at its nonce:
 * it can never be mined, so the write is recorded as replaced and the
 * listing's claim is freed for a fresh deployment. Returns whether it was.
 */
async function releaseDisplacedWrite(
  registration: RegistrationRef,
  listingId: string,
  writeId: string,
): Promise<boolean> {
  const row = await loadProviderWrite(writeId);
  if (!row || (row.status !== "prepared" && row.status !== "broadcast")) return false;
  // Displaced: no receipt of its own (a failed read proves nothing), while
  // the wallet's nonce at the finalized depth is already past its nonce.
  if (await receiptOf(row.transaction_hash) !== null) return false;
  if (await walletNonceAt(await finalizedReadBlockNumber()) <= BigInt(row.nonce)) return false;
  await replaceProviderWrite(writeId, null, "nonce_consumed");
  await releaseSplitterClaim(registration, listingId, writeId);
  return true;
}

/**
 * Broadcast-only pass: submit every missing splitter deployment without
 * waiting for confirmations, so all services' deployments can share one
 * finality window before the activation phase confirms them.
 */
export async function ensureSplitterBroadcasts(
  registration: RegistrationRef,
  view: GatewayRegistrationView,
): Promise<number> {
  await ensureSplitterPreparations(registration, view);
  const rows = new Map(
    (await listGatewaySplitterWrites(registration.id)).map((row) => [row.listing_id, row]),
  );
  let broadcast = 0;
  for (const listing of view.prepared.listings.filter((item) =>
    item.deploymentRequired)) {
    const persisted = rows.get(listing.listingId);
    if (!listing.preparation || !listing.transaction || !persisted) {
      throw new Error("durable splitter preparation is incomplete");
    }
    if (
      persisted.provider_write_id && persisted.transaction_hash &&
      !await releaseDisplacedWrite(registration, listing.listingId, persisted.provider_write_id)
    ) {
      // Already journaled; resend the same signed bytes only when the
      // original send never reached the mempool. Confirmation belongs to
      // the activation phase.
      const row = await loadProviderWrite(persisted.provider_write_id);
      if (row?.status === "prepared" && await resend(persisted.provider_write_id)) {
        broadcast += 1;
      }
      continue;
    }
    await deployListingSplitter(registration, listing);
    broadcast += 1;
  }
  await markRegistrationBroadcast(registration);
  return broadcast;
}

async function confirmExistingWrite(
  listingId: string,
  writeId: string,
  transactionHash: Hex,
): Promise<Hex> {
  const row = await loadProviderWrite(writeId);
  if (!row) throw new Error(`provider write ${writeId} is missing`);
  if (row.status === "prepared") await resend(writeId);
  if (row.status === "reverted") throw new Error(`splitter write ${writeId} reverted`);
  const receipt = await waitForCanonicalFinalReceipt(transactionHash);
  if (receipt.status !== "success") {
    await revertProviderWrite(writeId, "splitter_deployment_reverted");
    throw new Error(`splitter deployment for ${listingId} reverted`);
  }
  await confirmProviderWrite(writeId);
  await confirmSplitterWrite(listingId, writeId);
  return transactionHash;
}

/**
 * Confirm every required splitter deployment at the configured finality,
 * deploying the ones never journaled. Returns the deployment transaction
 * hashes the activation evidence binds, sorted by listing id.
 */
export async function confirmSplitterDeployments(
  registration: RegistrationRef,
  view: GatewayRegistrationView,
): Promise<Array<{ listingId: string; transactionHash: Hex }>> {
  await ensureSplitterPreparations(registration, view);
  const rows = new Map(
    (await listGatewaySplitterWrites(registration.id)).map((row) => [row.listing_id, row]),
  );
  const hashes: Array<{ listingId: string; transactionHash: Hex }> = [];
  for (const listing of view.prepared.listings.filter((item) =>
    item.deploymentRequired)) {
    const persisted = rows.get(listing.listingId);
    if (!listing.preparation || !listing.transaction || !persisted) {
      throw new Error("durable splitter preparation is incomplete");
    }
    if (
      persisted.provider_write_id && persisted.transaction_hash &&
      !await releaseDisplacedWrite(registration, listing.listingId, persisted.provider_write_id)
    ) {
      hashes.push({
        listingId: listing.listingId,
        transactionHash: await confirmExistingWrite(
          listing.listingId,
          persisted.provider_write_id,
          persisted.transaction_hash,
        ),
      });
      continue;
    }
    const write = await deployListingSplitter(registration, listing);
    hashes.push({
      listingId: listing.listingId,
      transactionHash: await confirmExistingWrite(
        listing.listingId,
        write.id,
        write.hash,
      ),
    });
  }
  await markRegistrationBroadcast(registration);
  return hashes.sort((left, right) => left.listingId.localeCompare(right.listingId));
}
