import { randomUUID } from "node:crypto";
import type {
  ApplicationStatus,
  ApplicationView,
  StatusEventInput,
} from "@assessment/contracts";
import { Prisma, type PrismaClient } from "@assessment/database";

export class ApplicationNotFoundError extends Error {
  constructor(applicationId: string) {
    super(`Application ${applicationId} was not found`);
    this.name = "ApplicationNotFoundError";
  }
}

export type RecordOutcome = "accepted" | "duplicate" | "stale" | "terminal";

// DECLINED and DISBURSED are terminal per DOMAIN.md; enforced directly rather
// than modelling the ambiguous full transition graph. Typed against
// ApplicationStatus so a renamed/removed status fails to compile here.
const TERMINAL_STATUSES: ReadonlySet<ApplicationStatus> =
  new Set<ApplicationStatus>(["DECLINED", "DISBURSED"]);

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

      // Idempotency is scoped per application, not globally by eventId.
      const alreadyRecorded = await tx.applicationStatusHistory.findFirst({
        where: { applicationId, sourceEventId: event.eventId },
      });
      if (alreadyRecorded) return "duplicate";

      // Checked before staleness: a finished loan rejects further events even
      // when their timestamp is newer.
      if (TERMINAL_STATUSES.has(application.status as ApplicationStatus)) {
        return "terminal";
      }

      const isNewer =
        !application.lastEventOccurredAt ||
        occurredAt > application.lastEventOccurredAt;

      // A superseded (older) event has no effect: no history, state, or
      // notification. Audit of "seen but not acted on" belongs in an operator
      // log (see DESIGN.md), not the customer-facing history.
      if (!isNewer) return "stale";

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
