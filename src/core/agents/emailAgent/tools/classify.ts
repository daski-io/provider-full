import { updateInboundEmailClassification } from "../../../db/queries/emails.js";
import { emitEvent } from "../../../events/emitter.js";
import type { EmailAgentTool } from "./context.js";

export const classify: EmailAgentTool = {
  definition: {
    type: "function",
    function: {
      name: "classify",
      description:
        "Set the classification on this inbound email. Always call this exactly once at the end of your processing to mark the email as handled.",
      parameters: {
        type: "object",
        properties: {
          classification: {
            type: "string",
            enum: ["informational", "question", "refund_request", "unknown"],
            description:
              "Classify the email by its INTENT (not by what you did with it — " +
              "escalating is a separate action via escalate_to_operator). " +
              "informational = no action needed (e.g. ICANN verification confirmation). " +
              "question = a question the buyer wants answered. " +
              "refund_request = the buyer is asking for a refund. " +
              "unknown = intent unclear. Still call escalate_to_operator when a " +
              "refund/unknown needs human or agent follow-up; the classification " +
              "records the intent regardless.",
          },
          reason: { type: "string", description: "One-sentence explanation of the decision." },
        },
        required: ["classification", "reason"],
      },
    },
  },
  async execute(args, ctx) {
    await updateInboundEmailClassification({
      id: ctx.inbound.id,
      classification: String(args.classification),
      reason: typeof args.reason === "string" ? args.reason : null,
    });
    await emitEvent({
      serviceId: ctx.serviceId,
      source: "email",
      type: "email.classified",
      message: "Inbound email classification recorded.",
      payload: { inboundId: ctx.inbound.id, classification: args.classification },
    });
    return JSON.stringify({ ok: true });
  },
};
