export interface StatusNotification {
  idempotencyKey: string;
  recipient: string;
  customerName: string;
  applicationId: string;
  status: string;
}

export interface NotificationSender {
  sendStatusUpdate(notification: StatusNotification): Promise<void>;
}

export class MockEmailProvider implements NotificationSender {
  // Same-process dedup only: a fresh instance (e.g. after a real crash and
  // restart) starts empty, so this does not simulate crash-durable
  // idempotency — that has to come from the real provider's own server-side
  // dedup on this key (see DESIGN.md).
  private readonly sentKeys = new Set<string>();

  async sendStatusUpdate(notification: StatusNotification): Promise<void> {
    if (this.sentKeys.has(notification.idempotencyKey)) return;

    await new Promise((resolve) => setTimeout(resolve, 75));

    if (notification.recipient.endsWith("@retry.invalid")) {
      throw new Error("mock provider is temporarily unavailable");
    }

    this.sentKeys.add(notification.idempotencyKey);
    console.info(
      `[email] sent ${notification.status} update for ${notification.applicationId} to ${notification.recipient}`,
    );
  }
}
