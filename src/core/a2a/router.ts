import { Router } from "express";
import {
  A2A_ERR,
  DASKI_ERR,
  JSON_RPC,
  getRequestId,
  jsonRpcError,
  jsonRpcInternalError,
  validateJsonRpc,
} from "./jsonrpc.js";
import { normalizeMethod } from "./parts.js";
import { handleFreeSkill } from "./handlers/freeSkill.js";
import { handleTasksGet } from "./handlers/tasksGet.js";
import { logInfo } from "../logger.js";
import { getProviderIdentityAuthorization } from "../chain/providerIdentity.js";

const EXTENSION_URI = "https://daski.io/a2a/v1";

export const a2aRouter = Router();

a2aRouter.post("/:serviceSlug", async (req, res) => {
  const startedAt = Date.now();
  const serviceSlug = req.params.serviceSlug;
  const requestId = getRequestId(req);
  try {
    if (!validateJsonRpc(req, res)) return;
    const { method, params } = req.body;
    if (!getProviderIdentityAuthorization().ok) {
      return jsonRpcError(
        res,
        DASKI_ERR.PROVIDER_IDENTITY_UNAVAILABLE,
        "Provider identity is temporarily unavailable",
        requestId,
        { recoverable: true },
      );
    }
    const canonical = normalizeMethod(method);
    if (canonical === "GetTask") {
      return await handleTasksGet(params, serviceSlug, res, requestId);
    }
    if (canonical === "SubscribeToTask" || canonical === "ListTasks") {
      return jsonRpcError(
        res,
        A2A_ERR.UNSUPPORTED_OPERATION,
        `${canonical} is not supported. Poll GetTask for a public free task.`,
        requestId,
      );
    }
    if (canonical !== "SendMessage") {
      return jsonRpcError(res, JSON_RPC.METHOD_NOT_FOUND, `Unknown method: ${method}`, requestId);
    }
    const metadata = params?.message?.metadata?.[EXTENSION_URI] as
      | Record<string, unknown>
      | undefined;
    if (!metadata || typeof metadata.skillId !== "string") {
      return jsonRpcError(
        res,
        JSON_RPC.INVALID_REQUEST,
        `metadata[${EXTENSION_URI}].skillId is required for public free skills`,
        requestId,
      );
    }
    if (metadata.paymentId || metadata.serviceRef || metadata.transactionHash) {
      return jsonRpcError(
        res,
        JSON_RPC.INVALID_REQUEST,
        "Native payment metadata is retired; paid and order-bound work must use the Daski gateway",
        requestId,
      );
    }
    return await handleFreeSkill(
      params.message,
      metadata,
      serviceSlug,
      res,
      requestId,
    );
  } catch (error) {
    return jsonRpcInternalError(
      res,
      JSON_RPC.INTERNAL_ERROR,
      "Internal error",
      error,
      requestId,
      { serviceSlug },
    );
  } finally {
    logInfo("A2A request completed", {
      serviceSlug,
      duration: Date.now() - startedAt,
    });
  }
});
