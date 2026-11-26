// Self-correcting help for agents calling a public free skill by hand.
//
// The provider's own A2A endpoint serves only open free skills (pricing
// previews, availability checks). Agents that call it without a client
// library guess the request shape: an A2A 0.x method name, a skill id as the
// method, the skill id outside the extension metadata, input without a data
// part. Each such error carries, in error.data, one complete request for
// this endpoint, the free skill ids it serves and where their contracts are
// published.
//
// The help is read-only presentation: it lists what the free-skill gate in
// handlers/freeSkill/request.ts already admits (active, no payment, no asset
// ownership) and never changes what is admitted.

import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { getServiceBySlug } from "../db/queries/services.js";
import { getActiveSkillsByServiceId } from "../db/queries/skills.js";
import { errorClassExtra, logWarn } from "../logger.js";
import { isPaymentRequired } from "../pricing/index.js";
import { getService } from "../serviceRegistry/registry.js";
import type { SkillDefinition } from "../serviceRegistry/types.js";
import { ANONYMOUS_TASK_ACCESS_ARTIFACT } from "./anonymousTaskAccess.js";

export const DASKI_EXTENSION_URI = "https://daski.io/a2a/v1";
export const SUPPORTED_METHODS = ["SendMessage", "GetTask"] as const;
export const SKILL_ID_PATH =
  `params.message.metadata["${DASKI_EXTENSION_URI}"].skillId`;

const DATA_PATH = "body.params.message.parts[0].data";
const MAX_EXAMPLE_DEPTH = 6;
const MAX_EXAMPLE_ITEMS = 4;

/// A request an agent can send to this endpoint. `placeholders` lists the
/// paths in it (from this object's root) that hold a stand-in value, such
/// as "<message>", to replace first; it is absent when the request works as
/// sent.
export interface ExampleRequest {
  httpMethod: "POST";
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  placeholders?: string[];
}

export interface FreeSkillHelp {
  supportedMethods: readonly string[];
  freeSkillIds?: string[];
  example: ExampleRequest;
  agentCardUrl?: string;
  documentationUrl?: string;
  catalogUrl?: string;
  hint: string;
}

export interface OpenFreeSkill {
  skillId: string;
  definition: SkillDefinition;
  documentationUrl: string;
}

/// The free skills this endpoint admits, in card order, or null when the
/// service is unknown or inactive.
export async function openFreeSkills(
  serviceSlug: string,
): Promise<OpenFreeSkill[] | null> {
  const module = getService(serviceSlug);
  if (!module) return null;
  const service = await getServiceBySlug(serviceSlug);
  if (!service || !service.is_active) return null;
  const definitions = new Map(
    module.skills.map((definition) => [definition.id, definition]),
  );
  const rows = await getActiveSkillsByServiceId(service.id);
  return rows.flatMap((row) => {
    const definition = definitions.get(row.skill_id);
    if (
      !definition
      || isPaymentRequired(row.pricing)
      || row.requires_asset_ownership
    ) return [];
    return [{
      skillId: row.skill_id,
      definition,
      documentationUrl: row.documentation_url
        ?? `${config.BASE_URL}/skills/${serviceSlug}/${row.skill_id}.md`,
    }];
  });
}

/// An input built from a closed provider schema: every required field with
/// its first allowed value or its lowest allowed number, and a "<name>"
/// stand-in where no value can be derived (strings, supplier-defined
/// records). `placeholders` lists the dotted paths of the stand-ins.
export function exampleInput(
  schema: Record<string, unknown>,
): { input: unknown; placeholders: string[] } {
  const placeholders: string[] = [];
  const input = fill(schema, "", "value", 0, placeholders);
  return { input, placeholders };
}

function fill(
  schema: Record<string, unknown>,
  path: string,
  name: string,
  depth: number,
  placeholders: string[],
): unknown {
  if (depth > MAX_EXAMPLE_DEPTH) {
    placeholders.push(path);
    return null;
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (Object.hasOwn(schema, "const")) return schema.const;
  switch (schema.type) {
    case "object": {
      if (schema.additionalProperties === true) {
        // A bounded dynamic record: its keys are the skill's to define.
        placeholders.push(path);
        return {};
      }
      const properties = (schema.properties ?? {}) as Record<
        string,
        Record<string, unknown>
      >;
      const required = Array.isArray(schema.required) ? schema.required : [];
      return Object.fromEntries(
        required
          .filter((field): field is string =>
            typeof field === "string" && Object.hasOwn(properties, field))
          .map((field) => [
            field,
            fill(
              properties[field]!,
              path ? `${path}.${field}` : field,
              field,
              depth + 1,
              placeholders,
            ),
          ]),
      );
    }
    case "array": {
      const items = schema.items as Record<string, unknown> | undefined;
      const count = typeof schema.minItems === "number" && items
        ? Math.min(Math.max(schema.minItems, 0), MAX_EXAMPLE_ITEMS)
        : 0;
      return Array.from({ length: count }, (_, index) =>
        fill(items!, `${path}[${index}]`, name, depth + 1, placeholders));
    }
    case "integer":
    case "number":
      return lowestNumber(schema);
    case "boolean":
      return false;
    case "null":
      return null;
    default: {
      placeholders.push(path);
      let text = `<${name}>`;
      if (typeof schema.minLength === "number") {
        text = text.padEnd(schema.minLength, "_");
      }
      if (typeof schema.maxLength === "number") {
        text = text.slice(0, schema.maxLength);
      }
      return text;
    }
  }
}

function lowestNumber(schema: Record<string, unknown>): number {
  let value = 1;
  if (typeof schema.minimum === "number") {
    value = schema.minimum;
  } else if (typeof schema.exclusiveMinimum === "number") {
    value = schema.type === "integer"
      ? Math.floor(schema.exclusiveMinimum) + 1
      : schema.exclusiveMinimum + 1;
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    value = schema.maximum;
  }
  return value;
}

function endpoint(serviceSlug: string | null): Pick<ExampleRequest, "httpMethod" | "url" | "headers"> {
  return {
    httpMethod: "POST",
    url: `${config.BASE_URL}/a2a/${serviceSlug ?? "<service-slug>"}`,
    headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
  };
}

/// A complete SendMessage request for `skill` on this endpoint. The
/// messageId is fresh on every call: a reused messageId with the same input
/// replays the earlier answer, and with different input is refused.
export function exampleRequest(
  serviceSlug: string | null,
  skill: OpenFreeSkill | null,
): ExampleRequest {
  const built = skill
    ? exampleInput(skill.definition.inputSchema)
    : { input: {}, placeholders: [""] };
  const placeholders = [
    ...(serviceSlug ? [] : ["url"]),
    ...built.placeholders.map((path) =>
      path === "" ? DATA_PATH : `${DATA_PATH}${path.startsWith("[") ? "" : "."}${path}`),
    ...(skill ? [] : [`body.${SKILL_ID_PATH}`]),
  ];
  return {
    ...endpoint(serviceSlug),
    body: {
      jsonrpc: "2.0",
      id: "1",
      method: "SendMessage",
      params: {
        message: {
          role: "user",
          messageId: randomUUID(),
          parts: [{ kind: "data", data: built.input }],
          metadata: {
            [DASKI_EXTENSION_URI]: { skillId: skill?.skillId ?? "<free-skill-id>" },
          },
        },
      },
    },
    ...(placeholders.length > 0 ? { placeholders } : {}),
  };
}

/// A GetTask request. The task id and its access token come from the
/// SendMessage response that created the task.
export function getTaskRequest(serviceSlug: string | null): ExampleRequest {
  return {
    ...endpoint(serviceSlug),
    body: {
      jsonrpc: "2.0",
      id: "1",
      method: "GetTask",
      params: { id: "<taskId>", taskAccessToken: "<taskAccessToken>" },
    },
    placeholders: [
      ...(serviceSlug ? [] : ["url"]),
      "body.params.id",
      "body.params.taskAccessToken",
    ],
  };
}

/// The sentence an error message uses to point at its example.
export function exampleSentence(example: ExampleRequest): string {
  return example.placeholders
    ? "error.data.example shows the request; replace the values listed in error.data.example.placeholders."
    : "error.data.example is a working request.";
}

const HINT =
  "Replace any placeholders, keep the data part to the skill's published " +
  "input schema, and use a new messageId for each request. Paid skills are " +
  "bought through the Daski gateway, not this endpoint.";
const GET_TASK_HINT =
  "GetTask reads a task this endpoint created: take the task id and the " +
  `taskAccessToken from the ${ANONYMOUS_TASK_ACCESS_ARTIFACT} artifact of ` +
  "the SendMessage response. To run a skill, use SendMessage.";

/// error.data for a request that named a free skill but whose input was
/// refused: a request for that skill and where its contract is published.
/// `includeSchema` adds the published input schema inline.
export function skillInputHelp(
  serviceSlug: string,
  skill: OpenFreeSkill,
  includeSchema: boolean,
): Record<string, unknown> {
  return {
    skillId: skill.skillId,
    ...(includeSchema ? { inputSchema: skill.definition.inputSchema } : {}),
    example: exampleRequest(serviceSlug, skill),
    documentationUrl: skill.documentationUrl,
    agentCardUrl: `${config.BASE_URL}/agent-cards/${serviceSlug}.json`,
    hint: HINT,
  };
}

/// error.data for a request that did not reach a free skill.
/// `preferredSkillId` picks the example's skill when it is one of the free
/// skills (for example a skill id sent as the method name); otherwise the
/// first skill whose example works as sent is preferred. `getTask` asks for
/// a GetTask example instead.
export async function freeSkillHelp(
  serviceSlug: string,
  options: { preferredSkillId?: string; getTask?: boolean } = {},
): Promise<FreeSkillHelp> {
  let skills: OpenFreeSkill[] | null = null;
  try {
    skills = await openFreeSkills(serviceSlug);
  } catch (error) {
    // Help must never turn a caller error into a provider fault.
    logWarn("Free skill help is unavailable", {
      serviceSlug,
      ...errorClassExtra(error),
    });
  }
  const hint = options.getTask ? GET_TASK_HINT : HINT;
  if (!skills) {
    return {
      supportedMethods: SUPPORTED_METHODS,
      example: options.getTask ? getTaskRequest(null) : exampleRequest(null, null),
      // The ERC-8004 registration file links every active service's card.
      catalogUrl: `${config.BASE_URL}/.well-known/agent.json`,
      hint,
    };
  }
  const chosen = skills.find((skill) => skill.skillId === options.preferredSkillId)
    ?? skills.find((skill) =>
      exampleInput(skill.definition.inputSchema).placeholders.length === 0)
    ?? skills[0]
    ?? null;
  return {
    supportedMethods: SUPPORTED_METHODS,
    freeSkillIds: skills.map((skill) => skill.skillId),
    example: options.getTask
      ? getTaskRequest(serviceSlug)
      : exampleRequest(serviceSlug, chosen),
    agentCardUrl: `${config.BASE_URL}/agent-cards/${serviceSlug}.json`,
    ...(chosen && !options.getTask ? { documentationUrl: chosen.documentationUrl } : {}),
    hint,
  };
}
