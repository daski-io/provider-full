import { vi } from "vitest";

/*
 * Dates like those signed into published long-lived standard-rail artifacts:
 * issued on 2026-09-25, envelopes valid before 2027-03-24, servicing
 * admissions and action definitions before 2027-03-23, the active rail
 * profile's admission window ending 2027-03-13. The provider keeps these
 * values as signed and never enforces them: the global rail policy, the
 * servicing admission, the action catalog and its definitions keep serving
 * after them. Only their signer, network and hashes are checked.
 */
const seconds = (iso: string): number => Date.parse(iso) / 1_000;

export const ARTIFACT_ISSUED_AT = seconds("2026-09-25T21:28:08Z");
export const ENVELOPE_VALID_BEFORE = seconds("2027-03-24T21:28:08Z");
export const SERVICING_VALID_BEFORE = seconds("2027-03-23T21:28:08Z");
export const RAIL_ADMISSION_VALID_BEFORE = seconds("2027-03-13T21:28:08Z");

/** Clocks after every one of those dates: just after, and five years on. */
export const AFTER_EXPIRY = ["2027-04-01T00:00:00Z", "2032-06-01T00:00:00Z"] as const;

/** Fake only the wall clock, so promises and timers run as usual. */
export function setClock(iso: string): number {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
  return Math.floor(Date.now() / 1_000);
}

export function restoreClock(): void {
  vi.useRealTimers();
}
