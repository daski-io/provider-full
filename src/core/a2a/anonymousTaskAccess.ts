import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { A2AArtifact, A2ATask } from "./responseBuilder.js";
import { config } from "../config.js";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const ANONYMOUS_TASK_ACCESS_ARTIFACT = "anonymous_task_access";
export const ANONYMOUS_TASK_ACCESS_HASH_KEY = "anonymous_task_access_hash";

export interface AnonymousTaskAccess {
  token: string;
  hash: string;
}

function digest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function issueAnonymousTaskAccess(taskId: string): AnonymousTaskAccess {
  return deriveAnonymousTaskAccess(taskId, config.PROVIDER_DATA_ENCRYPTION_KEY);
}

export function recoverAnonymousTaskAccess(
  taskId: string,
  metadata: Record<string, unknown>,
): AnonymousTaskAccess | null {
  const keys = [
    config.PROVIDER_DATA_ENCRYPTION_KEY,
    ...config.PROVIDER_DATA_ENCRYPTION_PREVIOUS_KEYS
      .split(",")
      .map((entry) => entry.trim().split("=", 2)[1])
      .filter((key): key is string => Boolean(key)),
  ];
  for (const key of keys) {
    const access = deriveAnonymousTaskAccess(taskId, key);
    if (verifyAnonymousTaskAccess(access.token, metadata)) return access;
  }
  return null;
}

function deriveAnonymousTaskAccess(
  taskId: string,
  key: string,
): AnonymousTaskAccess {
  const token = createHmac("sha256", Buffer.from(key.slice(2), "hex"))
    .update(`anonymous-task-access\0${taskId}`, "utf8")
    .digest("base64url");
  return { token, hash: digest(token) };
}

export function verifyAnonymousTaskAccess(
  token: unknown,
  metadata: Record<string, unknown>,
): boolean {
  const expected = metadata[ANONYMOUS_TASK_ACCESS_HASH_KEY];
  if (
    typeof token !== "string"
    || !TOKEN_PATTERN.test(token)
    || typeof expected !== "string"
    || !/^[0-9a-f]{64}$/.test(expected)
  ) {
    return false;
  }
  return timingSafeEqual(Buffer.from(digest(token), "hex"), Buffer.from(expected, "hex"));
}

export function appendAnonymousTaskAccess(
  response: A2ATask,
  token: string,
): A2ATask {
  const artifact: A2AArtifact = {
    artifactId: `${ANONYMOUS_TASK_ACCESS_ARTIFACT}-${response.id}`,
    name: ANONYMOUS_TASK_ACCESS_ARTIFACT,
    parts: [{
      kind: "data",
      data: {
        taskAccessToken: token,
        hint:
          "Pass this taskAccessToken as params.taskAccessToken on every " +
          "GetTask call for this anonymous task. It is shown only in " +
          "the submission response.",
      },
    }],
  };
  return { ...response, artifacts: [...(response.artifacts ?? []), artifact] };
}
