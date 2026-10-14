import { describe, expect, it, beforeEach, vi } from "vitest";
import type { TransactionRow } from "../src/core/db/queries/transactions.js";

// fetchTaskResponse reconstructs artifacts from `events` and reveals
// show-once secrets from artifact_secrets at response-assembly time.
// This is the seam that keeps protected artifact values out of persisted rows
// while still delivering them in the first assembled buyer response.

const eventRows: Array<Record<string, unknown>> = [];
vi.mock("../src/core/events/emitter.js", () => ({
  listEvents: vi.fn(async (filter: { type?: string }) =>
    filter.type === "transaction.artifact.created"
      ? eventRows.filter((e) => e.type === "transaction.artifact.created")
      : eventRows,
  ),
  decryptCustomerEvent: (event: Record<string, unknown>) => ({
    message: String(event.message ?? ""),
    payload: event.payload as Record<string, unknown> | null,
  }),
  emitEvent: vi.fn(async () => {}),
}));

let secretRows: Array<{ field_path: string; secret: string }> = [];
const bumpReveal = vi.fn(async () => {
  const consumed = secretRows;
  secretRows = [];
  return consumed;
});
const readSecrets = vi.fn(async () => secretRows);
vi.mock("../src/core/db/queries/artifactSecrets.js", () => ({
  consumeArtifactSecrets: (...a: unknown[]) => bumpReveal(...(a as [])),
  readArtifactSecrets: (...a: unknown[]) => readSecrets(...(a as [])),
}));

vi.mock("../src/core/chain/encryption.js", () => ({
  decryptString: vi.fn((ct: string) => {
    if (ct === "ct-good") return "S3cretPassw0rd";
    throw new Error("bad ciphertext");
  }),
}));

import {
  fetchTaskResponse,
  revealFrozenTaskProjection,
} from "../src/core/a2a/responseBuilder.js";
import type { A2ATask } from "../src/core/a2a/responseBuilder.js";

const task = {
  id: "task-1",
  status: "completed",
} as unknown as TransactionRow;

function artifactEvent(name: string, data: Record<string, unknown>) {
  return {
    id: "evt-1",
    type: "transaction.artifact.created",
    message: `Artifact: ${name}`,
    payload: { name, mime_type: "application/json", data },
    created_at: new Date(),
  };
}

beforeEach(() => {
  eventRows.length = 0;
  secretRows = [];
  vi.clearAllMocks();
});

describe("show-once artifact secrets", () => {
  it("grafts the decrypted password over the redacted placeholder (nested dot-path)", async () => {
    eventRows.push(
      artifactEvent("secret_created", {
        address: "scout@agentmail.example",
        credentials: { username: "scout@agentmail.example", password: "<redacted>" },
      }),
    );
    secretRows = [{ field_path: "credentials.password", secret: "ct-good" }];

    const response = await fetchTaskResponse(task);
    const data = response.artifacts?.[0]?.parts[0]?.data as {
      credentials: { username: string; password: string };
    };
    expect(data.credentials.password).toBe("S3cretPassw0rd");
    expect(data.credentials.username).toBe("scout@agentmail.example");
    expect(bumpReveal).toHaveBeenCalledWith("task-1", "secret_created");
  });

  it("returns the redacted artifact untouched once the TTL is over (no live rows)", async () => {
    eventRows.push(
      artifactEvent("secret_created", {
        credentials: { password: "<redacted>" },
      }),
    );
    secretRows = [];

    const response = await fetchTaskResponse(task);
    const data = response.artifacts?.[0]?.parts[0]?.data as {
      credentials: { password: string };
    };
    expect(data.credentials.password).toBe("<redacted>");
  });

  it("keeps the secret redacted on later task reads", async () => {
    eventRows.push(
      artifactEvent("secret_created", {
        credentials: { password: "<redacted>" },
      }),
    );
    secretRows = [{ field_path: "credentials.password", secret: "ct-good" }];

    const first = await fetchTaskResponse(task);
    const second = await fetchTaskResponse(task);

    expect(first.artifacts?.[0]?.parts[0]?.data).toMatchObject({
      credentials: { password: "S3cretPassw0rd" },
    });
    expect(second.artifacts?.[0]?.parts[0]?.data).toMatchObject({
      credentials: { password: "<redacted>" },
    });
  });

  it("makes authorized standard-rail artifact retries deterministic over the frozen projection", async () => {
    secretRows = [{ field_path: "credentials.password", secret: "ct-good" }];
    const frozen: A2ATask = {
      id: "task-1",
      status: { state: "TASK_STATE_COMPLETED", message: { role: "ROLE_AGENT", parts: [] } },
      artifacts: [{
        artifactId: "evt-1", name: "secret_created",
        parts: [{ kind: "data", data: { credentials: { password: "<redacted>" } } }],
      }],
    };
    const references = [{ artifactName: "secret_created", fieldPath: "credentials.password" }];

    const first = await revealFrozenTaskProjection("task-1", frozen, references);
    const second = await revealFrozenTaskProjection("task-1", frozen, references);

    expect(first.artifacts?.[0]?.parts[0]?.data).toMatchObject({
      credentials: { password: "S3cretPassw0rd" },
    });
    expect(second).toEqual(first);
    // The frozen projection stays the unrevealed hash input.
    expect(frozen.artifacts?.[0]?.parts[0]?.data).toEqual({ credentials: { password: "<redacted>" } });
    expect(readSecrets).toHaveBeenCalledTimes(2);
    expect(bumpReveal).not.toHaveBeenCalled();
    // A protected field frozen without a reference is never revealed.
    const unreferenced = await revealFrozenTaskProjection("task-1", frozen, []);
    expect(unreferenced).toEqual(frozen);
  });

  it("leaves the placeholder in place when decryption fails", async () => {
    eventRows.push(
      artifactEvent("secret_created", { credentials: { password: "<redacted>" } }),
    );
    secretRows = [{ field_path: "credentials.password", secret: "ct-corrupt" }];

    const response = await fetchTaskResponse(task);
    const data = response.artifacts?.[0]?.parts[0]?.data as {
      credentials: { password: string };
    };
    expect(data.credentials.password).toBe("<redacted>");
  });

  it("does not consult artifact_secrets rows of other artifacts", async () => {
    eventRows.push(artifactEvent("item_availability", { itemId: "sample-item" }));
    secretRows = [];
    await fetchTaskResponse(task);
    expect(bumpReveal).toHaveBeenCalledWith("task-1", "item_availability");
  });
});
