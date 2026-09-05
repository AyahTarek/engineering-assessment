import type { PrismaClient } from "@assessment/database";
import type { NotificationSender } from "./notification-provider.js";

export interface WorkerLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface BatchResult {
  found: number;
  delivered: number;
  failed: number;
}

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs(attempt: number): number;
}

export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 5,
  // 2, 4, 8, then capped at 15 min for attempt 4 (the last delay computed —
  // attempt 5 exhausts maxAttempts and dead-letters instead of retrying).
  backoffMs: (attempt) => Math.min(15 * 60_000, 60_000 * 2 ** attempt),
};

export async function processNotificationBatch(
  database: PrismaClient,
  sender: NotificationSender,
  logger: WorkerLogger = console,
  policy: RetryPolicy = defaultRetryPolicy,
): Promise<BatchResult> {
  const now = new Date();
  const jobs = await database.notificationJob.findMany({
    where: {
      processedAt: null,
      deadLetteredAt: null,
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: { createdAt: "asc" },
    take: 20,
  });

  let delivered = 0;
  let failed = 0;

  for (const job of jobs) {
    try {
      const application = await database.loanApplication.findUnique({
        where: { id: job.applicationId },
        include: { customer: true },
      });

      if (!application) {
        throw new Error(`application ${job.applicationId} no longer exists`);
      }

      const payload = JSON.parse(job.payload) as { status: string };
      await sender.sendStatusUpdate({
        idempotencyKey: job.sourceEventId,
        recipient: application.customer.email,
        customerName: application.customer.name,
        applicationId: application.id,
        status: payload.status,
      });

      delivered += 1;
      // Success: mark processed and clear the retry schedule. lastError is
      // left as-is — it's history of the last failed attempt, not current
      // job health (processedAt/deadLetteredAt answer that).
      await database.notificationJob.update({
        where: { id: job.id },
        data: {
          attemptCount: { increment: 1 },
          nextAttemptAt: null,
          processedAt: new Date(),
        },
      });
      logger.info(`notification job ${job.id} delivered`);
    } catch (error) {
      failed += 1;
      const lastError =
        error instanceof Error ? error.message : "unknown error";
      const attemptCount = job.attemptCount + 1;
      const exhausted = attemptCount >= policy.maxAttempts;

      // Failure: keep the job unprocessed so it stays eligible for retry.
      // Once attempts are exhausted, dead-letter it for operator inspection
      // and replay instead of setting processedAt (which would drop it).
      await database.notificationJob.update({
        where: { id: job.id },
        data: {
          attemptCount,
          lastError,
          ...(exhausted
            ? { deadLetteredAt: new Date(), nextAttemptAt: null }
            : {
                nextAttemptAt: new Date(
                  now.getTime() + policy.backoffMs(attemptCount),
                ),
              }),
        },
      });
      logger.error(
        `notification job ${job.id} failed (attempt ${attemptCount}${
          exhausted ? ", dead-lettered" : ""
        }): ${lastError}`,
      );
    }
  }

  return { found: jobs.length, delivered, failed };
}
