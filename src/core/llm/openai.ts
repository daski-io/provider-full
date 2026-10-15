import OpenAI from "openai";
import { config } from "../config.js";
import { observeOutbound } from "../observability/outboundFailures.js";
import { maxTokensParam } from "./params.js";

/** Outbound-failure log labels shared by every chat-completion call site. */
export const LLM_TARGET = "api.openai.com";
export const LLM_OPERATION = "chat.completions";

export class OpenAIClient {
  private client: OpenAI;
  private model: string;

  constructor() {
    this.client = new OpenAI({
      apiKey: config.OPENAI_API_KEY,
      timeout: config.OUTBOUND_TOTAL_TIMEOUT_MS,
      maxRetries: 0,
    });
    this.model = config.LLM_MODEL;
  }

  /// JSON-mode chat. Used by the pre-execute runner: caller's prompt
  /// must instruct the model to return JSON. `model` overrides the
  /// instance default (each skill can pin its own model).
  async completeJson(
    systemPrompt: string,
    userMessage: string,
    model?: string,
  ): Promise<string> {
    const effectiveModel = model ?? this.model;
    const response = await observeOutbound(LLM_TARGET, LLM_OPERATION, () =>
      this.client.chat.completions.create({
        model: effectiveModel,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        ...maxTokensParam(effectiveModel, 500),
      }));
    return response.choices[0].message.content || "";
  }
}
