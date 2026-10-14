import { randomUUID } from "node:crypto";
import type { AssetRow } from "../db/queries/assets.js";
import { emitEvent } from "../events/emitter.js";
import { getAdapter } from "../serviceRegistry/registry.js";
import { hasRetainedContracts, retainedTaskHandler } from "../serviceRegistry/retainedHandlers.js";
import {
  CancellationCleanupError,
  CancellationRefusedError,
  type AdapterResult,
  type FulfillmentAdapter,
  type TaskInputAuthorizationContext,
  type TaskContext,
} from "../serviceRegistry/types.js";

export function generateTaskId(): string {
  return `task-${randomUUID()}`;
}

/**
 * The handler for one call on a task: the service's adapter, or, for a skill
 * that retains earlier contracts, the handler of the contract the task was
 * admitted under. A task whose admitted contract this build cannot execute
 * fails here, before the service is called.
 */
async function adapterForTask(adapterName: string, skillId: string, taskId: string): Promise<FulfillmentAdapter> {
  if (!hasRetainedContracts(adapterName, skillId)) return getAdapter(adapterName);
  const handler = await retainedTaskHandler(adapterName, skillId, taskId);
  return handler.kind === "retained" ? handler.adapter : getAdapter(adapterName);
}

function executionPayload(
  action: string,
  task: TaskContext,
  startedAt: number,
  data: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    action,
    skillId: task.skill_id,
    durationMs: Date.now() - startedAt,
    request_fields: Object.keys(data),
  };
}

export async function executeAdapter(
  adapterName: string,
  skillId: string,
  task: TaskContext,
  data: Record<string, unknown>,
  assetContext?: AssetRow,
): Promise<AdapterResult> {
  const adapter = await adapterForTask(adapterName, skillId, task.id);
  const startedAt = Date.now();
  try {
    const result = await adapter.execute(skillId, task, data, assetContext);
    await emitEvent({
      transactionId: task.id,
      serviceId: task.service_id,
      source: "adapter",
      type: `adapter.${adapterName}.execute`,
      message: `${adapterName}/${skillId} execute → ${result.status}`,
      payload: {
        ...executionPayload("execute", task, startedAt, data),
        responseStatus: result.status,
        artifactNames: result.artifacts?.map((artifact) => artifact.name) ?? [],
        assetType: result.asset?.assetType ?? null,
      },
    });
    return result;
  } catch (error) {
    await emitEvent({
      transactionId: task.id,
      serviceId: task.service_id,
      source: "adapter",
      severity: "error",
      type: `adapter.${adapterName}.execute_failed`,
      message: `${adapterName}/${skillId} execution failed.`,
      payload: {
        ...executionPayload("execute", task, startedAt, data),
        errorClass: error instanceof Error ? error.name : "UnknownError",
      },
    });
    throw error;
  }
}

export async function handleAdapterInput(
  adapterName: string,
  task: TaskContext,
  inputText: string,
  data: Record<string, unknown>,
  authorization: TaskInputAuthorizationContext,
): Promise<AdapterResult> {
  const adapter = await adapterForTask(adapterName, task.skill_id, task.id);
  const startedAt = Date.now();
  try {
    const result = await adapter.handleInput(
      task,
      inputText,
      data,
      authorization,
    );
    await emitEvent({
      transactionId: task.id,
      serviceId: task.service_id,
      source: "adapter",
      type: `adapter.${adapterName}.handleInput`,
      message: `${adapterName} handleInput → ${result.status}`,
      payload: {
        ...executionPayload(
          "handleInput",
          task,
          startedAt,
          { inputText, ...data },
        ),
        responseStatus: result.status,
        artifactNames: result.artifacts?.map((artifact) => artifact.name) ?? [],
        assetType: result.asset?.assetType ?? null,
      },
    });
    return result;
  } catch (error) {
    await emitEvent({
      transactionId: task.id,
      serviceId: task.service_id,
      source: "adapter",
      severity: "error",
      type: `adapter.${adapterName}.handleInput_failed`,
      message: `${adapterName} input handling failed.`,
      payload: {
        ...executionPayload("handleInput", task, startedAt, data),
        errorClass: error instanceof Error ? error.name : "UnknownError",
      },
    });
    throw error;
  }
}

export async function cancelAdapterTask(
  adapterName: string,
  task: TaskContext,
): Promise<void> {
  const adapter = await adapterForTask(adapterName, task.skill_id, task.id);
  const startedAt = Date.now();
  try {
    await adapter.cancel(task);
    await emitEvent({
      transactionId: task.id,
      serviceId: task.service_id,
      source: "adapter",
      type: `adapter.${adapterName}.cancel`,
      message: `${adapterName} cancel`,
      payload: executionPayload("cancel", task, startedAt),
    });
  } catch (error) {
    if (error instanceof CancellationRefusedError) {
      await emitEvent({
        transactionId: task.id,
        serviceId: task.service_id,
        source: "adapter",
        severity: "info",
        type: `adapter.${adapterName}.cancel_refused`,
        message: `${adapterName} refused cancellation: ${error.message}`,
        payload: {
          ...executionPayload("cancel", task, startedAt),
          reason: error.message,
        },
      });
      throw error;
    }
    await emitEvent({
      transactionId: task.id,
      serviceId: task.service_id,
      source: "adapter",
      severity: "error",
      type: `adapter.${adapterName}.cancel_failed`,
      message: `${adapterName} cancellation failed.`,
      payload: {
        ...executionPayload("cancel", task, startedAt),
        errorClass: error instanceof Error ? error.name : "UnknownError",
      },
    });
    throw new CancellationCleanupError(
      `Supplier cleanup did not complete definitively: ${(error as Error).message}`,
      error,
    );
  }
}
