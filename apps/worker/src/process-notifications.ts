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

// How long a claim is honored before another worker may treat it as
// abandoned (e.g. the claimant crashed) and reclaim the job. Must stay well
// above realistic processing time, or a slow-but-alive worker could have its
// own claim stolen out from under it.
const DEFAULT_CLAIM_VISIBILITY_MS = 60_000;

export async function processNotificationBatch(
  database: PrismaClient,
  sender: NotificationSender,
  logger: WorkerLogger = console,
  policy: RetryPolicy = defaultRetryPolicy,
  claimVisibilityMs: number = DEFAULT_CLAIM_VISIBILITY_MS,
): Promise<BatchResult> {
  const now = new Date();
  const claimStaleBefore = new Date(now.getTime() - claimVisibilityMs);
  // A job is eligible if unclaimed, or claimed so long ago the claimant is
  // presumed dead. Reused identically by the read below and the atomic claim,
  // so the claim's WHERE re-checks the same condition instead of trusting it.
  const notClaimed = {
    OR: [{ claimedAt: null }, { claimedAt: { lt: claimStaleBefore } }],
  };

  const jobs = await database.notificationJob.findMany({
    where: {
      processedAt: null,
      deadLetteredAt: null,
      AND: [
        { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
        notClaimed,
      ],
    },
    orderBy: { createdAt: "asc" },
    take: 20,
  });

  let delivered = 0;
  let failed = 0;

  for (const job of jobs) {
    // Atomic claim: this single UPDATE...WHERE is what actually prevents two
    // workers from both delivering the same job, not the read above (which
    // can always be stale by the time we act on it). A losing worker's WHERE
    // matches zero rows here instead of racing past a separate check.
    const claim = await database.notificationJob.updateMany({
      where: {
        id: job.id,
        processedAt: null,
        deadLetteredAt: null,
        AND: [notClaimed],
      },
      data: { claimedAt: now },
    });
    if (claim.count === 0) continue;

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

      // Re-check ownership atomically: if our claim went stale mid-send
      // (the visibility window elapsed before we finished), another worker
      // may have already reclaimed and sent this job too. Don't overwrite
      // its bookkeeping or count our own send as a clean, exclusive delivery.
      const finish = await database.notificationJob.updateMany({
        where: { id: job.id, claimedAt: now },
        data: {
          attemptCount: { increment: 1 },
          nextAttemptAt: null,
          claimedAt: null,
          processedAt: new Date(),
        },
      });
      if (finish.count === 0) {
        logger.error(
          `notification job ${job.id} lost its claim before finishing; a duplicate send may have occurred`,
        );
        continue;
      }
      delivered += 1;
      logger.info(`notification job ${job.id} delivered`);
    } catch (error) {
      const lastError =
        error instanceof Error ? error.message : "unknown error";
      const attemptCount = job.attemptCount + 1;
      const exhausted = attemptCount >= policy.maxAttempts;

      // Same ownership re-check as the success path, and for the same
      // reason: don't record a failed attempt or dead-letter a job against a
      // claim we no longer hold.
      const finish = await database.notificationJob.updateMany({
        where: { id: job.id, claimedAt: now },
        data: {
          attemptCount,
          lastError,
          claimedAt: null,
          ...(exhausted
            ? { deadLetteredAt: new Date(), nextAttemptAt: null }
            : {
                nextAttemptAt: new Date(
                  now.getTime() + policy.backoffMs(attemptCount),
                ),
              }),
        },
      });
      if (finish.count === 0) {
        logger.error(
          `notification job ${job.id} lost its claim before recording failure`,
        );
        continue;
      }
      failed += 1;
      logger.error(
        `notification job ${job.id} failed (attempt ${attemptCount}${
          exhausted ? ", dead-lettered" : ""
        }): ${lastError}`,
      );
    }
  }

  return { found: jobs.length, delivered, failed };
}
