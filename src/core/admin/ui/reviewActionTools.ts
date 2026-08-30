import type { ToolContext, OperatorTool } from "../../agents/operatorAgent/tools/shared.js";
import { getScreeningExtension } from "../../screening/registry.js";
import { getAllServices } from "../../serviceRegistry/registry.js";
import { coreReviewActionTools } from "./coreReviewActions.js";

const REVIEW_ACTION_NAMES = new Set([
  "clear_screening_hold",
  "confirm_screening_match",
  "advance_compliance_case",
  "withhold_refund",
  "block_identity",
  "unblock_identity",
]);

export interface ReviewActionTool {
  name: string;
  description: string;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export function listReviewActionTools(): ReviewActionTool[] {
  const tools: OperatorTool[] = [];
  for (const service of getAllServices()) {
    tools.push(...(service.agents?.operatorAgentActionTools?.() ?? []));
  }
  tools.push(...(getScreeningExtension()?.operatorTools?.() ?? []));
  const unique = new Map<string, ReviewActionTool>();
  for (const tool of coreReviewActionTools()) unique.set(tool.name, tool);
  for (const tool of tools) {
    const name = tool.definition.function.name;
    if (!REVIEW_ACTION_NAMES.has(name) || unique.has(name)) continue;
    unique.set(name, {
      name,
      description: tool.definition.function.description,
      execute: tool.execute,
    });
  }
  return [...unique.values()].sort((left, right) => left.name.localeCompare(right.name));
}
