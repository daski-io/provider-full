import { pool } from "../db/pool.js";
import { getServiceById } from "../db/queries/services.js";
import { logWarn } from "../logger.js";
import type { A2ATask, Part } from "../a2a/responseTypes.js";
import { getService } from "../serviceRegistry/registry.js";
import { canonicalHash, canonicalJson } from "./canonical.js";

/**
 * Order deliverables: what a buyer gets for a completed order. The artifact
 * itself is always one. When part of the result sits behind an owner action
 * on the asset the order created (an API key, a document), a service lists
 * those actions here and the provider adds one standard data part to the
 * artifact read's task:
 *
 *   {"kind": "data", "data": {"https://daski.io/deliverables/v1": {"items": [
 *     {"kind": "artifact"},
 *     {"kind": "owner-action", "actionId": "get-api-key", "assetType": "api-account",
 *      "providerAssetId": "<uuid>", "input": {"keyId": "key_0001"}, "label": "API key"}
 *   ]}}}
 *
 * The part holds pointers, never secrets: the secret comes from the owner
 * action, which the payer's wallet authorizes on its own. The gateway checks
 * every item against this provider's signed asset-action catalog (the action
 * exists, is not destructive and has the asset type the item names) and lists
 * the checked items to the buyer. A gateway released before the part fails
 * the whole artifact read on it, so the provider adds it only when the
 * lifecycle POST names `deliverables` in `daski-order-status-additions`.
 */
export const DELIVERABLES_PART_KEY = "https://daski.io/deliverables/v1";
export const ORDER_STATUS_ADDITIONS_HEADER = "daski-order-status-additions";
export const DELIVERABLES_ADDITION = "deliverables";

/** The gateway's limits; an item outside them is dropped there, so it is never sent. */
export const DELIVERABLE_ITEMS_MAX = 32;
export const DELIVERABLE_INPUT_MAX_BYTES = 2_048;
export const DELIVERABLE_INPUT_MAX_KEYS = 16;
export const DELIVERABLE_INPUT_VALUE_MAX_LENGTH = 256;
export const DELIVERABLE_LABEL_MAX_LENGTH = 64;
/** The provider's own bound on the part, far below any response budget: 31 short pointers fit easily. */
export const DELIVERABLES_PART_MAX_BYTES = 16_384;
/** A service lists deliverables from its own records; a slower answer leaves the artifact as it is. */
export const ORDER_DELIVERABLES_DEADLINE_MS = 3_000;

/** One owner action that delivers part of an order's result. */
export interface OwnerActionDeliverable {
  /** Optional: the part always writes `owner-action`. */
  kind?: "owner-action";
  /** The asset action's id, as the skill that declares `assetAction` names it. */
  actionId: string;
  /** The asset type the action acts on, exactly as the signed catalog names it. */
  assetType: string;
  /** The asset's id (a lowercase UUID), as the provider's asset query answers it. */
  providerAssetId: string;
  /** The action's input: a flat object of identifiers, never a secret. */
  input: Record<string, string | number | boolean | null>;
  /** A short name for the buyer, 1 to 64 characters. */
  label?: string | null;
}

/** The completed order a service lists deliverables for. */
export interface OrderDeliverablesTask {
  id: string;
  serviceId: string;
  skillId: string;
  /** The asset the order created or acted on, when core linked one. */
  assetId: string | null;
}

const ACTION_ID = /^[a-z0-9][a-z0-9-]{0,95}$/;
const PROVIDER_ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INPUT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
// Control, invisible formatting and line separator characters (the gateway's rule).
const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
// A lone surrogate is not text: canonical JSON refuses it, which would fail
// the whole signed answer.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// The gateway refuses an artifact read whose result carries active content
// anywhere, so one bad label would cost the buyer the whole artifact.
const ACTIVE_CONTENT = /(?:javascript|vbscript)\s*:|data\s*:\s*text\/html|<\s*\/?\s*(?:script|iframe|object|embed|form|meta|link|style)\b|\bon[a-z]+\s*=/iu;
const ITEM_KEYS = new Set(["kind", "actionId", "assetType", "providerAssetId", "input", "label"]);

/** Whether the lifecycle POST's `daski-order-status-additions` header names deliverables. */
export function gatewayAcceptsDeliverables(headerValue: string | undefined): boolean {
  return (headerValue ?? "").split(",").some((entry) => entry.trim() === DELIVERABLES_ADDITION);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function text(value: unknown, minLength: number, maxLength: number): boolean {
  return typeof value === "string" && value.length >= minLength && value.length <= maxLength &&
    !HIDDEN_CHARACTERS.test(value) && !LONE_SURROGATE.test(value) && !ACTIVE_CONTENT.test(value);
}

function canonicalBytes(value: unknown): number | null {
  try {
    return Buffer.byteLength(canonicalJson(value), "utf8");
  } catch {
    return null;
  }
}

/** Why the gateway would drop this item (or refuse the answer over it), or null when it is well formed. */
export function ownerActionDeliverableProblem(item: unknown): string | null {
  if (!plainObject(item)) return "not an object";
  if (Object.keys(item).some((key) => !ITEM_KEYS.has(key))) return "unknown key";
  if (item.kind !== undefined && item.kind !== "owner-action") return "kind";
  if (typeof item.actionId !== "string" || !ACTION_ID.test(item.actionId)) return "actionId";
  if (!text(item.assetType, 1, 128)) return "assetType";
  if (typeof item.providerAssetId !== "string" || !PROVIDER_ASSET_ID.test(item.providerAssetId)) {
    return "providerAssetId";
  }
  if (!plainObject(item.input)) return "input";
  const entries = Object.entries(item.input);
  if (entries.length > DELIVERABLE_INPUT_MAX_KEYS) return "input";
  for (const [key, value] of entries) {
    // `operation` names the gateway's own follow-ups, never a first use.
    if (!INPUT_KEY.test(key) || key === "operation") return "input";
    if (!(value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) ||
      text(value, 0, DELIVERABLE_INPUT_VALUE_MAX_LENGTH))) return "input";
  }
  // Canonical JSON also refuses keys such as `constructor`.
  const inputBytes = canonicalBytes(item.input);
  if (inputBytes === null || inputBytes > DELIVERABLE_INPUT_MAX_BYTES) return "input";
  if (item.label !== undefined && item.label !== null && !text(item.label, 1, DELIVERABLE_LABEL_MAX_LENGTH)) {
    return "label";
  }
  return null;
}

/**
 * A display text as a label: lone surrogates and hidden characters become
 * spaces, runs of space collapse, and a longer text is cut at a character
 * boundary with an ellipsis. Null when nothing usable is left.
 */
export function deliverableLabel(value: string | null | undefined): string | null {
  const cleaned = (value ?? "")
    .replace(new RegExp(LONE_SURROGATE.source, "g"), " ")
    .replace(new RegExp(HIDDEN_CHARACTERS.source, "gu"), " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned || ACTIVE_CONTENT.test(cleaned)) return null;
  if (cleaned.length <= DELIVERABLE_LABEL_MAX_LENGTH) return cleaned;
  let cut = "";
  for (const character of cleaned) {
    if (cut.length + character.length > DELIVERABLE_LABEL_MAX_LENGTH - 1) break;
    cut += character;
  }
  // A cut can end mid-word on what then reads as active content ("<object…").
  const label = `${cut.trimEnd()}…`;
  return ACTIVE_CONTENT.test(label) ? null : label;
}

/**
 * The standard deliverables data part for these owner actions, the artifact
 * first. Malformed and repeated items are left out (by index, without their
 * values); at most DELIVERABLE_ITEMS_MAX items and DELIVERABLES_PART_MAX_BYTES
 * are listed. Null when no owner action remains: the artifact alone needs no
 * part.
 */
export function deliverablesPart(items: readonly OwnerActionDeliverable[]): {
  part: Part | null;
  dropped: Array<{ index: number; reason: string }>;
} {
  const listed: Array<Record<string, unknown>> = [{ kind: "artifact" }];
  const dropped: Array<{ index: number; reason: string }> = [];
  const seen = new Set<string>();
  let bytes = canonicalBytes(listed) ?? 0;
  for (const [index, item] of items.entries()) {
    const problem = ownerActionDeliverableProblem(item);
    const entry = problem ? null : {
      kind: "owner-action", actionId: item.actionId, assetType: item.assetType,
      providerAssetId: item.providerAssetId, input: { ...item.input },
      ...(typeof item.label === "string" ? { label: item.label } : {}),
    };
    // Every value is checked above; this keeps any item canonical JSON would
    // refuse out of the signed answer.
    const size = entry ? canonicalBytes(entry) : null;
    if (problem || !entry || size === null) {
      dropped.push({ index, reason: problem ?? "not canonical" });
      continue;
    }
    const identity = canonicalHash({ actionId: entry.actionId, providerAssetId: entry.providerAssetId, input: entry.input });
    if (seen.has(identity)) dropped.push({ index, reason: "duplicate" });
    else if (listed.length >= DELIVERABLE_ITEMS_MAX) dropped.push({ index, reason: "too many items" });
    else if (bytes + size + 1 > DELIVERABLES_PART_MAX_BYTES) dropped.push({ index, reason: "part too large" });
    else {
      seen.add(identity);
      listed.push(entry);
      bytes += size + 1;
    }
  }
  if (listed.length === 1) return { part: null, dropped };
  return { part: { kind: "data", data: { [DELIVERABLES_PART_KEY]: { items: listed } } }, dropped };
}

/** The task with the part in its own `deliverables` artifact, after the task's own artifacts. */
export function withDeliverablesArtifact(task: A2ATask, part: Part): A2ATask {
  return { ...task, artifacts: [...(task.artifacts ?? []), { artifactId: "deliverables", name: "deliverables", parts: [part] }] };
}

class OrderDeliverablesDeadlineError extends Error {
  override name = "OrderDeliverablesDeadlineError";
}

/** The work's answer, or a refusal once ORDER_DELIVERABLES_DEADLINE_MS pass; the read never waits longer. */
async function withinDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new OrderDeliverablesDeadlineError()), ORDER_DELIVERABLES_DEADLINE_MS);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The artifact read's task with the deliverables its service lists for this
 * completed order (`fulfillment.orderDeliverables`), for a gateway that named
 * them. A service without the facet, one that lists nothing, or one that
 * fails leaves the task unchanged: a bad pointer never costs the buyer the
 * artifact.
 */
export async function addOrderDeliverables(
  task: { id: string; service_id: string; skill_id: string },
  result: A2ATask,
): Promise<A2ATask> {
  try {
    const service = await getServiceById(task.service_id);
    const list = service ? getService(service.slug)?.fulfillment.orderDeliverables : undefined;
    if (!list) return result;
    const items = await withinDeadline((async () => {
      const linked = await pool.query<{ asset_id: string | null }>(
        "SELECT asset_id FROM transactions WHERE id=$1", [task.id],
      );
      return list({
        id: task.id, serviceId: task.service_id, skillId: task.skill_id, assetId: linked.rows[0]?.asset_id ?? null,
      });
    })());
    const { part, dropped } = deliverablesPart(items);
    if (dropped.length > 0) {
      logWarn("order deliverables left out", { taskId: task.id, dropped: dropped.map((entry) => `${entry.index}:${entry.reason}`).join(",") });
    }
    return part ? withDeliverablesArtifact(result, part) : result;
  } catch (error) {
    logWarn("order deliverables unavailable", {
      taskId: task.id, errorClass: error instanceof Error ? error.name : "UnknownError",
    });
    return result;
  }
}
