import OpenAI from "openai";
import { config } from "../../config.js";
import { getServiceById } from "../../db/queries/services.js";
import { getActiveSkillsByServiceId } from "../../db/queries/skills.js";
import { listActiveRulesForLlm } from "../../db/queries/serviceRules.js";
import {
  getInboundEmailById,
  updateInboundEmailClassification,
  type InboundEmailRow,
} from "../../db/queries/emails.js";
import { emitEvent } from "../../events/emitter.js";
import { type EmailAgentContext } from "./tools/index.js";
import { toolsForService } from "./toolRegistry.js";
import { getService } from "../../serviceRegistry/registry.js";
import { buildEmailAgentPrompt } from "./prompt.js";
import { maxTokensParam } from "../../llm/params.js";
import { logError } from "../../logger.js";
import { redactSensitiveText } from "../../security/redaction.js";

// Email Agent runtime. Triggered by the durable email-ingress worker after
// the authenticated webhook stores and queues an accepted inbound message.
//
// Fail-open: any LLM / tool error gets the email classified as
// 'unknown' so the operator sees it in the unclassified queue rather
// than silently swallowing.

const MAX_TOOL_ROUNDS = 4;
const PROMPT_SUBJECT_CHARS = 256;
const PROMPT_BODY_CHARS = 4_000;
const openai = new OpenAI({
  apiKey: config.OPENAI_API_KEY,
  timeout: config.OUTBOUND_TOTAL_TIMEOUT_MS,
  maxRetries: 0,
});

export async function processInboundEmail(inboundId: string): Promise<void> {
  const inbound = await getInboundEmailById(inboundId);
  if (!inbound) {
    logError("emailAgent: inbound row missing", { inboundId });
    return;
  }
  if (inbound.classification && inbound.classification !== "unrouted") {
    // Already handled (auto-filtered or a previous run set a class).
    return;
  }
  if (!inbound.service_id) {
    // Unrouted — nothing for the agent to do without a service context.
    return;
  }

  const service = await getServiceById(inbound.service_id);
  if (!service) {
    await markUnknown(inbound, "service not resolvable");
    return;
  }

  const fromAddress = service.outbound_email_from;
  if (!fromAddress) {
    await markUnknown(inbound, "service.outbound_email_from not set");
    return;
  }

  const [skills, rules] = await Promise.all([
    getActiveSkillsByServiceId(service.id),
    listActiveRulesForLlm({ service_id: service.id, scope: "email_agent" }),
  ]);

  // The manifest's support policy (email-authoritative vs skill-required)
  // lets the agent give service-accurate guidance instead of generic advice.
  const support = getService(service.slug)?.manifest.support;

  const promptInbound: InboundEmailRow = {
    ...inbound,
    from_address: redactSensitiveText(inbound.from_address).slice(0, PROMPT_SUBJECT_CHARS),
    subject: inbound.subject
      ? redactSensitiveText(inbound.subject.slice(0, PROMPT_SUBJECT_CHARS))
      : null,
    body_text: redactSensitiveText(
      (inbound.body_text ?? inbound.body_html ?? "").slice(0, PROMPT_BODY_CHARS),
    ),
    body_html: null,
    headers: {},
    customer_id: null,
    transaction_id: null,
  };
  const systemPrompt = buildEmailAgentPrompt({
    service,
    skills,
    rules,
    inbound: promptInbound,
    support,
  });

  interface AgentMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
  }
  const messages: AgentMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: "Process the email above." },
  ];

  const ctx: EmailAgentContext = {
    inbound,
    serviceId: service.id,
    serviceSlug: service.slug,
    fromAddress,
    authorization: { kind: "unauthenticated" },
  };
  // Only the tools in scope for this email's resolved service: the shared
  // triage tools plus whatever this service contributes.
  const tools = toolsForService(service.slug);
  const toolsByName = new Map(tools.map((t) => [t.definition.function.name, t]));
  const toolDefs = tools.map((t) => t.definition);
  const model = config.EMAIL_AGENT_LLM_MODEL ?? config.LLM_MODEL;

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // Cast through unknown because the OpenAI SDK has a more specific
      // discriminated union for messages than our local AgentMessage shape.
      const response = await openai.chat.completions.create({
        model,
        messages: messages as unknown as Parameters<typeof openai.chat.completions.create>[0]["messages"],
        tools: toolDefs as unknown as Parameters<typeof openai.chat.completions.create>[0]["tools"],
        tool_choice: "auto",
        ...maxTokensParam(model, 800),
      });
      const m = response.choices[0].message;
      const toolCalls = m.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        messages.push({ role: "assistant", content: m.content ?? "" });
        messages.push({
          role: "user",
          content:
            "You must call the classify tool before finishing. If you couldn't determine the intent, classify as 'unknown' and escalate.",
        });
        continue;
      }
      messages.push({
        role: "assistant",
        content: m.content ?? null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
      });
      let calledClassify = false;
      for (const tc of toolCalls) {
        if (tc.function.name === "classify") calledClassify = true;
        const tool = toolsByName.get(tc.function.name);
        let result: string;
        if (!tool) {
          result = JSON.stringify({ error: `unknown tool: ${tc.function.name}` });
        } else {
          try {
            const args = JSON.parse(tc.function.arguments || "{}");
            result = await tool.execute(args, ctx);
          } catch (err) {
            result = JSON.stringify({ error: (err as Error).message });
          }
        }
        messages.push({
          role: "tool",
          content: result,
          tool_call_id: tc.id,
        });
      }
      if (calledClassify) return;
    }
    // Tool-call cap exceeded without classification — mark unknown.
    await markUnknown(inbound, "tool-call cap exceeded without classification");
  } catch (err) {
    // Retryable provider/network failures are owned by the durable worker;
    // unknown/dead-letter visibility is applied only after its retry budget.
    throw new Error(`email agent failed: ${(err as Error).message}`);
  }
}

async function markUnknown(inbound: InboundEmailRow, reason: string): Promise<void> {
  await updateInboundEmailClassification({
    id: inbound.id,
    classification: "unknown",
    reason,
  });
  await emitEvent({
    serviceId: inbound.service_id ?? undefined,
    source: "email",
    severity: "warn",
    type: "email.classification_failed",
    message: "Inbound email classification requires review.",
    payload: { inboundId: inbound.id },
  });
}
