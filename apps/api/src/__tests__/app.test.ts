import { randomUUID } from "node:crypto";
import { prisma } from "@assessment/database";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

async function resetApplication() {
  await prisma.notificationJob.deleteMany();
  await prisma.applicationStatusHistory.deleteMany();
  await prisma.loanApplication.deleteMany();
  await prisma.customer.deleteMany();

  await prisma.customer.create({
    data: {
      id: "customer-a",
      name: "Test Customer",
      email: "customer@example.test",
      phone: "+201111111111",
      applications: {
        create: {
          id: "application-a",
          status: "SUBMITTED",
          requestedAmountCents: 100_000_00,
          lastEventOccurredAt: new Date("2026-08-20T08:00:00.000Z"),
          history: {
            create: {
              id: randomUUID(),
              status: "SUBMITTED",
              sourceEventId: "initial-event",
              occurredAt: new Date("2026-08-20T08:00:00.000Z"),
            },
          },
        },
      },
    },
  });

  await prisma.customer.create({
    data: {
      id: "customer-b",
      name: "Other Customer",
      email: "other@example.test",
      phone: "+201333333333",
      applications: {
        create: {
          id: "application-b",
          status: "SUBMITTED",
          requestedAmountCents: 200_000_00,
          lastEventOccurredAt: new Date("2026-08-20T08:00:00.000Z"),
        },
      },
    },
  });
}

describe("application API", () => {
  beforeEach(resetApplication);

  it("returns an application with its history", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const response = await app.inject({
      method: "GET",
      url: "/v1/applications/application-a",
      headers: { "x-customer-id": "customer-a" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "application-a",
      status: "SUBMITTED",
      customer: { id: "customer-a" },
      history: [{ status: "SUBMITTED" }],
    });
    await app.close();
  });

  it("records a valid partner event and queues a notification", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/applications/application-a/status-events",
      payload: {
        eventId: "partner-event-1",
        status: "IN_REVIEW",
        occurredAt: "2026-08-20T09:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().application.status).toBe("IN_REVIEW");
    await expect(
      prisma.applicationStatusHistory.count({
        where: { sourceEventId: "partner-event-1" },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.notificationJob.count({
        where: { sourceEventId: "partner-event-1" },
      }),
    ).resolves.toBe(1);
    await app.close();
  });

  it("rejects malformed partner events", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/applications/application-a/status-events",
      payload: { eventId: "", status: "UNKNOWN", occurredAt: "yesterday" },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("requires a customer identity to read an application", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const response = await app.inject({
      method: "GET",
      url: "/v1/applications/application-a",
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("does not let a customer read another customer's application", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const response = await app.inject({
      method: "GET",
      url: "/v1/applications/application-a",
      headers: { "x-customer-id": "customer-b" },
    });

    // 404 (not 403) so the API does not disclose that the id exists.
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("requires a customer identity to list applications", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const response = await app.inject({
      method: "GET",
      url: "/v1/applications",
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("lists only the applications owned by the caller", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const response = await app.inject({
      method: "GET",
      url: "/v1/applications",
      headers: { "x-customer-id": "customer-a" },
    });

    expect(response.statusCode).toBe(200);
    const { applications } = response.json();
    expect(applications).toHaveLength(1);
    expect(applications[0]).toMatchObject({
      id: "application-a",
      status: "SUBMITTED",
    });
    // Discriminates from "returns everything": customer-b's application
    // must not leak into customer-a's list.
    expect(
      applications.some(
        (application: { id: string }) => application.id === "application-b",
      ),
    ).toBe(false);
    await app.close();
  });

  it("treats a retried event (same eventId) as an idempotent no-op", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const payload = {
      eventId: "partner-event-dup",
      status: "IN_REVIEW",
      occurredAt: "2026-08-20T09:00:00.000Z",
    };

    const first = await app.inject({
      method: "POST",
      url: "/v1/applications/application-a/status-events",
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/applications/application-a/status-events",
      payload,
    });

    expect(first.statusCode).toBe(202);
    expect(first.json().outcome).toBe("accepted");
    expect(second.statusCode).toBe(200);
    expect(second.json().outcome).toBe("duplicate");

    // Exactly one history row and one notification job for the event.
    await expect(
      prisma.applicationStatusHistory.count({
        where: { sourceEventId: "partner-event-dup" },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.notificationJob.count({
        where: { sourceEventId: "partner-event-dup" },
      }),
    ).resolves.toBe(1);
    await app.close();
  });

  it("keeps current state at the newest event when events arrive out of order", async () => {
    const app = buildApp({ database: prisma, logger: false });

    // Newer event arrives first and becomes current state.
    await app.inject({
      method: "POST",
      url: "/v1/applications/application-a/status-events",
      payload: {
        eventId: "event-newer",
        status: "IN_REVIEW",
        occurredAt: "2026-08-21T10:00:00.000Z",
      },
    });

    // Older, late-arriving event must not overwrite current state and has no
    // effect at all (a stale event was never applied).
    const stale = await app.inject({
      method: "POST",
      url: "/v1/applications/application-a/status-events",
      payload: {
        eventId: "event-older",
        status: "SUBMITTED",
        occurredAt: "2026-08-20T09:00:00.000Z",
      },
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.json().outcome).toBe("stale");

    const read = await app.inject({
      method: "GET",
      url: "/v1/applications/application-a",
      headers: { "x-customer-id": "customer-a" },
    });

    expect(read.statusCode).toBe(200);
    expect(read.json().status).toBe("IN_REVIEW");
    // A stale event leaves no trace: no history row and no notification.
    await expect(
      prisma.applicationStatusHistory.count({
        where: { sourceEventId: "event-older" },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.notificationJob.count({
        where: { sourceEventId: "event-older" },
      }),
    ).resolves.toBe(0);
    await app.close();
  });

  it("allows the same eventId on different applications", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const payload = {
      eventId: "shared-event",
      status: "IN_REVIEW",
      occurredAt: "2026-08-21T10:00:00.000Z",
    };

    const onA = await app.inject({
      method: "POST",
      url: "/v1/applications/application-a/status-events",
      payload,
    });
    // Same eventId on a different application must not be treated as a duplicate.
    const onB = await app.inject({
      method: "POST",
      url: "/v1/applications/application-b/status-events",
      payload,
    });

    expect(onA.json().outcome).toBe("accepted");
    expect(onB.json().outcome).toBe("accepted");
    await expect(
      prisma.applicationStatusHistory.count({
        where: { sourceEventId: "shared-event" },
      }),
    ).resolves.toBe(2);
    await app.close();
  });

  it("creates at most one notification job when the same event races concurrently", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const payload = {
      eventId: "race-event",
      status: "IN_REVIEW",
      occurredAt: "2026-08-20T09:00:00.000Z",
    };

    const [first, second] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/applications/application-a/status-events",
        payload,
      }),
      app.inject({
        method: "POST",
        url: "/v1/applications/application-a/status-events",
        payload,
      }),
    ]);

    // Exactly one request actually applied the event; the other is a no-op,
    // whether it lost the race at the pre-check or at the unique constraint.
    expect([first.json().outcome, second.json().outcome].sort()).toEqual([
      "accepted",
      "duplicate",
    ]);
    await expect(
      prisma.applicationStatusHistory.count({
        where: { sourceEventId: "race-event" },
      }),
    ).resolves.toBe(1);
    // NotificationJob has no unique constraint of its own; this proves job
    // creation is still gated by the history table's unique constraint
    // inside the same transaction, so a real race can't produce two jobs.
    await expect(
      prisma.notificationJob.count({
        where: { sourceEventId: "race-event" },
      }),
    ).resolves.toBe(1);
    await app.close();
  });

  it("rejects any event once an application is terminal, even with a newer timestamp", async () => {
    const app = buildApp({ database: prisma, logger: false });

    // Move application-a into a terminal state.
    await prisma.loanApplication.update({
      where: { id: "application-a" },
      data: {
        status: "DISBURSED",
        lastEventOccurredAt: new Date("2026-08-20T12:00:00.000Z"),
      },
    });

    // A genuinely newer event (later timestamp, new eventId) must still be
    // refused: "this loan is finished" outranks "this event is newer".
    const response = await app.inject({
      method: "POST",
      url: "/v1/applications/application-a/status-events",
      payload: {
        eventId: "post-terminal-event",
        status: "SUBMITTED",
        occurredAt: "2026-08-20T20:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().outcome).toBe("terminal");

    // Status is unchanged and the event left no trace.
    const read = await app.inject({
      method: "GET",
      url: "/v1/applications/application-a",
      headers: { "x-customer-id": "customer-a" },
    });
    expect(read.json().status).toBe("DISBURSED");
    await expect(
      prisma.applicationStatusHistory.count({
        where: { sourceEventId: "post-terminal-event" },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.notificationJob.count({
        where: { sourceEventId: "post-terminal-event" },
      }),
    ).resolves.toBe(0);
    await app.close();
  });

  it("rejects a skipped-step transition even with a newer timestamp", async () => {
    const app = buildApp({ database: prisma, logger: false });

    // application-a is SUBMITTED; jumping straight to APPROVED skips
    // IN_REVIEW and OFFERED, which DOMAIN.md's lifecycle does not permit.
    const response = await app.inject({
      method: "POST",
      url: "/v1/applications/application-a/status-events",
      payload: {
        eventId: "skip-step-event",
        status: "APPROVED",
        occurredAt: "2026-08-20T09:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().outcome).toBe("invalid");

    const read = await app.inject({
      method: "GET",
      url: "/v1/applications/application-a",
      headers: { "x-customer-id": "customer-a" },
    });
    expect(read.json().status).toBe("SUBMITTED");
    await expect(
      prisma.applicationStatusHistory.count({
        where: { sourceEventId: "skip-step-event" },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.notificationJob.count({
        where: { sourceEventId: "skip-step-event" },
      }),
    ).resolves.toBe(0);
    await app.close();
  });

  it("rejects a backward transition even with a newer timestamp", async () => {
    const app = buildApp({ database: prisma, logger: false });

    // Move application-a to OFFERED first.
    await app.inject({
      method: "POST",
      url: "/v1/applications/application-a/status-events",
      payload: {
        eventId: "to-in-review",
        status: "IN_REVIEW",
        occurredAt: "2026-08-20T09:00:00.000Z",
      },
    });
    await app.inject({
      method: "POST",
      url: "/v1/applications/application-a/status-events",
      payload: {
        eventId: "to-offered",
        status: "OFFERED",
        occurredAt: "2026-08-20T10:00:00.000Z",
      },
    });

    // A later event trying to move OFFERED back to IN_REVIEW is not a legal
    // edge in the lifecycle graph, regardless of its timestamp.
    const response = await app.inject({
      method: "POST",
      url: "/v1/applications/application-a/status-events",
      payload: {
        eventId: "backward-event",
        status: "IN_REVIEW",
        occurredAt: "2026-08-20T11:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().outcome).toBe("invalid");

    const read = await app.inject({
      method: "GET",
      url: "/v1/applications/application-a",
      headers: { "x-customer-id": "customer-a" },
    });
    expect(read.json().status).toBe("OFFERED");
    await app.close();
  });
});
