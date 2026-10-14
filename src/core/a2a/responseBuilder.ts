import type { TransactionRow } from "../db/queries/transactions.js";
import {
  consumeArtifactSecrets,
  readArtifactSecrets,
} from "../db/queries/artifactSecrets.js";
import { decryptString } from "../chain/encryption.js";
import {
  buildA2ATaskResponse,
  getTransactionArtifacts,
  getTransactionMessages,
  type ArtifactLike,
} from "./taskHistory.js";
import type { A2ATask } from "./responseTypes.js";

export type { A2AArtifact, A2ATask, Part } from "./responseTypes.js";
export type { ArtifactLike, MessageLike } from "./taskHistory.js";

// A2A v1.0 wire shape. Parts use `kind: "text"|"data"|"file"`; roles are
// ProtoJSON enum strings (ROLE_USER / ROLE_AGENT); task states are
// ProtoJSON enum strings (TASK_STATE_*). Artifacts carry `artifactId`.
//
// Messages and artifacts live in `events` (see taskHistory.ts). This module
// reveals protected artifact fields for the authorized responses that may
// carry them.

/// Reveal encrypted-at-rest secrets in artifacts before they're shipped
/// to the buyer: any artifact may have `artifact_secrets` rows keyed by
/// (transaction, artifact name, field path). The persisted event payload
/// holds a redacted placeholder at each path; the decrypted value is
/// grafted back here while the row is unexpired. Services can use this for
/// one-time credentials, recovery codes, or other bounded secret delivery.
async function revealArtifactSecrets(
  transactionId: string,
  artifacts: ArtifactLike[],
): Promise<ArtifactLike[]> {
  if (artifacts.length === 0) return artifacts;
  return Promise.all(
    artifacts.map((artifact) => revealGenericSecrets(transactionId, artifact)),
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

/** One protected field a frozen terminal projection may reveal. */
export interface ProtectedArtifactReference {
  artifactName: string;
  fieldPath: string;
}

/**
 * The authorized protected representation of a frozen terminal projection:
 * each data artifact gains the current, unexpired value of exactly the
 * protected fields frozen with it. The unrevealed projection stays the hash
 * input; this representation never is.
 */
export async function revealFrozenTaskProjection(
  transactionId: string,
  projection: A2ATask,
  references: readonly ProtectedArtifactReference[],
): Promise<A2ATask> {
  const revealed = structuredClone(projection);
  for (const artifact of revealed.artifacts ?? []) {
    const fields = new Set(references
      .filter((reference) => reference.artifactName === artifact.name)
      .map((reference) => reference.fieldPath));
    if (fields.size === 0) continue;
    const rows = (await readArtifactSecrets(transactionId, artifact.name))
      .filter((row) => fields.has(row.field_path));
    for (const part of artifact.parts) {
      if (part.kind !== "data" || !part.data) continue;
      for (const row of rows) {
        const value = decryptSecret(transactionId, artifact.name, row);
        if (value !== null) setAtPath(part.data, row.field_path, value);
      }
    }
  }
  return revealed;
}

function decryptSecret(
  transactionId: string,
  artifactName: string,
  row: { field_path: string; secret: string },
): string | null {
  try {
    return decryptString(row.secret, {
      purpose: "customer-artifact",
      table: "artifact_secrets",
      recordId: `${transactionId}:${artifactName}:${row.field_path}`,
      field: "secret",
    });
  } catch {
    return null;
  }
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
    const value = decryptSecret(transactionId, artifact.name, row);
    if (value !== null) setAtPath(data, row.field_path, value);
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
