import { Router, type Response } from "express";
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
import {
  DASKI_EXTENSION_URI as EXTENSION_URI,
  SKILL_ID_PATH,
  exampleSentence,
  freeSkillHelp,
} from "./freeSkillHelp.js";
import { handleFreeSkill } from "./handlers/freeSkill.js";
import { handleTasksGet } from "./handlers/tasksGet.js";
import { logInfo } from "../logger.js";
import { getProviderIdentityAuthorization } from "../chain/providerIdentity.js";

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
      return await unknownMethod(method, canonical, serviceSlug, res, requestId);
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
        {
          required: SKILL_ID_PATH,
          ...await freeSkillHelp(serviceSlug, {
            preferredSkillId: misplacedSkillId(params),
          }),
        },
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

// Older or guessed names for reading a task; every other unknown method is
// pointed at SendMessage.
const GET_TASK_NAMES = new Set(["tasks/get", "getTask", "get_task"]);

async function unknownMethod(
  method: string,
  canonical: string | undefined,
  serviceSlug: string,
  res: Response,
  requestId: string | number | null,
): Promise<void> {
  const shown = method.slice(0, 64);
  // An A2A v1.0 method this endpoint does not serve (CancelTask, push
  // notification config) has no substitute to name.
  const useMethod = canonical
    ? undefined
    : GET_TASK_NAMES.has(method) ? "GetTask" : "SendMessage";
  const help = await freeSkillHelp(serviceSlug, {
    preferredSkillId: method,
    getTask: useMethod === "GetTask",
  });
  const advice = help.freeSkillIds?.includes(method)
    ? `${shown} is a skill id, not a method: call SendMessage with it as ${SKILL_ID_PATH}.`
    : useMethod
      ? `Use ${useMethod}.`
      : `This endpoint serves only ${help.supportedMethods.join(" and ")}.`;
  return jsonRpcError(
    res,
    JSON_RPC.METHOD_NOT_FOUND,
    `Unknown method: ${shown}. ${advice} ${exampleSentence(help.example)}`,
    requestId,
    { ...(useMethod ? { useMethod } : {}), ...help },
  );
}

// A skill id sent outside the extension metadata (a common guess) picks the
// example's skill; it is never treated as the request's skill.
function misplacedSkillId(params: unknown): string | undefined {
  const record = (value: unknown) =>
    value !== null && typeof value === "object"
      ? value as Record<string, unknown>
      : undefined;
  const request = record(params);
  const message = record(request?.message);
  const candidates = [
    record(message?.metadata)?.skillId,
    record(record(request?.metadata)?.[EXTENSION_URI])?.skillId,
    record(request?.metadata)?.skillId,
    request?.skillId,
  ];
  return candidates.find((value): value is string => typeof value === "string");
}
