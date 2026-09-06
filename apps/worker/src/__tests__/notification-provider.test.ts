import { describe, expect, it, vi } from "vitest";
import { MockEmailProvider } from "../notification-provider.js";

describe("MockEmailProvider", () => {
  it("does not re-send for a repeated idempotencyKey on the same instance", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const provider = new MockEmailProvider();
    const notification = {
      idempotencyKey: "event-1",
      recipient: "customer@example.test",
      customerName: "Test Customer",
      applicationId: "application-a",
      status: "IN_REVIEW",
    };

    await provider.sendStatusUpdate(notification);
    await provider.sendStatusUpdate(notification);

    expect(info).toHaveBeenCalledTimes(1);
    info.mockRestore();
  });

  it("sends again for the same key on a new instance (no cross-restart durability)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const notification = {
      idempotencyKey: "event-1",
      recipient: "customer@example.test",
      customerName: "Test Customer",
      applicationId: "application-a",
      status: "IN_REVIEW",
    };

    await new MockEmailProvider().sendStatusUpdate(notification);
    // A fresh instance simulates a process restart after a crash — the
    // in-memory dedup set is gone, so this is a real second send.
    await new MockEmailProvider().sendStatusUpdate(notification);

    expect(info).toHaveBeenCalledTimes(2);
    info.mockRestore();
  });
});
