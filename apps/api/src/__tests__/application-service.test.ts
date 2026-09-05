import { Prisma, type PrismaClient } from "@assessment/database";
import { describe, expect, it, vi } from "vitest";
import { recordStatusEvent } from "../application-service.js";

describe("recordStatusEvent concurrency", () => {
  it("treats a unique-constraint violation from a concurrent duplicate as an idempotent no-op", async () => {
    // Simulates two requests racing past the in-transaction "already
    // recorded?" pre-check; the loser hits the @@unique([applicationId,
    // sourceEventId]) constraint and Prisma surfaces it as P2002.
    const database = {
      $transaction: vi.fn().mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "test",
        }),
      ),
      loanApplication: {
        findFirst: vi.fn().mockResolvedValue({
          id: "application-a",
          status: "SUBMITTED",
          requestedAmountCents: 100_000_00,
          currency: "EGP",
          createdAt: new Date("2026-08-20T08:00:00.000Z"),
          updatedAt: new Date("2026-08-20T08:00:00.000Z"),
          customer: {
            id: "customer-a",
            name: "Test Customer",
            email: "customer@example.test",
            phone: "+201111111111",
          },
          history: [],
        }),
      },
    } as unknown as PrismaClient;

    const result = await recordStatusEvent(database, "application-a", {
      eventId: "racy-event",
      status: "IN_REVIEW",
      occurredAt: "2026-08-20T09:00:00.000Z",
    });

    // The losing request reports "duplicate" (not a 500) and still returns
    // the current, unchanged application view.
    expect(result.outcome).toBe("duplicate");
    expect(result.application.status).toBe("SUBMITTED");
    expect(database.$transaction).toHaveBeenCalledTimes(1);
  });

  it("rethrows a non-conflict database error instead of masking it as a duplicate", async () => {
    const database = {
      $transaction: vi.fn().mockRejectedValue(new Error("connection lost")),
    } as unknown as PrismaClient;

    await expect(
      recordStatusEvent(database, "application-a", {
        eventId: "some-event",
        status: "IN_REVIEW",
        occurredAt: "2026-08-20T09:00:00.000Z",
      }),
    ).rejects.toThrow("connection lost");
  });
});
