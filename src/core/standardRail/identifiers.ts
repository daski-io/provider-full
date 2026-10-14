import { randomUUID } from "node:crypto";

// Identifiers the provider mints for standard-rail records. They are opaque
// and unguessable; one module owns their generation.

/** The provider task id of a newly admitted standard order. */
export function newStandardTaskId(): string {
  return `task-${randomUUID()}`;
}

/** The id of a buyer support message, published in its support receipt. */
export function newSupportMessageId(): string {
  return randomUUID();
}

/** The id a newly opened support Review takes, published in its receipt. */
export function newSupportReviewId(): string {
  return randomUUID();
}
