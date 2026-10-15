import { getAddress, type Address, type Hex } from "viem";
import type { BuildIdentity } from "../buildIdentity.js";
import type { Queryable } from "../db/queryable.js";
import type { ProviderRuntimeListingBundleV1 } from "../gatewayRegistration/runtimeCatalog.js";
import { loadVersionObligations, type VersionObligations } from "../gatewayRegistration/versionObligations.js";
import {
  executableDefinitionHash,
  matchAssetAction,
  matchContract,
  type AdmittedActionContract,
} from "../serviceRegistry/executableContracts.js";
import { canonicalHash } from "../standardRail/canonical.js";
import type { ControlProfileSet } from "../standardRail/controlProfiles.js";
import {
  capabilityHash,
  capabilityManifest,
  moduleContracts,
  type CapabilityModule,
  type ProviderCapabilityManifestV1,
} from "./capabilityManifest.js";

/*
 * Does this artifact, with this deployment's keys, serve everything durable
 * state still requires? A version requires its handler while it can still
 * receive work: it is sold now, or unretired with any provider quote (one
 * may still be paid), or it has pending orders, jobs, supplier operations,
 * reviews or lifecycle actions. It requires its signing key for as long as
 * any order of it can be read. An open asset-action execution requires its
 * admitted definition and that definition's handler. An unretired version
 * whose quotes were issued under a control profile the deployment no longer
 * accepts may still receive a first dispatch it would refuse. Everything is
 * read from the database; nothing is assumed from an external coordinator.
 */

export type CompatibilityGapKind =
  | "handler" | "signing_key" | "unreadable_contract" | "action_definition" | "action_handler"
  | "control_profile";

export interface CompatibilityGap {
  kind: CompatibilityGapKind;
  serviceSlug: string;
  skillId: string;
  listingManifestHash?: Hex;
  executableDefinitionHash?: Hex;
  actionDefinitionHash?: Hex;
  signingKey?: Address;
  controlProfileHash?: Hex;
}

export interface VersionCompatibility extends VersionObligations {
  serviceSlug: string;
  executableDefinitionHash: Hex | null;
  signingKey: Address;
  requiresHandler: boolean;
  requiresSigningKey: boolean;
  /** The control profiles its recorded quotes were issued under. */
  quoteControlProfiles: Hex[];
}

export interface ProviderCompatibilityReportV1 {
  artifactType: "ProviderCompatibilityReportV1";
  schemaVersion: 1;
  capabilityHash: Hex;
  capability: ProviderCapabilityManifestV1;
  activationRevision: string;
  signingKeys: Address[];
  /** The control profiles this deployment accepts; null when not configured for the check. */
  controlProfiles: ControlProfileSet | null;
  versions: VersionCompatibility[];
  openActions: number;
  gaps: CompatibilityGap[];
  ok: boolean;
}

interface VersionRow {
  runtime_commitment_hash: Buffer;
  bundle: ProviderRuntimeListingBundleV1;
}

interface ActionRow {
  action_definition_hash: Buffer;
  definition: (AdmittedActionContract & { actionDefinitionHash?: string }) | null;
}

const hex = (value: Buffer): Hex => `0x${value.toString("hex")}`;

/** The catalog's activation revision: 0 before its first write. */
export async function activationRevision(db: Queryable): Promise<string> {
  const row = (await db.query<{ last_value: string; is_called: boolean }>(
    "SELECT last_value::text AS last_value,is_called FROM provider_catalog_revision",
  )).rows[0];
  return row?.is_called ? row.last_value : "0";
}

function versionRequirements(version: VersionObligations): { handler: boolean; signingKey: boolean } {
  const owesWork = version.pendingTasks > 0 || version.durableJobs > 0 || version.supplierOperations > 0 ||
    version.openReviews > 0 || version.unresolvedLifecycleActions > 0;
  const handler = owesWork || (!version.retired && (version.head || version.quotes > 0));
  return { handler, signingKey: handler || version.terminalTasks > 0 };
}

/** Each version's recorded quote control profiles, by lowercase commitment hash. */
async function quoteControlProfiles(db: Queryable): Promise<Map<string, Hex[]>> {
  const rows = (await db.query<{ listing_manifest_hash: Buffer; provider_control_profile_hash: Buffer }>(
    `SELECT DISTINCT listing_manifest_hash,provider_control_profile_hash FROM standard_provider_quotes
      WHERE provider_control_profile_hash IS NOT NULL`,
  )).rows;
  const profiles = new Map<string, Hex[]>();
  for (const row of rows) {
    const key = hex(row.listing_manifest_hash);
    profiles.set(key, [...profiles.get(key) ?? [], hex(row.provider_control_profile_hash)].sort());
  }
  return profiles;
}

export async function compatibilityReport(db: Queryable, args: {
  gatewayOrigin: string;
  modules: readonly CapabilityModule[];
  signingKeys: ReadonlySet<Address>;
  build: BuildIdentity;
  /** The deployment's accepted control profiles; omitted, quote profiles are listed but not judged. */
  controlProfiles?: ControlProfileSet | null;
}): Promise<ProviderCompatibilityReportV1> {
  const capability = capabilityManifest(args.modules, args.build);
  const entries = moduleContracts(args.modules);
  const revision = await activationRevision(db);
  const obligations = await loadVersionObligations(db, { gatewayOrigin: args.gatewayOrigin });
  const bundles = new Map((await db.query<VersionRow>(
    `SELECT runtime_commitment_hash,bundle FROM provider_runtime_listing_versions
      WHERE gateway_origin=$1 AND payment_required`,
    [args.gatewayOrigin],
  )).rows.map((row) => [hex(row.runtime_commitment_hash), row.bundle]));
  const keys = new Set([...args.signingKeys].map((key) => getAddress(key)));
  const quoteProfiles = await quoteControlProfiles(db);
  const accepted = args.controlProfiles
    ? new Set([args.controlProfiles.current, ...args.controlProfiles.retained].map((hash) => hash.toLowerCase()))
    : null;
  const gaps: CompatibilityGap[] = [];
  const versions: VersionCompatibility[] = obligations.map((version) => {
    const bundle = bundles.get(version.listingManifestHash);
    const serviceSlug = bundle?.intent?.payload?.serviceSlug ?? "";
    const contract = bundle?.skillContract?.contract ?? null;
    const signingKey = getAddress(bundle?.providerIdentity?.agentWallet ?? "0x0000000000000000000000000000000000000000");
    let executable: Hex | null = null;
    try {
      executable = contract ? executableDefinitionHash(serviceSlug, version.skillId, contract) : null;
    } catch {
      executable = null;
    }
    const requires = versionRequirements(version);
    const at = { serviceSlug, skillId: version.skillId, listingManifestHash: version.listingManifestHash };
    if (requires.handler && executable === null) gaps.push({ kind: "unreadable_contract", ...at });
    else if (requires.handler && !matchContract(entries, serviceSlug, version.skillId, contract)) {
      gaps.push({ kind: "handler", ...at, executableDefinitionHash: executable! });
    }
    if (requires.signingKey && !keys.has(signingKey)) gaps.push({ kind: "signing_key", ...at, signingKey });
    // Any quote of an unretired version may still be paid and first
    // dispatched under the profile it was issued under.
    const profiles = quoteProfiles.get(version.listingManifestHash.toLowerCase()) ?? [];
    if (accepted && !version.retired) {
      for (const profile of profiles) {
        if (!accepted.has(profile)) gaps.push({ kind: "control_profile", ...at, controlProfileHash: profile });
      }
    }
    return {
      ...version, serviceSlug, executableDefinitionHash: executable, signingKey,
      requiresHandler: requires.handler, requiresSigningKey: requires.signingKey,
      quoteControlProfiles: profiles,
    };
  });
  const actions = (await db.query<ActionRow>(
    `SELECT DISTINCT x.action_definition_hash,d.definition
       FROM standard_asset_action_executions x
       LEFT JOIN standard_admitted_action_definitions d ON d.action_definition_hash=x.action_definition_hash
      WHERE x.state NOT IN ('completed','failed','canceled','expired')`,
  )).rows;
  for (const action of actions) {
    const hash = hex(action.action_definition_hash);
    const { actionDefinitionHash: _hash, ...preimage } = action.definition ?? {};
    const definition = action.definition && canonicalHash(preimage) === hash ? action.definition : null;
    const at = {
      serviceSlug: definition?.serviceSlug ?? "", skillId: definition?.actionId ?? "", actionDefinitionHash: hash,
    };
    if (!definition) gaps.push({ kind: "action_definition", ...at });
    else if (!matchAssetAction(entries, definition)) gaps.push({ kind: "action_handler", ...at });
  }
  return {
    artifactType: "ProviderCompatibilityReportV1",
    schemaVersion: 1,
    capabilityHash: capabilityHash(capability),
    capability,
    activationRevision: revision,
    signingKeys: [...keys].sort(),
    controlProfiles: args.controlProfiles
      ? { current: args.controlProfiles.current, retained: [...args.controlProfiles.retained].sort() }
      : null,
    versions,
    openActions: actions.length,
    gaps,
    ok: gaps.length === 0,
  };
}

/** One stable line per gap, for logs and readiness diagnostics. */
export function describeGap(gap: CompatibilityGap): string {
  const target = gap.listingManifestHash ?? gap.actionDefinitionHash ?? "";
  const profile = gap.controlProfileHash ? `:${gap.controlProfileHash}` : "";
  return `${gap.kind}:${gap.serviceSlug}/${gap.skillId}:${target}${profile}`;
}
