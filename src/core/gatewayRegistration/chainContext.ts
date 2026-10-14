import { getAddress, type Address, type Hex } from "viem";
import { config } from "../config.js";
import type { ServiceRow } from "../db/queries/services.js";
import { finalizedReadBlockNumber } from "../chain/finality.js";
import { identityRegistryAbi, serviceRegistryAbi } from "../chain/abis.js";
import { providerAddress, publicClient } from "../chain/client.js";
import type { PublishedServiceContract, RegistrationPolicy } from "./types.js";
import {
  fetchBoundedJson,
  normalizedGatewayOrigin,
  parsePublishedServiceContract,
  parseRegistrationPolicy,
} from "./wire.js";

const ZERO = "0x0000000000000000000000000000000000000000";

export interface FinalizedService {
  providerAgentId: bigint;
  serviceId: Hex;
  serviceSlug: string;
  version: string;
  serviceURI: string;
  serviceWallet: Address;
  active: boolean;
}

/** Everything one registration step reads before it decides anything. */
export interface RegistrationContext {
  gatewayOrigin: string;
  policy: RegistrationPolicy;
  finalizedBlock: bigint;
  record: FinalizedService;
  providerPayee: Address;
  published: PublishedServiceContract;
}

export function gatewaySigner(): Address {
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
): Promise<{ record: FinalizedService; providerPayee: Address }> {
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

/**
 * The gateway policy, the finalized chain record and provider authority, and
 * the provider's own published card for one service. Reads only.
 */
export async function loadRegistrationContext(
  gateway: string,
  service: ServiceRow,
): Promise<RegistrationContext> {
  const gatewayOrigin = normalizedGatewayOrigin(gateway);
  const policy = await loadPolicy(gatewayOrigin);
  const finalizedBlock = await finalizedReadBlockNumber();
  const { record, providerPayee } = await chainService(service, finalizedBlock);
  const published = await publishedContract(record);
  return { gatewayOrigin, policy, finalizedBlock, record, providerPayee, published };
}
