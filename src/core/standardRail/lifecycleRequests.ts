import { lifecycleRejected } from "./lifecycleErrors.js";

/** The order actions the gateway forwards to a provider's lifecycle URL. */
export const LIFECYCLE_ACTIONS = ["status", "artifact", "support", "input", "cancel"] as const;
export type LifecycleAction = typeof LIFECYCLE_ACTIONS[number];

export const isLifecycleAction = (value: unknown): value is LifecycleAction =>
  (LIFECYCLE_ACTIONS as readonly unknown[]).includes(value);

/** Read capabilities authorize only these actions. */
export const READ_ACTIONS: ReadonlySet<LifecycleAction> = new Set(["status", "artifact"]);

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
/** The gateway's support requestId: a stable business identity the buyer keeps across retries. */
const SUPPORT_REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface SupportRequest {
  requestId: string;
  message: string;
}

/** Support text: 1 to 4,000 characters, not blank, no control characters but tab and line breaks. */
export function isSupportText(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 4_000 &&
    value.trim().length > 0 && !CONTROL.test(value);
}

export function isSupportRequest(request: Record<string, unknown>): request is Record<string, unknown> & SupportRequest {
  return Object.keys(request).sort().join() === "message,requestId" &&
    typeof request.requestId === "string" && SUPPORT_REQUEST_ID.test(request.requestId) &&
    isSupportText(request.message);
}

/**
 * Validate the action's request body exactly; the schemas are unchanged from
 * the admitted contract (support adds the gateway's requestId). A body that
 * does not fit is refused before anything is looked up.
 */
export function assertLifecycleRequest(action: LifecycleAction, request: Record<string, unknown>): void {
  const keys = Object.keys(request).sort();
  if (action === "status" || action === "artifact") {
    if (keys.length !== 0) throw lifecycleRejected(`${action} request must be empty`);
    return;
  }
  if (action === "support") {
    if (!isSupportRequest(request)) throw lifecycleRejected("Support requires a requestId and a non-empty message");
    return;
  }
  if (action === "input") {
    if (
      keys.join(",") !== "data,inputText" || typeof request.inputText !== "string" ||
      request.inputText.length > 4_000 || CONTROL.test(request.inputText) ||
      !request.data || typeof request.data !== "object" || Array.isArray(request.data) ||
      Object.keys(request.data).length === 0
    ) throw lifecycleRejected("Input request has an open or invalid shape");
    return;
  }
  if (keys.some((key) => key !== "reason") ||
      (request.reason !== undefined && (typeof request.reason !== "string" || request.reason.length > 1_000))) {
    throw lifecycleRejected("Cancel request has an open or invalid shape");
  }
}
