import {
  getEscalationById,
  type EscalationRow,
} from "../../db/queries/escalations.js";
import {
  getInboundEmailById,
  type InboundEmailRow,
} from "../../db/queries/emails.js";
import {
  getTransactionById,
  type TransactionRow,
} from "../../db/queries/transactions.js";
import { getServiceById, type ServiceRow } from "../../db/queries/services.js";
import { redactSensitiveText } from "../../security/redaction.js";

export interface StandardSettlementSummary {
  orderId: string;
  payer: string;
  token: string;
  grossAmount: string;
  providerAmount: string;
  daskiAmount: string;
  state: string;
}

export interface EscalationContext {
  escalation: EscalationRow;
  inbound: InboundEmailRow | null;
  transaction: TransactionRow | null;
  service: ServiceRow | null;
  settlement: StandardSettlementSummary | null;
}

function standardSettlement(transaction: TransactionRow | null): StandardSettlementSummary | null {
  if (!transaction?.standard_order_id || !transaction.standard_payer ||
      !transaction.standard_token || !transaction.standard_gross_amount ||
      !transaction.standard_provider_net_amount || !transaction.standard_daski_commission_amount) {
    return null;
  }
  return {
    orderId: transaction.standard_order_id,
    payer: transaction.standard_payer,
    token: transaction.standard_token,
    grossAmount: transaction.standard_gross_amount,
    providerAmount: transaction.standard_provider_net_amount,
    daskiAmount: transaction.standard_daski_commission_amount,
    state: transaction.status,
  };
}

export async function loadEscalationContext(
  escalationId: string,
): Promise<EscalationContext | null> {
  const escalation = await getEscalationById(escalationId);
  if (!escalation) return null;
  const [inbound, transaction] = await Promise.all([
    escalation.inbound_id ? getInboundEmailById(escalation.inbound_id) : null,
    escalation.transaction_id ? getTransactionById(escalation.transaction_id) : null,
  ]);
  const serviceId = transaction?.service_id ?? inbound?.service_id ?? null;
  const service = serviceId ? await getServiceById(serviceId) : null;
  const settlement = standardSettlement(transaction);
  return { escalation, inbound, transaction, service, settlement };
}

export function summarizeEscalationContext(context: EscalationContext): string {
  const review = context.escalation;
  const protectedCase = review.source === "email_agent" || review.assignee === "human";
  const lines = [
    `Review ${review.id}`,
    `  status: ${review.status}`,
    `  source: ${review.source}`,
    `  kind: ${review.review_kind ?? "unclassified"}`,
    `  question: ${protectedCase
      ? "Protected case details are retained for human review and withheld from the model."
      : redactSensitiveText(review.question)}`,
  ];
  if (review.agent_recommendation) {
    lines.push(`  prior recommendation: ${protectedCase
      ? "Protected recommendation retained for human review and withheld from the model."
      : redactSensitiveText(review.agent_recommendation)}`);
  }
  if (context.service) lines.push(`Service: ${context.service.name} (${context.service.slug})`);
  if (context.transaction) {
    lines.push(
      `Transaction: ${context.transaction.id} — ${context.transaction.skill_id} ` +
      `[${context.transaction.status}]`,
    );
    if (context.settlement) {
      lines.push(
        `  standard order: ${context.settlement.orderId} — ` +
        `${context.settlement.grossAmount} atomic units [${context.settlement.state}]`,
      );
    }
  } else {
    lines.push("Transaction: none (unbound review)");
  }
  lines.push(context.inbound
    ? "Inbound email: present; sender-authored content is untrusted and available only through the bound email context."
    : "Inbound email: none on file.");
  return lines.join("\n");
}
