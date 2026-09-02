import { canonicalHash } from "../standardRail/canonical.js";
import { config } from "../config.js";
import type { ServiceRow } from "../db/queries/services.js";
import type { SkillRow } from "../db/queries/skills.js";
import { isPaymentRequired } from "../pricing/index.js";
import type {
  ServiceModule,
  SkillDefinition,
} from "../serviceRegistry/types.js";

export const DASKI_CONTRACT_EXTENSION_URI = "https://daski.io/a2a/v2";

export interface PublishedSkillContract {
  skillId: string;
  skillContractHash: string;
  presentation: {
    name: string;
    description: string;
    examples: string[];
    tags: string[];
    documentationUrl: string;
  };
  acceptingNewOrders: boolean;
  contract: Record<string, unknown>;
}

function publishedContract(
  module: ServiceModule,
  definition: SkillDefinition,
  row: SkillRow | undefined,
): PublishedSkillContract {
  // Availability is mutable card state outside the hashed contract, so a
  // provider pauses or resumes a skill without a new listing version.
  const acceptingNewOrders =
    (definition.acceptingNewOrders ?? true) && (row?.is_active ?? false);
  const contract = {
    inputSchema: definition.inputSchema,
    resultSchema: definition.resultSchema,
    pricing: row?.pricing ?? definition.pricing,
    requiresAssetOwnership: definition.requiresAssetOwnership,
    paymentRequired: isPaymentRequired(row?.pricing ?? definition.pricing),
    assetType: definition.assetType ?? null,
    fulfillmentMode:
      definition.fulfillmentMode ?? module.manifest.defaultFulfillmentMode,
    capacity: definition.capacity ?? { maxOpenOrders: 100 },
    deadlines: definition.deadlines ?? {},
    assetAction: definition.assetAction ?? null,
  };
  const skillContractHash = canonicalHash({
    schemaVersion: 1,
    serviceSlug: module.manifest.slug,
    serviceVersion: module.manifest.version ?? "1",
    skillId: definition.id,
    contract,
  });
  return {
    skillId: definition.id,
    skillContractHash,
    acceptingNewOrders,
    presentation: {
      name: definition.name,
      description: definition.description,
      examples: definition.examples,
      tags: definition.tags ?? [],
      documentationUrl: definition.documentationUrl ??
        `${config.BASE_URL}/skills/${module.manifest.slug}/${definition.id}.md`,
    },
    contract,
  };
}

// The skill-contract hashes this build would serve for one service, keyed by
// skillId — the same computation buildContractExtension publishes, exposed so
// the listing-commitment drift check compares registration against reality.
export function servedSkillContractHashes(
  module: ServiceModule,
  rows: SkillRow[],
): Map<string, string> {
  const byId = new Map(rows.map((row) => [row.skill_id, row]));
  return new Map(module.skills.map((definition) => [
    definition.id,
    publishedContract(module, definition, byId.get(definition.id)).skillContractHash,
  ]));
}

export function buildContractExtension(
  service: ServiceRow,
  rows: SkillRow[],
  module: ServiceModule,
): Record<string, unknown> {
  const byId = new Map(rows.map((row) => [row.skill_id, row]));
  const skills = module.skills
    .map((definition) => publishedContract(module, definition, byId.get(definition.id)))
    .sort((left, right) => left.skillId.localeCompare(right.skillId));
  const skillContractSetHash = canonicalHash(skills.map((skill) => ({
    skillId: skill.skillId,
    skillContractHash: skill.skillContractHash,
  })));
  const origin = new URL(config.BASE_URL).origin;
  return {
    schemaVersion: 1,
    providerAgentId: config.PROVIDER_AGENT_ID.toString(),
    service: {
      serviceId: service.on_chain_id
        ? `0x${service.on_chain_id.toString("hex")}`
        : null,
      slug: service.slug,
      version: service.version,
      categoryFamily: service.category_family,
      serviceType: service.service_type,
      jurisdictions: service.jurisdictions,
      lifecycle: service.service_lifecycle,
      turnaroundEstimate: service.turnaround_estimate,
      acceptingNewOrders: service.is_active &&
        skills.some((skill) => skill.acceptingNewOrders),
    },
    standardRail: {
      origin,
      providerAudience: config.BASE_URL,
      quoteUrl: `${origin}/standard-rail/quote`,
      dispatchUrl: `${origin}/standard-rail/dispatch`,
      dispatchStatusUrl: `${origin}/standard-rail/dispatch/status`,
      lifecycleUrl: `${origin}/standard-rail/lifecycle`,
      assetQueryUrl: `${origin}/standard-rail/assets/query`,
      assetActionUrl: `${origin}/standard-rail/assets/action`,
    },
    skillContractSetHash,
    skills,
  };
}
