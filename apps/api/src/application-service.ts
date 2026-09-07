import { randomUUID } from "node:crypto";
import type {
  ApplicationStatus,
  ApplicationView,
  StatusEventInput,
} from "@assessment/contracts";
import { Prisma, type PrismaClient } from "@assessment/database";
import { canTransition, isTerminalStatus } from "./status-transitions.js";

export class ApplicationNotFoundError extends Error {
  constructor(applicationId: string) {
    super(`Application ${applicationId} was not found`);
    this.name = "ApplicationNotFoundError";
  }
}

export type RecordOutcome =
  | "accepted"
  | "duplicate"
  | "stale"
  | "terminal"
  | "invalid";

export interface RecordStatusEventResult {
  outcome: RecordOutcome;
  application: ApplicationView;
}

async function findApplication(
  database: PrismaClient,
  where: Prisma.LoanApplicationWhereInput,
): Promise<ApplicationView | null> {
  const application = await database.loanApplication.findFirst({
    where,
    include: {
      customer: true,
      history: { orderBy: { occurredAt: "desc" } },
    },
  });

  if (!application) return null;

  return {
    id: application.id,
    status: application.status as ApplicationStatus,
    requestedAmountCents: application.requestedAmountCents,
    currency: application.currency,
    createdAt: application.createdAt.toISOString(),
    updatedAt: application.updatedAt.toISOString(),
    customer: {
      id: application.customer.id,
      name: application.customer.name,
      email: application.customer.email,
      phone: application.customer.phone,
    },
    history: application.history.map((entry) => ({
      id: entry.id,
      status: entry.status as ApplicationStatus,
      reason: entry.reason,
      occurredAt: entry.occurredAt.toISOString(),
      recordedAt: entry.recordedAt.toISOString(),
    })),
  };
}

// Unscoped: only for trusted internal callers (e.g. re-reading after a
// partner webhook) that have no customer session to scope by.
function getApplication(
  database: PrismaClient,
  applicationId: string,
): Promise<ApplicationView | null> {
  return findApplication(database, { id: applicationId });
}

// Scoped by customerId so a caller can only read applications they own;
// returning null (=> 404) avoids disclosing that the id exists to others.
export function getApplicationForCustomer(
  database: PrismaClient,
  applicationId: string,
  customerId: string,
): Promise<ApplicationView | null> {
  return findApplication(database, { id: applicationId, customerId });
}

export interface ApplicationSummary {
  id: string;
  status: ApplicationStatus;
  updatedAt: string;
}

// Scoped by customerId; lets a caller (e.g. the web app's homepage) discover
// which application(s) belong to them instead of a hardcoded id.
export async function listApplicationsForCustomer(
  database: PrismaClient,
  customerId: string,
): Promise<ApplicationSummary[]> {
  const applications = await database.loanApplication.findMany({
    where: { customerId },
    orderBy: { updatedAt: "desc" },
    select: { id: true, status: true, updatedAt: true },
  });

  return applications.map((application) => ({
    id: application.id,
    status: application.status as ApplicationStatus,
    updatedAt: application.updatedAt.toISOString(),
  }));
}

export async function recordStatusEvent(
  database: PrismaClient,
  applicationId: string,
  event: StatusEventInput,
): Promise<RecordStatusEventResult> {
  const occurredAt = new Date(event.occurredAt);

  let outcome: RecordOutcome;
  try {
    outcome = await database.$transaction(async (tx) => {
      const application = await tx.loanApplication.findUnique({
        where: { id: applicationId },
      });

      if (!application) throw new ApplicationNotFoundError(applicationId);

      // Checked first, before any state-based rule: a retried eventId may
      // have already advanced current status past what it represents, so
      // re-validating it against current status would be comparing the
      // wrong pair. Idempotency is scoped per application, not globally.
      const alreadyRecorded = await tx.applicationStatusHistory.findFirst({
        where: { applicationId, sourceEventId: event.eventId },
      });
      if (alreadyRecorded) return "duplicate";

      // Checked before staleness: a finished loan rejects further events even
      // when their timestamp is newer.
      if (isTerminalStatus(application.status as ApplicationStatus)) {
        return "terminal";
      }

      const isNewer =
        !application.lastEventOccurredAt ||
        occurredAt > application.lastEventOccurredAt;

      // Checked before transition validity, for the same reason as above: a
      // stale event's context predates the current status, so current status
      // is the wrong baseline to validate its edge against. No history,
      // state, or notification. Audit of "seen but not acted on" belongs in
      // an operator log (see DESIGN.md), not the customer-facing history.
      if (!isNewer) return "stale";

      // Last gate before mutating: event is new, app is alive, and it's not
      // superseded, so current status is now a meaningful baseline. Reject an
      // illegal edge (backward move, skipped step, no-op restate) the same
      // way as a stale event: no history, state, or notification.
      if (
        !canTransition(application.status as ApplicationStatus, event.status)
      ) {
        return "invalid";
      }

      await tx.applicationStatusHistory.create({
        data: {
          id: randomUUID(),
          applicationId,
          status: event.status,
          reason: event.reason,
          sourceEventId: event.eventId,
          occurredAt,
        },
      });

      await tx.loanApplication.update({
        where: { id: applicationId },
        data: {
          status: event.status,
          lastEventOccurredAt: occurredAt,
        },
      });

      await tx.notificationJob.create({
        data: {
          id: randomUUID(),
          applicationId,
          sourceEventId: event.eventId,
          type: "APPLICATION_STATUS_CHANGED",
          payload: JSON.stringify({
            status: event.status,
            reason: event.reason ?? null,
          }),
        },
      });

      return "accepted";
    });
  } catch (error) {
    // A concurrent duplicate loses the race on the unique sourceEventId; treat
    // it as an idempotent no-op rather than a server error.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      outcome = "duplicate";
    } else {
      throw error;
    }
  }

  const application = await getApplication(database, applicationId);
  if (!application) throw new ApplicationNotFoundError(applicationId);
  return { outcome, application };
}
