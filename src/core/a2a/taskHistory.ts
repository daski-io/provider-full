import { pool } from "../db/pool.js";
import type { Queryable } from "../db/queryable.js";
import type { TransactionRow } from "../db/queries/transactions.js";
import { decryptCustomerEvent, listEvents } from "../events/emitter.js";
import { roleToProtoJson, stateToProtoJson, type InternalRole } from "./parts.js";
import type { A2AArtifact, A2ATask, Part } from "./responseTypes.js";

// A2A messages and artifacts are stored as rows in `events` with
// type='transaction.message.*' and type='transaction.artifact.created'.
// This module reads them, through a transaction client when the caller is
// freezing a terminal result, and shapes the A2A v1.0 task projection.

/** The channel of a buyer's standard-order support message. */
export const ORDER_SUPPORT_CHANNEL = "standard-order-support";

export interface MessageLike {
  role: "user" | "agent" | "system";
  content: string;
  created_at: Date;
}

export interface ArtifactLike {
  id: string;
  name: string;
  mime_type: string;
  url: string | null;
  data: Record<string, unknown> | null;
  access_action: "document-download" | null;
}

/**
 * The message thread for a transaction, chronological. Buyer support
 * messages are a side channel of a standard order, never part of its task
 * projection; `includeSupport` reproduces the projection earlier releases
 * hashed, which did include them.
 */
export async function getTransactionMessages(
  transactionId: string,
  options: { db?: Queryable; includeSupport?: boolean } = {},
): Promise<MessageLike[]> {
  const events = await listEvents({ transactionId, limit: 1000 }, options.db ?? pool);
  const messages: MessageLike[] = [];
  for (const e of events) {
    if (e.type !== "transaction.message.user" && e.type !== "transaction.message.agent") continue;
    const protectedEvent = decryptCustomerEvent(e);
    const payload = protectedEvent.payload ?? {};
    if (!options.includeSupport && payload.channel === ORDER_SUPPORT_CHANNEL) continue;
    const content =
      typeof payload.content === "string"
        ? payload.content
        : protectedEvent.message;
    messages.push({
      role: e.type === "transaction.message.user" ? "user" : "agent",
      content,
      created_at: e.created_at,
    });
  }
  // listEvents returns DESC; reverse to chronological for message history.
  return messages.reverse();
}

/** The artifact list for a transaction, as persisted (secrets redacted). */
export async function getTransactionArtifacts(
  transactionId: string,
  db: Queryable = pool,
): Promise<ArtifactLike[]> {
  const events = await listEvents({
    transactionId,
    type: "transaction.artifact.created",
    limit: 1000,
  }, db);
  return events.reverse().map((e) => {
    const payload = decryptCustomerEvent(e).payload ?? {};
    return {
      id: e.id,
      name: typeof payload.name === "string" ? payload.name : "artifact",
      mime_type:
        typeof payload.mime_type === "string"
          ? payload.mime_type
          : "application/json",
      url: typeof payload.url === "string" ? payload.url : null,
      data:
        typeof payload.data === "object" && payload.data !== null
          ? (payload.data as Record<string, unknown>)
          : null,
      access_action:
        payload.access_action === "document-download"
          ? "document-download"
          : null,
    };
  });
}

function buildArtifactParts(artifact: ArtifactLike): Part[] {
  if (artifact.url) {
    return [{ kind: "file", file: { url: artifact.url, mimeType: artifact.mime_type } }];
  }
  if (artifact.data) {
    return [{ kind: "data", data: artifact.data }];
  }
  return [{ kind: "text", text: `Artifact: ${artifact.name}` }];
}

function artifactToA2A(artifact: ArtifactLike): A2AArtifact {
  return {
    artifactId: artifact.id,
    name: artifact.name,
    parts: buildArtifactParts(artifact),
  };
}

export function buildA2ATaskResponse(
  task: Pick<TransactionRow, "id" | "status">,
  messages: MessageLike[],
  artifacts: ArtifactLike[],
): A2ATask {
  const latestMessage = messages[messages.length - 1];
  const parts: Part[] = [];

  if (latestMessage?.content) {
    parts.push({ kind: "text", text: latestMessage.content });
  }

  // Provider-side messages are always agent-authored.
  const role: InternalRole = "agent";

  return {
    id: task.id,
    status: {
      state: stateToProtoJson(task.status),
      message: { role: roleToProtoJson(role), parts },
    },
    ...(artifacts.length > 0 && { artifacts: artifacts.map(artifactToA2A) }),
  };
}

/**
 * The canonical unrevealed task projection of a standard order: its latest
 * message and persisted artifacts with protected fields still redacted. A
 * terminal transition freezes exactly this projection, and its canonical
 * hash is the order's terminal resultHash.
 */
export async function buildStandardTaskProjection(
  task: Pick<TransactionRow, "id" | "status">,
  options: { db?: Queryable; includeSupport?: boolean } = {},
): Promise<A2ATask> {
  const [messages, artifacts] = await Promise.all([
    getTransactionMessages(task.id, options),
    getTransactionArtifacts(task.id, options.db ?? pool),
  ]);
  return buildA2ATaskResponse(task, messages, artifacts);
}
