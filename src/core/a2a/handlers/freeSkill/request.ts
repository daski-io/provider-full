import { getServiceBySlug } from "../../../db/queries/services.js";
import { getSkillByServiceAndSkillId } from "../../../db/queries/skills.js";
import { isPaymentRequired } from "../../../pricing/index.js";
import { extractDataFromParts } from "../../parts.js";
import { DASKI_ERR, JSON_RPC } from "../../jsonrpc.js";
import { missingRequiredFields } from "../requiredFields.js";
import {
  getService,
  validateSkillInput,
} from "../../../serviceRegistry/registry.js";
import type { TaskDurability } from "../../../serviceRegistry/types.js";
import { validateFreeSkillInput } from "./inputValidation.js";
import type { DaskiMetadata, FreeSkillError } from "./types.js";

type ResolvedRequest =
  | {
      ok: true;
      service: NonNullable<Awaited<ReturnType<typeof getServiceBySlug>>>;
      skill: NonNullable<
        Awaited<ReturnType<typeof getSkillByServiceAndSkillId>>
      >;
      skillId: string;
      data: Record<string, unknown>;
      messageId: string;
      taskDurability: TaskDurability;
    }
  | ({ ok: false } & FreeSkillError);

export async function resolveFreeSkillRequest(args: {
  message: Record<string, unknown>;
  metadata: DaskiMetadata;
  serviceSlug: string;
}): Promise<ResolvedRequest> {
  const service = await getServiceBySlug(args.serviceSlug);
  if (!service || !service.is_active) {
    return {
      ok: false,
      code: DASKI_ERR.SERVICE_NOT_FOUND,
      message: `Service not found or inactive: ${args.serviceSlug}`,
    };
  }
  const skillId = args.metadata.skillId;
  if (!skillId) {
    return {
      ok: false,
      code: JSON_RPC.INVALID_PARAMS,
      message: "Missing skillId in metadata",
    };
  }
  const skill = await getSkillByServiceAndSkillId(service.id, skillId);
  if (!skill || !skill.is_active) {
    return {
      ok: false,
      code: JSON_RPC.INVALID_PARAMS,
      message: `Invalid skill: ${skillId}`,
    };
  }
  if (
    isPaymentRequired(skill.pricing)
    || skill.requires_asset_ownership
  ) {
    return {
      ok: false,
      code: JSON_RPC.INVALID_PARAMS,
      message:
        `Skill '${skillId}' requires standard-rail order authority. ` +
        "Call it through the Daski gateway instead of the provider's public free-skill endpoint.",
    };
  }
  const data = extractDataFromParts(args.message);
  const definition = getService(args.serviceSlug)?.skills.find(
    (candidate) => candidate.id === skillId,
  );
  if (!definition) {
    return {
      ok: false,
      code: JSON_RPC.INTERNAL_ERROR,
      message: `Skill contract is unavailable: ${skillId}`,
    };
  }
  const taskDurability = definition.taskDurability ?? "persistent";
  const input = validateFreeSkillInput({
    messageId: args.message.messageId,
    data,
    taskDurability,
    requiredFields: skill.required_fields,
    optionalFields: skill.optional_fields,
  });
  if (!input.ok) {
    return {
      ok: false,
      code: JSON_RPC.INVALID_PARAMS,
      message: input.message,
    };
  }
  try {
    validateSkillInput(args.serviceSlug, skillId, data);
  } catch {
    return {
      ok: false,
      code: JSON_RPC.INVALID_PARAMS,
      message: "Input does not match the published skill contract",
    };
  }
  const missing = missingRequiredFields(skill, data);
  if (missing.length > 0) {
    return {
      ok: false,
      code: JSON_RPC.INVALID_PARAMS,
      message: `Missing required fields: ${missing.join(", ")}`,
    };
  }
  return {
    ok: true,
    service,
    skill,
    skillId,
    data,
    messageId: input.messageId,
    taskDurability,
  };
}
