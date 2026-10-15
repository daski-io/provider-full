import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceRow } from "../src/core/db/queries/services.js";
import type { SkillRow } from "../src/core/db/queries/skills.js";
import type { TransactionRow } from "../src/core/db/queries/transactions.js";

const state = vi.hoisted(() => ({
  taskStatus: "submitted",
  builtInStart: false,
  canonicalRequestHash: null as Buffer | null,
  escalation: null as Record<string, unknown> | null,
  failEscalationInsert: false,
  failAuditType: null as string | null,
  audits: [] as string[],
}));

const db = vi.hoisted(() => ({
  async query(text: string, values: unknown[] = []) {
    if (text.includes("FROM transactions WHERE id = $1 FOR UPDATE")) {
      return {
        rows: [{
          service_id: "11111111-1111-4111-8111-111111111111",
          skill_id: "create-record",
          customer_id: "33333333-3333-4333-8333-333333333333",
          status: state.taskStatus,
          canonical_request_hash: state.canonicalRequestHash,
        }],
        rowCount: 1,
      };
    }
    if (text.includes("SET status = 'working'")) {
      state.builtInStart = true;
      if (state.taskStatus !== "submitted") return { rows: [], rowCount: 0 };
      state.taskStatus = "working";
      return { rows: [{ id: values[0] }], rowCount: 1 };
    }
    if (text.includes("INSERT INTO escalations")) {
      if (state.failEscalationInsert) throw new Error("simulated escalation insert failure");
      state.escalation = {
        id: values[0],
        transaction_id: values[1],
        question: values[2],
        source: "pre_execute",
        status: "pending",
        response: null,
        edited_data: null,
        assignee: null,
        agent_recommendation: null,
        inbound_id: null,
        thread_id: null,
        created_at: new Date(),
        resolved_at: null,
        resolved_by: null,
        execution_snapshot_encrypted: values[3],
        execution_snapshot_hash: values[4],
        request_hash: values[5],
        snapshot_version: 1,
        snapshot_service_id: values[6],
        snapshot_skill_id: values[7],
        snapshot_asset_id: values[8],
      };
      return { rows: [{ ...state.escalation }], rowCount: 1 };
    }
    throw new Error(`unexpected SQL in escalation creation test: ${text}`);
  },
}));

vi.mock("../src/core/db/pool.js", () => ({ pool: {} }));
vi.mock("../src/core/db/queryable.js", () => ({
  inTransaction: async (_pool: unknown, work: (client: typeof db) => Promise<unknown>) => {
    const before = {
      taskStatus: state.taskStatus,
      escalation: state.escalation,
      audits: [...state.audits],
    };
    try {
      return await work(db);
    } catch (error) {
      state.taskStatus = before.taskStatus;
      state.escalation = before.escalation;
      state.audits = before.audits;
      throw error;
    }
  },
}));
vi.mock("../src/core/events/emitter.js", () => ({
  recordMandatoryAudit: vi.fn(async (_db, event: { type: string }) => {
    if (state.failAuditType === event.type) throw new Error("simulated mandatory audit failure");
    state.audits.push(event.type);
  }),
}));

import {
  createPreExecuteEscalation,
  EscalationStartRefusedError,
} from "../src/core/engine/escalationResolutionStore.js";
import { computeRequestHash } from "../src/core/auth/requestHash.js";

const service = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "sample-service",
  version: "1",
  adapter_name: "sample-service",
  config_revision: "4",
} as ServiceRow;

const skill = {
  id: "22222222-2222-4222-8222-222222222222",
  service_id: service.id,
  skill_id: "create-record",
  required_fields: ["customerName"],
  optional_fields: [],
  updated_at: new Date("2026-07-10T00:00:00.000Z"),
} as unknown as SkillRow;

const transaction = {
  id: "task-atomic-review",
  customer_id: "33333333-3333-4333-8333-333333333333",
  service_id: service.id,
  skill_id: skill.skill_id,
  status: "submitted",
} as TransactionRow;

const requestData = { customerName: "Protected Customer", secretToken: "private-token-123" };

beforeEach(() => {
  state.taskStatus = "submitted";
  state.builtInStart = false;
  state.canonicalRequestHash = Buffer.from(computeRequestHash(requestData).slice(2), "hex");
  state.escalation = null;
  state.failEscalationInsert = false;
  state.failAuditType = null;
  state.audits = [];
});

describe("atomic pre-execute escalation creation", () => {
  it("commits the working task, protected snapshot, and durable events together", async () => {
    const row = await createPreExecuteEscalation({
      transaction,
      service,
      skill,
      asset: null,
      requestData,
      question: "Review protected request",
    });

    expect(state.taskStatus).toBe("working");
    expect(state.escalation?.status).toBe("pending");
    expect(String(state.escalation?.execution_snapshot_encrypted)).toMatch(/^daski:v1:/);
    expect(String(state.escalation?.execution_snapshot_encrypted)).not.toContain("private-token-123");
    expect(row.question).toBe("Review protected request");
    expect(state.audits).toEqual([
      "escalation.snapshot.created",
      "transaction.message.agent",
      "llm.preexecute.escalate",
    ]);
  });

  it("rolls the task transition back if snapshot persistence fails", async () => {
    state.failEscalationInsert = true;
    await expect(createPreExecuteEscalation({
      transaction,
      service,
      skill,
      asset: null,
      requestData,
      question: "review",
    })).rejects.toThrow(/insert failure/);
    expect(state.taskStatus).toBe("submitted");
    expect(state.escalation).toBeNull();
    expect(state.audits).toEqual([]);
  });

  it("rolls all review state back if a mandatory event cannot be persisted", async () => {
    state.failAuditType = "transaction.message.agent";
    await expect(createPreExecuteEscalation({
      transaction,
      service,
      skill,
      asset: null,
      requestData,
      question: "review",
    })).rejects.toThrow(/mandatory audit failure/);
    expect(state.taskStatus).toBe("submitted");
    expect(state.escalation).toBeNull();
    expect(state.audits).toEqual([]);
  });

  it("starts the task only through the caller's start step when one is given", async () => {
    const claimStart = vi.fn(async (client: unknown) => {
      expect(client).toBe(db);
      state.taskStatus = "working";
      return true;
    });
    await createPreExecuteEscalation({
      transaction, service, skill, asset: null, requestData, question: "review", claimStart,
    });
    expect(claimStart).toHaveBeenCalledOnce();
    expect(state.builtInStart).toBe(false);
    expect(state.escalation?.status).toBe("pending");
  });

  it("writes nothing when the caller's start step refuses, also for a task another executor started", async () => {
    for (const status of ["submitted", "working"]) {
      state.taskStatus = status;
      await expect(createPreExecuteEscalation({
        transaction, service, skill, asset: null, requestData, question: "review", claimStart: async () => false,
      })).rejects.toBeInstanceOf(EscalationStartRefusedError);
      expect(state.taskStatus).toBe(status);
      expect(state.builtInStart).toBe(false);
      expect(state.escalation).toBeNull();
      expect(state.audits).toEqual([]);
    }
  });

  it("loses safely when another transition reaches a terminal state first", async () => {
    state.taskStatus = "failed";
    await expect(createPreExecuteEscalation({
      transaction,
      service,
      skill,
      asset: null,
      requestData,
      question: "review",
    })).rejects.toThrow(/cannot escalate transaction in failed/);
    expect(state.escalation).toBeNull();
    expect(state.audits).toEqual([]);
  });
});
