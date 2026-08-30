import { createHash } from "node:crypto";
import {
  createDirectSink,
  createJsonSink,
  envelopeAt,
  sinkContext,
  sinkText,
  type ProtectedDataSink,
} from "./protectedDataSinkTypes.js";
import {
  registerProtectedAssetIdentifier,
  type ProtectedAssetIdentifierScheme,
} from "../db/queries/assets.js";

// Core-owned protected-data sinks. Service-owned tables declare their own
// sinks via `ServiceModule.security.protectedDataSinks`; they are registered here
// (boot path: serviceRegistry/registry.ts; standalone rotation entrypoint:
// src/rotateProtectedData.ts) and the rotation machinery walks core +
// service sinks together via `allProtectedDataSinks()`.

type Row = Record<string, unknown>;

const escalationFields = ["question", "response", "agent_recommendation", "resolution_error"]
  .map((field) => ({
    column: field,
    context: (row: Row) => sinkContext(
      "operator-escalation", "escalations", sinkText(row, "id"), field, { service: "core" },
    ),
  }));
const evidenceFields = [
  ["execution_snapshot_encrypted", "execution-snapshot"],
  ["reviewer_edits_encrypted", "reviewer-edits"],
  ["review_binding_encrypted", "review-binding"],
  ["adapter_result_encrypted", "adapter-result"],
].map(([column, field]) => ({
  column,
  context: (row: Row) => sinkContext(
    `escalation-${field}`,
    "escalations",
    sinkText(row, "id"),
    field,
    { service: sinkText(row, "snapshot_service_id"), recordVersion: 1 },
  ),
}));
const fulfillmentHoldAttemptEvidenceFields = [
  ["reviewer_edits_encrypted", "reviewer-edits"],
  ["review_binding_encrypted", "review-binding"],
  ["adapter_result_encrypted", "adapter-result"],
].map(([column, field]) => ({
  column,
  context: (row: Row) => sinkContext(
    `escalation-${field}`,
    "escalations",
    sinkText(row, "escalation_id"),
    field,
    { service: sinkText(row, "snapshot_service_id"), recordVersion: 1 },
  ),
}));
const fulfillmentHoldAttemptErrorField = {
  column: "resolution_error",
  context: (row: Row) => sinkContext(
    "operator-escalation",
    "escalations",
    sinkText(row, "escalation_id"),
    "resolution_error",
    { service: "core" },
  ),
};

const inboundEmailFields = [
  "from_address", "to_address", "subject", "body_text", "body_html", "rfc_message_id", "in_reply_to",
  "thread_root", "classification_reason", "processing_error",
].map((field) => ({
  column: field,
  context: (row: Row) => sinkContext("email-content", "emails_inbound", sinkText(row, "id"), field),
  ...(field === "to_address"
    ? { lookup: { column: "to_address_hash", purpose: "email-recipient" } }
    : field === "thread_root"
      ? { lookup: { column: "thread_root_hash", purpose: "email-thread" } }
      : {}),
}));
const outboundEmailFields = [
  "to_address", "subject", "body_text", "body_html", "in_reply_to", "thread_root", "reply_to",
].map((field) => ({
  column: field,
  context: (row: Row) => sinkContext("email-content", "emails_outbound", sinkText(row, "id"), field),
  ...(field === "thread_root"
    ? { lookup: { column: "thread_root_hash", purpose: "email-thread" } }
    : {}),
}));
const emailAttachmentFields = ["filename", "content_id", "content_encrypted"].map((field) => ({
  column: field,
  context: (row: Row) => sinkContext(
    field === "content_encrypted" ? "email-attachment" : "email-attachment-metadata",
    "email_attachments",
    sinkText(row, "id"),
    field,
  ),
}));


const coreProtectedDataSinks: ProtectedDataSink[] = [
  createDirectSink({
    name: "supplier-configs",
    table: "supplier_configs",
    cursorColumn: "supplier",
    fields: [
      {
        column: "credentials_encrypted",
        context: (row) => sinkContext(
          "supplier-credentials", "supplier_configs", sinkText(row, "supplier"),
          "credentials_encrypted", { service: sinkText(row, "supplier") },
        ),
      },
      {
        column: "notes",
        context: (row) => sinkContext(
          "supplier-metadata", "supplier_configs", sinkText(row, "supplier"),
          "notes", { service: sinkText(row, "supplier") },
        ),
      },
    ],
  }),
  createDirectSink({
    name: "customer-email",
    table: "customers",
    cursorColumn: "id",
    fields: [{
      column: "last_known_email",
      context: (row) => sinkContext("customer-contact", "customers", sinkText(row, "id"), "last_known_email"),
      lookup: { column: "last_known_email_hash", purpose: "customer-email" },
    }],
  }),
  createDirectSink({
    name: "transaction-contact",
    table: "transactions",
    cursorColumn: "id",
    fields: [{
      column: "contact_email",
      context: (row) => sinkContext("customer-contact", "transactions", sinkText(row, "id"), "contact_email"),
    }],
  }),
  createDirectSink({
    name: "provider-quote-country-evidence",
    table: "provider_quotes",
    cursorColumn: "id",
    fields: [{
      column: "trusted_request_country_encrypted",
      context: (row) => sinkContext(
        "trusted-request-country",
        "provider_quotes",
        sinkText(row, "id"),
        "trusted_request_country",
        { service: "core" },
      ),
    }],
  }),
  createDirectSink({
    name: "push-secrets",
    table: "push_subscriptions",
    cursorColumn: "id",
    fields: [{
      column: "token",
      context: (row) => sinkContext(
        "push-webhook-secret",
        "push_subscriptions",
        createHash("sha256").update(`${sinkText(row, "transaction_id")}\0${sinkText(row, "url")}`).digest("hex"),
        "token",
      ),
    }],
  }),
  createDirectSink({ name: "inbound-email", table: "emails_inbound", cursorColumn: "id", fields: inboundEmailFields }),
  createDirectSink({
    name: "inbound-email-headers",
    table: "emails_inbound",
    cursorColumn: "id",
    fields: [{
      column: "headers",
      storage: "json-string",
      context: (row) => sinkContext("email-content", "emails_inbound", sinkText(row, "id"), "headers"),
    }],
  }),
  createDirectSink({ name: "outbound-email", table: "emails_outbound", cursorColumn: "id", fields: outboundEmailFields }),
  createDirectSink({
    name: "email-attachments",
    table: "email_attachments",
    cursorColumn: "id",
    fields: emailAttachmentFields,
  }),
  createDirectSink({
    name: "operator-chat",
    table: "operator_chats",
    cursorColumn: "id",
    fields: ["content", "tool_calls", "suggested_actions"].map((field) => ({
      column: field,
      storage: field === "content" ? "text" as const : "json-string" as const,
      context: (row: Row) => sinkContext("operator-context", "operator_chats", sinkText(row, "id"), field),
    })),
  }),
  createDirectSink({
    name: "operator-thread",
    table: "chat_threads",
    cursorColumn: "id",
    fields: [{
      column: "title",
      context: (row) => sinkContext(
        "operator-chat-thread", "chat_threads", sinkText(row, "id"), "title", { service: "core" },
      ),
    }],
  }),
  createDirectSink({
    name: "legal-holds",
    table: "legal_holds",
    cursorColumn: "id",
    fields: [{
      column: "reason",
      context: (row) => sinkContext(
        "legal-hold", "legal_holds", sinkText(row, "id"), "reason", { service: "core" },
      ),
    }],
  }),
  createDirectSink({
    name: "escalations",
    table: "escalations",
    cursorColumn: "id",
    fields: [...escalationFields, ...evidenceFields],
  }),
  createDirectSink({
    name: "fulfillment-hold-attempts",
    table: "fulfillment_hold_attempts",
    cursorColumn: "id",
    fields: [...fulfillmentHoldAttemptEvidenceFields, fulfillmentHoldAttemptErrorField],
  }),
  // transfer_artifacts retired (audit 4.6): the EPP auth code now lives in
  // the generic artifact_secrets sink below.
  createDirectSink({
    name: "artifact-secrets",
    table: "artifact_secrets",
    cursorColumn: "id",
    fields: [{
      column: "secret",
      context: (row) => sinkContext(
        "customer-artifact", "artifact_secrets",
        `${sinkText(row, "transaction_id")}:${sinkText(row, "artifact_name")}:${sinkText(row, "field_path")}`,
        "secret",
      ),
    }],
  }),
  createJsonSink({
    name: "standard-order-requests",
    table: "transactions",
    cursorColumn: "id",
    column: "metadata",
    cells: (row, json) => envelopeAt(json, ["standard_request_encrypted"], sinkContext(
      "standard-order-request",
      "transactions",
      sinkText(row, "id"),
      "metadata.standard_request_encrypted",
      { recordVersion: 1 },
    )),
  }),
  createJsonSink({
    name: "customer-events",
    table: "events",
    cursorColumn: "id",
    column: "payload",
    cells: (row, json) => envelopeAt(json, ["envelope"], sinkContext(
      "customer-event", "events", sinkText(row, "id"), "payload", { service: "core" },
    )),
  }),
  createDirectSink({
    name: "operator-confirmation-payloads",
    table: "operator_confirmation_intents",
    cursorColumn: "id",
    fields: [{
      column: "pending_payload_encrypted",
      context: (row) => sinkContext(
        "operator-confirmation-payload",
        "operator_confirmation_intents",
        sinkText(row, "id"),
        "pending_payload_encrypted",
        { service: "core" },
      ),
    }],
  }),
  createDirectSink({
    name: "provider-chain-writes",
    table: "provider_chain_writes",
    cursorColumn: "id",
    fields: [{
      column: "signed_tx_encrypted",
      context: (row) => sinkContext(
        "provider-signed-transaction",
        "provider_chain_writes",
        sinkText(row, "id"),
        "signed_tx_encrypted",
        { service: "core" },
      ),
    }],
  }),
];

// ── Registry ──────────────────────────────────────────────────────────

const registeredSinks: ProtectedDataSink[] = [...coreProtectedDataSinks];
const registeredServiceSlugs = new Set<string>();
const registeredExtensionIds = new Set<string>();

/** Every registered sink — core plus the services registered so far. */
export function allProtectedDataSinks(): readonly ProtectedDataSink[] {
  return registeredSinks;
}

/**
 * Register a service's protected-data declarations: rotation sinks and
 * encrypted asset-identifier schemes. Called for every module on the boot
 * path (serviceRegistry) and by standalone entrypoints that walk protected
 * data without booting the server (src/rotateProtectedData.ts). Idempotent
 * per service slug so both paths may run in one process.
 */
export function registerServiceProtectedData(module: {
  manifest: { slug: string };
  security?: {
    protectedDataSinks?: ProtectedDataSink[];
    protectedAssetIdentifiers?: Record<string, ProtectedAssetIdentifierScheme>;
  };
}): void {
  if (registeredServiceSlugs.has(module.manifest.slug)) return;
  registeredServiceSlugs.add(module.manifest.slug);
  for (const sink of module.security?.protectedDataSinks ?? []) {
    if (registeredSinks.some((existing) => existing.name === sink.name)) {
      throw new Error(`Protected-data sink name collision: ${sink.name}`);
    }
    registeredSinks.push(sink);
  }
  for (const [assetType, scheme] of Object.entries(
    module.security?.protectedAssetIdentifiers ?? {},
  )) {
    registerProtectedAssetIdentifier(assetType, scheme);
  }
}

/** Register protected columns owned by a provider extension. */
export function registerExtensionProtectedData(
  extensionId: string,
  sinks: readonly ProtectedDataSink[],
): void {
  if (registeredExtensionIds.has(extensionId)) return;
  registeredExtensionIds.add(extensionId);
  for (const sink of sinks) {
    if (registeredSinks.some((existing) => existing.name === sink.name)) {
      throw new Error(`Protected-data sink name collision: ${sink.name}`);
    }
    registeredSinks.push(sink);
  }
}
