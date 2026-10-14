import { afterEach, describe, expect, it, vi } from "vitest";
import type { Queryable } from "../src/core/db/queryable.js";

const original = {
  key: process.env.PROVIDER_DATA_ENCRYPTION_KEY,
  keyId: process.env.PROVIDER_DATA_ENCRYPTION_KEY_ID,
  previous: process.env.PROVIDER_DATA_ENCRYPTION_PREVIOUS_KEYS,
};
const oldKey = `0x${"3".repeat(64)}`;
const newKey = `0x${"4".repeat(64)}`;
const context = {
  purpose: "rotation-test",
  table: "rotation_records",
  recordId: "record-1",
  field: "secret",
} as const;

afterEach(() => {
  process.env.PROVIDER_DATA_ENCRYPTION_KEY = original.key;
  if (original.keyId === undefined) delete process.env.PROVIDER_DATA_ENCRYPTION_KEY_ID;
  else process.env.PROVIDER_DATA_ENCRYPTION_KEY_ID = original.keyId;
  if (original.previous === undefined) delete process.env.PROVIDER_DATA_ENCRYPTION_PREVIOUS_KEYS;
  else process.env.PROVIDER_DATA_ENCRYPTION_PREVIOUS_KEYS = original.previous;
  vi.resetModules();
});

async function encryptionWith(activeKey: string, keyId: string, previous = "") {
  process.env.PROVIDER_DATA_ENCRYPTION_KEY = activeKey;
  process.env.PROVIDER_DATA_ENCRYPTION_KEY_ID = keyId;
  process.env.PROVIDER_DATA_ENCRYPTION_PREVIOUS_KEYS = previous;
  vi.resetModules();
  return import("../src/core/chain/encryption.js");
}

function memoryDb(row: Record<string, unknown>): Queryable {
  return {
    async query(text: string, values: unknown[] = []) {
      if (text.startsWith("SELECT")) {
        const after = values[0];
        return { rows: after === null ? [row] : [], rowCount: after === null ? 1 : 0 } as never;
      }
      if (text.startsWith("UPDATE")) {
        row.secret = values[2];
        row.secret_hash = values[3];
        return { rows: [], rowCount: 1 } as never;
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

describe("protected-data rotation sink", () => {
  it("reads a previous key, writes the active key, rewrites lookup hashes, and supports rollback", async () => {
    const oldEncryption = await encryptionWith(oldKey, "old");
    const row: Record<string, unknown> = {
      id: "record-1",
      secret: oldEncryption.encryptString("PII_SENTINEL@example.com", context),
      secret_hash: oldEncryption.protectedLookupHash("PII_SENTINEL@example.com", "rotation-lookup"),
    };

    const activeEncryption = await encryptionWith(newKey, "new", `old=${oldKey}`);
    const { createDirectSink } = await import("../src/core/security/protectedDataSinkTypes.js");
    const sink = createDirectSink({
      name: "test",
      table: "rotation_records",
      cursorColumn: "id",
      fields: [{
        column: "secret",
        context: () => context,
        lookup: { column: "secret_hash", purpose: "rotation-lookup" },
      }],
    });
    const rotated = await sink.processBatch({
      db: memoryDb(row), after: null, limit: 100, fromKeyId: "old",
    });
    expect(rotated.rotated).toBe(1);
    expect(activeEncryption.inspectEncryptionEnvelope(String(row.secret)).keyId).toBe("new");
    expect(activeEncryption.decryptString(String(row.secret), context)).toBe("PII_SENTINEL@example.com");
    expect(String(row.secret_hash)).toMatch(/^new:/);

    const rollbackEncryption = await encryptionWith(oldKey, "old", `new=${newKey}`);
    const rollbackTypes = await import("../src/core/security/protectedDataSinkTypes.js");
    const rollbackSink = rollbackTypes.createDirectSink({
      name: "test",
      table: "rotation_records",
      cursorColumn: "id",
      fields: [{
        column: "secret",
        context: () => context,
        lookup: { column: "secret_hash", purpose: "rotation-lookup" },
      }],
    });
    const rolledBack = await rollbackSink.processBatch({
      db: memoryDb(row), after: null, limit: 100, fromKeyId: "new",
    });
    expect(rolledBack.rotated).toBe(1);
    expect(rollbackEncryption.inspectEncryptionEnvelope(String(row.secret)).keyId).toBe("old");
    expect(rollbackEncryption.decryptString(String(row.secret), context)).toBe("PII_SENTINEL@example.com");
  });

  it("rotates a frozen terminal projection under the context its writer used", async () => {
    const { terminalProjectionContext } = await import("../src/core/standardRail/terminalResult.js");
    const frozenContext = terminalProjectionContext("task-1");
    const oldEncryption = await encryptionWith(oldKey, "old");
    const row: Record<string, unknown> = {
      transaction_id: "task-1",
      projection_encrypted: oldEncryption.encryptString('{"id":"task-1"}', frozenContext),
    };
    const activeEncryption = await encryptionWith(newKey, "new", `old=${oldKey}`);
    const { allProtectedDataSinks } = await import("../src/core/security/protectedDataSinks.js");
    const sink = allProtectedDataSinks().find((candidate) => candidate.name === "standard-terminal-results");
    expect(sink?.registeredColumns).toEqual(["standard_terminal_results.projection_encrypted"]);
    const db: Queryable = {
      async query(text: string, values: unknown[] = []) {
        if (text.startsWith("SELECT")) {
          return { rows: values[0] === null ? [row] : [], rowCount: values[0] === null ? 1 : 0 } as never;
        }
        if (text.startsWith("UPDATE")) {
          row.projection_encrypted = values[2];
          return { rows: [], rowCount: 1 } as never;
        }
        throw new Error(`unexpected query: ${text}`);
      },
    };
    expect((await sink!.processBatch({ db, after: null, limit: 100, fromKeyId: "old" })).rotated).toBe(1);
    expect(activeEncryption.decryptString(String(row.projection_encrypted), frozenContext)).toBe('{"id":"task-1"}');
    expect(activeEncryption.inspectEncryptionEnvelope(String(row.projection_encrypted)).keyId).toBe("new");
  });

  it("rotates archived fulfillment-hold evidence with its original escalation context", async () => {
    const archivedContext = {
      purpose: "escalation-review-binding",
      table: "escalations",
      recordId: "escalation-1",
      field: "review-binding",
      service: "service-1",
      recordVersion: 1,
    } as const;
    const oldEncryption = await encryptionWith(oldKey, "old");
    const row: Record<string, unknown> = {
      id: "attempt-1",
      escalation_id: "escalation-1",
      snapshot_service_id: "service-1",
      reviewer_edits_encrypted: null,
      review_binding_encrypted: oldEncryption.encryptString("approval", archivedContext),
      adapter_result_encrypted: null,
    };

    const activeEncryption = await encryptionWith(newKey, "new", `old=${oldKey}`);
    const { allProtectedDataSinks } = await import("../src/core/security/protectedDataSinks.js");
    const sink = allProtectedDataSinks().find((candidate) =>
      candidate.name === "fulfillment-hold-attempts");
    expect(sink?.registeredColumns).toEqual(expect.arrayContaining([
      "fulfillment_hold_attempts.reviewer_edits_encrypted",
      "fulfillment_hold_attempts.review_binding_encrypted",
      "fulfillment_hold_attempts.adapter_result_encrypted",
      "fulfillment_hold_attempts.resolution_error",
    ]));

    const db: Queryable = {
      async query(text: string, values: unknown[] = []) {
        if (text.startsWith("SELECT")) return { rows: [row], rowCount: 1 } as never;
        if (text.startsWith("UPDATE")) {
          const column = /SET ([a-z_]+) =/.exec(text)?.[1];
          if (!column) throw new Error(`unexpected rotation update: ${text}`);
          row[column] = values[2];
          return { rows: [], rowCount: 1 } as never;
        }
        throw new Error(`unexpected query: ${text}`);
      },
    };
    const rotated = await sink!.processBatch({ db, after: null, limit: 100, fromKeyId: "old" });

    expect(rotated.rotated).toBe(1);
    expect(activeEncryption.decryptString(
      String(row.review_binding_encrypted),
      archivedContext,
    )).toBe("approval");
    expect(activeEncryption.inspectEncryptionEnvelope(
      String(row.review_binding_encrypted),
    ).keyId).toBe("new");
  });
});
