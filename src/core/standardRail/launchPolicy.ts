import { isPaymentRequired } from "../pricing/index.js";
import type {
  AssetActionEffect,
  AssetActionReplayPolicy,
  ClosedJsonSchema,
  ServiceModule,
} from "../serviceRegistry/types.js";

export interface ProviderPaidSkillLaunchPolicy {
  serviceSlug: string;
  skillId: string;
}

export interface ProviderOutcomeLaunchPolicy {
  paidSkills: readonly ProviderPaidSkillLaunchPolicy[];
}

export interface ProviderAssetActionLaunchPolicy {
  serviceSlug: string;
  actionId: string;
  effect: AssetActionEffect;
  replayPolicy: AssetActionReplayPolicy;
  inputSchema: ClosedJsonSchema;
  resultSchema: ClosedJsonSchema;
}

export interface ProviderWalletLaunchPolicy {
  assetActions: readonly ProviderAssetActionLaunchPolicy[];
}

export type ProviderLaunchPolicy =
  ProviderOutcomeLaunchPolicy & ProviderWalletLaunchPolicy;

export function deriveProviderLaunchPolicy(
  services: readonly ServiceModule[],
): ProviderLaunchPolicy {
  return {
    paidSkills: services.flatMap((service) => service.skills
      .filter((skill) => isPaymentRequired(skill.pricing))
      .map((skill) => ({
        serviceSlug: service.manifest.slug,
        skillId: skill.id,
      }))),
    assetActions: services.flatMap((service) => service.skills.flatMap((skill) =>
      skill.assetAction
        ? [{
            serviceSlug: service.manifest.slug,
            actionId: skill.id,
            effect: skill.assetAction.effect,
            replayPolicy: skill.assetAction.replayPolicy,
            inputSchema: skill.inputSchema,
            resultSchema: skill.resultSchema,
          }]
        : []
    )),
  };
}
