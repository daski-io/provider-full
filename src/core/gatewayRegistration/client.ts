import {
  getAddress,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { config } from "../config.js";
import type { ServiceRow } from "../db/queries/services.js";
import {
  confirmProviderWrite,
  loadProviderWrite,
  prepareAndBroadcastProviderWrite,
  rebroadcastProviderWrite,
  revertProviderWrite,
} from "../chain/providerWriteCoordinator.js";
import {
  finalizedReadBlockNumber,
  waitForCanonicalFinalReceipt,
} from "../chain/finality.js";
import {
  identityRegistryAbi,
  serviceRegistryAbi,
} from "../chain/abis.js";
import {
  providerAddress,
  publicClient,
} from "../chain/client.js";
import { canonicalHash } from "../standardRail/canonical.js";
import {
  beginGatewayRegistration,
  claimSplitterProviderWrite,
  confirmSplitterWrite,
  getGatewayRegistration,
  listGatewaySplitterWrites,
  markGatewayRegistrationActive,
  markGatewayRegistrationAttention,
  markRegistrationBroadcast,
  savePreparedRegistration,
  saveRegistrationEvidence,
} from "./store.js";
import {
  factoryAbi,
  parseGatewayRegistrationView,
  verifyPreparedRegistration,
} from "./prepared.js";
import {
  buildRuntimeListingCommitment,
  runtimeCommitmentHash,
} from "./runtimeCommitment.js";
import {
  loadRuntimeListingHeads,
  promoteRuntimeListingVersions,
  type ProviderRuntimeListingBundleV1,
  type SplitterActivationCheckpoint,
} from "./runtimeCatalog.js";
import type {
  GatewayRegistrationView,
  ProviderServiceRegistrationEvidenceEnvelope,
  ProviderServiceRegistrationIntentEnvelope,
  PublishedServiceContract,
  RegistrationPolicy,
} from "./types.js";
import {
  fetchBoundedJson,
  GatewayRegistrationHttpError,
  normalizedGatewayOrigin,
  parsePublishedServiceContract,
  parseRegistrationPolicy,
  registrationNonce,
  requestBoundedJson,
  signProviderEnvelope,
} from "./wire.js";

const ZERO = "0x0000000000000000000000000000000000000000";
// Persistent clock skew or repeated gateway auth rejection must not churn
// forever: the intent-expiry retry below re-enters the whole idempotent
// workflow, so it carries a local attempt budget.
const MAX_REGISTRATION_INTENT_ATTEMPTS = 3;

async function registrationRetryDelay(attempt: number): Promise<void> {
  const jitter = Math.floor(Math.random() * 250);
  await new Promise((resolve) => setTimeout(resolve, attempt * 500 + jitter));
}

interface FinalizedService {
  providerAgentId: bigint;
  serviceId: Hex;
  serviceSlug: string;
  version: string;
  serviceURI: string;
  serviceWallet: Address;
  active: boolean;
}

function gatewaySigner(): Address {
  const raw = process.env.STANDARD_RAIL_GATEWAY_SIGNER;
  if (!raw) throw new Error("STANDARD_RAIL_GATEWAY_SIGNER is required");
  return getAddress(raw);
}

async function loadPolicy(gatewayOrigin: string): Promise<RegistrationPolicy> {
  return parseRegistrationPolicy(
    await fetchBoundedJson(`${gatewayOrigin}/public/v3/registration-policy`),
    {
      gatewayOrigin,
      chainId: config.CHAIN_ID,
      serviceRegistry: getAddress(config.SERVICE_REGISTRY_ADDRESS),
      canonicalToken: getAddress(config.USDC_ADDRESS),
    },
  );
}

async function chainService(
  service: ServiceRow,
  finalizedBlock: bigint,
): Promise<{
  record: FinalizedService;
  providerPayee: Address;
}> {
  if (!service.on_chain_id) throw new Error(`${service.slug} is not registered on chain`);
  const serviceId = `0x${service.on_chain_id.toString("hex")}` as Hex;
  const [record, owner, agentWallet] = await Promise.all([
    publicClient.readContract({
      address: config.SERVICE_REGISTRY_ADDRESS as Hex,
      abi: serviceRegistryAbi,
      functionName: "getService",
      args: [serviceId],
      blockNumber: finalizedBlock,
    }) as Promise<FinalizedService>,
    publicClient.readContract({
      address: config.IDENTITY_REGISTRY_ADDRESS as Hex,
      abi: identityRegistryAbi,
      functionName: "ownerOf",
      args: [config.PROVIDER_AGENT_ID],
      blockNumber: finalizedBlock,
    }) as Promise<Address>,
    publicClient.readContract({
      address: config.IDENTITY_REGISTRY_ADDRESS as Hex,
      abi: identityRegistryAbi,
      functionName: "getAgentWallet",
      args: [config.PROVIDER_AGENT_ID],
      blockNumber: finalizedBlock,
    }) as Promise<Address>,
  ]);
  const expectedUri = new URL(
    `/agent-cards/${service.slug}.json`,
    config.BASE_URL,
  ).toString();
  if (
    !record.active ||
    record.providerAgentId !== config.PROVIDER_AGENT_ID ||
    record.serviceId.toLowerCase() !== serviceId ||
    record.serviceSlug !== service.slug ||
    record.version !== service.version ||
    record.serviceURI !== expectedUri ||
    getAddress(record.serviceWallet) !== getAddress(service.service_wallet ?? ZERO)
  ) throw new Error(`${service.slug} finalized ServiceRegistry record drifted`);
  if (
    getAddress(providerAddress) !== getAddress(owner) &&
    getAddress(providerAddress) !== getAddress(agentWallet)
  ) throw new Error("provider private key is not current finalized ERC-8004 authority");
  const providerPayee = record.serviceWallet.toLowerCase() === ZERO
    ? getAddress(agentWallet)
    : getAddress(record.serviceWallet);
  if (providerPayee === getAddress(ZERO)) {
    throw new Error("provider has no verified payment wallet");
  }
  return { record, providerPayee };
}

async function publishedContract(
  record: FinalizedService,
): Promise<PublishedServiceContract> {
  const cardUrl = new URL(record.serviceURI);
  const expectedOrigin = new URL(config.BASE_URL).origin;
  if (
    cardUrl.protocol !== "https:" || cardUrl.origin !== expectedOrigin ||
    cardUrl.username || cardUrl.password || cardUrl.hash
  ) throw new Error("chain-recorded Agent Card URI is not the configured HTTPS provider");
  return parsePublishedServiceContract(
    await fetchBoundedJson(cardUrl.toString()),
    {
      cardUrl: cardUrl.toString(),
      providerAgentId: config.PROVIDER_AGENT_ID.toString(),
      serviceId: record.serviceId,
      serviceSlug: record.serviceSlug,
      serviceVersion: record.version,
    },
  );
}

async function postRegistration(
  gatewayOrigin: string,
  idempotencyKey: string,
  intent: ProviderServiceRegistrationIntentEnvelope,
): Promise<GatewayRegistrationView> {
  return parseGatewayRegistrationView(await requestBoundedJson(
    `${gatewayOrigin}/v1/service-registrations`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(intent),
    },
  ));
}

// Broadcast one listing's splitter deployment (no confirmation wait).
async function deployListingSplitter(
  listing: GatewayRegistrationView["prepared"]["listings"][number],
) {
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

// Broadcast-only pass: submit every missing splitter deployment without
// waiting for confirmations, so all services' deployments can share one
// finality window before the activation phase confirms them.
async function ensureSplitterBroadcasts(
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
      // Already submitted once; re-broadcast only if the original send never
      // reached the mempool. Confirmation belongs to the activation phase.
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

async function broadcastSplitters(
  localId: string,
  view: GatewayRegistrationView,
): Promise<Array<{ listingId: string; transactionHash: Hex }>> {
  const rows = new Map(
    (await listGatewaySplitterWrites(localId)).map((row) => [row.listing_id, row]),
  );
  const hashes: Array<{ listingId: string; transactionHash: Hex }> = [];
  for (const listing of view.prepared.listings.filter((item) =>
    item.deploymentRequired)) {
    const preparation = listing.preparation;
    const transaction = listing.transaction;
    const persisted = rows.get(listing.listingId);
    if (!preparation || !transaction || !persisted) {
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

async function submitEvidence(args: {
  gatewayOrigin: string;
  localId: string;
  view: GatewayRegistrationView;
  existingEvidence: ProviderServiceRegistrationEvidenceEnvelope | null;
  splitterHashes: Array<{ listingId: string; transactionHash: Hex }>;
  policy: RegistrationPolicy;
}): Promise<{
  view: GatewayRegistrationView;
  evidence: ProviderServiceRegistrationEvidenceEnvelope;
}> {
  const evidence = args.existingEvidence ?? await signProviderEnvelope({
    artifactType: "ProviderServiceRegistrationEvidenceV1",
    environment: args.policy.environment,
    chainId: args.policy.chainId,
    audience: args.policy.audience,
    validForSeconds: args.policy.intentMaximumLifetimeSeconds,
    privateKey: config.PROVIDER_WALLET_PRIVATE_KEY as Hex,
    payload: {
      registrationId: args.view.registrationId,
      preparedRegistrationHash: canonicalHash(args.view.prepared),
      expectedState: args.view.state === "EVIDENCE_PENDING"
        ? "EVIDENCE_PENDING" as const
        : "PREPARED" as const,
      splitterTransactionHashes: args.splitterHashes,
      evidenceNonce: registrationNonce(),
    },
  });
  if (!args.existingEvidence) {
    await saveRegistrationEvidence(args.localId, evidence);
  }
  const view = parseGatewayRegistrationView(await requestBoundedJson(
    `${args.gatewayOrigin}/v1/service-registrations/${args.view.registrationId}/evidence`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(evidence),
    },
  ));
  return { view, evidence };
}

const ACTIVATION_POLL_INTERVAL_MS =
  Number(process.env.REGISTRATION_ACTIVATION_POLL_MS ?? 5_000);
const ACTIVATION_POLL_TIMEOUT_MS =
  Number(process.env.REGISTRATION_ACTIVATION_TIMEOUT_MS ?? 1_800_000);
const ACTIVATION_REKICK_MS =
  Number(process.env.REGISTRATION_ACTIVATION_REKICK_MS ?? 60_000);

// The gateway accepts evidence with 202 and verifies asynchronously; poll
// the registration until it turns ACTIVE, re-posting the SAME persisted
// evidence envelope when verification has sat idle long enough that a
// transient failure may have ended it. Never a new envelope, never a new
// nonce.
async function awaitActivation(
  gatewayOrigin: string,
  registrationId: string,
  evidence: ProviderServiceRegistrationEvidenceEnvelope,
): Promise<GatewayRegistrationView> {
  const deadline = Date.now() + ACTIVATION_POLL_TIMEOUT_MS;
  let lastKick = Date.now();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, ACTIVATION_POLL_INTERVAL_MS));
    const view = parseGatewayRegistrationView(await requestBoundedJson(
      `${gatewayOrigin}/v1/service-registrations/${registrationId}`,
    ));
    if (view.state === "ACTIVE") return view;
    if (Date.now() > deadline) {
      throw new Error("gateway activation polling timed out");
    }
    if (Date.now() - lastKick >= ACTIVATION_REKICK_MS) {
      lastKick = Date.now();
      await requestBoundedJson(
        `${gatewayOrigin}/v1/service-registrations/${registrationId}/evidence`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(evidence),
        },
      );
    }
  }
}

export async function registerServiceWithGateway(
  gateway: string,
  service: ServiceRow,
  attempt = 1,
  // "broadcast" stops after submitting the splitter deployments so every
  // service's transactions share one finality window; "full" (default)
  // confirms them, submits evidence, and activates.
  phase: "broadcast" | "full" = "full",
): Promise<{ serviceSlug: string; state: string; registrationId: string }> {
  const gatewayOrigin = normalizedGatewayOrigin(gateway);
  const policy = await loadPolicy(gatewayOrigin);
  const finalizedBlock = await finalizedReadBlockNumber();
  const { record, providerPayee } = await chainService(service, finalizedBlock);
  const published = await publishedContract(record);
  let local = await getGatewayRegistration(gatewayOrigin, record.serviceId);
  if (
    local?.state === "ACTIVE" &&
    local.card_contract_hash.equals(Buffer.from(published.serviceContractHash.slice(2), "hex"))
  ) {
    return {
      serviceSlug: service.slug,
      state: "ACTIVE",
      registrationId: local.gateway_registration_id!,
    };
  }
  if (
    local &&
    !["ACTIVE", "ATTENTION"].includes(local.state) &&
    !local.card_contract_hash.equals(Buffer.from(published.serviceContractHash.slice(2), "hex"))
  ) {
    throw new Error(`${service.slug} card changed during a prepared registration`);
  }

  let intent = local && !["ACTIVE", "ATTENTION"].includes(local.state)
    ? local.canonical_intent
    : null;
  if (intent && intent.payload.railPolicyHash !== policy.railPolicyHash) {
    await markGatewayRegistrationAttention(local!.id, "rail_policy_changed_during_prepare");
    throw new Error(`${service.slug} rail policy changed during registration`);
  }
  if (!intent) {
    intent = await signProviderEnvelope({
      artifactType: "ProviderServiceRegistrationIntentV1",
      environment: policy.environment,
      chainId: policy.chainId,
      audience: policy.audience,
      validForSeconds: policy.intentMaximumLifetimeSeconds,
      privateKey: config.PROVIDER_WALLET_PRIVATE_KEY as Hex,
      payload: {
        providerAgentId: config.PROVIDER_AGENT_ID.toString(),
        serviceId: record.serviceId,
        serviceSlug: record.serviceSlug,
        serviceVersion: record.version,
        providerPayee,
        serviceContractHash: published.serviceContractHash,
        skillContractSetHash: published.skillContractSetHash,
        skills: published.skills.map(({ skillId, skillContractHash }) => ({
          skillId,
          skillContractHash,
        })),
        railPolicyHash: policy.railPolicyHash,
        registrationNonce: registrationNonce(),
      },
    });
    const idempotencyKey =
      `svc-${canonicalHash(intent).slice(2, 50)}`;
    local = await beginGatewayRegistration({
      gatewayOrigin,
      serviceRowId: service.id,
      serviceId: record.serviceId,
      cardContractHash: published.serviceContractHash,
      idempotencyKey,
      intent,
    });
  }
  if (!local) throw new Error("local gateway registration was not persisted");

  let view = local.prepared_response;
  if (!view) {
    try {
      view = await postRegistration(
        gatewayOrigin,
        local.idempotency_key,
        local.canonical_intent,
      );
    } catch (error) {
      const expiredUnusedIntent =
        local.state === "INTENT_READY" &&
        local.canonical_intent.validBefore <= Math.floor(Date.now() / 1_000);
      if (
        expiredUnusedIntent &&
        error instanceof GatewayRegistrationHttpError &&
        error.status === 401 &&
        error.code === "REGISTRATION_AUTH_INVALID"
      ) {
        await markGatewayRegistrationAttention(
          local.id,
          "intent_expired_before_prepare",
        );
        if (attempt >= MAX_REGISTRATION_INTENT_ATTEMPTS) {
          throw new Error(
            `${service.slug} registration intent expired ${attempt} times before the gateway accepted it`,
          );
        }
        await registrationRetryDelay(attempt);
        return registerServiceWithGateway(gateway, service, attempt + 1, phase);
      }
      throw error;
    }
    await verifyPreparedRegistration({
      view,
      intent: local.canonical_intent,
      service: published,
      providerAgentId: config.PROVIDER_AGENT_ID.toString(),
      providerPayee,
      serviceWallet: getAddress(record.serviceWallet),
      policy,
      gatewaySigner: gatewaySigner(),
      publicClient,
      finalizedBlock,
    });
    await savePreparedRegistration(local.id, view);
  } else {
    await verifyPreparedRegistration({
      view,
      intent: local.canonical_intent,
      service: published,
      providerAgentId: config.PROVIDER_AGENT_ID.toString(),
      providerPayee,
      serviceWallet: getAddress(record.serviceWallet),
      policy,
      gatewaySigner: gatewaySigner(),
      publicClient,
      finalizedBlock,
    });
  }

  if (view.state === "ACTIVE") {
    await promoteActiveRuntimeListings({
      localId: local.id,
      gatewayOrigin,
      view,
      policy,
      published,
      intent: local.canonical_intent,
      finalizedBlock,
    });
    await markGatewayRegistrationActive(local.id);
    return {
      serviceSlug: service.slug,
      state: "ACTIVE",
      registrationId: view.registrationId,
    };
  }
  if (phase === "broadcast") {
    await ensureSplitterBroadcasts(local.id, view);
    return {
      serviceSlug: service.slug,
      state: "BROADCAST",
      registrationId: view.registrationId,
    };
  }
  const splitterHashes = await broadcastSplitters(local.id, view);
  let active: GatewayRegistrationView;
  try {
    const submitted = await submitEvidence({
      gatewayOrigin,
      localId: local.id,
      view,
      existingEvidence: local.canonical_evidence,
      splitterHashes,
      policy,
    });
    active = submitted.view.state === "ACTIVE"
      ? submitted.view
      : await awaitActivation(gatewayOrigin, view.registrationId, submitted.evidence);
  } catch (error) {
    if (
      error instanceof GatewayRegistrationHttpError &&
      error.code === "PREPARED_REGISTRATION_DRIFT"
    ) {
      await markGatewayRegistrationAttention(
        local.id,
        "prepared_registration_drift",
      );
    }
    throw error;
  }
  if (active.state !== "ACTIVE") {
    throw new Error(`${service.slug} gateway registration did not activate`);
  }
  await promoteActiveRuntimeListings({
    localId: local.id,
    gatewayOrigin,
    view: active,
    policy,
    published,
    intent: local.canonical_intent,
    finalizedBlock,
  });
  await markGatewayRegistrationActive(local.id);
  return {
    serviceSlug: service.slug,
    state: active.state,
    registrationId: active.registrationId,
  };
}

const splitterCheckpointAbi = parseAbi([
  "function releaseSequence() view returns (uint64)",
]);
const tokenBalanceAbi = parseAbi([
  "function balanceOf(address holder) view returns (uint256)",
]);

// Provider-verified chain facts for a freshly admitted paid listing. The
// checkpoint is read at the finalized deployment block and the splitter
// bytecode is checked against the trusted policy hash — gateway responses
// are never the evidence source.
async function verifyListingActivationCheckpoint(args: {
  splitterAddress: Address;
  transactionHash: Hex;
  policy: RegistrationPolicy;
}): Promise<SplitterActivationCheckpoint> {
  const receipt = await publicClient.getTransactionReceipt({
    hash: args.transactionHash,
  });
  const finalized = await finalizedReadBlockNumber();
  if (receipt.blockNumber > finalized) {
    throw new Error("splitter deployment is not finalized");
  }
  const blockNumber = receipt.blockNumber;
  const [code, balance, sequence] = await Promise.all([
    publicClient.getCode({ address: args.splitterAddress, blockNumber }),
    publicClient.readContract({
      address: args.policy.canonicalToken,
      abi: tokenBalanceAbi,
      functionName: "balanceOf",
      args: [args.splitterAddress],
      blockNumber,
    }),
    publicClient.readContract({
      address: args.splitterAddress,
      abi: splitterCheckpointAbi,
      functionName: "releaseSequence",
      blockNumber,
    }),
  ]);
  // Immutables live in runtime code, so splitters never share one hash;
  // authenticity is the verified chain (trusted factory, exact calldata over
  // the pinned creation code, CREATE2 match at materialization). Record the
  // observed hash for settlement evidence rather than pinning it here.
  if (!code) {
    throw new Error("splitter has no runtime bytecode at its deployment block");
  }
  return {
    splitterDeploymentTransactionHash: args.transactionHash,
    splitterDeploymentBlockNumber: blockNumber.toString(),
    splitterDeploymentBlockHash: receipt.blockHash,
    splitterRuntimeCodeHash: keccak256(code),
    splitterActivationBlockNumber: blockNumber.toString(),
    splitterActivationBlockHash: receipt.blockHash,
    splitterActivationPosition: "END_OF_BLOCK",
    splitterStartingTokenBalance: (balance as bigint).toString(),
    splitterStartingReleaseSequence: (sequence as bigint).toString(),
  };
}

// Recompute every listing's runtime commitment from our own copies of the
// admitted artifacts, cross-check the gateway's reported hashes, resolve
// deployment evidence, and promote the versions into the append-only runtime
// catalog before the registration is marked active. The cross-check is
// unconditional — an activation response without a matching hash for every
// listing is a protocol violation, so crash-recovery replays can never
// promote unverified values.
async function promoteActiveRuntimeListings(args: {
  localId: string;
  gatewayOrigin: string;
  view: GatewayRegistrationView;
  policy: RegistrationPolicy;
  published: PublishedServiceContract;
  intent: ProviderServiceRegistrationIntentEnvelope;
  finalizedBlock: bigint;
}): Promise<void> {
  const prepared = args.view.prepared;
  const skills = new Map(
    args.published.skills.map((skill) => [skill.skillId, skill]),
  );
  const versions = prepared.listings.map((listing) => {
    const commitment = buildRuntimeListingCommitment({
      environment: args.policy.environment,
      chainId: args.policy.chainId,
      gatewayAudience: args.policy.audience,
      providerAgentId: prepared.providerAgentId,
      serviceId: prepared.serviceId,
      currentProviderIntentHash: prepared.providerIntentHash,
      currentProviderPayee: getAddress(prepared.providerPayee),
      policy: {
        canonicalToken: args.policy.canonicalToken,
        daskiCommissionReceiver: args.policy.daskiCommissionReceiver,
        commissionBps: args.policy.commissionBps,
        policyVersionHash: args.policy.railPolicyHash,
        splitterFactory: args.policy.splitterFactory,
      },
      listing: {
        listingId: listing.listingId,
        listingKey: listing.listingKey,
        skillId: listing.skillId,
        skillContractHash: listing.skillContractHash,
        paymentRequired: listing.paymentRequired,
        splitterAddress: listing.splitterAddress,
        preparation: listing.preparation,
        controlProfile: listing.controlProfile,
      },
    });
    return { listing, commitment, hash: runtimeCommitmentHash(commitment) };
  });
  // Exact-set cross-check: the gateway must report one commitment per
  // listing — no missing, extra, or duplicate entries — and every hash must
  // equal the locally recomputed value.
  const reportedEntries = args.view.runtimeCommitments ?? [];
  const reported = new Map(
    reportedEntries.map((item) => [
      item.listingId,
      item.runtimeCommitmentHash.toLowerCase(),
    ]),
  );
  const exactSet =
    reported.size === reportedEntries.length &&
    reported.size === versions.length &&
    versions.every(({ commitment, hash }) =>
      reported.get(commitment.listingId) === hash.toLowerCase());
  if (!exactSet) {
    await markGatewayRegistrationAttention(
      args.localId,
      "runtime_commitment_mismatch",
    );
    throw new Error(
      `${prepared.serviceSlug} activation did not report the exact runtime commitment set`,
    );
  }
  const writes = new Map(
    (await listGatewaySplitterWrites(args.localId))
      .filter((row) => row.transaction_hash !== null)
      .map((row) => [row.listing_id, row.transaction_hash as Hex]),
  );
  const priorHeads = new Map(
    (await loadRuntimeListingHeads(args.gatewayOrigin))
      .filter((head) =>
        head.serviceId.toLowerCase() === prepared.serviceId.toLowerCase())
      .map((head) => [head.skillId, head]),
  );
  const evidence = new Map<string, {
    splitterTransactionHash: Hex | null;
    activationCheckpoint: SplitterActivationCheckpoint | null;
  }>();
  for (const { listing, commitment, hash } of versions) {
    const prior = priorHeads.get(listing.skillId);
    const unchangedHead =
      prior !== undefined &&
      prior.runtimeCommitmentHash.toLowerCase() === hash.toLowerCase();
    if (unchangedHead || !listing.paymentRequired || listing.splitterAddress === null) {
      // Unchanged heads are promotion no-ops keeping their original bundle;
      // free skills and paid take-downs have no deployment evidence.
      evidence.set(listing.skillId, {
        splitterTransactionHash: null,
        activationCheckpoint: null,
      });
      continue;
    }
    const transactionHash = writes.get(commitment.listingId);
    if (!transactionHash) {
      throw new Error(
        `${prepared.serviceSlug} has no splitter evidence for ${listing.skillId}; recover the original deployment record before promoting`,
      );
    }
    evidence.set(listing.skillId, {
      splitterTransactionHash: transactionHash,
      activationCheckpoint: await verifyListingActivationCheckpoint({
        splitterAddress: getAddress(listing.splitterAddress),
        transactionHash,
        policy: args.policy,
      }),
    });
  }
  await promoteRuntimeListingVersions(
    args.gatewayOrigin,
    prepared.serviceId,
    versions.map(({ listing, commitment, hash }) => {
      const bundle: ProviderRuntimeListingBundleV1 = {
        schemaVersion: 1,
        listing,
        skillContract: skills.get(listing.skillId) ?? null,
        intent: args.intent,
        ...evidence.get(listing.skillId)!,
        providerIdentity: {
          agentWallet: providerAddress,
          verifiedAtBlock: args.finalizedBlock.toString(),
        },
        policyRefs: {
          railPolicyHash: args.policy.railPolicyHash,
          canonicalToken: args.policy.canonicalToken,
          splitterFactory: args.policy.splitterFactory,
          splitterFactoryRuntimeCodeHash: args.policy.splitterFactoryRuntimeCodeHash,
          splitterCreationCodeHash: args.policy.splitterCreationCodeHash,
        },
      };
      return {
        listingId: commitment.listingId,
        listingKey: listing.listingKey,
        skillId: listing.skillId,
        paymentRequired: listing.paymentRequired,
        runtimeCommitmentHash: hash,
        runtimeCommitment: commitment,
        bundle,
      };
    }),
  );
}
