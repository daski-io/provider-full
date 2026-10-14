import type { Hex } from "viem";
import { publicClient } from "./client.js";
import { serviceRegistryAbi } from "./abis.js";
import { config } from "../config.js";
import type { ServiceRow } from "../db/queries/services.js";
import type { ProviderChainWriteRow } from "../db/queries/providerChainWrites.js";
import {
  confirmProviderWrite,
  prepareAndBroadcastProviderWrite,
  revertProviderWrite,
} from "./providerWriteCoordinator.js";
import { finalizedReadBlockNumber } from "./finality.js";
import {
  JournaledWriteObserved,
  assertCycleCurrent,
  awaitFinalReceipt,
  type ReconcileCycle,
} from "./reconcileCycle.js";
import {
  INHERITED_SERVICE_WALLET,
  assertRegisteredService,
  reconcileRegisteredService,
  serviceUriFor,
} from "./registeredService.js";
import { isServiceAlreadyRegisteredRevert } from "./registrationReverts.js";
import {
  openRegistrationWrites,
  registryHolds,
  resumeServiceWrite,
  settleServiceWrites,
  waitForFinalizedRegistration,
} from "./registrationWrites.js";

// One service's ServiceRegistry registration: verify an existing entry and
// heal its discovery URI, resume a journaled registration write, adopt a
// peer's registration once final, or submit a new one. The reconcile cycle in
// serviceRegistrar.ts drives these steps and owns their verdict.

export async function registerOne(service: ServiceRow, cycle: ReconcileCycle): Promise<Hex> {
  // 1. Compute the expected serviceId without any state change.
  const expected = (await publicClient.readContract({
    address: config.SERVICE_REGISTRY_ADDRESS as Hex,
    abi: serviceRegistryAbi,
    functionName: "computeServiceId",
    args: [config.PROVIDER_AGENT_ID, service.slug, service.version],
  })) as Hex;

  // 2. Record every journaled write whose outcome is final, so a reverted
  // write, or one whose nonce another transaction used, no longer stands in
  // for a registration. Then: did someone else already register this id
  // (e.g. a prior boot that succeeded on-chain but failed before writing
  // services.on_chain_id)? The contract reverts on collision so we must
  // check first.
  const finalizedBlock = await finalizedReadBlockNumber();
  await settleServiceWrites(service.id, finalizedBlock);
  if (await registryHolds(expected, finalizedBlock)) {
    await reconcileRegisteredService(service, expected, finalizedBlock, cycle);
    return expected;
  }

  // 3. A registration this provider already journaled, whose transaction may
  // still be pending, is resumed and never signed a second time.
  const [journaled] = await openRegistrationWrites(service.id);
  if (journaled) return resumeRegistrationWrite(service, expected, journaled, cycle);

  // 4. Submit a registration tx. serviceWallet=0x0 inherits the provider
  // wallet; a non-zero wallet records a service-specific operating account.
  const serviceWallet = (service.service_wallet ??
    INHERITED_SERVICE_WALLET) as Hex;

  let peerRegistrationBlock: bigint | null = null;
  let peerWrite: ProviderChainWriteRow | null = null;
  let write;
  try {
    write = await prepareAndBroadcastProviderWrite({
      purpose: "service_registration",
      target: { type: "service", id: service.id },
      address: config.SERVICE_REGISTRY_ADDRESS as Hex,
      abi: serviceRegistryAbi,
      functionName: "registerService",
      callArgs: [
        config.PROVIDER_AGENT_ID,
        service.slug,
        service.version,
        serviceUriFor(service),
        serviceWallet,
      ],
      preflight: async () => {
        assertCycleCurrent(cycle);
        const blockNumber = await finalizedReadBlockNumber();
        if (await registryHolds(expected, blockNumber)) {
          peerRegistrationBlock = blockNumber;
          throw new JournaledWriteObserved();
        }
        // Under the signer lease every registrar journals under: one another
        // replica or the CLI journaled since step 3 is resumed instead.
        peerWrite = (await openRegistrationWrites(service.id))[0] ?? null;
        if (peerWrite) throw new JournaledWriteObserved();
      },
      // Checked again inside the journal transaction, after signing and just
      // before broadcast: a cycle its budget abandoned meanwhile persists and
      // sends nothing.
      persist: async () => cycle.isCurrent(),
    });
  } catch (error) {
    if (error instanceof JournaledWriteObserved && peerWrite) {
      return resumeRegistrationWrite(service, expected, peerWrite, cycle);
    }
    if (error instanceof JournaledWriteObserved && peerRegistrationBlock !== null) {
      await reconcileRegisteredService(service, expected, peerRegistrationBlock, cycle);
      return expected;
    }
    // The registry already holds the id although the finalized-depth reads
    // above could not see it: it was mined fewer than
    // CHAIN_WRITE_FINALITY_CONFIRMATIONS blocks ago, typically by another
    // replica. Adopt it once it is final; only a registration that is not at
    // the latest block either makes the revert an error.
    if (isServiceAlreadyRegisteredRevert(error) &&
        await adoptVisibleRegistration(service, expected, cycle)) {
      return expected;
    }
    throw error;
  }
  const receipt = await awaitFinalReceipt(cycle, write.hash);
  return finishRegistrationWrite(service, expected, write, receipt.status, cycle);
}

/**
 * Verify a registration another replica's transaction made: visible at the
 * latest block, then waited for until it is final and checked at the
 * finalized depth like this provider's own registrations.
 */
async function adoptVisibleRegistration(
  service: ServiceRow,
  expected: Hex,
  cycle: ReconcileCycle,
): Promise<boolean> {
  // A fresh head, not the one the preflight's finality read just cached:
  // a registration mined in the newest block must be visible.
  const latestBlock = await publicClient.getBlockNumber({ cacheTime: 0 }) as bigint;
  if (!await registryHolds(expected, latestBlock)) return false;
  const finalizedBlock = await cycle.awaitBroadcast(() =>
    waitForFinalizedRegistration(expected));
  await reconcileRegisteredService(service, expected, finalizedBlock, cycle);
  return true;
}

async function finishRegistrationWrite(
  service: ServiceRow,
  expected: Hex,
  write: { id: string; hash: Hex },
  status: string,
  cycle: ReconcileCycle,
): Promise<Hex> {
  if (status !== "success") {
    await revertProviderWrite(write.id, "canonical_receipt_reverted");
    // A peer's registration mined first and this duplicate reverted.
    if (await adoptVisibleRegistration(service, expected, cycle)) return expected;
    throw new Error(`registerService tx reverted: ${write.hash}`);
  }
  await confirmProviderWrite(write.id);
  const postRegistrationBlock = await finalizedReadBlockNumber();
  await assertRegisteredService(service, expected, postRegistrationBlock);
  return expected;
}

// Resume a journaled registration until the registry holds the entry at the
// finalized depth, whichever attempt at its nonce is mined.
async function resumeRegistrationWrite(
  service: ServiceRow,
  expected: Hex,
  write: ProviderChainWriteRow,
  cycle: ReconcileCycle,
): Promise<Hex> {
  const outcome = await resumeServiceWrite({
    write,
    label: `registerService for ${service.slug}`,
    cycle,
    reached: (blockNumber) => registryHolds(expected, blockNumber),
  });
  if ("reverted" in outcome) {
    return finishRegistrationWrite(
      service,
      expected,
      { id: write.id, hash: write.transaction_hash },
      "reverted",
      cycle,
    );
  }
  await settleServiceWrites(service.id, outcome.finalizedBlock);
  await reconcileRegisteredService(service, expected, outcome.finalizedBlock, cycle);
  return expected;
}

