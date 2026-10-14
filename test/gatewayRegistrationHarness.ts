import { randomUUID } from "node:crypto";
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbiParameters,
  recoverMessageAddress,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type pg from "pg";
import { canonicalHash, unsignedEnvelopeHash } from "../src/core/standardRail/canonical.js";
import { factoryAbi } from "../src/core/gatewayRegistration/prepared.js";
import {
  buildRuntimeListingCommitment,
  runtimeCommitmentHash,
} from "../src/core/gatewayRegistration/runtimeCommitment.js";
import type { SignedEnvelope } from "../src/core/standardRail/types.js";
import { signTestEnvelope, testGatewaySignerKey } from "./runtimeCatalogFixture.js";

// Offline stand-ins for the gateway's service-registration API and the
// chain, modelled on the gateway's documented semantics: idempotent
// registration, reuse of unchanged listings with their persisted runtime
// commitment, exact accepted-evidence replay beyond expiry, and refusal of
// replacement evidence once some evidence was accepted.

export const GATEWAY = "https://gateway.example";
export const PROVIDER_ORIGIN = "https://provider.example";
export const PROVIDER_AGENT_ID = 42n;
export const CHAIN_ID = 84_532;
export const SERVICE_SLUG = "orbital-logistics";
export const SERVICE_ID = `0x${"5a".repeat(32)}` as Hex;
export const SERVICE_REGISTRY = "0x3333333333333333333333333333333333333333" as Address;
export const IDENTITY_REGISTRY = "0x4444444444444444444444444444444444444444" as Address;
export const USDC = "0x6666666666666666666666666666666666666666" as Address;
export const COMMISSION_RECEIVER = "0x7777777777777777777777777777777777777777" as Address;
export const SPLITTER_FACTORY = "0x8888888888888888888888888888888888888888" as Address;
export const PROVIDER_KEY = `0x${"1".repeat(64)}` as Hex;
export const providerAccount = privateKeyToAccount(PROVIDER_KEY);
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const FACTORY_CODE = "0x6080604052600a600c" as Hex;
const SPLITTER_CODE = "0x60806040526001" as Hex;
const BLOCK_HASH = `0x${"ab".repeat(32)}` as Hex;

export const registrationPolicy = {
  schemaVersion: 1,
  environment: "testnet",
  chainId: CHAIN_ID,
  audience: GATEWAY,
  providerSignerKeyId: "provider-authority",
  serviceRegistry: SERVICE_REGISTRY,
  defaultMarketplaceEnabled: true,
  railPolicyHash: `0x${"6".repeat(64)}`,
  canonicalToken: USDC,
  daskiCommissionReceiver: COMMISSION_RECEIVER,
  commissionBps: 500,
  splitterFactory: SPLITTER_FACTORY,
  splitterCreationCodeHash: `0x${"c".repeat(64)}`,
  splitterFactoryRuntimeCodeHash: keccak256(FACTORY_CODE),
  intentMaximumLifetimeSeconds: 600,
} as const;

export interface SkillDefinition {
  skillId: string;
  paymentRequired: boolean;
  assetAction: boolean;
  /** Bumping it changes the skill contract (and therefore its hash). */
  revision: number;
}

export const defaultSkills = (): SkillDefinition[] => [
  { skillId: "move-orbit", paymentRequired: false, assetAction: true, revision: 1 },
  { skillId: "reserve-orbit", paymentRequired: true, assetAction: false, revision: 1 },
  { skillId: "track-orbit", paymentRequired: false, assetAction: false, revision: 1 },
];

function skillContract(skill: SkillDefinition) {
  return {
    inputSchema: {
      type: "object",
      properties: { target: { type: "string" } },
      required: ["target"],
      additionalProperties: false,
    },
    resultSchema: { type: "object", additionalProperties: true },
    pricing: {
      USDC: {
        type: "one-time",
        fixed_amount: skill.paymentRequired ? `${1_000_000 * skill.revision}` : "0",
      },
    },
    paymentRequired: skill.paymentRequired,
    requiresAssetOwnership: skill.assetAction,
    assetType: skill.assetAction ? "orbital-slot" : null,
    fulfillmentMode: "automated",
    capacity: { maxOpenOrders: 10 },
    deadlines: { dispatchSeconds: 60 },
    revision: skill.revision,
    assetAction: skill.assetAction
      ? {
        ownershipPolicy: "owner-only",
        effect: "mutate",
        replayPolicy: "stable-result",
        retentionSeconds: 3600,
      }
      : null,
  };
}

export function serviceCard(skills: SkillDefinition[]) {
  const definitions = skills.map((skill) => {
    const contract = skillContract(skill);
    return {
      skillId: skill.skillId,
      skillContractHash: canonicalHash({
        schemaVersion: 1,
        serviceSlug: SERVICE_SLUG,
        serviceVersion: "1",
        skillId: skill.skillId,
        contract,
      }),
      acceptingNewOrders: true,
      presentation: {
        name: skill.skillId,
        description: skill.skillId,
        examples: [skill.skillId],
        tags: ["space"],
        documentationUrl: `${PROVIDER_ORIGIN}/skills/${skill.skillId}.md`,
      },
      contract,
    };
  });
  return {
    extensions: {
      "https://daski.io/a2a/v1": {
        legal: {
          marketplaceTermsUrl: "https://daski.example/terms",
          marketplacePrivacyUrl: "https://daski.example/privacy",
          providerLegalName: "Orbital Logistics LLC",
          providerTermsUrl: `${PROVIDER_ORIGIN}/terms`,
          providerPrivacyUrl: `${PROVIDER_ORIGIN}/privacy`,
        },
      },
      "https://daski.io/a2a/v2": {
        schemaVersion: 1,
        providerAgentId: PROVIDER_AGENT_ID.toString(),
        service: {
          serviceId: SERVICE_ID,
          slug: SERVICE_SLUG,
          version: "1",
          categoryFamily: "space-operations",
          serviceType: "orbital-logistics",
          jurisdictions: ["LEO"],
          lifecycle: "asset-lifecycle",
          turnaroundEstimate: "one orbit",
          acceptingNewOrders: true,
        },
        standardRail: {
          origin: PROVIDER_ORIGIN,
          providerAudience: `${PROVIDER_ORIGIN}/`,
          quoteUrl: `${PROVIDER_ORIGIN}/standard-rail/quote`,
          dispatchUrl: `${PROVIDER_ORIGIN}/standard-rail/dispatch`,
          dispatchStatusUrl: `${PROVIDER_ORIGIN}/standard-rail/dispatch/status`,
          lifecycleUrl: `${PROVIDER_ORIGIN}/standard-rail/lifecycle`,
          assetQueryUrl: `${PROVIDER_ORIGIN}/standard-rail/assets/query`,
          assetActionUrl: `${PROVIDER_ORIGIN}/standard-rail/assets/action`,
        },
        skillContractSetHash: canonicalHash(definitions
          .map(({ skillId, skillContractHash }) => ({ skillId, skillContractHash }))
          .sort((left, right) => left.skillId.localeCompare(right.skillId))),
        skills: definitions,
      },
    },
  };
}

export function predictSplitter(args: readonly unknown[]): Address {
  const encoded = encodeAbiParameters(
    parseAbiParameters("bytes32,uint256,address,address,address,uint16,bytes32,bytes32,bytes32,uint64"),
    args as never,
  );
  return getAddress(`0x${keccak256(encoded).slice(26)}`);
}

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

interface StoredRegistration {
  registrationId: string;
  state: "PREPARED" | "EVIDENCE_PENDING" | "ACTIVE" | "SUPERSEDED" | "REJECTED";
  intent: SignedEnvelope<Record<string, unknown>>;
  prepared: Record<string, unknown> & { listings: Array<Record<string, any>> };
  evidence: SignedEnvelope<Record<string, unknown>> | null;
  activatedAt: string | null;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const refusal = (status: number, code: string) =>
  json(status, { error: { code, message: code.toLowerCase().replaceAll("_", " ") } });

export class FakeGateway {
  readonly requests: RecordedRequest[] = [];
  readonly registrations = new Map<string, StoredRegistration>();
  private readonly idempotency = new Map<string, string>();
  private readonly commitments = new Map<string, { hash: Hex; commitment: unknown }>();
  private activeRegistrationId: string | null = null;
  private sequence = 0;
  skills: SkillDefinition[] = defaultSkills();
  payee: Address = providerAccount.address;
  /** The rail policy hash the gateway serves, prepares and activates under. */
  railPolicyHash: Hex = registrationPolicy.railPolicyHash;
  /** "on-evidence" activates as soon as evidence is accepted. */
  activation: "on-evidence" | "manual" = "on-evidence";
  /** Next evidence posts answered with a bare 503 before any processing. */
  unavailableEvidencePosts = 0;
  /** Next registration posts answered with a bare 503 before any processing. */
  unavailableRegistrationPosts = 0;
  /** Next registration posts processed, then answered with a bare 503 (a lost response). */
  lostRegistrationResponses = 0;
  /** Next reads of a registration awaiting verification answered with a bare 503. */
  unavailablePendingReads = 0;
  /** Next exact replays wrongly refused as unauthenticated. */
  refuseReplays = 0;
  /** Reports one wrong commitment hash for this listing id while set. */
  corruptCommitmentFor: string | null = null;
  /** Reuse prior listings even when the payee changed. */
  reuseAcrossPayees = false;
  /** Called with the posted evidence before the gateway processes it. */
  onEvidence: ((evidence: unknown) => Promise<void>) | null = null;

  async fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) as unknown : null;
    this.requests.push({ method, path: `${url.origin}${url.pathname}`, body });
    if (url.origin === PROVIDER_ORIGIN && url.pathname === `/agent-cards/${SERVICE_SLUG}.json`) {
      return json(200, serviceCard(this.skills));
    }
    if (url.origin !== GATEWAY) return json(404, { error: { code: "NOT_FOUND" } });
    if (url.pathname === "/public/v3/registration-policy") {
      return json(200, { ...registrationPolicy, railPolicyHash: this.railPolicyHash });
    }
    if (url.pathname === "/v1/service-registrations" && method === "POST") {
      if (this.unavailableRegistrationPosts > 0) {
        this.unavailableRegistrationPosts -= 1;
        return new Response(null, { status: 503 });
      }
      const key = new Headers(init.headers).get("idempotency-key") ?? "";
      const answer = await this.register(body as StoredRegistration["intent"], key);
      if (this.lostRegistrationResponses > 0) {
        this.lostRegistrationResponses -= 1;
        return new Response(null, { status: 503 });
      }
      return answer;
    }
    const evidenceMatch = /^\/v1\/service-registrations\/([^/]+)\/evidence$/.exec(url.pathname);
    if (evidenceMatch && method === "POST") {
      return this.submitEvidence(decodeURIComponent(evidenceMatch[1]!), body as StoredRegistration["evidence"]);
    }
    const readMatch = /^\/v1\/service-registrations\/([^/]+)$/.exec(url.pathname);
    if (readMatch && method === "GET") {
      const stored = this.registrations.get(decodeURIComponent(readMatch[1]!));
      if (stored?.state === "EVIDENCE_PENDING" && this.unavailablePendingReads > 0) {
        this.unavailablePendingReads -= 1;
        return new Response(null, { status: 503 });
      }
      return stored ? json(200, this.view(stored)) : refusal(404, "REGISTRATION_NOT_FOUND");
    }
    return refusal(404, "NOT_FOUND");
  }

  /** Gateway-side manual activation (asynchronous verification finished). */
  activate(registrationId: string): void {
    const stored = this.registrations.get(registrationId)!;
    for (const listing of stored.prepared.listings) {
      if (listing.reused && this.commitments.has(listing.listingId)) continue;
      const commitment = buildRuntimeListingCommitment({
        environment: registrationPolicy.environment,
        chainId: CHAIN_ID,
        gatewayAudience: GATEWAY,
        providerAgentId: PROVIDER_AGENT_ID.toString(),
        serviceId: SERVICE_ID,
        currentProviderIntentHash: stored.prepared.providerIntentHash as Hex,
        currentProviderPayee: getAddress(stored.prepared.providerPayee as string),
        policy: {
          canonicalToken: USDC,
          daskiCommissionReceiver: COMMISSION_RECEIVER,
          commissionBps: registrationPolicy.commissionBps,
          policyVersionHash: this.railPolicyHash,
          splitterFactory: SPLITTER_FACTORY,
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
      this.commitments.set(listing.listingId, {
        hash: runtimeCommitmentHash(commitment),
        commitment,
      });
    }
    if (this.activeRegistrationId && this.activeRegistrationId !== registrationId) {
      this.registrations.get(this.activeRegistrationId)!.state = "SUPERSEDED";
    }
    stored.state = "ACTIVE";
    stored.activatedAt = new Date().toISOString();
    this.activeRegistrationId = registrationId;
  }

  view(stored: StoredRegistration) {
    const view: Record<string, unknown> = {
      registrationId: stored.registrationId,
      state: stored.state,
      providerAgentId: PROVIDER_AGENT_ID.toString(),
      serviceId: SERVICE_ID,
      serviceSlug: SERVICE_SLUG,
      serviceVersion: "1",
      agentCardUrl: `${PROVIDER_ORIGIN}/agent-cards/${SERVICE_SLUG}.json`,
      providerPayee: stored.prepared.providerPayee,
      marketplaceEnabled: true,
      registrationHealthy: true,
      nextAction: ["PREPARED", "EVIDENCE_PENDING"].includes(stored.state)
        ? "submit-splitter-evidence"
        : null,
      prepared: stored.prepared,
      activatedAt: stored.activatedAt,
      updatedAt: new Date().toISOString(),
    };
    if (stored.state === "ACTIVE") {
      view.runtimeCommitments = stored.prepared.listings.map((listing) => ({
        listingId: listing.listingId,
        runtimeCommitmentHash: listing.listingId === this.corruptCommitmentFor
          ? `0x${"e".repeat(64)}`
          : this.commitments.get(listing.listingId)!.hash,
      }));
    }
    return view;
  }

  private async providerSigned(envelope: SignedEnvelope<unknown>): Promise<boolean> {
    try {
      const signer = await recoverMessageAddress({
        message: { raw: unsignedEnvelopeHash(envelope as unknown as Record<string, unknown>) },
        signature: envelope.signature,
      });
      return getAddress(signer) === providerAccount.address;
    } catch {
      return false;
    }
  }

  private async register(
    intent: StoredRegistration["intent"],
    key: string,
  ): Promise<Response> {
    const replay = this.idempotency.get(key);
    if (replay) return json(200, this.view(this.registrations.get(replay)!));
    if (
      intent.validBefore <= Math.floor(Date.now() / 1_000) ||
      !await this.providerSigned(intent)
    ) return refusal(401, "REGISTRATION_AUTH_INVALID");
    if ([...this.registrations.values()].some((item) =>
      item.state === "PREPARED" || item.state === "EVIDENCE_PENDING")) {
      return refusal(409, "REGISTRATION_REVISION_PENDING");
    }
    // Validated against the card it serves now and its current policy;
    // nothing is stored for a refused intent.
    if (
      intent.payload.skillContractSetHash !==
        serviceCard(this.skills).extensions["https://daski.io/a2a/v2"].skillContractSetHash ||
      intent.payload.railPolicyHash !== this.railPolicyHash
    ) return refusal(409, "REGISTRATION_CONTRACT_MISMATCH");
    const active = this.activeRegistrationId
      ? this.registrations.get(this.activeRegistrationId)!
      : null;
    // The same card, policy and payee refresh the active registration; any
    // change prepares a superseding one, reusing listings only while the
    // payee and rail policy are unchanged.
    const policyKept = active?.prepared.railPolicyHash === this.railPolicyHash;
    if (
      active && policyKept &&
      active.intent.payload.serviceContractHash === intent.payload.serviceContractHash &&
      getAddress(active.prepared.providerPayee as string) === getAddress(this.payee)
    ) {
      return json(200, this.view(active));
    }
    this.sequence += 1;
    const registrationId = `00000000-0000-4000-8000-${this.sequence.toString().padStart(12, "0")}`;
    const card = serviceCard(this.skills).extensions["https://daski.io/a2a/v2"];
    const priorUsable = active && policyKept && (this.reuseAcrossPayees ||
      getAddress(active.prepared.providerPayee as string) === getAddress(this.payee));
    const providerIntentHash = canonicalHash(intent);
    const listings = [];
    for (const skill of card.skills) {
      const prior = priorUsable
        ? active!.prepared.listings.find((item) => item.skillId === skill.skillId)
        : undefined;
      if (prior && prior.skillContractHash === skill.skillContractHash) {
        listings.push({ ...prior, deploymentRequired: false, reused: true, transaction: null });
        continue;
      }
      listings.push(await this.newListing({
        registrationId,
        skill,
        skillContractSetHash: card.skillContractSetHash,
        providerIntentHash,
        priorEpoch: prior?.preparation ? BigInt(prior.preparation.payload.listingEpoch) : 0n,
      }));
    }
    const stored: StoredRegistration = {
      registrationId,
      state: "PREPARED",
      intent,
      evidence: null,
      activatedAt: null,
      prepared: {
        registrationId,
        state: "PREPARED",
        providerAgentId: PROVIDER_AGENT_ID.toString(),
        serviceId: SERVICE_ID,
        serviceSlug: SERVICE_SLUG,
        serviceVersion: "1",
        agentCardUrl: `${PROVIDER_ORIGIN}/agent-cards/${SERVICE_SLUG}.json`,
        serviceWallet: ZERO,
        providerPayee: this.payee,
        providerIntentHash,
        railPolicyHash: this.railPolicyHash,
        marketplaceEnabled: true,
        listings,
      },
    };
    this.registrations.set(registrationId, stored);
    this.idempotency.set(key, registrationId);
    return json(201, this.view(stored));
  }

  private async newListing(args: {
    registrationId: string;
    skill: ReturnType<typeof serviceCard>["extensions"]["https://daski.io/a2a/v2"]["skills"][number];
    skillContractSetHash: Hex;
    providerIntentHash: Hex;
    priorEpoch: bigint;
  }) {
    const listingId = randomUUID();
    const listingKey = canonicalHash({
      domain: "DaskiListingKeyV1",
      chainId: CHAIN_ID,
      providerAgentId: PROVIDER_AGENT_ID.toString(),
      serviceId: SERVICE_ID,
      skillId: args.skill.skillId,
    });
    const envelope = <T>(artifactType: string, payload: T) => signTestEnvelope({
      artifactType,
      schemaVersion: 1,
      environment: registrationPolicy.environment,
      chainId: CHAIN_ID,
      audience: GATEWAY,
      signerKeyId: "gateway-protocol",
      signerKey: testGatewaySignerKey,
      payload,
    });
    const action = args.skill.contract.assetAction;
    const controlProfile = action
      ? await envelope("GatewaySkillControlProfileV1", {
        registrationId: args.registrationId,
        providerAgentId: PROVIDER_AGENT_ID.toString(),
        providerIntentHash: args.providerIntentHash,
        serviceId: SERVICE_ID,
        serviceSlug: SERVICE_SLUG,
        skillId: args.skill.skillId,
        skillContractHash: args.skill.skillContractHash,
        policyVersionHash: this.railPolicyHash,
        providerEndpoint: `${PROVIDER_ORIGIN}/standard-rail/assets/action`,
        ownershipPolicy: action.ownershipPolicy,
        effect: action.effect,
        replayPolicy: action.replayPolicy,
        retentionSeconds: action.retentionSeconds,
        walletAuthorizationRequired: true,
        delayedConfirmationRequired: false,
        confirmationSummarySchemaHash: null,
        confirmationSummaryTemplateHash: null,
      })
      : null;
    const base = {
      listingId,
      listingKey,
      skillId: args.skill.skillId,
      skillContractHash: args.skill.skillContractHash,
      paymentRequired: args.skill.contract.paymentRequired,
      acceptingNewOrders: true,
      reused: false,
      controlProfile,
    };
    if (!args.skill.contract.paymentRequired) {
      return {
        ...base,
        deploymentRequired: false,
        splitterAddress: null,
        preparation: null,
        transaction: null,
      };
    }
    const listingEpoch = args.priorEpoch + 1n;
    const salt = canonicalHash({
      domain: "DaskiDynamicSplitterV1",
      chainId: CHAIN_ID,
      registrationId: args.registrationId,
      listingId,
    });
    const preparation = await envelope("GatewayListingPreparationV1", {
      registrationId: args.registrationId,
      listingId,
      listingKey,
      providerAgentId: PROVIDER_AGENT_ID.toString(),
      serviceId: SERVICE_ID,
      serviceSlug: SERVICE_SLUG,
      serviceVersion: "1",
      skillId: args.skill.skillId,
      skillContractHash: args.skill.skillContractHash,
      skillContractSetHash: args.skillContractSetHash,
      providerIntentHash: args.providerIntentHash,
      canonicalToken: USDC,
      providerPayee: this.payee,
      daskiCommissionReceiver: COMMISSION_RECEIVER,
      commissionBps: registrationPolicy.commissionBps,
      splitterFactory: SPLITTER_FACTORY,
      splitterDeploymentSalt: salt,
      policyVersionHash: this.railPolicyHash,
      listingEpoch: listingEpoch.toString(),
    });
    const callArgs = [
      salt, BigInt(CHAIN_ID), USDC, this.payee, COMMISSION_RECEIVER,
      registrationPolicy.commissionBps, this.railPolicyHash,
      listingKey, canonicalHash(preparation), listingEpoch,
    ] as const;
    return {
      ...base,
      deploymentRequired: true,
      splitterAddress: predictSplitter(callArgs),
      preparation,
      transaction: {
        kind: "splitter-deployment",
        listingId,
        to: SPLITTER_FACTORY,
        data: encodeFunctionData({ abi: factoryAbi, functionName: "deploy", args: callArgs }),
        value: "0",
      },
    };
  }

  private async submitEvidence(
    registrationId: string,
    evidence: StoredRegistration["evidence"],
  ): Promise<Response> {
    await this.onEvidence?.(evidence);
    if (this.unavailableEvidencePosts > 0) {
      this.unavailableEvidencePosts -= 1;
      return new Response(null, { status: 503 });
    }
    const stored = this.registrations.get(registrationId);
    if (!stored || !evidence) return refusal(404, "REGISTRATION_NOT_FOUND");
    const persistedReplay = stored.evidence !== null &&
      canonicalHash(evidence) === canonicalHash(stored.evidence);
    if (persistedReplay && this.refuseReplays > 0) {
      this.refuseReplays -= 1;
      return refusal(401, "EVIDENCE_AUTH_INVALID");
    }
    if (stored.state === "ACTIVE" && persistedReplay) return json(200, this.view(stored));
    if (!persistedReplay && (
      evidence.validBefore <= Math.floor(Date.now() / 1_000) ||
      !await this.providerSigned(evidence)
    )) return refusal(401, "EVIDENCE_AUTH_INVALID");
    if (
      evidence.payload.registrationId !== registrationId ||
      evidence.payload.preparedRegistrationHash !== canonicalHash(stored.prepared)
    ) return refusal(409, "EVIDENCE_BINDING_MISMATCH");
    if (stored.state === "ACTIVE") return refusal(409, "REGISTRATION_ALREADY_ACTIVE");
    if (
      !["PREPARED", "EVIDENCE_PENDING"].includes(stored.state) ||
      (!persistedReplay && (
        stored.state !== evidence.payload.expectedState ||
        stored.state === "EVIDENCE_PENDING"
      ))
    ) return refusal(409, "REGISTRATION_STATE_CONFLICT");
    if (!persistedReplay) {
      stored.state = "EVIDENCE_PENDING";
      stored.evidence = evidence;
    }
    if (this.activation === "on-evidence") this.activate(registrationId);
    const accepted = this.registrations.get(registrationId)!;
    return json(accepted.state === "ACTIVE" ? 200 : 202, this.view(accepted));
  }
}

/** A chain answering the reads registration verification performs. */
export class FakeChain {
  head = 1_000n;
  agentWallet: Address = providerAccount.address;
  readonly reads: string[] = [];

  async getBlockNumber(): Promise<bigint> {
    return this.head;
  }

  async getBlock(): Promise<{ hash: Hex }> {
    return { hash: BLOCK_HASH };
  }

  async getCode({ address }: { address: Address }): Promise<Hex | undefined> {
    return getAddress(address) === SPLITTER_FACTORY ? FACTORY_CODE : SPLITTER_CODE;
  }

  async getTransactionReceipt({ hash }: { hash: Hex }) {
    return { status: "success", transactionHash: hash, blockNumber: 900n, blockHash: BLOCK_HASH };
  }

  async waitForTransactionReceipt({ hash }: { hash: Hex }) {
    return this.getTransactionReceipt({ hash });
  }

  async readContract(args: { functionName: string; args?: readonly unknown[] }): Promise<unknown> {
    this.reads.push(args.functionName);
    switch (args.functionName) {
      case "getService":
        return {
          providerAgentId: PROVIDER_AGENT_ID,
          serviceId: SERVICE_ID,
          serviceSlug: SERVICE_SLUG,
          version: "1",
          serviceURI: `${PROVIDER_ORIGIN}/agent-cards/${SERVICE_SLUG}.json`,
          serviceWallet: ZERO,
          active: true,
        };
      case "ownerOf": return providerAccount.address;
      case "getAgentWallet": return this.agentWallet;
      case "splitterCreationCodeHash": return registrationPolicy.splitterCreationCodeHash;
      case "computeAddress": return predictSplitter(args.args ?? []);
      case "balanceOf":
      case "releaseSequence":
        return 0n;
      default:
        throw new Error(`unexpected chain read ${args.functionName}`);
    }
  }
}

/**
 * A provider-write coordinator double: it journals every splitter write
 * and its domain claim in one database transaction, as the real coordinator
 * does before broadcast, and records every call so tests can prove that a
 * recovery sent nothing.
 */
// Journal nonces stay unique across every coordinator a test file creates.
let journalNonce = 0n;

export class FakeWriteCoordinator {
  readonly prepared: string[] = [];
  readonly rebroadcast: string[] = [];

  constructor(private readonly pool: () => pg.Pool) {}

  async prepareAndBroadcastProviderWrite(args: {
    purpose: string;
    target: { type: string; id: string };
    persist: (prepared: { id: string; hash: Hex; intentHash: Hex; nonce: bigint }, db: pg.PoolClient) => Promise<boolean | void>;
  }) {
    const id = randomUUID();
    const prepared = {
      id,
      hash: keccak256(stringToHex(`tx:${id}`)),
      intentHash: keccak256(stringToHex(`intent:${id}`)),
      nonce: journalNonce++,
    };
    const client = await this.pool().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO provider_chain_writes
          (id,chain_id,wallet_address,nonce,purpose,target_type,target_id,
           intent_hash,transaction_hash,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'broadcast')`,
        [
          id, CHAIN_ID, providerAccount.address.toLowerCase(), prepared.nonce,
          args.purpose, args.target.type, args.target.id, prepared.intentHash, prepared.hash,
        ],
      );
      if (await args.persist(prepared, client) === false) {
        throw new Error("Provider write lost its domain-state persistence claim");
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    this.prepared.push(args.target.id);
    return prepared;
  }

  async loadProviderWrite(id: string | null | undefined) {
    if (!id) return null;
    const result = await this.pool().query("SELECT * FROM provider_chain_writes WHERE id=$1", [id]);
    return result.rows[0] ?? null;
  }

  async rebroadcastProviderWrite(id: string): Promise<Hex> {
    this.rebroadcast.push(id);
    const row = await this.loadProviderWrite(id);
    return row.transaction_hash as Hex;
  }

  async confirmProviderWrite(id: string | null | undefined): Promise<void> {
    if (id) await this.pool().query("UPDATE provider_chain_writes SET status='confirmed' WHERE id=$1", [id]);
  }

  async revertProviderWrite(id: string | null | undefined): Promise<void> {
    if (id) await this.pool().query("UPDATE provider_chain_writes SET status='reverted' WHERE id=$1", [id]);
  }
}
