import { describe, it, expect, vi } from "vitest";

vi.mock("@workspace/db", () => {
  const captured: Array<Record<string, unknown>> = [];
  return {
    db: {
      insert: () => ({
        values: async (row: Record<string, unknown>) => {
          captured.push(row);
        },
      }),
    },
    activityLogTable: { __tag: "activityLogTable" },
    __captured: captured,
  };
});

vi.mock("./logger", () => ({
  logger: { error: () => undefined, warn: () => undefined, info: () => undefined },
}));

import { logAdminAction } from "./audit";

async function lastWrite(): Promise<Record<string, unknown>> {
  const mod = (await import("@workspace/db")) as unknown as {
    __captured: Array<Record<string, unknown>>;
  };
  return mod.__captured[mod.__captured.length - 1];
}

describe("logAdminAction redaction", () => {
  it("masks PII string fields in before/after", async () => {
    await logAdminAction({
      type: "admin_attendee_updated",
      summary: "Edit",
      before: { firstName: "Alice", workEmail: "alice@example.com", isTbc: false },
      after: { firstName: "Bob", workEmail: "bob@example.com", isTbc: true },
    });
    const row = await lastWrite();
    const data = row.data as Record<string, unknown>;
    const before = data.before as Record<string, unknown>;
    const after = data.after as Record<string, unknown>;
    expect(before.firstName).toBe("***(5)");
    expect(before.workEmail).toBe("***(17)");
    expect(before.isTbc).toBe(false);
    expect(after.firstName).toBe("***(3)");
    expect(after.workEmail).toBe("***(15)");
    expect(after.isTbc).toBe(true);

    const changes = data.changes as Record<string, { from: unknown; to: unknown }>;
    expect(changes.firstName.from).toBe("***(5)");
    expect(changes.firstName.to).toBe("***(3)");
    expect(changes.workEmail.from).toBe("***(17)");
    expect(changes.isTbc.from).toBe(false);
    expect(changes.isTbc.to).toBe(true);
  });

  it("does not mask non-PII fields like status", async () => {
    await logAdminAction({
      type: "admin_booking_status_changed",
      summary: "Status change",
      before: { status: "partial" },
      after: { status: "paid" },
    });
    const row = await lastWrite();
    const data = row.data as Record<string, unknown>;
    expect((data.before as Record<string, unknown>).status).toBe("partial");
    expect((data.after as Record<string, unknown>).status).toBe("paid");
  });

  it("redacts PII embedded in meta-style address fields", async () => {
    await logAdminAction({
      type: "admin_booking_updated",
      before: { billingAddress: "1 High St", company: "ACME Ltd" },
      after: { billingAddress: "2 Low St", company: "OTHER" },
    });
    const row = await lastWrite();
    const data = row.data as Record<string, unknown>;
    const after = data.after as Record<string, unknown>;
    expect(after.billingAddress).toMatch(/^\*\*\*\(/);
    expect(after.company).toMatch(/^\*\*\*\(/);
  });
});
