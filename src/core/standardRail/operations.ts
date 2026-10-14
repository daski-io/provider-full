import { z } from "zod";

// The public operations view signed into every dispatch and status answer.
// It mirrors the gateway's strict consumer schema for the sections this
// starter can own. The starter has no fulfillment-wait or paid-recovery
// subsystem, so those sections are always null; a stored non-null value fails
// closed instead of being signed. Support appears once support receipts exist.
const time = z.number().int().nonnegative();
const id = z.string().min(1).max(128);

const supportViewSchema = z.object({
  reviewId: id,
  status: z.enum(["open", "closed"]),
  lastAcceptedRequest: z.object({ requestId: id, messageId: id, acceptedAt: time }).strict(),
  lastReply: z.object({
    messageId: id, repliedAt: time, message: z.string().min(1).max(4_000),
  }).strict().optional(),
}).strict();

/** The persisted semantic projection: everything except schemaVersion, revision and observedAt. */
export const operationsProjectionSchema = z.object({
  fulfillment: z.null(),
  support: supportViewSchema.nullable(),
  recovery: z.null(),
}).strict();

export const operationsSchema = operationsProjectionSchema.extend({
  schemaVersion: z.literal(1),
  revision: time,
  observedAt: time,
}).strict();

export type OrderOperations = z.infer<typeof operationsSchema>;

/**
 * One fresh operations observation for a signed answer: the stored semantic
 * projection and revision, observed at the database time of this read. It is
 * never cached; every answer stamps and signs its own observation.
 */
export function observeOperations(row: {
  revision: string | number;
  projection: unknown;
  observedAt: string | number;
}): OrderOperations {
  const projection = operationsProjectionSchema.parse(row.projection);
  return operationsSchema.parse({
    schemaVersion: 1,
    revision: Number(row.revision),
    observedAt: Number(row.observedAt),
    ...projection,
  });
}
