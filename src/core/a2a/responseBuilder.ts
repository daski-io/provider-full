import type { TransactionRow } from "../db/queries/transactions.js";
import { decryptCustomerEvent, listEvents } from "../events/emitter.js";
import {
  consumeArtifactSecrets,
  readArtifactSecrets,
} from "../db/queries/artifactSecrets.js";
import { decryptString } from "../chain/encryption.js";
import { roleToProtoJson, stateToProtoJson, type InternalRole } from "./parts.js";
import type {
  A2AArtifact,
  A2ATask,
  Part,
} from "./responseTypes.js";

export type { A2AArtifact, A2ATask, Part } from "./responseTypes.js";

// A2A v1.0 wire shape. Parts use `kind: "text"|"data"|"file"`; roles are
// ProtoJSON enum strings (ROLE_USER / ROLE_AGENT); task states are
// ProtoJSON enum strings (TASK_STATE_*). Artifacts carry `artifactId`.
//
// v4: A2A messages and artifacts no longer live in dedicated tables.
// They're stored as rows in `events` with type='transaction.message.*'
// and type='transaction.artifact.created'. This module synthesizes the
// wire response from those event rows.

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

/// Reconstruct the message thread for a transaction from `events`.
/// Returns chronological order. Internal-only helper; the A2A surface
/// flows through buildA2ATaskResponse.
async function getTransactionMessages(transactionId: string): Promise<MessageLike[]> {
  const events = await listEvents({ transactionId, limit: 1000 });
  const messages: MessageLike[] = [];
  for (const e of events) {
    if (e.type !== "transaction.message.user" && e.type !== "transaction.message.agent") continue;
    const protectedEvent = decryptCustomerEvent(e);
    const payload = protectedEvent.payload ?? {};
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

/// Reconstruct the artifact list for a transaction from `events`.
async function getTransactionArtifacts(transactionId: string): Promise<ArtifactLike[]> {
  const events = await listEvents({
    transactionId,
    type: "transaction.artifact.created",
    limit: 1000,
  });
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

/// Reveal encrypted-at-rest secrets in artifacts before they're shipped
/// to the buyer: any artifact may have `artifact_secrets` rows keyed by
/// (transaction, artifact name, field path). The persisted event payload
/// holds a redacted placeholder at each path; the decrypted value is
/// grafted back here while the row is unexpired. Services can use this for
/// one-time credentials, recovery codes, or other bounded secret delivery.
async function revealArtifactSecrets(
  transactionId: string,
  artifacts: ArtifactLike[],
  repeatable = false,
): Promise<ArtifactLike[]> {
  if (artifacts.length === 0) return artifacts;
  return Promise.all(
    artifacts.map((artifact) =>
      revealGenericSecrets(transactionId, artifact, repeatable),
    ),
  );
}

export async function revealStandardActionArtifacts(
  transactionId: string,
  artifacts: Array<{ name: string; data?: Record<string, unknown> | null }>,
): Promise<Array<{ name: string; data: Record<string, unknown> | null }>> {
  return Promise.all(artifacts.map(async (artifact) => {
    const revealed = await revealGenericSecrets(transactionId, {
      id: `${transactionId}:${artifact.name}`,
      name: artifact.name,
      mime_type: "application/json",
      url: null,
      data: artifact.data ?? null,
      access_action: null,
    }, true);
    return { name: artifact.name, data: revealed.data };
  }));
}

/// Graft any live `artifact_secrets` rows for this artifact back into its
/// data payload. Decryption failures leave the redacted placeholder in
/// place rather than failing the whole response.
async function revealGenericSecrets(
  transactionId: string,
  artifact: ArtifactLike,
  repeatable = false,
): Promise<ArtifactLike> {
  const rows = repeatable
    ? await readArtifactSecrets(transactionId, artifact.name)
    : await consumeArtifactSecrets(transactionId, artifact.name);
  if (rows.length === 0) return artifact;
  const data: Record<string, unknown> = structuredClone(artifact.data ?? {});
  for (const row of rows) {
    let value: string;
    try {
      value = decryptString(row.secret, {
        purpose: "customer-artifact",
        table: "artifact_secrets",
        recordId: `${transactionId}:${artifact.name}:${row.field_path}`,
        field: "secret",
      });
    } catch {
      continue;
    }
    setAtPath(data, row.field_path, value);
  }
  return { ...artifact, data };
}

/// Set a value at a dot-path inside a nested record, creating intermediate
/// objects as needed. Only plain-object intermediates are traversed — a
/// non-object in the way is replaced rather than mutated in place.
function setAtPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = path.split(".").filter((p) => p.length > 0);
  if (parts.length === 0) return;
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const next = cursor[key];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
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

function buildA2ATaskResponse(
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

/// Helper for handlers that just need to read the full v4 wire response.
/// Single entry point so each handler doesn't repeat the
/// `(messages, artifacts) = await Promise.all(...)` boilerplate.
async function loadTaskResponse(task: TransactionRow): Promise<{
  response: A2ATask;
  artifacts: ArtifactLike[];
}> {
  const [messages, artifacts] = await Promise.all([
    getTransactionMessages(task.id),
    getTransactionArtifacts(task.id).then((a) => revealArtifactSecrets(task.id, a)),
  ]);
  return {
    response: buildA2ATaskResponse(task, messages, artifacts),
    artifacts,
  };
}

export async function fetchStandardTaskResponse(
  task: Pick<TransactionRow, "id" | "status">,
  revealSecrets = false,
): Promise<A2ATask> {
  const [messages, storedArtifacts] = await Promise.all([
    getTransactionMessages(task.id),
    getTransactionArtifacts(task.id),
  ]);
  const artifacts = revealSecrets
    ? await revealArtifactSecrets(task.id, storedArtifacts, true)
    : storedArtifacts;
  return buildA2ATaskResponse(task, messages, artifacts);
}

function carriesGatedDocument(artifacts: ArtifactLike[]): boolean {
  return artifacts.some(
    (artifact) =>
      artifact.url !== null &&
      artifact.access_action === "document-download",
  );
}

/// Read the full task response. Completed tasks with a gated document URL
/// also carry a fresh one-shot document-download challenge, whether the
/// completion is returned directly from SendMessage or discovered by poll.
export async function fetchTaskResponse(task: TransactionRow): Promise<A2ATask> {
  const loaded = await loadTaskResponse(task);
  if (carriesGatedDocument(loaded.artifacts)) {
    loaded.response.artifacts = loaded.response.artifacts?.filter((artifact) =>
      artifact.name !== "document-download");
  }
  return loaded.response;
}

/// fetchTaskResponse for SendMessage handlers: the same wire response,
/// plus the bundled GetTask challenge whenever the task will be polled.
/// Input challenges are request-bound and can only be built after receiving
/// the complete correction body. Completed gated documents are handled by
/// fetchTaskResponse for both submission and poll paths. A buyer-lookup
/// failure only drops a bundled challenge, never the response itself.
export async function fetchSubmissionResponse(
  task: TransactionRow,
): Promise<A2ATask> {
  return fetchTaskResponse(task);
}
