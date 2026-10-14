import { randomUUID } from "node:crypto";

// Identifiers the provider mints for standard-rail records. They are opaque
// and unguessable; one module owns their generation.

/** The provider task id of a newly admitted standard order. */
export function newStandardTaskId(): string {
  return `task-${randomUUID()}`;
}
