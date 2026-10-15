import OpenAI from "openai";
import { config } from "../../config.js";
import {
  appendOperatorChatMessage,
  listChatThreadMessages,
  type OperatorChatRow,
} from "../../db/queries/operatorChats.js";
import { emitEvent } from "../../events/emitter.js";
import { LLM_OPERATION, LLM_TARGET } from "../../llm/openai.js";
import { maxTokensParam } from "../../llm/params.js";
import { observeOutbound } from "../../observability/outboundFailures.js";
import { redactSensitiveText } from "../../security/redaction.js";
import { redactConfirmationTokens } from "./audit.js";
import {
  protectModelText,
  protectModelToolCalls,
  type ModelToolCall,
} from "./modelBoundary.js";
import { buildSystemPrompt } from "./prompt.js";
import { toolsForMode, type ToolContext } from "./tools.js";

const MAX_TOOL_ROUNDS = 6;

const openai = new OpenAI({
  apiKey: config.OPENAI_API_KEY,
  timeout: config.OUTBOUND_TOTAL_TIMEOUT_MS,
  maxRetries: 0,
});

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

function rowToChatMessages(row: OperatorChatRow): ChatMessage[] {
  if (row.role === "operator") {
    return [{ role: "user", content: protectModelText(row.content) }];
  }
  if (row.role === "tool") {
    return [
      {
        role: "tool",
        content: protectModelText(row.content),
        tool_call_id: row.tool_call_id ?? undefined,
      },
    ];
  }

  const toolCalls = protectModelToolCalls(row.tool_calls as ModelToolCall[] | null);
  return [
    {
      role: "assistant",
      content: row.content === "" ? null : protectModelText(row.content),
      ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
  ];
}

export interface OperatorTurnResult {
  finalText: string;
  rounds: number;
}

export async function runOperatorLoop(args: {
  threadId: string;
  actor: string;
  sessionId?: string;
  turnId?: string;
  escalationId: string | null;
  mode: "free_form" | "human" | "autonomous";
  escalationContext?: string;
}): Promise<OperatorTurnResult> {
  const { threadId, actor } = args;
  const history = await listChatThreadMessages(threadId, 50);
  const replayed = history.flatMap(rowToChatMessages);
  let start = 0;
  while (start < replayed.length && replayed[start]?.role === "tool") start++;
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt({
        walletAddress: actor,
        nowIso: new Date().toISOString(),
        mode: args.mode,
        escalationContext: protectModelText(args.escalationContext ?? null) ?? undefined,
      }),
    },
    ...replayed.slice(start),
  ];

  const ctx: ToolContext = {
    actor,
    threadId,
    sessionId: args.sessionId,
    turnId: args.turnId,
    escalationId: args.escalationId,
    mode: args.mode,
  };
  const tools = toolsForMode(ctx);
  const toolsByName = new Map(tools.map((tool) => [tool.definition.function.name, tool]));
  const toolDefs = tools.map((tool) => tool.definition);
  const model = config.OPERATOR_AGENT_LLM_MODEL ?? config.LLM_MODEL;

  let rounds = 0;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    rounds = round + 1;
    let response;
    try {
      response = await observeOutbound(LLM_TARGET, LLM_OPERATION, () =>
        openai.chat.completions.create({
          model,
          messages: messages as unknown as Parameters<typeof openai.chat.completions.create>[0]["messages"],
          tools: toolDefs as unknown as Parameters<typeof openai.chat.completions.create>[0]["tools"],
          tool_choice: "auto",
          ...maxTokensParam(model, 800),
        }));
    } catch {
      const errorMessage =
        "The operator model call failed. Retry the request or inspect provider operations.";
      await appendOperatorChatMessage({
        threadId,
        walletAddress: actor,
        role: "agent",
        content: errorMessage,
      });
      return { finalText: errorMessage, rounds };
    }

    const message = response.choices[0].message;
    const toolCalls = message.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      const text = message.content ?? "";
      await appendOperatorChatMessage({
        threadId,
        walletAddress: actor,
        role: "agent",
        content: text,
        suggestedActions: ctx.suggestedActions ?? undefined,
      });
      return { finalText: text, rounds };
    }

    await appendOperatorChatMessage({
      threadId,
      walletAddress: actor,
      role: "agent",
      content: message.content ?? "",
      toolCalls,
    });
    messages.push({
      role: "assistant",
      content: protectModelText(message.content ?? null),
      tool_calls: protectModelToolCalls(
        toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: "function",
          function: {
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
          },
        })),
      )!,
    });

    for (const toolCall of toolCalls) {
      const tool = toolsByName.get(toolCall.function.name);
      let result: string;
      if (!tool) {
        result = JSON.stringify({ error: `unknown tool: ${toolCall.function.name}` });
      } else {
        try {
          const toolArgs = JSON.parse(toolCall.function.arguments || "{}");
          result = await tool.execute(toolArgs, ctx);
        } catch (error) {
          result = JSON.stringify({
            error: redactSensitiveText((error as Error).message).slice(0, 1_000),
          });
        }
      }

      await appendOperatorChatMessage({
        threadId,
        walletAddress: actor,
        role: "tool",
        content: result,
        toolCallId: toolCall.id,
      });
      await emitEvent({
        source: "llm",
        type: "llm.operator_agent.tool_call",
        actor,
        message: toolCall.function.name,
        payload: {
          tool: toolCall.function.name,
          args: redactConfirmationTokens(
            protectModelText(toolCall.function.arguments) ?? "{}",
          ),
          result_preview: redactConfirmationTokens(
            protectModelText(result) ?? "",
          ).slice(0, 200),
        },
      });
      messages.push({
        role: "tool",
        content: protectModelText(result),
        tool_call_id: toolCall.id,
      });
    }
  }

  const fallback =
    "I'm in a tool-call loop — too many rounds without a final answer. Try rephrasing your question.";
  await appendOperatorChatMessage({
    threadId,
    walletAddress: actor,
    role: "agent",
    content: fallback,
    suggestedActions: ctx.suggestedActions ?? undefined,
  });
  return { finalText: fallback, rounds };
}
