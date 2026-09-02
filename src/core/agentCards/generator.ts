import { config } from "../config.js";
import type { ServiceRow } from "../db/queries/services.js";
import type { SkillRow } from "../db/queries/skills.js";
import { buildLegalMetadata } from "../legal/metadata.js";
import {
  DEFAULT_MODES,
  buildSkillEntries,
  buildSkillMetadata,
} from "./skillMetadata.js";
import { getService } from "../serviceRegistry/registry.js";
import {
  buildContractExtension,
  DASKI_CONTRACT_EXTENSION_URI,
} from "./contractExtension.js";
import {
  buildServicePricing,
  buildSupportBlock,
  collectAssetTypes,
} from "./serviceMetadata.js";
import type { AgentCard } from "./types.js";

// These constants are active gateway contracts. The generator is split by
// concern, but their values and emitted shape stay stable.
const DASKI_EXT_URI = "https://daski.io/a2a/v1";
const PROVIDER_VERSION = "2.0.0";
const A2A_PROTOCOL_VERSION = "1.0";

export function generateAgentCard(
  service: ServiceRow,
  skills: SkillRow[],
): AgentCard {
  const activeSkills = skills
    .filter((skill) => skill.is_active)
    .sort((left, right) => left.sort_order - right.sort_order);
  const assetTypes = collectAssetTypes(service, activeSkills);

  return {
    name: service.name,
    description: service.service_description,
    version: PROVIDER_VERSION,
    defaultInputModes: DEFAULT_MODES,
    defaultOutputModes: DEFAULT_MODES,
    supportedInterfaces: [{
      url: `${config.BASE_URL}/a2a/${service.slug}`,
      protocolBinding: "JSONRPC",
      protocolVersion: A2A_PROTOCOL_VERSION,
    }],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [{
        uri: DASKI_EXT_URI,
        description:
          "Daski marketplace extension: service taxonomy, per-skill " +
          "pricing and fulfillment, on-chain service linkage " +
          "(serviceSlug/serviceVersion), and payment binding.",
        required: false,
      }, {
        uri: DASKI_CONTRACT_EXTENSION_URI,
        description:
          "Daski provider-driven service and skill contracts, including " +
          "closed schemas, pricing, availability, and asset-action semantics.",
        required: false,
      }],
    },
    skills: buildSkillEntries(service, activeSkills),
    documentationUrl: `${config.BASE_URL}/skills/${service.slug}.md`,
    extensions: {
      [DASKI_EXT_URI]: {
        providerAgentId: config.PROVIDER_AGENT_ID.toString(),
        x402Version: 2,
        ...(config.GATEWAY_BASE_URL
          ? { facilitatorUrl: config.GATEWAY_BASE_URL }
          : {}),
        pricing: buildServicePricing(activeSkills),
        serviceDescription: service.service_description,
        categoryFamily: service.category_family,
        serviceType: service.service_type,
        jurisdictions: service.jurisdictions,
        turnaroundEstimate: service.turnaround_estimate,
        serviceLifecycle: service.service_lifecycle,
        ...(service.service_lifecycle === "asset-lifecycle"
          && Object.keys(assetTypes).length > 0
          ? { assetTypes }
          : {}),
        onChainServiceId: service.on_chain_id
          ? `0x${service.on_chain_id.toString("hex")}`
          : null,
        serviceVersion: service.version,
        legal: buildLegalMetadata(),
        support: buildSupportBlock(service),
        auth: {
          openFreeA2aOnly: true,
          managedOrdersAndAssets: "Daski gateway wallet authorization",
        },
        skills: buildSkillMetadata(service, activeSkills),
      },
      [DASKI_CONTRACT_EXTENSION_URI]: (() => {
        const module = getService(service.slug);
        if (!module) throw new Error(`Service contract is unavailable: ${service.slug}`);
        return buildContractExtension(service, skills, module);
      })(),
    },
  };
}
