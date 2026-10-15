import { Router, type Request, type Response } from "express";
import { getServiceBySlug } from "../db/queries/services.js";
import { getSkillsByServiceId } from "../db/queries/skills.js";
import { generateAgentCard } from "./generator.js";

export const agentCardRouter = Router();

async function serveAgentCard(
  req: Request<{ serviceSlug: string }>,
  res: Response,
) {
  const slug = req.params.serviceSlug;

  const service = await getServiceBySlug(slug);
  if (!service || !service.is_active) {
    return res.status(404).json({ error: "Service not found" });
  }

  const skills = await getSkillsByServiceId(service.id);
  const card = generateAgentCard(service, skills);

  res.json(card);
}

agentCardRouter.get("/:serviceSlug.json", serveAgentCard);

// The ERC-8004 registration file lists each card URL as its service's A2A
// endpoint. Registry crawlers that treat an A2A endpoint as a site root
// request <endpoint>/.well-known/agent-card.json instead, so that path
// answers the same deterministic card. It is served rather than redirected:
// common crawler HTTP clients do not follow redirects by default.
agentCardRouter.get(
  "/:serviceSlug.json/.well-known/agent-card.json",
  serveAgentCard,
);
