import { describe, expect, it, beforeEach, vi } from "vitest";

// The platform ambiguous-external-result contract (audit 1.0):
// runSupplierOperation journals an intent before the supplier call,
// reconciles dangling/ambiguous attempts from supplier truth, replays
// confirmed results idempotently, and refuses to adopt an intent whose
// request drifted.

const h = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  locks: new Map<string, Promise<void>>(),
  releaseModes: [] as boolean[],
  failConnect: false,
  failLock: false,
  failUnlock: false,
  failConfirm: false,
  failAmbiguousWrite: false,
  failFailedWrite: false,
  failRelease: false,
  unlockFalse: false,
}));

vi.mock("../src/core/db/pool.js", () => ({
  pool: (() => {
    const dataQuery = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("INSERT INTO supplier_operations")) {
        const key = `${params[0]}:${params[2]}`;
        if (h.rows.has(key)) return { rows: [], rowCount: 0 };
        const row = {
          id: `op-${h.rows.size + 1}`,
          service_id: params[0],
          transaction_id: params[1],
          op_key: params[2],
          kind: params[3],
          request_fingerprint: params[4],
          state: "intent",
          result: null,
          error_code: null,
          attempts: 1,
        };
        h.rows.set(key, row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes("SELECT * FROM supplier_operations")) {
        const key = `${params[0]}:${params[1]}`;
        const row = h.rows.get(key);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes("SET state = 'confirmed'")) {
        if (h.failConfirm) throw new Error("journal confirmation unavailable");
        let changed = 0;
        for (const row of h.rows.values()) {
          if (row.id === params[0] && ["intent", "ambiguous"].includes(row.state as string)) {
            row.state = "confirmed";
            row.result = params[1] ? JSON.parse(params[1] as string) : null;
            changed += 1;
          }
        }
        return { rows: [], rowCount: changed };
      }
      if (sql.includes("SET state = 'ambiguous'")) {
        if (h.failAmbiguousWrite) {
          throw new Error("ambiguous journal write unavailable");
        }
        let changed = 0;
        for (const row of h.rows.values()) {
          if (row.id === params[0] && ["intent", "ambiguous"].includes(row.state as string)) {
            row.state = "ambiguous";
            row.error_code = params[1];
            changed += 1;
          }
        }
        return { rows: [], rowCount: changed };
      }
      if (sql.includes("SET state = 'failed'")) {
        if (h.failFailedWrite) {
          throw new Error("failed journal write unavailable");
        }
        let changed = 0;
        for (const row of h.rows.values()) {
          if (row.id === params[0] && ["intent", "ambiguous"].includes(row.state as string)) {
            row.state = "failed";
            row.error_code = params[1];
            changed += 1;
          }
        }
        return { rows: [], rowCount: changed };
      }
      return { rows: [], rowCount: 0 };
    });
    return {
      query: dataQuery,
      connect: vi.fn(async () => {
        if (h.failConnect) throw new Error("pool unavailable");
        let unlockSession: (() => void) | null = null;
        const query = vi.fn(async (sql: string, params: unknown[] = []) => {
          if (sql.includes("pg_advisory_lock")) {
            if (h.failLock) throw new Error("lock unavailable");
            const key = `${params[0]}:${params[1]}`;
            const previous = h.locks.get(key) ?? Promise.resolve();
            let resolveCurrent!: () => void;
            const current = new Promise<void>((resolve) => {
              resolveCurrent = resolve;
            });
            const tail = previous.then(() => current);
            h.locks.set(key, tail);
            await previous;
            unlockSession = () => {
              resolveCurrent();
              if (h.locks.get(key) === tail) h.locks.delete(key);
              unlockSession = null;
            };
            return { rows: [{ locked: null }], rowCount: 1 };
          }
          if (sql.includes("pg_advisory_unlock")) {
            if (h.failUnlock) throw new Error("unlock unavailable");
            unlockSession?.();
            return { rows: [{ unlocked: !h.unlockFalse }], rowCount: 1 };
          }
          return dataQuery(sql, params);
        });
        return {
          query,
          release: vi.fn((destroy = false) => {
            h.releaseModes.push(destroy);
            if (destroy) unlockSession?.();
            if (h.failRelease) throw new Error("release unavailable");
          }),
          on: vi.fn(),
          removeListener: vi.fn(),
        };
      }),
    };
  })(),
}));

import {
  beginSupplierOperation,
  confirmSupplierOperation,
  failSupplierOperation,
  getSupplierOperation,
  markSupplierOperationAmbiguous,
  runSupplierOperation,
  SupplierOutcomeAmbiguousError,
  fingerprintRequest,
} from "../src/core/suppliers/operationJournal.js";
import { SupplierMutationAuthorizationError } from "../src/core/suppliers/errorClassifier.js";
import { SupplierCostCeilingError } from "../src/core/serviceRegistry/supplierCostCeiling.js";

function opArgs(overrides: Partial<Parameters<typeof runSupplierOperation>[0]> = {}) {
  return {
    serviceId: "svc-1",
    transactionId: "task-1",
    opKey: "renew:asset-1:2027",
    kind: "sample-supplier.renew",
    request: { itemId: "sample-item", quantity: 1 },
    execute: vi.fn(async () => ({ orderId: "o-1" })),
    reconcile: vi.fn(async () => null),
    ...overrides,
  };
}

describe("runSupplierOperation", () => {
  beforeEach(() => {
    h.rows.clear();
    h.locks.clear();
    h.releaseModes.length = 0;
    h.failConnect = false;
    h.failLock = false;
    h.failUnlock = false;
    h.failConfirm = false;
    h.failAmbiguousWrite = false;
    h.failFailedWrite = false;
    h.failRelease = false;
    h.unlockFalse = false;
  });

  it("executes once and replays the confirmed result without a second supplier call", async () => {
    const args = opArgs();
    const first = await runSupplierOperation(args);
    expect(first).toEqual({ orderId: "o-1" });

    const replayArgs = opArgs();
    const replay = await runSupplierOperation(replayArgs);
    expect(replay).toEqual({ orderId: "o-1" });
    expect(replayArgs.execute).not.toHaveBeenCalled();
    expect(replayArgs.reconcile).not.toHaveBeenCalled();
  });

  it("propagates a pre-mutation authorization rejection without calling the supplier", async () => {
    const authorizeMutation = vi.fn(async () => {
      throw new SupplierMutationAuthorizationError(
        "sample-supplier",
        "price exceeds settled quote",
      );
    });
    const args = opArgs({ authorizeMutation });

    await expect(runSupplierOperation(args)).rejects.toBeInstanceOf(
      SupplierMutationAuthorizationError,
    );
    expect(authorizeMutation).toHaveBeenCalledOnce();
    expect(args.execute).not.toHaveBeenCalled();

    const retry = opArgs({
      authorizeMutation: vi.fn(async () => {}),
      reconcile: vi.fn(async () => null),
    });
    await expect(runSupplierOperation(retry)).resolves.toEqual({
      orderId: "o-1",
    });
    expect(retry.reconcile).toHaveBeenCalledOnce();
    expect(retry.authorizeMutation).toHaveBeenCalledOnce();
    expect(retry.execute).toHaveBeenCalledOnce();
  });

  it("refuses a planned spend above the admitted ceiling before the supplier call", async () => {
    const ceiling = {
      kind: "supplier-cost-ceiling-v1" as const,
      supplier: "sample-supplier",
      currency: "USD",
      maximumAmount: "4.25",
    };
    const over = opArgs({ spend: { ceiling, planned: { supplier: "sample-supplier", currency: "USD", amount: "4.2501" } } });
    const refusal = await runSupplierOperation(over).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(SupplierCostCeilingError);
    expect(refusal).toBeInstanceOf(SupplierMutationAuthorizationError);
    expect(refusal).toMatchObject({ refusal: "ceiling_exceeded", supplier: "sample-supplier" });
    expect(over.execute).not.toHaveBeenCalled();
    expect([...h.rows.values()][0]).toMatchObject({ state: "intent", error_code: null });

    // A later attempt reconciles the dangling intent first and spends only
    // within the same admitted ceiling.
    const within = opArgs({ spend: { ceiling, planned: { supplier: "sample-supplier", currency: "USD", amount: "4.250" } } });
    await expect(runSupplierOperation(within)).resolves.toEqual({ orderId: "o-1" });
    expect(within.reconcile).toHaveBeenCalledOnce();
    expect(within.execute).toHaveBeenCalledOnce();
  });

  it("refuses spend when the task has no admitted ceiling", async () => {
    const args = opArgs({ spend: { ceiling: undefined, planned: { supplier: "sample-supplier", currency: "USD", amount: "0" } } });
    await expect(runSupplierOperation(args)).rejects.toMatchObject({ refusal: "ceiling_missing" });
    expect(args.execute).not.toHaveBeenCalled();
  });

  it("parks an ambiguous supplier outcome and NEVER blind-retries", async () => {
    const args = opArgs({
      execute: vi.fn(async () => {
        throw new Error("socket hang up");
      }),
    });
    await expect(runSupplierOperation(args)).rejects.toBeInstanceOf(
      SupplierOutcomeAmbiguousError,
    );
    expect([...h.rows.values()][0]?.error_code).toBe("execute.unexpected");

    // Retry: reconcile says the mutation actually landed → adopt, no re-post.
    const retry = opArgs({
      reconcile: vi.fn(async () => ({ orderId: "o-recovered" })),
    });
    const result = await runSupplierOperation(retry);
    expect(result).toEqual({ orderId: "o-recovered" });
    expect(retry.execute).not.toHaveBeenCalled();
  });

  it("re-executes only after reconciliation proves the mutation did NOT happen", async () => {
    const args = opArgs({
      execute: vi.fn(async () => {
        throw new Error("timeout");
      }),
    });
    await expect(runSupplierOperation(args)).rejects.toBeInstanceOf(
      SupplierOutcomeAmbiguousError,
    );

    const retry = opArgs({ reconcile: vi.fn(async () => null) });
    const result = await runSupplierOperation(retry);
    expect(result).toEqual({ orderId: "o-1" });
    expect(retry.reconcile).toHaveBeenCalledOnce();
    expect(retry.execute).toHaveBeenCalledOnce();
  });

  it("stays parked while reconciliation itself cannot prove the outcome", async () => {
    const args = opArgs({
      execute: vi.fn(async () => {
        throw new Error("timeout");
      }),
    });
    await expect(runSupplierOperation(args)).rejects.toBeInstanceOf(
      SupplierOutcomeAmbiguousError,
    );

    const retry = opArgs({
      reconcile: vi.fn(async () => {
        throw new SupplierOutcomeAmbiguousError("supplier list API down");
      }),
    });
    await expect(runSupplierOperation(retry)).rejects.toBeInstanceOf(
      SupplierOutcomeAmbiguousError,
    );
    expect(retry.execute).not.toHaveBeenCalled();
    expect([...h.rows.values()][0]?.error_code).toBe("reconcile.ambiguous");
  });

  it("refuses to adopt an intent whose request drifted", async () => {
    await runSupplierOperation(opArgs());
    const drifted = opArgs({ request: { itemId: "sample-item", quantity: 5 } });
    await expect(runSupplierOperation(drifted)).rejects.toThrow(
      "Supplier operation intent could not be established.",
    );
    expect(drifted.execute).not.toHaveBeenCalled();
  });

  it("serializes concurrent callers and exposes one confirmed mutation", async () => {
    let releaseExecute!: () => void;
    let reportStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    const executeGate = new Promise<void>((resolve) => {
      releaseExecute = resolve;
    });
    const first = opArgs({
      execute: vi.fn(async () => {
        reportStarted();
        await executeGate;
        return { orderId: "o-serialized" };
      }),
    });
    const firstRun = runSupplierOperation(first);
    await started;

    const second = opArgs();
    const secondRun = runSupplierOperation(second);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(second.execute).not.toHaveBeenCalled();

    releaseExecute();
    await expect(firstRun).resolves.toEqual({ orderId: "o-serialized" });
    await expect(secondRun).resolves.toEqual({ orderId: "o-serialized" });
    expect(second.execute).not.toHaveBeenCalled();
    expect(second.reconcile).not.toHaveBeenCalled();
  });

  it("keeps a confirmed result when advisory unlock fails and evicts the session", async () => {
    h.failUnlock = true;
    await expect(runSupplierOperation(opArgs())).resolves.toEqual({ orderId: "o-1" });
    expect(h.releaseModes.at(-1)).toBe(true);
  });

  it("evicts the journal session when advisory unlock returns false", async () => {
    h.unlockFalse = true;
    await expect(runSupplierOperation(opArgs())).resolves.toEqual({
      orderId: "o-1",
    });
    expect(h.releaseModes.at(-1)).toBe(true);
  });

  it("preserves supplier ambiguity when advisory unlock also fails", async () => {
    h.failUnlock = true;
    const args = opArgs({
      execute: vi.fn(async () => {
        throw new Error("supplier timeout");
      }),
    });
    await expect(runSupplierOperation(args)).rejects.toThrow(/outcome is unknown/);
    expect(h.releaseModes.at(-1)).toBe(true);
  });

  it("keeps a confirmed result when client release itself fails", async () => {
    h.failRelease = true;
    await expect(runSupplierOperation(opArgs())).resolves.toEqual({ orderId: "o-1" });
  });

  it("classifies journal session and lock acquisition failures as ambiguous", async () => {
    h.failConnect = true;
    await expect(runSupplierOperation(opArgs())).rejects.toBeInstanceOf(
      SupplierOutcomeAmbiguousError,
    );

    h.failConnect = false;
    h.failLock = true;
    await expect(runSupplierOperation(opArgs())).rejects.toBeInstanceOf(
      SupplierOutcomeAmbiguousError,
    );
    expect(h.releaseModes.at(-1)).toBe(true);
  });

  it("parks when a delivered result cannot be durably confirmed", async () => {
    h.failConfirm = true;
    await expect(runSupplierOperation(opArgs())).rejects.toBeInstanceOf(
      SupplierOutcomeAmbiguousError,
    );
    expect([...h.rows.values()][0]?.state).toBe("ambiguous");
    expect([...h.rows.values()][0]?.error_code).toBe(
      "confirmation.unexpected",
    );
  });

  it("never persists or rethrows raw supplier diagnostics", async () => {
    const secret =
      "buyer-secret@example.test /items/private-item supplier raw body";
    const thrown = await runSupplierOperation(
      opArgs({
        opKey: "private-operation-key",
        execute: vi.fn(async () => {
          throw Object.assign(new Error(secret), {
            category: "transport",
            status: 503,
          });
        }),
      }),
    ).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(SupplierOutcomeAmbiguousError);
    expect((thrown as Error).message).not.toContain(secret);
    expect((thrown as Error).message).not.toContain("private-operation-key");
    const stored = JSON.stringify([...h.rows.values()]);
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain("/items/private-item");
    expect([...h.rows.values()][0]?.error_code).toBe("execute.transport");
  });

  it("rejects null-to-non-null request identity drift", async () => {
    await runSupplierOperation(opArgs({ request: undefined }));
    await expect(runSupplierOperation(opArgs())).rejects.toThrow(
      "Supplier operation intent could not be established.",
    );
  });

  it("fingerprints deterministically", () => {
    expect(fingerprintRequest({ a: 1 })).toBe(fingerprintRequest({ a: 1 }));
    expect(fingerprintRequest({ a: 1 })).not.toBe(fingerprintRequest({ a: 2 }));
  });

  it("covers direct journal claims, reads, and identity rejection paths", async () => {
    const fresh = await beginSupplierOperation({
      serviceId: "svc-direct",
      transactionId: null,
      opKey: "direct-key",
      kind: "direct.kind",
      requestFingerprint: null,
    });
    expect(fresh.fresh).toBe(true);
    await expect(
      getSupplierOperation("svc-direct", "direct-key"),
    ).resolves.toMatchObject({ id: fresh.op.id });
    await expect(
      getSupplierOperation("svc-direct", "missing-key"),
    ).resolves.toBeNull();

    await expect(beginSupplierOperation({
      serviceId: "svc-direct",
      opKey: "direct-key",
      kind: "different.kind",
    })).rejects.toThrow("DIFFERENT kind");
    await expect(beginSupplierOperation({
      serviceId: "svc-direct",
      opKey: "direct-key",
      kind: "direct.kind",
      requestFingerprint: "drifted",
    })).rejects.toThrow("DIFFERENT request");

    const vanishedDb = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }),
    };
    await expect(beginSupplierOperation({
      serviceId: "svc",
      opKey: "vanished",
      kind: "direct.kind",
      db: vanishedDb as never,
    })).rejects.toThrow("vanished");
  });

  it("validates direct failure and ambiguity machine-code writes", async () => {
    const failedClaim = await beginSupplierOperation({
      serviceId: "svc-direct",
      opKey: "failed-key",
      kind: "direct.kind",
    });
    await failSupplierOperation(failedClaim.op.id, "operator.not_applied");
    expect(
      h.rows.get("svc-direct:failed-key")?.error_code,
    ).toBe("operator.not_applied");

    const ambiguousClaim = await beginSupplierOperation({
      serviceId: "svc-direct",
      opKey: "ambiguous-key",
      kind: "direct.kind",
    });
    await markSupplierOperationAmbiguous(
      ambiguousClaim.op.id,
      "execute.transport",
    );
    expect(
      h.rows.get("svc-direct:ambiguous-key")?.error_code,
    ).toBe("execute.transport");

    await expect(
      failSupplierOperation(
        ambiguousClaim.op.id,
        "raw supplier message" as never,
      ),
    ).rejects.toThrow("invalid supplier operation error code");
    await expect(
      markSupplierOperationAmbiguous(
        ambiguousClaim.op.id,
        "x".repeat(65) as never,
      ),
    ).rejects.toThrow("invalid supplier operation error code");
  });

  it("fails closed when direct journal state writes lose their claim", async () => {
    const noWrite = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    };
    await expect(
      confirmSupplierOperation("missing", null, noWrite as never),
    ).rejects.toThrow("not durably confirmed");
    await expect(
      failSupplierOperation(
        "missing",
        "operator.not_applied",
        noWrite as never,
      ),
    ).rejects.toThrow("not durably failed");
    await expect(
      markSupplierOperationAmbiguous(
        "missing",
        "execute.transport",
        noWrite as never,
      ),
    ).rejects.toThrow("not durably marked ambiguous");
  });

  it("derives bounded diagnostic codes from every supported HTTP status class", async () => {
    const expected = [
      [401, "execute.auth"],
      [408, "execute.transport"],
      [409, "execute.conflict"],
      [429, "execute.rate_limited"],
      [503, "execute.server"],
      [422, "execute.rejected"],
      [200, "execute.unexpected"],
    ] as const;
    for (const [status, code] of expected) {
      const args = opArgs({
        opKey: `status-${status}`,
        execute: vi.fn(async () => {
          throw Object.assign(new Error("raw body"), { status });
        }),
      });
      await expect(runSupplierOperation(args)).rejects.toBeInstanceOf(
        SupplierOutcomeAmbiguousError,
      );
      expect(h.rows.get(`svc-1:status-${status}`)?.error_code).toBe(code);
    }
  });

  it("derives diagnostic codes from trusted supplier categories", async () => {
    const args = opArgs({
      execute: vi.fn(async () => {
        throw Object.assign(new Error("raw validation body"), {
          category: "validation",
        });
      }),
    });
    await expect(runSupplierOperation(args)).rejects.toBeInstanceOf(
      SupplierOutcomeAmbiguousError,
    );
    expect([...h.rows.values()][0]?.error_code).toBe("execute.validation");
  });

  it("refuses to replay an operation already failed under the same key", async () => {
    const args = opArgs();
    const claimed = await beginSupplierOperation({
      serviceId: args.serviceId,
      transactionId: args.transactionId,
      opKey: args.opKey,
      kind: args.kind,
      requestFingerprint: fingerprintRequest(args.request),
    });
    await failSupplierOperation(claimed.op.id, "operator.not_applied");
    await expect(runSupplierOperation(args)).rejects.toThrow(
      "already failed definitively",
    );
  });

  it("parks safely when ambiguity itself cannot be journaled", async () => {
    h.failAmbiguousWrite = true;
    await expect(runSupplierOperation(opArgs({
      execute: vi.fn(async () => {
        throw new Error("raw failure");
      }),
    }))).rejects.toThrow("could not be journaled");
  });

  it("parks safely when reconciliation failure cannot be journaled", async () => {
    await expect(runSupplierOperation(opArgs({
      execute: vi.fn(async () => {
        throw new Error("timeout");
      }),
    }))).rejects.toBeInstanceOf(SupplierOutcomeAmbiguousError);
    h.failAmbiguousWrite = true;
    await expect(runSupplierOperation(opArgs({
      reconcile: vi.fn(async () => {
        throw new Error("raw read error");
      }),
    }))).rejects.toThrow("reconciliation could not be journaled");
  });

  it("parks when a reconciled result cannot be confirmed or re-journaled", async () => {
    await expect(runSupplierOperation(opArgs({
      execute: vi.fn(async () => {
        throw new Error("timeout");
      }),
    }))).rejects.toBeInstanceOf(SupplierOutcomeAmbiguousError);
    h.failConfirm = true;
    h.failAmbiguousWrite = true;
    await expect(runSupplierOperation(opArgs({
      reconcile: vi.fn(async () => ({ orderId: "reconciled" })),
    }))).rejects.toThrow("could not be durably confirmed");
  });

  it("parks when a fresh confirmation cannot be re-journaled", async () => {
    h.failConfirm = true;
    h.failAmbiguousWrite = true;
    await expect(runSupplierOperation(opArgs())).rejects.toThrow(
      "result could not be journaled",
    );
  });
});
