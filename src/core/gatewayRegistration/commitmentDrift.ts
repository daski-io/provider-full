import type { RuntimeListingHead } from "./runtimeCatalog.js";

export interface ListingCommitmentDrift {
  serviceId: string;
  skillId: string;
  registeredSkillContractHash: string;
  servedSkillContractHash: string;
}

export function findListingCommitmentDrift(
  heads: readonly RuntimeListingHead[],
  served: ReadonlyMap<string, string>,
): ListingCommitmentDrift[] {
  const drifts: ListingCommitmentDrift[] = [];
  for (const head of heads) {
    const key = `${head.serviceId.toLowerCase()}:${head.skillId}`;
    const servedHash = served.get(key);
    if (servedHash === undefined) continue;
    const registered = head.runtimeCommitment.skillContractHash.toLowerCase();
    if (registered === servedHash.toLowerCase()) continue;
    drifts.push({
      serviceId: head.serviceId,
      skillId: head.skillId,
      registeredSkillContractHash: registered,
      servedSkillContractHash: servedHash.toLowerCase(),
    });
  }
  return drifts;
}
