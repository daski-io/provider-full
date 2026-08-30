import type { ServiceManifest } from "../../core/serviceRegistry/types.js";
import { defineSkills } from "../../core/serviceRegistry/types.js";
import { DUMMY_SLUG, NOTE_ASSET_TYPE, NOTE_PRICE_ATOMIC } from "./config.js";

import { dummySkillContracts } from "./skillContracts.js";
// Reference manifest. The slug + version feed ServiceRegistry's
// computeServiceId; the provider's ERC-8004 agentId comes from env
// (PROVIDER_AGENT_ID), never from the manifest. A real service also
// typically sets `supplier` (the supplier_configs row holding its
// external credentials) — the dummy has no external supplier.
export const manifest: ServiceManifest = {
  slug: DUMMY_SLUG,
  version: "1",
  name: "Dummy Notes",
  categoryFamily: "other",
  serviceType: "other",
  jurisdictions: ["global"],
  description:
    "Reference service for provider authors: a free echo skill, a paid " +
    "note-creation skill that provisions an asset. Not a real marketplace offering.",
  turnaroundEstimate: "< 5 seconds",
  serviceLifecycle: "asset-lifecycle",
  dispatchMode: "one-shot",
  defaultFulfillmentMode: "automated",
  // Buyer-facing lifecycle for the note asset type, surfaced on the
  // AgentCard so agents can reason about reversibility before calling a
  // terminal-state skill. Vocabulary must match the AssetStatus values
  // the service actually writes.
  assetLifecycle: {
    [NOTE_ASSET_TYPE]: {
      states: ["active"],
      terminalStates: [],
      transitions: [
        { from: null, to: "active", skill: "create-note" },
      ],
    },
  },
};

export const skills = defineSkills([
  {
    id: "echo",
    name: "Echo",
    description:
      "Free demonstration skill: returns the submitted message back as an " +
      "artifact, completing immediately. No payment, ownership, or " +
      "authorization requirements — the minimal end-to-end round trip for " +
      "verifying connectivity with this provider. Send `message` (1-500 " +
      "Unicode code points); the response artifact `echo_result` carries the same " +
      "text plus the service's processing timestamp.",
    examples: [
      "Echo the message 'hello daski'",
      "Send a connectivity test message to the dummy service",
      "Verify the provider round-trip with a ping",
    ],
    pricing: { USDC: { type: "one-time", fixed_amount: "0" } },
    taskDurability: "ephemeral",
    fulfillmentMode: "automated",
    requiresAssetOwnership: false,
    requiredFields: ["message"],
    tags: ["dummy"],
    sortOrder: 0,
  },
  {
    id: "create-note",
    name: "Create Note",
    description:
      "Paid demonstration skill: validates a short note and provisions a " +
      "non-sensitive asset owned by the wallet-authorized payer. Requires " +
      "payment ($0.10 USDC) but no additional authorization. Send `title` " +
      "(1-80 Unicode code points, becomes the asset-identifier prefix) and " +
      "optional `body` (up to 2,000 Unicode code points). A unique task id " +
      "suffix prevents repeated titles from colliding. The body is not retained. " +
      "Completes with a `note_created` artifact naming the asset identifier.",
    examples: [
      "Create a note titled 'Launch checklist'",
      "Store a note with title 'ideas' and body 'ship the template repo'",
      "Save a new note for me",
    ],
    pricing: { USDC: { type: "one-time", fixed_amount: NOTE_PRICE_ATOMIC } },
    fulfillmentMode: "automated",
    requiresAssetOwnership: false,
    assetType: NOTE_ASSET_TYPE,
    requiredFields: ["title"],
    optionalFields: ["body"],
    humanParties: "none",
    tags: ["dummy"],
    sortOrder: 1,
  },
], dummySkillContracts);
