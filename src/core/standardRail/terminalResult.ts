import type { Hex } from "viem";
import { fetchStandardTaskResponse } from "../a2a/responseBuilder.js";
import { canonicalHash } from "./canonical.js";

export type TerminalState = "completed" | "failed" | "canceled";

export const TERMINAL_STATES: ReadonlySet<string> = new Set(["completed", "failed", "canceled"]);

/**
 * The terminal identity a dispatch attestation signs: the canonical hash of
 * the unrevealed task projection and the completion time.
 *
 * Seam for the frozen terminal-result store. Today the projection is rebuilt
 * from task events, so a later message or event retention can change the
 * hash; the next protocol workstream freezes it atomically with the terminal
 * transition and replaces only this function's body with a lookup of that
 * frozen record (with legacy-row reconciliation).
 */
export async function terminalResultIdentity(task: {
  id: string;
  status: TerminalState;
  completedAt: Date;
}): Promise<{ resultHash: Hex; completedAt: number }> {
  const projection = await fetchStandardTaskResponse({ id: task.id, status: task.status });
  return {
    resultHash: canonicalHash(projection),
    completedAt: Math.floor(task.completedAt.getTime() / 1_000),
  };
}
