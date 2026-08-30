import type { ValidateFunction } from "ajv";
import type { FulfillmentAdapter, ServiceModule } from "./types.js";
import { pool } from "../db/pool.js";
import { registerServiceProtectedData } from "../security/protectedDataSinks.js";
import { upsertService } from "../db/queries/services.js";
import { upsertSkill } from "../db/queries/skills.js";
import { validatePricing } from "../pricing/index.js";
import { isFree } from "../pricing/index.js";
import { config } from "../config.js";
import { logInfo } from "../logger.js";
import { runModuleMigrations } from "./moduleMigrations.js";
import { requireScreeningScopes } from "../screening/registry.js";
import {
  compileProviderSchema,
  validateProviderRequest,
} from "../standardRail/schema.js";

const REGISTERED: Map<string, ServiceModule> = new Map();
const FULFILLMENT_MODES = new Set(["automated", "human", "hybrid"]);
const SKILL_INPUT_VALIDATORS = new Map<string, ValidateFunction>();
/**
 * Registers a ServiceModule with core. Side effects:
 *   1. Validates manifest (slug shape, pricing JSONB on every skill).
 *   2. Runs service-specific migrations (idempotent, namespaced by slug).
 *   3. Upserts the services row from manifest. Idempotent on (slug, version).
 *   4. Diff-syncs skills: inserts new, updates metadata of existing,
 *      soft-deactivates rows that are no longer in code (never hard-deletes).
 *   5. Validates every skill has a doc file.
 *   6. Adds the module to the in-process map.
 *
 * Adapter routes are NOT wired here — `core/server.ts` walks
 * `getAllServices()` after registration and mounts each service's
 * routes/docs.
 *
 * Pre-execute prompts are NOT seeded here; they live in `service_rules`
 * (operator-curated, written via the Operator Agent or admin UI). The
 * runtime knobs (model/timeout/enabled) seed into `skills.config.llm`
 * from `module.fulfillment.preExecuteAgent` defaults.
 */
export async function registerService(module: ServiceModule): Promise<void> {
  const { manifest, skills } = module;
  const migrations = module.operations?.migrations;
  const docs = module.protocol.docs;

  // 1. Validate manifest.
  if (!manifest.slug || !/^[a-z0-9-]+$/.test(manifest.slug)) {
    throw new Error(
      `Invalid service slug: ${manifest.slug} (kebab-case alphanumerics only)`,
    );
  }
  if (
    !/^[a-z0-9][a-z0-9-]{0,127}$/.test(manifest.categoryFamily) ||
    !/^[a-z0-9][a-z0-9-]{0,127}$/.test(manifest.serviceType)
  ) {
    throw new Error(
      `Service ${manifest.slug}: category and service type must be normalized open identifiers`,
    );
  }
  if (REGISTERED.has(manifest.slug)) {
    throw new Error(`Service already registered: ${manifest.slug}`);
  }
  if (manifest.dispatchMode !== "one-shot" && manifest.dispatchMode !== "durable") {
    throw new Error(`Service ${manifest.slug}: dispatchMode must be one-shot or durable`);
  }
  if (!/^[a-z0-9-]+$/.test(manifest.serviceType)) {
    throw new Error(`Service ${manifest.slug}: serviceType must be a kebab-case slug`);
  }
  if (
    !Array.isArray(manifest.jurisdictions) ||
    manifest.jurisdictions.length === 0 ||
    new Set(manifest.jurisdictions).size !== manifest.jurisdictions.length ||
    (manifest.jurisdictions.includes("global") && manifest.jurisdictions.length > 1) ||
    manifest.jurisdictions.some(
      (jurisdiction) =>
        !/^(?:global|[A-Z]{2}(?:-[A-Z0-9]{1,3})?)$/.test(jurisdiction),
    )
  ) {
    throw new Error(
      `Service ${manifest.slug}: jurisdictions must be unique uppercase ISO values, or global alone`,
    );
  }
  if (!FULFILLMENT_MODES.has(manifest.defaultFulfillmentMode)) {
    throw new Error(
      `Service ${manifest.slug}: defaultFulfillmentMode must be automated, human, or hybrid`,
    );
  }
  for (const skill of skills) {
    if (skill.fulfillmentMode && !FULFILLMENT_MODES.has(skill.fulfillmentMode)) {
      throw new Error(
        `Service ${manifest.slug}: skill "${skill.id}" fulfillmentMode must be ` +
          `automated, human, or hybrid`,
      );
    }
    if (!/^[a-z0-9][a-z0-9-]{0,95}$/.test(skill.id)) {
      throw new Error(`Service ${manifest.slug}: skill id is invalid`);
    }
    const inputValidator = compileProviderSchema(skill.inputSchema);
    compileProviderSchema(skill.resultSchema);
    const properties = Object.keys(
      skill.inputSchema.properties as Record<string, unknown>,
    ).sort();
    const declared = [
      ...(skill.requiredFields ?? []),
      ...(skill.optionalFields ?? []),
    ].sort();
    if (
      properties.length !== declared.length ||
      properties.some((field, index) => field !== declared[index]) ||
      new Set(declared).size !== declared.length
    ) {
      throw new Error(
        `Service ${manifest.slug}: skill "${skill.id}" field lists differ from inputSchema`,
      );
    }
    const action = skill.assetAction;
    if (action) {
      const destructive = action.effect === "destructive";
      const hasConfirmation =
        action.confirmationSummarySchema !== undefined &&
        action.confirmationSummaryTemplate !== undefined;
      if (
        !skill.requiresAssetOwnership ||
        action.ownershipPolicy !== "owner-only" ||
        !["read", "mutate", "destructive"].includes(action.effect) ||
        !["stable-result", "regenerate-ephemeral", "redacted-after-window"].includes(
          action.replayPolicy,
        ) ||
        !Number.isSafeInteger(action.retentionSeconds) ||
        action.retentionSeconds < 1 ||
        action.retentionSeconds > 31_536_000 ||
        destructive !== hasConfirmation ||
        (action.replayPolicy === "redacted-after-window" &&
          action.retentionSeconds > 604_800) ||
        (destructive && action.retentionSeconds <= 600)
      ) {
        throw new Error(
          `Service ${manifest.slug}: skill "${skill.id}" asset action contract is unsafe`,
        );
      }
      if (destructive) {
        const confirmation = compileProviderSchema(
          action.confirmationSummarySchema!,
        );
        validateProviderRequest(
          confirmation,
          action.confirmationSummaryTemplate,
        );
      }
    }
    if (
      skill.capacity !== undefined &&
      (!Number.isSafeInteger(skill.capacity.maxOpenOrders) ||
        skill.capacity.maxOpenOrders < 1 ||
        skill.capacity.maxOpenOrders > 100_000)
    ) {
      throw new Error(`Service ${manifest.slug}: skill capacity is invalid`);
    }
    SKILL_INPUT_VALIDATORS.set(`${manifest.slug}:${skill.id}`, inputValidator);
    try {
      validatePricing(skill.pricing);
    } catch (err) {
      throw new Error(
        `Service ${manifest.slug}: skill "${skill.id}" pricing is invalid: ` +
          (err as Error).message,
      );
    }
    if (
      skill.taskDurability === "ephemeral"
      && (
        !isFree(skill.pricing)
        || skill.requiresAssetOwnership
        || (skill.fulfillmentMode ?? manifest.defaultFulfillmentMode) !== "automated"
      )
    ) {
      throw new Error(
        `Service ${manifest.slug}: ephemeral skill "${skill.id}" must be ` +
          "free, open, and automated",
      );
    }
  }
  if (module.screening) {
    const extension = requireScreeningScopes(module.screening.requiredScopes);
    if (!extension.policy.serviceBindings[manifest.slug]) {
      throw new Error(`Screening policy has no service binding for ${manifest.slug}`);
    }
  }

  // 2. Register protected-data declarations (rotation sinks + encrypted
  //    asset-identifier schemes) BEFORE anything touches this service's
  //    rows, then run service-specific migrations.
  registerServiceProtectedData(module);
  if (migrations && migrations.length > 0) {
    await runModuleMigrations(manifest.slug, migrations);
  }

  // 3. Upsert services row. When the manifest doesn't pin an explicit
  //    `agentDomain`, default to the host of BASE_URL. This is what the
  //    ServiceRegistrar bootstrap uses as the on-chain `serviceURI` host,
  //    so a fresh deploy can register its services on-chain without an
  //    operator first having to set agent_domain via the admin UI. The
  //    manifest field remains an explicit override path for split-deploy
  //    setups (admin / public hostname split, multi-tenant fronts).
  const defaultAgentDomain = defaultAgentDomainFromBaseUrl();
  const serviceRow = await upsertService({
    name: manifest.name,
    slug: manifest.slug,
    version: manifest.version ?? "1",
    category_family: manifest.categoryFamily,
    service_type: manifest.serviceType,
    jurisdictions: manifest.jurisdictions,
    turnaround_estimate: manifest.turnaroundEstimate,
    service_lifecycle: manifest.serviceLifecycle,
    service_description: manifest.description,
    adapter_name: manifest.slug,
    agent_domain: manifest.agentDomain ?? defaultAgentDomain,
    supplier: manifest.supplier ?? null,
    outbound_email_from: manifest.outboundEmailFrom ?? null,
    inbound_email_address: manifest.inboundEmailAddress ?? null,
    service_wallet: manifest.serviceWallet ?? null,
    is_active: true,
  });

  // 4. Diff-sync skills.
  await syncSkills(serviceRow.id, module);

  // Validate doc coverage. Docs are REQUIRED (audit 4.5): a service
  // with no docs module, a missing skill entry, a blank file, or a
  // Missing-document sentinels fail registration.
  // docs must never ship as the public contract.
  const placeholderDoc = (content: unknown): boolean =>
    typeof content !== "string" ||
    content.trim().length === 0 ||
    /documentation unavailable/i.test(content);
  if (placeholderDoc(docs.service)) {
    throw new Error(
      `Service ${manifest.slug}: the service doc is missing, blank, or a placeholder.`,
    );
  }
  for (const skill of skills) {
    if (placeholderDoc(docs.skills[skill.id])) {
      throw new Error(
        `Service ${manifest.slug}: skill "${skill.id}" doc is missing, blank, or a ` +
          `placeholder. Add docs/${skill.id}.md and wire it into ` +
            "ServiceModule.protocol.docs.skills.",
      );
    }
  }

  // 7. Run optional seed.
  if (module.operations?.seed) {
    await module.operations.seed();
  }

  REGISTERED.set(manifest.slug, module);

  logInfo(`Service registered: ${manifest.slug}`, {
    version: manifest.version ?? "1",
    skills: skills.length,
  });
}

export function getService(slug: string): ServiceModule | null {
  return REGISTERED.get(slug) ?? null;
}

export function getAllServices(): ServiceModule[] {
  return Array.from(REGISTERED.values());
}

export function validateSkillInput(
  serviceSlug: string,
  skillId: string,
  value: unknown,
): void {
  const validator = SKILL_INPUT_VALIDATORS.get(`${serviceSlug}:${skillId}`);
  if (!validator) throw new Error("Skill input contract is unavailable");
  validateProviderRequest(validator, value);
}

export function getAdapter(slug: string): FulfillmentAdapter {
  const module = REGISTERED.get(slug);
  if (!module) {
    throw new Error(`Unknown service: ${slug}`);
  }
  return module.fulfillment.adapter;
}

// ──────────────────────────────────────────────────────────────────────

/// Derive the default `agent_domain` value from `config.BASE_URL`. Falls
/// back to null if BASE_URL is unparseable — the ServiceRegistrar will
/// then skip the on-chain registration and warn instead of crashing.
function defaultAgentDomainFromBaseUrl(): string | null {
  try {
    return new URL(config.BASE_URL).host;
  } catch {
    return null;
  }
}

async function syncSkills(
  serviceId: string,
  module: ServiceModule,
): Promise<void> {
  const codeSkillIds = new Set(module.skills.map((s) => s.id));

  for (let i = 0; i < module.skills.length; i++) {
    const skill = module.skills[i];

    // Translate the module's preExecuteAgent defaults into the
    // skills.config.llm shape. Operator can override via the admin UI's
    // Services workspace; subsequent upserts merge (skills.config || EXCLUDED).
    const preExec = module.fulfillment.preExecuteAgent?.[skill.id];
    const seededConfig = preExec
      ? {
          llm: {
            model: preExec.model,
            timeout_ms: preExec.timeoutMs,
            enabled: preExec.enabled,
            // Fail-open vs fail-closed when the review itself can't decide.
            on_error: preExec.onError ?? "proceed",
            // Default system prompt + escalation rules from the module.
            // Operator can override via service_rules with scope='pre_execute'.
            default_system_prompt: preExec.systemPrompt,
            default_escalation_rules: preExec.escalationRules,
          },
        }
      : {};

    await upsertSkill({
      service_id: serviceId,
      skill_id: skill.id,
      name: skill.name,
      description: skill.description,
      pricing: skill.pricing,
      tags: skill.tags,
      required_fields: skill.requiredFields,
      optional_fields: skill.optionalFields,
      requires_asset_ownership: skill.requiresAssetOwnership,
      asset_type: skill.assetType ?? null,
      sort_order: skill.sortOrder ?? i,
      is_active: true,
      human_parties: skill.humanParties ?? null,
      fulfillment_mode: skill.fulfillmentMode ?? module.manifest.defaultFulfillmentMode,
      config: seededConfig,
      examples: skill.examples,
      documentation_url: skill.documentationUrl ?? null,
    });
  }

  // Soft-deactivate skills that exist in the DB but are no longer in code.
  // Never hard-delete; keep them for audit and so existing transactions
  // don't lose their FK target.
  await pool.query(
    `UPDATE skills SET is_active = false, updated_at = now()
      WHERE service_id = $1 AND skill_id != ALL($2::text[]) AND is_active = true`,
    [serviceId, Array.from(codeSkillIds)],
  );
}
