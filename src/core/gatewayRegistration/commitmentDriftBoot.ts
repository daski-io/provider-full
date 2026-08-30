import { servedSkillContractHashes } from "../agentCards/contractExtension.js";
import { getSkillsByServiceId } from "../db/queries/skills.js";
import { getServiceBySlug } from "../db/queries/services.js";
import { errorExtra, logError, logInfo } from "../logger.js";
import { getAllServices } from "../serviceRegistry/registry.js";
import { findListingCommitmentDrift, type ListingCommitmentDrift } from "./commitmentDrift.js";
import { loadRuntimeListingHeads } from "./runtimeCatalog.js";

// Non-fatal by design: the changed AgentCard must remain online so an
// authorized re-registration can clear drift instead of deadlocking startup.
export async function logListingCommitmentDrift(
  gatewayOrigin: string,
): Promise<ListingCommitmentDrift[]> {
  try {
    const served = new Map<string, string>();
    for (const module of getAllServices()) {
      const service = await getServiceBySlug(
        module.manifest.slug,
        module.manifest.version ?? "1",
      );
      if (!service?.on_chain_id) continue;
      const serviceId = `0x${service.on_chain_id.toString("hex")}`.toLowerCase();
      const rows = await getSkillsByServiceId(service.id);
      for (const [skillId, hash] of servedSkillContractHashes(module, rows)) {
        served.set(`${serviceId}:${skillId}`, hash);
      }
    }
    const heads = await loadRuntimeListingHeads(gatewayOrigin);
    const drifts = findListingCommitmentDrift(heads, served);
    for (const drift of drifts) {
      logError(
        "listing commitment drift: this build serves a skill contract its promoted listing did not commit; re-register before the gateway quarantines the service",
        { ...drift },
      );
    }
    if (drifts.length === 0) {
      logInfo("listing commitments match the served skill contracts", {
        gatewayOrigin,
        heads: heads.length,
      });
    }
    return drifts;
  } catch (error) {
    logError("listing commitment drift check failed", errorExtra(error));
    return [];
  }
}
