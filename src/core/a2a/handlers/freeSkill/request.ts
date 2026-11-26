import { getServiceBySlug } from "../../../db/queries/services.js";
import { getSkillByServiceAndSkillId } from "../../../db/queries/skills.js";
import { isPaymentRequired } from "../../../pricing/index.js";
import { extractDataFromParts } from "../../parts.js";
import { DASKI_ERR, JSON_RPC } from "../../jsonrpc.js";
import { missingRequiredFields } from "../requiredFields.js";
import { serviceDeclaresOutage } from "../../../serviceRegistry/readiness.js";
import {
  getService,
  skillInputFieldErrors,
} from "../../../serviceRegistry/registry.js";
import { config } from "../../../config.js";
import {
  freeSkillHelp,
  skillInputHelp,
  type OpenFreeSkill,
} from "../../freeSkillHelp.js";
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
      data: { ...await freeSkillHelp(args.serviceSlug) },
    };
  }
  const skillId = args.metadata.skillId;
  if (!skillId) {
    return {
      ok: false,
      code: JSON_RPC.INVALID_PARAMS,
      message: "Missing skillId in metadata",
      data: { ...await freeSkillHelp(args.serviceSlug) },
    };
  }
  const skill = await getSkillByServiceAndSkillId(service.id, skillId);
  if (!skill || !skill.is_active) {
    return {
      ok: false,
      code: JSON_RPC.INVALID_PARAMS,
      message: `Invalid skill: ${skillId}`,
      data: { ...await freeSkillHelp(args.serviceSlug) },
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
  const help = (includeSchema: boolean) => skillInputHelp(
    args.serviceSlug,
    {
      skillId,
      definition,
      requiredFields: skill.required_fields ?? [],
      documentationUrl: skill.documentation_url
        ?? `${config.BASE_URL}/skills/${args.serviceSlug}/${skillId}.md`,
    } satisfies OpenFreeSkill,
    includeSchema,
  );
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
      data: help(input.field === "data"),
    };
  }
  let fieldErrors;
  try {
    fieldErrors = skillInputFieldErrors(args.serviceSlug, skillId, data);
  } catch {
    return {
      ok: false,
      code: JSON_RPC.INTERNAL_ERROR,
      message: `Skill contract is unavailable: ${skillId}`,
    };
  }
  if (fieldErrors.length > 0) {
    const fields = [
      ...new Set(fieldErrors.map((error) => error.field || "(input)")),
    ];
    return {
      ok: false,
      code: JSON_RPC.INVALID_PARAMS,
      message:
        `Input does not match the published skill contract: ${fields.join(", ")}. ` +
        "See error.data.errors and error.data.inputSchema.",
      data: {
        errors: fieldErrors,
        ...(hasDataPart(args.message) ? {} : { inputPart: NO_DATA_PART }),
        ...help(true),
      },
    };
  }
  const missing = missingRequiredFields(skill, data);
  if (missing.length > 0) {
    return {
      ok: false,
      code: JSON_RPC.INVALID_PARAMS,
      message: `Missing required fields: ${missing.join(", ")}`,
      data: help(true),
    };
  }
  // A valid call waits out an outage the service declares instead of
  // running into it.
  if (await serviceDeclaresOutage(args.serviceSlug)) {
    return {
      ok: false,
      code: DASKI_ERR.SERVICE_UNAVAILABLE,
      message: "Service is temporarily unavailable",
      data: { recoverable: true },
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

const NO_DATA_PART =
  'No part with kind "data" was found, so the input was read as {}. ' +
  'Send the input as parts: [{"kind":"data","data":{...}}].';

function hasDataPart(message: Record<string, unknown>): boolean {
  return Array.isArray(message.parts) && message.parts.some((part) =>
    part !== null && typeof part === "object"
    && (part as Record<string, unknown>).kind === "data");
}
