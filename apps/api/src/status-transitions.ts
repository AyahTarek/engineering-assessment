import type { ApplicationStatus } from "@assessment/contracts";

// The application lifecycle state machine (see DOMAIN.md), kept in one place
// so callers reason about transitions via isTerminal/canTransition instead of
// touching these tables directly.

// DECLINED and DISBURSED are terminal per DOMAIN.md; enforced directly rather
// than modelling the ambiguous full transition graph. Typed against
// ApplicationStatus so a renamed/removed status fails to compile here.
const TERMINAL_STATUSES: ReadonlySet<ApplicationStatus> =
  new Set<ApplicationStatus>(["DECLINED", "DISBURSED"]);

// Keyed on non-terminal statuses only — TERMINAL_STATUSES is checked first, so
// a terminal status never reaches this lookup — but Exclude<> still forces a
// compile error if a new non-terminal status is ever added without an entry.
type NonTerminalStatus = Exclude<ApplicationStatus, "DECLINED" | "DISBURSED">;

// The full lifecycle graph from DOMAIN.md. Only these edges are legal; every
// other pair (backward moves, skipped steps, staying put) is "invalid".
const ALLOWED_TRANSITIONS: Readonly<
  Record<NonTerminalStatus, ReadonlySet<ApplicationStatus>>
> = {
  SUBMITTED: new Set<ApplicationStatus>(["IN_REVIEW", "DECLINED"]),
  IN_REVIEW: new Set<ApplicationStatus>(["OFFERED", "DECLINED"]),
  OFFERED: new Set<ApplicationStatus>(["APPROVED", "DECLINED"]),
  APPROVED: new Set<ApplicationStatus>(["DISBURSED"]),
};

// Fallback for a status with no entry above (only reachable if the
// TERMINAL_STATUSES guard is ever removed/reordered) — fails closed as
// "invalid" instead of throwing on `undefined.has(...)`.
const NO_TRANSITIONS: ReadonlySet<ApplicationStatus> = new Set();

export function isTerminalStatus(status: ApplicationStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

// Encapsulates the terminal check and NO_TRANSITIONS fallback so callers never
// touch ALLOWED_TRANSITIONS directly or need to know it's keyed on
// NonTerminalStatus; safe to call standalone since it short-circuits on
// isTerminal itself.
export function canTransition(
  from: ApplicationStatus,
  to: ApplicationStatus,
): boolean {
  if (isTerminalStatus(from)) return false;
  const allowedNext =
    ALLOWED_TRANSITIONS[from as NonTerminalStatus] ?? NO_TRANSITIONS;
  return allowedNext.has(to);
}
