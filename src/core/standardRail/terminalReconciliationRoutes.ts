import { Router, type Request } from "express";
import { logError, logWarn } from "../logger.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { listUnresolvedLegacyTerminalResults, recordLegacyTerminalEvidence } from "./terminalLegacy.js";

const ACTOR = /^[A-Za-z0-9@._-]{1,128}$/;
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;

function evidenceRequest(req: Request): {
  actor: string;
  kind: "attestation" | "unobserved";
  attestation?: unknown;
  reference: string;
} {
  const actor = req.get("x-admin-actor");
  const body = req.body as Record<string, unknown> | null;
  if (!actor || !ACTOR.test(actor) || !body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("invalid evidence authority");
  }
  const keys = Object.keys(body).sort().join();
  const reference = body.reference;
  if (typeof reference !== "string" || reference.length < 1 || reference.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(reference)) throw new Error("invalid evidence reference");
  if (body.kind === "attestation" && keys === "attestation,kind,reference") {
    return { actor, kind: "attestation", attestation: body.attestation, reference };
  }
  if (body.kind === "unobserved" && keys === "kind,reference") return { actor, kind: "unobserved", reference };
  throw new Error("invalid evidence shape");
}

/**
 * Bearer-admin reconciliation of terminal standard orders that predate frozen
 * results. GET lists every row the provider refuses to answer, read-only,
 * with a stable diagnostic and no customer content. POST records one piece
 * of evidence (a provider terminal attestation the gateway retained, or the
 * gateway handoff reference stating no identity was admitted) and reconciles
 * the row from it; nothing is ever guessed or relabelled.
 */
export function createTerminalReconciliationRouter(config: ProviderStandardRailConfig): Router {
  const router = Router();
  router.get("/unresolved", async (req, res) => {
    try {
      const limit = Number(req.query.limit ?? 100);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("invalid limit");
      const rows = await listUnresolvedLegacyTerminalResults(limit);
      res.json({ unresolved: rows, count: rows.length });
    } catch (error) {
      logError("Legacy terminal reconciliation listing failed", {
        errorClass: error instanceof Error ? error.name : "UnknownError",
      });
      res.status(503).json({ error: "terminal_reconciliation_unavailable" });
    }
  });
  router.post("/:transactionId/evidence", async (req, res) => {
    const transactionId = String(req.params.transactionId);
    try {
      if (!TASK_ID.test(transactionId)) throw new Error("invalid task id");
      const request = evidenceRequest(req);
      const outcome = await recordLegacyTerminalEvidence(config, { transactionId, ...request });
      logWarn("Legacy terminal evidence recorded", { actor: request.actor, kind: request.kind, outcome: outcome.status });
      res.json({ ok: true, outcome });
    } catch (error) {
      logWarn("Legacy terminal evidence refused", { errorClass: error instanceof Error ? error.name : "UnknownError" });
      res.status(409).json({ error: "terminal_evidence_rejected" });
    }
  });
  return router;
}
