// A2A v1.0 message-envelope normalizers.
//
// We keep the internal representation in lowercase / kebab form
// (`role: "user"|"agent"`, `state: "submitted"|"working"|...`,
// `kind: "text"|"data"|"file"` for parts) because that's what the rest
// of the codebase + DB schema use. Translation happens at the JSON-RPC
// boundary: dual-accept on inbound, emit v1.0 ProtoJSON shape on
// outbound (see responseBuilder.ts).

// ── Parts ────────────────────────────────────────────────────────────

export function extractTextFromParts(message: Record<string, unknown>): string {
  const parts = (message.parts as Array<Record<string, unknown>>) || [];
  return parts
    .filter((part) => part.kind === "text")
    .map((part) => part.text as string)
    .join(" ");
}

export function extractDataFromParts(
  message: Record<string, unknown>,
): Record<string, unknown> {
  const parts = (message.parts as Array<Record<string, unknown>>) || [];
  const dataPart = parts.find((part) => part.kind === "data");
  return (dataPart?.data as Record<string, unknown>) || {};
}

// ── Roles (ROLE_USER/ROLE_AGENT vs. user/agent) ─────────────────────

// A2A v1.0 ProtoJSON enum strings: ROLE_USER, ROLE_AGENT. Internal
// representation stays lowercase; we emit ProtoJSON form outbound.
// (Inbound role is never read — the provider infers it from transport.)
export type InternalRole = "user" | "agent";

export function roleToProtoJson(role: InternalRole): "ROLE_USER" | "ROLE_AGENT" {
  return role === "user" ? "ROLE_USER" : "ROLE_AGENT";
}

// ── Task states (TASK_STATE_* vs. kebab) ─────────────────────────────

// A2A v1.0 §5.5 ProtoJSON enums. Internal DB representation stays
// kebab-case (matches the state machine and existing rows); we map
// at the boundary only.
export type InternalState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "canceled"
  | "failed"
  | "rejected"
  | "auth-required"
  | "unknown";

const STATE_OUTBOUND: Record<InternalState, string> = {
  submitted: "TASK_STATE_SUBMITTED",
  working: "TASK_STATE_WORKING",
  "input-required": "TASK_STATE_INPUT_REQUIRED",
  completed: "TASK_STATE_COMPLETED",
  canceled: "TASK_STATE_CANCELED",
  failed: "TASK_STATE_FAILED",
  rejected: "TASK_STATE_REJECTED",
  "auth-required": "TASK_STATE_AUTH_REQUIRED",
  unknown: "TASK_STATE_UNKNOWN",
};

export function stateToProtoJson(state: string): string {
  // Best-effort — if it's a recognized internal state, map to ProtoJSON.
  // Otherwise emit TASK_STATE_UNKNOWN so the wire format always validates.
  const internal = STATE_OUTBOUND[state as InternalState];
  return internal ?? "TASK_STATE_UNKNOWN";
}

// ── Method names ─────────────────────────────────────────────────────

export type CanonicalMethod =
  | "SendMessage"
  | "GetTask"
  | "CancelTask"
  | "SubscribeToTask"
  | "ListTasks"
  | "PushNotificationConfigSet"
  | "PushNotificationConfigGet";

const METHODS = new Set<CanonicalMethod>([
  "SendMessage",
  "GetTask",
  "CancelTask",
  "SubscribeToTask",
  "ListTasks",
  "PushNotificationConfigSet",
  "PushNotificationConfigGet",
]);

// A2A 0.x named SendMessage `message/send`, and agents calling a public free
// skill by hand often reach for it first. It is accepted as that one alias
// only: the request shape the provider reads is unchanged, responses stay
// A2A v1.0, the open-request rate limit classifies it the same way
// (security/openA2aBoundary.ts), and the free-skill gate still refuses every
// paid or owner-only skill. No other 0.x method name is accepted; an unknown
// method's error names the v1.0 method to use.
const METHOD_ALIASES: Readonly<Record<string, CanonicalMethod>> = {
  "message/send": "SendMessage",
};

export function normalizeMethod(method: string): CanonicalMethod | undefined {
  if (METHODS.has(method as CanonicalMethod)) return method as CanonicalMethod;
  return Object.hasOwn(METHOD_ALIASES, method) ? METHOD_ALIASES[method] : undefined;
}
