import { getAddress, type Hex } from "viem";
import { config } from "../config.js";
import {
  confirmProviderWrite,
  loadProviderWrite,
  prepareAndBroadcastProviderWrite,
  rebroadcastProviderWrite,
  revertProviderWrite,
} from "../chain/providerWriteCoordinator.js";
import { waitForCanonicalFinalReceipt } from "../chain/finality.js";
import { canonicalHash } from "../standardRail/canonical.js";
import {
  claimSplitterProviderWrite,
  confirmSplitterWrite,
  listGatewaySplitterWrites,
  markRegistrationBroadcast,
} from "./store.js";
import { factoryAbi } from "./prepared.js";
import type { GatewayRegistrationView } from "./types.js";

type PreparedListing = GatewayRegistrationView["prepared"]["listings"][number];

// Broadcast one listing's splitter deployment (no confirmation wait). The
// chain-write journal persists the signed transaction and the listing's
// claim in one transaction before anything is sent.
async function deployListingSplitter(listing: PreparedListing) {
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
      claimSplitterProviderWrite(listing.listingId, prepared, db),
  });
}

/**
 * Broadcast-only pass: submit every missing splitter deployment without
 * waiting for confirmations, so all services' deployments can share one
 * finality window before the activation phase confirms them.
 */
export async function ensureSplitterBroadcasts(
  localId: string,
  view: GatewayRegistrationView,
): Promise<number> {
  const rows = new Map(
    (await listGatewaySplitterWrites(localId)).map((row) => [row.listing_id, row]),
  );
  let broadcast = 0;
  for (const listing of view.prepared.listings.filter((item) =>
    item.deploymentRequired)) {
    const persisted = rows.get(listing.listingId);
    if (!listing.preparation || !listing.transaction || !persisted) {
      throw new Error("durable splitter preparation is incomplete");
    }
    if (persisted.provider_write_id && persisted.transaction_hash) {
      // Already journaled; resend the same signed bytes only when the
      // original send never reached the mempool. Confirmation belongs to
      // the activation phase.
      const row = await loadProviderWrite(persisted.provider_write_id);
      if (row?.status === "prepared") {
        await rebroadcastProviderWrite(persisted.provider_write_id);
        broadcast += 1;
      }
      continue;
    }
    await deployListingSplitter(listing);
    broadcast += 1;
  }
  await markRegistrationBroadcast(localId);
  return broadcast;
}

async function confirmExistingWrite(
  listingId: string,
  writeId: string,
  transactionHash: Hex,
): Promise<Hex> {
  const row = await loadProviderWrite(writeId);
  if (!row) throw new Error(`provider write ${writeId} is missing`);
  if (row.status === "prepared") await rebroadcastProviderWrite(writeId);
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
  localId: string,
  view: GatewayRegistrationView,
): Promise<Array<{ listingId: string; transactionHash: Hex }>> {
  const rows = new Map(
    (await listGatewaySplitterWrites(localId)).map((row) => [row.listing_id, row]),
  );
  const hashes: Array<{ listingId: string; transactionHash: Hex }> = [];
  for (const listing of view.prepared.listings.filter((item) =>
    item.deploymentRequired)) {
    const persisted = rows.get(listing.listingId);
    if (!listing.preparation || !listing.transaction || !persisted) {
      throw new Error("durable splitter preparation is incomplete");
    }
    if (persisted.provider_write_id && persisted.transaction_hash) {
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
    const write = await deployListingSplitter(listing);
    hashes.push({
      listingId: listing.listingId,
      transactionHash: await confirmExistingWrite(
        listing.listingId,
        write.id,
        write.hash,
      ),
    });
  }
  await markRegistrationBroadcast(localId);
  return hashes.sort((left, right) => left.listingId.localeCompare(right.listingId));
}
