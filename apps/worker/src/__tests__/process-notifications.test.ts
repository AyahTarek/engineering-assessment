import { randomUUID } from "node:crypto";
import { prisma } from "@assessment/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationSender } from "../notification-provider.js";
import { processNotificationBatch } from "../process-notifications.js";

async function resetJobs() {
  await prisma.notificationJob.deleteMany();
  await prisma.applicationStatusHistory.deleteMany();
  await prisma.loanApplication.deleteMany();
  await prisma.customer.deleteMany();

  await prisma.customer.create({
    data: {
      id: "customer-worker",
      name: "Worker Test",
      email: "worker@example.test",
      phone: "+201222222222",
      applications: {
        create: {
          id: "application-worker",
          status: "IN_REVIEW",
          requestedAmountCents: 50_000_00,
          notificationJobs: {
            create: {
              id: randomUUID(),
              sourceEventId: "worker-event-1",
              type: "APPLICATION_STATUS_CHANGED",
              payload: JSON.stringify({ status: "IN_REVIEW" }),
            },
          },
        },
      },
    },
  });
}

describe("notification worker", () => {
  beforeEach(resetJobs);

  it("delivers a pending status notification", async () => {
    const sender: NotificationSender = {
      sendStatusUpdate: vi.fn().mockResolvedValue(undefined),
    };

    const result = await processNotificationBatch(prisma, sender, {
      info: vi.fn(),
      error: vi.fn(),
    });

    expect(result).toEqual({ found: 1, delivered: 1, failed: 0 });
    expect(sender.sendStatusUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "worker-event-1",
        recipient: "worker@example.test",
      }),
    );

    const storedJob = await prisma.notificationJob.findFirstOrThrow();
    expect(storedJob.processedAt).toBeInstanceOf(Date);
    expect(storedJob.attemptCount).toBe(1);
  });

  it("keeps a failed job eligible for retry with backoff", async () => {
    const sender: NotificationSender = {
      sendStatusUpdate: vi.fn().mockRejectedValue(new Error("provider down")),
    };

    const result = await processNotificationBatch(prisma, sender, {
      info: vi.fn(),
      error: vi.fn(),
    });

    expect(result).toEqual({ found: 1, delivered: 0, failed: 1 });

    const storedJob = await prisma.notificationJob.findFirstOrThrow();
    // Not processed and not dead-lettered => still eligible for retry.
    expect(storedJob.processedAt).toBeNull();
    expect(storedJob.deadLetteredAt).toBeNull();
    expect(storedJob.attemptCount).toBe(1);
    expect(storedJob.nextAttemptAt).toBeInstanceOf(Date);
    expect(storedJob.lastError).toBe("provider down");
  });

  it("dead-letters a job once retries are exhausted", async () => {
    const sender: NotificationSender = {
      sendStatusUpdate: vi.fn().mockRejectedValue(new Error("provider down")),
    };
    const logger = { info: vi.fn(), error: vi.fn() };
    // Small policy so the job exhausts on the second attempt.
    const policy = { maxAttempts: 2, backoffMs: () => 0 };

    await processNotificationBatch(prisma, sender, logger, policy);
    await processNotificationBatch(prisma, sender, logger, policy);

    const storedJob = await prisma.notificationJob.findFirstOrThrow();
    expect(storedJob.attemptCount).toBe(2);
    expect(storedJob.deadLetteredAt).toBeInstanceOf(Date);
    expect(storedJob.processedAt).toBeNull();

    // A dead-lettered job is no longer picked up by the poller.
    const followUp = await processNotificationBatch(
      prisma,
      sender,
      logger,
      policy,
    );
    expect(followUp.found).toBe(0);
  });

  it("preserves lastError as history once a previously failing job goes on to succeed", async () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const policy = { maxAttempts: 5, backoffMs: () => 0 };
    const sender: NotificationSender = {
      sendStatusUpdate: vi
        .fn()
        .mockRejectedValueOnce(new Error("provider down"))
        .mockResolvedValueOnce(undefined),
    };

    await processNotificationBatch(prisma, sender, logger, policy);
    const afterFailure = await prisma.notificationJob.findFirstOrThrow();
    expect(afterFailure.lastError).toBe("provider down");

    await processNotificationBatch(prisma, sender, logger, policy);
    const afterSuccess = await prisma.notificationJob.findFirstOrThrow();
    // Current health comes from processedAt, not lastError, which is kept
    // as a record of the last failed attempt rather than cleared on success.
    expect(afterSuccess.processedAt).toBeInstanceOf(Date);
    expect(afterSuccess.lastError).toBe("provider down");
    expect(afterSuccess.attemptCount).toBe(2);
  });
});
