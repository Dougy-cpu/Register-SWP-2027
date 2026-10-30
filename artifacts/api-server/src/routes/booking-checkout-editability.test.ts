import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { eq } from "drizzle-orm";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../../../lib/db/src/schema";

let database: PGlite;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
let server: http.Server;
let baseUrl: string;

const services = vi.hoisted(() => ({
  calculatePricing: vi.fn(),
  logAdminAction: vi.fn(),
  sendReissuedInvoiceEmail: vi.fn(),
  sendBillingEditNotification: vi.fn(),
  reissueBookingInvoice: vi.fn(),
}));

vi.mock("@workspace/db", async () => ({
  ...(await import("../../../../lib/db/src/schema")),
  db: new Proxy({}, { get: (_, key) => Reflect.get(testDb, key) }),
}));
vi.mock("../lib/pricing", () => ({ calculatePricing: services.calculatePricing }));
vi.mock("../lib/audit", () => ({ logAdminAction: services.logAdminAction }));
vi.mock("../lib/sponsor-redemptions", () => ({ reservePromoUsageForBooking: vi.fn() }));
vi.mock("./promo-codes", () => ({ isCodeUsedByEmail: vi.fn() }));
vi.mock("../middleware/admin-auth", () => ({
  getAdminPassword: () => "test-admin-password",
  verifyAdminToken: (token: string) => ({ valid: token === "test-admin-token" }),
}));
vi.mock("../lib/email", () => ({
  sendIncompleteFormNotification: vi.fn(),
  sendReissuedInvoiceEmail: services.sendReissuedInvoiceEmail,
  sendBillingEditNotification: services.sendBillingEditNotification,
  diffBillingFields: () => [],
  getEventSettings: async () => ({ attendeeChangesLocked: false }),
  resolveLatestBookingPdf: vi.fn(),
  resendConfirmationAndReceipt: vi.fn(),
}));
vi.mock("../lib/booking-confirmation", () => ({ runConfirmationSideEffects: vi.fn() }));
vi.mock("../lib/invoice", () => ({
  reissueBookingInvoice: services.reissueBookingInvoice,
  applyReissueInvoiceResultTx: vi.fn(),
  getStripeInvoiceStatus: vi.fn(),
  refreshStripeInvoiceStatusIfStale: vi.fn(),
  refreshStripeInvoiceUrls: vi.fn(),
}));
vi.mock("../lib/stripe-client", () => ({ getStripe: () => null }));
vi.mock("../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import bookingsRouter from "./bookings";

function pricing(quantity: number) {
  return {
    subtotalAfterDiscounts: 189 * quantity,
    vatAmount: 37.8 * quantity,
    total: 226.8 * quantity,
    groupDiscountAmount: 0,
    promoDiscountAmount: 0,
  };
}

beforeAll(async () => {
  database = new PGlite();
  testDb = drizzle(database, { schema });
  // Use the production column types and names, with no external database or
  // unrelated tables. The status predicate below is executed by PostgreSQL.
  for (const definition of [
    schema.bookingStatusEnum,
    schema.passTypeEnum,
    schema.attendeeTypeEnum,
    schema.paymentMethodEnum,
    schema.registrationSourceEnum,
  ]) {
    await database.exec(
      `CREATE TYPE "${definition.enumName}" AS ENUM (${definition.enumValues.map((value) => `'${value}'`).join(", ")})`,
    );
  }
  const columns = getTableConfig(schema.bookingsTable).columns.map(
    (column) => `"${column.name}" ${column.getSQLType()}`,
  );
  await database.exec(`CREATE TABLE bookings (${columns.join(", ")})`);

  const app = express();
  app.use(express.json());
  app.use("/api", bookingsRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 20_000);

beforeEach(async () => {
  vi.clearAllMocks();
  services.calculatePricing
    .mockReset()
    .mockImplementation(async (_passType: string, quantity: number) => pricing(quantity));
  await database.exec("DELETE FROM bookings");
  await testDb.insert(schema.bookingsTable).values({
    id: 42,
    sessionToken: "checkout-owner",
    managementToken: "invoice-management-token",
    status: "partial",
    passType: "single",
    attendeeType: "hr_professional",
    quantity: 1,
    paymentMethod: "card",
    subtotalAmount: "189.00",
    vatAmount: "37.80",
    totalAmount: "226.80",
    billingAddressLine1: "Original billing address",
    currentStep: 4,
    orderReference: "SWP27-0042",
    createdAt: new Date("2026-10-30T12:00:00Z"),
    updatedAt: new Date("2026-10-30T12:00:00Z"),
  });
});

afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  await database?.close();
});

async function currentBooking() {
  const [row] = await testDb
    .select()
    .from(schema.bookingsTable)
    .where(eq(schema.bookingsTable.id, 42));
  return row;
}

async function patch(
  body: Record<string, unknown>,
  headers: Record<string, string> = { "x-booking-session": "checkout-owner" },
) {
  return fetch(`${baseUrl}/api/bookings/42`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function expectNoDeliveryOrReissue() {
  expect(services.sendReissuedInvoiceEmail).not.toHaveBeenCalled();
  expect(services.sendBillingEditNotification).not.toHaveBeenCalled();
  expect(services.reissueBookingInvoice).not.toHaveBeenCalled();
}

describe("public checkout booking editability", () => {
  it.each(["partial", "pending_payment"] as const)(
    "continues to save an owned %s booking",
    async (status) => {
      await testDb
        .update(schema.bookingsTable)
        .set({ status })
        .where(eq(schema.bookingsTable.id, 42));
      const response = await patch({ billingAddressLine1: "Updated address", currentStep: 3 });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        status,
        billingAddressLine1: "Updated address",
        currentStep: 3,
      });
      expect((await currentBooking()).billingAddressLine1).toBe("Updated address");
      expectNoDeliveryOrReissue();
    },
  );

  it.each(["paid", "invoiced", "cancelled", "refunded", "transferred", "disputed"] as const)(
    "refuses authenticated public edits to a %s booking without changing any row values",
    async (status) => {
      await testDb
        .update(schema.bookingsTable)
        .set({ status })
        .where(eq(schema.bookingsTable.id, 42));
      const before = await currentBooking();
      const response = await patch({
        billingAddressLine1: "Late autosave",
        quantity: 2,
        currentStep: 4,
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "This booking is no longer editable through checkout.",
      });
      expect(await currentBooking()).toEqual(before);
      expect(services.calculatePricing).not.toHaveBeenCalled();
      expectNoDeliveryOrReissue();
    },
  );

  it.each([
    { initial: "partial", completed: "invoiced" },
    { initial: "pending_payment", completed: "paid" },
  ] as const)(
    "rejects a stale $initial update if payment becomes $completed between read and write",
    async ({ initial, completed }) => {
      await testDb
        .update(schema.bookingsTable)
        .set({ status: initial })
        .where(eq(schema.bookingsTable.id, 42));
      services.calculatePricing.mockImplementationOnce(async () => {
        // Simulate confirmation winning after PATCH reads the row, while its
        // price lookup is in progress. The route must reject at the SQL write.
        await testDb
          .update(schema.bookingsTable)
          .set({
            status: completed,
            currentStep: 5,
            billingAddressLine1: "Confirmed billing address",
          })
          .where(eq(schema.bookingsTable.id, 42));
        return pricing(2);
      });
      const response = await patch({
        billingAddressLine1: "Stale draft",
        quantity: 2,
        currentStep: 4,
      });

      expect(response.status).toBe(409);
      expect(await currentBooking()).toMatchObject({
        status: completed,
        currentStep: 5,
        quantity: 1,
        billingAddressLine1: "Confirmed billing address",
        totalAmount: "226.80",
      });
      expectNoDeliveryOrReissue();
    },
  );

  it("still checks ownership before reporting that a booking is no longer editable", async () => {
    await testDb
      .update(schema.bookingsTable)
      .set({ status: "paid" })
      .where(eq(schema.bookingsTable.id, 42));
    const response = await patch(
      { billingAddressLine1: "Not the owner" },
      { "x-booking-session": "other-booking" },
    );
    expect(response.status).toBe(403);
    expect((await currentBooking()).billingAddressLine1).toBe("Original billing address");
    expect(services.calculatePricing).not.toHaveBeenCalled();
  });

  it("preserves authenticated admin edits and their audit record on a completed booking", async () => {
    await testDb
      .update(schema.bookingsTable)
      .set({ status: "paid" })
      .where(eq(schema.bookingsTable.id, 42));
    const response = await patch(
      { billingAddressLine1: "Admin correction" },
      { "x-admin-token": "test-admin-token" },
    );

    expect(response.status).toBe(200);
    expect((await currentBooking()).billingAddressLine1).toBe("Admin correction");
    expect(services.logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "admin_booking_updated",
        bookingId: 42,
        after: expect.objectContaining({ billingAddressLine1: "Admin correction" }),
      }),
    );
  });

  it("leaves the separate management-token billing flow available for an unpaid invoice", async () => {
    await testDb
      .update(schema.bookingsTable)
      .set({ status: "invoiced", paymentMethod: "invoice" })
      .where(eq(schema.bookingsTable.id, 42));
    const response = await fetch(
      `${baseUrl}/api/bookings/by-management-token/invoice-management-token/billing`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ poNumber: "PO-AFTER-BOOKING" }),
      },
    );

    expect(response.status).toBe(200);
    expect((await currentBooking()).poNumber).toBe("PO-AFTER-BOOKING");
    expect(services.calculatePricing).not.toHaveBeenCalled();
  });
});
