import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { logError } from "../logger.js";
import { redactSensitiveText, redactSensitiveValue } from "../security/redaction.js";
import type { Queryable } from "../db/queryable.js";
import { decryptString, encryptString } from "../chain/encryption.js";

// Append-only activity log. Drives per-transaction timelines and the
// admin Platform Log feed. Folds in what previously lived in adapter_logs,
// task_messages, and task_artifacts. Every notable thing the provider
// does should emit one or more rows here — adapter calls, chain reads,
// LLM decisions, email actions, admin button clicks, push deliveries.
//
// Ordinary telemetry failures do not break the calling path. Security,
// financial, admin, and customer-response events are mandatory and throw
// on failure; state-changing callers should use recordMandatoryAudit in
// the same database transaction so an audit failure rolls the mutation back.

export type EventSource =
  | "adapter"
  | "email"
  | "llm"
  | "chain"
  | "admin"
  | "push"
  | "system";

export type EventSeverity = "debug" | "info" | "warn" | "error";

export interface EmitEventArgs {
  transactionId?: string;
  assetId?: string;
  serviceId?: string;
  source: EventSource;
  severity?: EventSeverity;
  /// Machine-readable event type, dotted lowercase, e.g.
  /// `adapter.namecom.register`, `email.received`, `chain.refund.confirmed`,
  /// `admin.refund.issued`, `transaction.message.user`,
  /// `transaction.artifact.created`. The convention is
  /// `<source>.<noun>.<verb_or_state>`.
  type: string;
  /// Human-readable one-liner shown in the platform log feed.
  message: string;
  /// Structured payload — request/response bodies, error messages, IDs,
  /// anything you'd want when debugging this row later. Stored as JSONB.
  payload?: unknown;
  /// Who triggered this event. For source=admin: the SIWE wallet address
  /// or `'token'` for bearer auth. For source=llm: the agent name
  /// (`email_agent`, `operator_agent`, `pre_execute`). For source=system:
  /// usually null.
  actor?: string;
  /** Mandatory audit writes fail the caller instead of becoming best-effort telemetry. */
  mandatory?: boolean;
}

const INSERT = `
  INSERT INTO events (id,
    transaction_id, asset_id, service_id,
    source, severity, type, message, payload, actor
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
`;

const CUSTOMER_EVENT_TYPES = new Set([
  "transaction.message.user",
  "transaction.message.agent",
  "transaction.artifact.created",
]);

function protectedEventContext(eventId: string) {
  return {
    purpose: "customer-event",
    table: "events",
    recordId: eventId,
    field: "payload",
    service: "core",
  } as const;
}

function eventValues(args: EmitEventArgs): unknown[] {
  const id = randomUUID();
  const protectedCustomerEvent = CUSTOMER_EVENT_TYPES.has(args.type);
  if (protectedCustomerEvent && !args.transactionId) {
    throw new Error(`${args.type} requires a transaction id`);
  }
  const storedMessage = protectedCustomerEvent
    ? args.type === "transaction.artifact.created"
      ? "Customer artifact available"
      : args.type === "transaction.message.user"
        ? "Buyer message received"
        : "Agent message available"
    : redactSensitiveText(args.message);
  const storedPayload = protectedCustomerEvent
    ? {
        protected: "daski:v1",
        envelope: encryptString(
          JSON.stringify({ message: args.message, payload: args.payload ?? null }),
          protectedEventContext(id),
        ),
      }
    : args.payload === undefined
      ? null
      : redactSensitiveValue(args.payload);
  return [
    id,
    args.transactionId ?? null,
    args.assetId ?? null,
    args.serviceId ?? null,
    args.source,
    args.severity ?? "info",
    args.type,
    storedMessage,
    storedPayload === null ? null : JSON.stringify(storedPayload),
    args.actor ?? null,
  ];
}

/** Write a required audit row inside the caller's business transaction. */
export async function recordMandatoryAudit(
  db: Queryable,
  args: EmitEventArgs,
): Promise<void> {
  await db.query(INSERT, eventValues({ ...args, mandatory: true }));
}

export async function emitEvent(args: EmitEventArgs): Promise<void> {
  try {
    await pool.query(INSERT, eventValues(args));
  } catch (err) {
    // Best-effort telemetry is logged and swallowed. Mandatory audit rows
    // fail closed when a transactional writer was not available.
    logError("emitEvent failed", {
      type: args.type,
      error: (err as Error).message,
    });
    const mandatory = args.mandatory === true
      || CUSTOMER_EVENT_TYPES.has(args.type)
      || args.source === "admin"
      || args.source === "chain"
      || /(?:refund|screening|compliance|block|credential|confirmation)/.test(args.type);
    if (mandatory) throw err;
  }
}

export interface EventRow {
  id: string;
  transaction_id: string | null;
  asset_id: string | null;
  service_id: string | null;
  source: EventSource;
  severity: EventSeverity;
  type: string;
  message: string;
  payload: Record<string, unknown> | null;
  actor: string | null;
  created_at: Date;
}

export function decryptCustomerEvent(row: EventRow): {
  message: string;
  payload: Record<string, unknown> | null;
} {
  if (!CUSTOMER_EVENT_TYPES.has(row.type)) {
    throw new Error(`event ${row.id} is not a customer response event`);
  }
  const wrapper = row.payload;
  if (
    wrapper?.protected !== "daski:v1" ||
    typeof wrapper.envelope !== "string"
  ) {
    throw new Error(`event ${row.id} has no protected customer payload`);
  }
  const decoded = JSON.parse(
    decryptString(wrapper.envelope, protectedEventContext(row.id)),
  ) as { message?: unknown; payload?: unknown };
  if (typeof decoded.message !== "string") {
    throw new Error(`event ${row.id} has an invalid protected message`);
  }
  return {
    message: decoded.message,
    payload:
      typeof decoded.payload === "object" && decoded.payload !== null
        ? (decoded.payload as Record<string, unknown>)
        : null,
  };
}

export interface ListEventsFilter {
  transactionId?: string;
  serviceId?: string;
  source?: EventSource;
  severity?: EventSeverity;
  type?: string;
  /// Free-text ILIKE search against `message`. Pass null/undefined to skip.
  search?: string;
  /// ISO timestamps. Inclusive lower bound, exclusive upper bound.
  since?: Date;
  until?: Date;
  /// Max rows to return. Default 200.
  limit?: number;
  /// Pagination offset.
  offset?: number;
}

/// Filter/paginate the events feed for the admin Platform Log page and
/// per-transaction timelines. All filters are optional; default ordering
/// is created_at DESC.
export async function listEvents(filter: ListEventsFilter = {}): Promise<EventRow[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  const push = (clause: string, value: unknown) => {
    args.push(value);
    where.push(clause.replace("?", `$${args.length}`));
  };

  if (filter.transactionId !== undefined) push("transaction_id = ?", filter.transactionId);
  if (filter.serviceId !== undefined) push("service_id = ?", filter.serviceId);
  if (filter.source !== undefined) push("source = ?", filter.source);
  if (filter.severity !== undefined) push("severity = ?", filter.severity);
  if (filter.type !== undefined) push("type = ?", filter.type);
  if (filter.search !== undefined && filter.search.length > 0) {
    push("message ILIKE ?", `%${filter.search}%`);
  }
  if (filter.since !== undefined) push("created_at >= ?", filter.since);
  if (filter.until !== undefined) push("created_at < ?", filter.until);

  const limit = filter.limit ?? 200;
  const offset = filter.offset ?? 0;
  args.push(limit, offset);
  const limitIdx = args.length - 1;
  const offsetIdx = args.length;

  const sql =
    `SELECT * FROM events` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY created_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`;

  const result = await pool.query(sql, args);
  return result.rows as EventRow[];
}

/// Count rows that listEvents would return for the same filter (minus
/// limit/offset). Used by the admin Platform Log page for the "showing
/// N of TOTAL" load-more affordance.
export async function countEvents(
  filter: Omit<ListEventsFilter, "limit" | "offset"> = {},
): Promise<number> {
  const where: string[] = [];
  const args: unknown[] = [];
  const push = (clause: string, value: unknown) => {
    args.push(value);
    where.push(clause.replace("?", `$${args.length}`));
  };
  if (filter.transactionId !== undefined) push("transaction_id = ?", filter.transactionId);
  if (filter.serviceId !== undefined) push("service_id = ?", filter.serviceId);
  if (filter.source !== undefined) push("source = ?", filter.source);
  if (filter.severity !== undefined) push("severity = ?", filter.severity);
  if (filter.type !== undefined) push("type = ?", filter.type);
  if (filter.search !== undefined && filter.search.length > 0) {
    push("message ILIKE ?", `%${filter.search}%`);
  }
  if (filter.since !== undefined) push("created_at >= ?", filter.since);
  if (filter.until !== undefined) push("created_at < ?", filter.until);

  const sql =
    `SELECT COUNT(*)::int AS n FROM events` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "");
  const result = await pool.query(sql, args);
  return (result.rows[0] as { n: number }).n;
}
