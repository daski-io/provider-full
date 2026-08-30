import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { logError } from "../logger.js";
import { emitEvent } from "../events/emitter.js";

// JSON-RPC 2.0 standard error codes (RFC).
export const JSON_RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

// A2A v1.0 §5.4 reserved server error codes. Each has a specific
// canonical meaning — never reuse for unrelated errors.
export const A2A_ERR = {
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  PUSH_NOTIFICATION_NOT_SUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32004,
  CONTENT_TYPE_NOT_SUPPORTED: -32005,
  INVALID_AGENT_RESPONSE: -32006,
  AUTHENTICATED_EXTENDED_CARD_NOT_CONFIGURED: -32007,
} as const;

// Daski app-level codes outside the JSON-RPC implementation-reserved
// range (-32000..-32099) and the A2A-reserved subset, so they can't
// collide with future spec additions.
export const DASKI_ERR = {
  SERVICE_NOT_FOUND: -32100,
  SERVICE_OWNERSHIP_MISMATCH: -32101,
  CHAIN_MISMATCH: -32102,
  PAYMENT_VERIFICATION_FAILED: -32103,
  ASSET_NOT_OWNED: -32104,
  FULFILLMENT_FAILED: -32105,
  TASK_NOT_IN_INPUT_REQUIRED: -32106,
  CAPABILITY_REQUIRED: -32107,
  CAPABILITY_REJECTED: -32108,
  PAYMENT_INSUFFICIENT: -32111,
  PROVIDER_IDENTITY_UNAVAILABLE: -32112,
} as const;

export function jsonRpcSuccess(res: Response, id: string | number | null, result: unknown): void {
  res.json({
    jsonrpc: "2.0",
    id,
    result,
  });
}

export function jsonRpcError(
  res: Response,
  code: number,
  message: string,
  id?: string | number | null,
  data?: unknown
): void {
  // `data` is the JSON-RPC 2.0 error member (§5.1): machine-actionable
  // detail a client can act on without parsing the prose `message`.
  // Used by the envelope-auth gate to hand back the ready-to-sign
  // typed-data template. Omitted entirely when undefined so existing
  // `{ code, message }` errors keep their exact shape.
  const error: { code: number; message: string; data?: unknown } = {
    code,
    message,
  };
  if (data !== undefined) error.data = data;
  res.json({
    jsonrpc: "2.0",
    id: id ?? null,
    error,
  });
}

/// Log the full error server-side under a short correlation id and return a
/// JSON-RPC error carrying only `publicMessage` + that id — never the raw
/// exception string, which can leak supplier/RPC/DB/internal detail to an
/// untrusted buyer agent. Quote the `ref` id in support requests to find the
/// full detail in the logs.
export function jsonRpcInternalError(
  res: Response,
  code: number,
  publicMessage: string,
  err: unknown,
  id: string | number | null,
  logContext?: Record<string, unknown>,
  responseData?: Record<string, unknown>,
): void {
  const errorId = randomUUID().slice(0, 8);
  logError(`${publicMessage} [${errorId}]`, {
    errorId,
    ...logContext,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  // Mirror into the events table so internal errors are visible in the
  // admin Platform Log (not only in the process/Railway logs) and can be
  // correlated back via the same ref id. Fire-and-forget: emitEvent never
  // throws, and observability must not change the error response path.
  void emitEvent({
    transactionId:
      typeof logContext?.transactionId === "string"
        ? logContext.transactionId
        : undefined,
    source: "system",
    severity: "error",
    type: "system.rpc.internal_error",
    message: `${publicMessage} [${errorId}]`,
    payload: {
      errorId,
      ...logContext,
      error: err instanceof Error ? err.message : String(err),
    },
  });
  // `data` gives agents a machine-actionable stop condition — without it,
  // buyers can't distinguish a provider fault from a transient issue and
  // burn signed retries (observed: six identical -32603 retry cycles).
  jsonRpcError(res, code, `${publicMessage} (ref ${errorId})`, id, {
    errorId,
    recoverable: false,
    next_action:
      "Provider-side fault, not an input problem. Verify actual state with a " +
      "read-only skill; if the same skill+args fails twice with different refs, " +
      "stop retrying and report the refs to your principal.",
    ...responseData,
  });
}

export function getRequestId(req: Request): string | number | null {
  return req.body?.id ?? null;
}

export function validateJsonRpc(req: Request, res: Response): boolean {
  const body = req.body;

  if (!body || typeof body !== "object") {
    jsonRpcError(res, JSON_RPC.PARSE_ERROR, "Parse error");
    return false;
  }

  if (body.jsonrpc !== "2.0") {
    jsonRpcError(res, JSON_RPC.INVALID_REQUEST, "Invalid Request: missing jsonrpc 2.0", body.id ?? null);
    return false;
  }

  if (typeof body.method !== "string") {
    jsonRpcError(res, JSON_RPC.INVALID_REQUEST, "Invalid Request: missing method", body.id ?? null);
    return false;
  }

  if (body.id === undefined || body.id === null) {
    jsonRpcError(res, JSON_RPC.INVALID_REQUEST, "Invalid Request: missing id", null);
    return false;
  }

  return true;
}
