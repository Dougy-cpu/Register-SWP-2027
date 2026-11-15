import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { eq } from "drizzle-orm";
import express from "express";
import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../../../lib/db/src/schema";

let database: PGlite;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
let server: Server;
let baseUrl: string;
const clients: Array<EventEmitter & { release: ReturnType<typeof vi.fn> }> = [];
const locks = new Map<number, EventEmitter>();
let failWrite: ((sql: string, params: unknown[]) => boolean) | undefined;
let unlockFails = false;

const services = vi.hoisted(() => ({
  stripe: {
    customers: { list: vi.fn(), create: vi.fn(), update: vi.fn() },
    checkout: { sessions: { create: vi.fn(), retrieve: vi.fn(), expire: vi.fn() } },
    invoices: {
      create: vi.fn(),
      retrieve: vi.fn(),
      update: vi.fn(),
      finalizeInvoice: vi.fn(),
      sendInvoice: vi.fn(),
      voidInvoice: vi.fn(),
      del: vi.fn(),
    },
    invoiceItems: { create: vi.fn() },
    invoicePayments: { list: vi.fn() },
    paymentIntents: { retrieve: vi.fn(), update: vi.fn() },
    charges: { update: vi.fn(), retrieve: vi.fn() },
    refunds: { create: vi.fn() },
    taxRates: { list: vi.fn() },
  },
  receipt: vi.fn(),
  welcome: vi.fn(),
  organiser: vi.fn(),
  expired: vi.fn(),
  failedPayment: vi.fn(),
  sheets: vi.fn(),
  reserve: vi.fn(),
  release: vi.fn(),
  restore: vi.fn(),
}));

vi.mock("@workspace/db", async () => ({
  ...(await import("../../../../lib/db/src/schema")),
  db: new Proxy({}, { get: (_, key) => Reflect.get(testDb, key) }),
  createDbConnection: () => testDb,
  // Model session-scoped advisory locks, but execute all journal and booking SQL
  // in real PostgreSQL (PGlite). Each request gets a separate pool client.
  pool: {
    connect: async () => {
      const client = Object.assign(new EventEmitter(), {
        release: vi.fn(),
        query: async (sql: string, params: unknown[] = []) => {
          if (sql.includes("pg_try_advisory_lock")) {
            const id = Number(params[1]);
            if (locks.has(id)) return { rows: [{ locked: false }] };
            locks.set(id, client);
            return { rows: [{ locked: true }] };
          }
          if (sql.includes("pg_advisory_unlock")) {
            if (unlockFails) throw new Error("connection lost during unlock");
            if (locks.get(Number(params[1])) !== client) throw new Error("unlock on wrong client");
            locks.delete(Number(params[1]));
            return { rows: [{ pg_advisory_unlock: true }] };
          }
          if (failWrite?.(sql, params)) throw new Error("simulated persistence failure");
          const result = await database.query(sql, params);
          return { ...result, rowCount: result.affectedRows };
        },
      });
      client.release.mockImplementation((error?: Error) => {
        if (error) for (const [id, owner] of locks) if (owner === client) locks.delete(id);
      });
      clients.push(client);
      return client;
    },
  },
}));
vi.mock("./promo-codes", () => ({ isCodeUsedByEmail: vi.fn().mockResolvedValue(false) }));
vi.mock("../lib/stripe-client", () => ({ getStripe: () => services.stripe }));
vi.mock("../lib/sponsor-redemptions", () => ({
  reservePromoUsageForBooking: services.reserve,
  releaseSponsorRedemption: services.release,
  restoreSponsorRedemption: services.restore,
  notifySponsorRedemptionForBooking: async () => true,
}));
vi.mock("../lib/sponsor-email", () => ({
  sendSponsorInternalNotification: vi.fn(),
  sendSponsorStaffWelcome: vi.fn(),
}));
vi.mock("../lib/email", () => ({
  sendConfirmationAndReceiptEmail: services.receipt,
  sendAttendeeWelcomeEmails: services.welcome,
  sendOrganiserNotification: services.organiser,
  sendCheckoutExpiredEmail: services.expired,
  sendInvoicePaymentFailedEmail: services.failedPayment,
  sendRefundConfirmationEmail: vi.fn(),
  sendDisputeAlertEmail: vi.fn(),
}));
vi.mock("../lib/google-sheets", () => ({ syncBookingToSheets: services.sheets }));
vi.mock("../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../middleware/admin-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../middleware/admin-auth")>()),
  adminAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.headers["x-admin-token"] === "test-admin") next();
    else res.status(403).json({ error: "Forbidden" });
  },
}));

import router from "./stripe";
import adminRouter from "./admin";
import { logger } from "../lib/logger";
import {
  reissueBookingInvoice,
  applyReissueInvoiceResultTx,
  refreshStripeInvoiceUrls,
} from "../lib/invoice";
import {
  withPaymentOperation,
  PaymentOperationBusy,
  paymentFingerprint,
} from "../lib/payment-operations";

const stripe = services.stripe as unknown as Stripe;
const sessions = new Map<string, Stripe.Checkout.Session>();
const invoices = new Map<string, Stripe.Invoice>();
const idempotentResults = new Map<string, { params: string; result: { id: string } }>();
const remoteCounts: Record<string, number> = {};
let loseResponse: string | undefined;
let customer: Stripe.Customer | undefined;
let savedSecret: string | undefined;

async function remote<T extends { id: string }>(
  name: string,
  params: unknown,
  options: Stripe.RequestOptions,
  create: () => T,
): Promise<T> {
  const key = options?.idempotencyKey;
  if (!key) throw new Error(`Missing idempotency key for ${name}`);
  const previous = idempotentResults.get(key);
  if (previous) {
    expect(previous.params).toBe(paymentFingerprint(params));
    return previous.result as T;
  }
  const result = create();
  remoteCounts[name] = (remoteCounts[name] || 0) + 1;
  idempotentResults.set(key, { params: paymentFingerprint(params), result });
  if (loseResponse === name) {
    loseResponse = undefined;
    throw new Error(`Response lost after Stripe completed ${name}`);
  }
  return result;
}

beforeAll(async () => {
  savedSecret = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = "test-webhook-secret";
  database = new PGlite();
  testDb = drizzle(database, { schema });
  for (const type of [
    schema.bookingStatusEnum,
    schema.passTypeEnum,
    schema.attendeeTypeEnum,
    schema.paymentMethodEnum,
    schema.registrationSourceEnum,
    schema.discountTypeEnum,
    schema.sponsorPromoKindEnum,
  ]) {
    await database.exec(
      `CREATE TYPE "${type.enumName}" AS ENUM (${type.enumValues.map((value) => `'${value}'`).join(", ")})`,
    );
  }
  for (const table of [
    schema.bookingsTable,
    schema.attendeesTable,
    schema.activityLogTable,
    schema.promoCodesTable,
    schema.sponsorPromoCodesTable,
  ]) {
    const config = getTableConfig(table);
    await database.exec(
      `CREATE TABLE "${config.name}" (${config.columns.map((column) => `"${column.name}" ${column.getSQLType()}`).join(", ")})`,
    );
  }
  await database.exec("ALTER TABLE activity_log ALTER COLUMN created_at SET DEFAULT now()");
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use("/api", adminRouter);
  // Silence expected errors while preserving production's 500/retry behaviour.
  app.use(
    (_err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
      res.status(500).json({ error: "retry" }),
  );
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/stripe`;
}, 20_000);

afterAll(async () => {
  if (savedSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET = savedSecret;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await database?.close();
});

beforeEach(async () => {
  vi.resetAllMocks();
  failWrite = undefined;
  unlockFails = false;
  loseResponse = undefined;
  customer = undefined;
  locks.clear();
  clients.length = 0;
  sessions.clear();
  invoices.clear();
  idempotentResults.clear();
  for (const key of Object.keys(remoteCounts)) delete remoteCounts[key];
  await database.exec(
    "TRUNCATE bookings, attendees, activity_log, promo_codes, sponsor_promo_codes RESTART IDENTITY",
  );
  await testDb.insert(schema.bookingsTable).values({
    id: 1,
    sessionToken: "owner",
    status: "partial",
    passType: "single",
    attendeeType: "hr_professional",
    quantity: 2,
    subtotalAmount: "498.00",
    vatAmount: "99.60",
    totalAmount: "597.60",
    groupDiscountAmount: "0",
    promoDiscountAmount: "0",
    billingName: "Alex Smith",
    billingCompany: "Example Ltd",
    billingEmail: "alex@example.com",
    paymentMethod: "card",
    currentStep: 4,
    confirmationEmailSent: false,
    welcomeEmailsSent: false,
    organiserNotified: false,
    sheetsSynced: false,
    manualEntry: false,
    registrationSource: "checkout",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await testDb.insert(schema.attendeesTable).values({
    id: 1,
    bookingId: 1,
    isLead: true,
    firstName: "Jamie",
    lastName: "Lee",
    company: "Example Ltd",
    workEmail: "jamie@example.com",
    jobTitle: "HR Director",
  });
  for (const fn of [services.receipt, services.welcome, services.organiser, services.reserve])
    fn.mockResolvedValue(true);
  services.stripe.customers.list.mockImplementation(async () => ({
    data: customer ? [customer] : [],
  }));
  services.stripe.customers.create.mockImplementation(async (params, options) =>
    remote("customer", params, options, () => (customer = { id: "cus_1", ...params })),
  );
  services.stripe.customers.update.mockImplementation(
    async (_id, params) => (customer = { ...customer, ...params, id: "cus_1" } as Stripe.Customer),
  );
  services.stripe.checkout.sessions.create.mockImplementation(async (params, options) =>
    remote("checkout", params, options, () => {
      const id = `cs_${sessions.size + 1}`;
      const session = {
        ...params,
        id,
        url: `https://checkout.stripe.com/${id}`,
        status: "open",
        payment_status: "unpaid",
        currency: "gbp",
        amount_total: 59760,
        payment_intent: null,
      } as Stripe.Checkout.Session;
      sessions.set(id, session);
      return session;
    }),
  );
  services.stripe.checkout.sessions.retrieve.mockImplementation(async (id) => {
    if (!sessions.has(id)) throw new Error(`Unknown checkout ${id}`);
    return sessions.get(id);
  });
  services.stripe.checkout.sessions.expire.mockImplementation(async (id) => {
    const session = sessions.get(id)!;
    if (session.status !== "open") throw new Error("Checkout is not open");
    session.status = "expired";
    return session;
  });
  services.stripe.taxRates.list.mockResolvedValue({
    data: [{ id: "txr_vat", percentage: 20, country: "GB", inclusive: false }],
  });
  services.stripe.invoices.create.mockImplementation(async (params, options) =>
    remote("invoice", params, options, () => {
      const invoice = {
        ...params,
        id: `in_${invoices.size + 1}`,
        status: "draft",
        number: null,
      } as Stripe.Invoice;
      invoices.set(invoice.id, invoice);
      return invoice;
    }),
  );
  services.stripe.invoices.retrieve.mockImplementation(async (id) => {
    if (!invoices.has(id))
      throw Object.assign(new Error("No such invoice"), { code: "resource_missing" });
    return invoices.get(id);
  });
  services.stripe.invoiceItems.create.mockImplementation(async (params, options) =>
    remote(`item-${params.amount}`, params, options, () => ({
      id: `ii_${idempotentResults.size}`,
    })),
  );
  services.stripe.invoices.finalizeInvoice.mockImplementation(async (id, params, options) =>
    remote("finalize", { id, params }, options, () =>
      Object.assign(invoices.get(id)!, {
        status: "open",
        number: "INV-1",
        due_date: 1800000000,
        invoice_pdf: "https://example.com/invoice.pdf",
        hosted_invoice_url: "https://example.com/pay",
      }),
    ),
  );
  services.stripe.invoices.sendInvoice.mockImplementation(async (id, params, options) =>
    remote("send", { id, params }, options, () => invoices.get(id)!),
  );
  services.stripe.invoices.voidInvoice.mockImplementation(async (id, params, options) =>
    options
      ? remote("void", { id, params }, options, () =>
          Object.assign(invoices.get(id)!, { status: "void" }),
        )
      : Object.assign(invoices.get(id)!, { status: "void" }),
  );
  services.stripe.invoices.del.mockImplementation(async (id, options) =>
    options
      ? remote("delete", { id }, options, () => {
          invoices.delete(id);
          return { id, deleted: true };
        })
      : (invoices.delete(id), { id, deleted: true }),
  );
  services.stripe.invoices.update.mockImplementation(async (id, params) =>
    Object.assign(invoices.get(id)!, params),
  );
  services.stripe.invoicePayments.list.mockResolvedValue({ data: [], has_more: false });
  services.stripe.paymentIntents.update.mockImplementation(async (id) => ({ id }));
  services.stripe.refunds.create.mockResolvedValue({ id: "re_test" });
  services.restore.mockResolvedValue(true);
});

async function post(path: string, body: unknown, token = "owner") {
  return fetch(`${baseUrl}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-booking-session": token },
    body: JSON.stringify(body),
  });
}
const checkout = (overrides = {}) =>
  post("create-checkout-session", {
    bookingId: 1,
    successUrl: "https://example.com/success",
    cancelUrl: "https://example.com/cancel",
    ...overrides,
  });
const issueInvoice = () => post("create-invoice", { bookingId: 1 });
const webhook = (type: string, object: unknown) => post("webhook", { type, data: { object } });
const adminStatus = (status: string) =>
  fetch(`${baseUrl.replace(/\/stripe$/, "")}/admin/registrations/1/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-admin-token": "test-admin" },
    body: JSON.stringify({ status }),
  });
async function booking() {
  return (
    await testDb.select().from(schema.bookingsTable).where(eq(schema.bookingsTable.id, 1))
  )[0];
}
async function journal() {
  return withPaymentOperation(1, (ops) => ops.attempts());
}
function paid(id = "cs_1", intent = "pi_1") {
  const session = sessions.get(id)!;
  Object.assign(session, { status: "complete", payment_status: "paid", payment_intent: intent });
  return session;
}
async function ageUncertainStep(name: string) {
  await withPaymentOperation(1, async (ops) => {
    const [attempt] = await ops.attempts();
    attempt.steps[name].requestedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    delete attempt.steps[name].resultId;
    await ops.save(attempt);
  });
}

describe("durable payment operations and connection locks", () => {
  it("refuses concurrent operations for the same booking and releases the pinned connection", async () => {
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const running = withPaymentOperation(1, async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await ready;
    await expect(withPaymentOperation(1, async () => "unsafe")).rejects.toBeInstanceOf(
      PaymentOperationBusy,
    );
    expect(await withPaymentOperation(2, async () => "independent")).toBe("independent");
    release();
    await running;
    expect(locks.size).toBe(0);
    expect(clients.every((client) => client.release.mock.calls.length === 1)).toBe(true);
  });
  it("releases locks after errors and discards a connection when unlocking fails", async () => {
    await expect(
      withPaymentOperation(1, async () => {
        throw new Error("failure");
      }),
    ).rejects.toThrow("failure");
    expect(locks.size).toBe(0);
    unlockFails = true;
    await withPaymentOperation(1, async () => undefined);
    expect(clients.at(-1)!.release).toHaveBeenCalledWith(expect.any(Error));
    expect(locks.size).toBe(0);
  });
  it("does not contact Stripe when the initial journal write fails", async () => {
    failWrite = (sql) => sql.startsWith("INSERT INTO activity_log");
    expect((await checkout()).status).toBe(502);
    expect(services.stripe.customers.list).not.toHaveBeenCalled();
    expect(sessions.size).toBe(0);
  });
  it("does not contact Stripe if saving the started step fails", async () => {
    failWrite = (sql) => sql.startsWith("UPDATE activity_log");
    expect((await checkout()).status).toBe(502);
    expect(services.stripe.customers.list).not.toHaveBeenCalled();
  });
  it("retains a payment journal when its booking is deleted", async () => {
    expect((await checkout()).status).toBe(200);
    await testDb.delete(schema.activityLogTable).where(eq(schema.activityLogTable.bookingId, 1));
    await testDb.delete(schema.bookingsTable).where(eq(schema.bookingsTable.id, 1));
    expect(await journal()).toHaveLength(1);
  });
});

describe("card payment retries", () => {
  it("returns the same open checkout on repeat requests", async () => {
    const first = await (await checkout()).json();
    const second = await (await checkout()).json();
    expect(second).toEqual(first);
    expect(remoteCounts.checkout).toBe(1);
    expect((await booking()).stripeSessionId).toBe("cs_1");
  });
  it("rejects a double click while Stripe is still responding", async () => {
    const original = services.stripe.checkout.sessions.create.getMockImplementation()!;
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    services.stripe.checkout.sessions.create.mockImplementationOnce(async (...args) => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return original(...args);
    });
    const first = checkout();
    await ready;
    expect((await checkout()).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    expect(remoteCounts.checkout).toBe(1);
  });
  it.each(["customer", "checkout"])(
    "recovers a lost %s response with a fresh request and unchanged idempotency key",
    async (stage) => {
      loseResponse = stage;
      expect((await checkout()).status).toBe(502);
      expect((await checkout()).status).toBe(200);
      expect(remoteCounts.checkout).toBe(1);
      expect(remoteCounts.customer).toBe(1);
      expect(await journal()).toHaveLength(1);
    },
  );
  it("recovers when saving the returned checkout ID fails", async () => {
    failWrite = (sql, params) =>
      sql.startsWith("UPDATE activity_log") && String(params[0]).includes('"resultId":"cs_1"');
    expect((await checkout()).status).toBe(502);
    failWrite = undefined;
    expect((await checkout()).status).toBe(200);
    expect(sessions.size).toBe(1);
    expect(remoteCounts.checkout).toBe(1);
  });
  it("expires an old link before creating a changed checkout", async () => {
    await checkout();
    expect((await checkout({ cancelUrl: "https://example.com/new-cancel" })).status).toBe(200);
    expect(sessions.get("cs_1")!.status).toBe("expired");
    expect((await booking()).stripeSessionId).toBe("cs_2");
    expect((await journal()).map((attempt) => attempt.status)).toContain("expired");
  });
  it("stops replacement if the old session completes during expiry", async () => {
    await checkout();
    services.stripe.checkout.sessions.expire.mockImplementationOnce(async () => {
      paid();
      throw new Error("just paid");
    });
    expect((await checkout({ cancelUrl: "https://example.com/new-cancel" })).status).toBe(409);
    expect(sessions.size).toBe(1);
    expect((await webhook("checkout.session.completed", paid())).status).toBe(200);
    expect((await booking()).status).toBe("paid");
  });
  it("halts an uncertain attempt beyond the retry-key safety window", async () => {
    loseResponse = "checkout";
    await checkout();
    await ageUncertainStep("checkout");
    // Simulate Stripe having pruned its old idempotency-key cache.
    idempotentResults.clear();
    expect((await checkout()).status).toBe(409);
    expect(remoteCounts.checkout).toBe(1);
    expect((await journal())[0].status).toBe("review");
  });
  it("reuses a known old session without calling create again", async () => {
    await checkout();
    await withPaymentOperation(1, async (ops) => {
      const [attempt] = await ops.attempts();
      attempt.createdAt = "2020-01-01";
      await ops.save(attempt);
    });
    expect((await checkout()).status).toBe(200);
    expect(remoteCounts.checkout).toBe(1);
  });
  it("recognises a paid earlier recorded session and closes the newer open link", async () => {
    await checkout();
    await checkout({ cancelUrl: "https://example.com/new-cancel" });
    expect((await webhook("checkout.session.completed", paid())).status).toBe(200);
    expect(await booking()).toMatchObject({
      status: "paid",
      stripeSessionId: "cs_1",
      stripePaymentIntentId: "pi_1",
    });
    expect(sessions.get("cs_2")!.status).toBe("expired");
    expect(services.receipt).toHaveBeenCalledOnce();
  });
  it("recovers a paid checkout from its saved attempt marker after the response was lost", async () => {
    loseResponse = "checkout";
    await checkout();
    expect((await webhook("checkout.session.completed", paid())).status).toBe(200);
    expect((await booking()).status).toBe("paid");
    expect((await journal())[0].steps.checkout.resultId).toBe("cs_1");
  });
  it("does not overwrite the original refund reference when another session was paid", async () => {
    await checkout();
    await checkout({ cancelUrl: "https://example.com/new-cancel" });
    await webhook("checkout.session.completed", paid());
    await webhook("checkout.session.completed", paid("cs_2", "pi_duplicate"));
    expect((await booking()).stripePaymentIntentId).toBe("pi_1");
    expect(services.receipt).toHaveBeenCalledOnce();
    expect(
      (await testDb.select().from(schema.activityLogTable)).some(
        (row) => row.type === "payment_reconciliation_required",
      ),
    ).toBe(true);
  });
  it("confirms once when the browser and webhook overlap, and retries unfinished delivery", async () => {
    await checkout();
    paid();
    services.receipt.mockResolvedValueOnce(false);
    const results = await Promise.all([
      webhook("checkout.session.completed", paid()),
      post("confirm-card-payment", { bookingId: 1, sessionId: "cs_1" }),
    ]);
    expect(results.map((result) => result.status)).toContain(200);
    expect((await post("confirm-card-payment", { bookingId: 1, sessionId: "cs_1" })).status).toBe(
      200,
    );
    expect(services.receipt).toHaveBeenCalledTimes(2);
    expect(services.welcome).toHaveBeenCalledOnce();
    expect((await booking()).status).toBe("paid");
  });
  it.each([
    { currency: "usd" },
    { amount_total: 1 },
    { customer: "cus_someone_else" },
    { metadata: { bookingId: "1", registrationApp: "another-app" } },
    { metadata: { bookingId: "2", registrationApp: "swp-2027" } },
    { mode: "subscription" },
    { payment_status: "unpaid" },
    { payment_intent: null },
  ])("rejects mismatched or unpaid checkout evidence: %j", async (changes) => {
    await checkout();
    const session = { ...paid(), ...changes };
    await webhook("checkout.session.completed", session);
    expect((await booking()).status).toBe("pending_payment");
    expect(services.receipt).not.toHaveBeenCalled();
    expect(
      (await post("confirm-card-payment", { bookingId: 1, sessionId: "cs_1" }, "wrong-owner"))
        .status,
    ).toBe(403);
  });
  it("flags a historical amount mismatch instead of marking an underpaid booking paid", async () => {
    await checkout();
    await testDb
      .update(schema.bookingsTable)
      .set({ totalAmount: "1000.00" })
      .where(eq(schema.bookingsTable.id, 1));
    await webhook("checkout.session.completed", paid());
    expect((await booking()).status).toBe("pending_payment");
    expect(
      (await testDb.select().from(schema.activityLogTable)).some(
        (row) => row.type === "payment_reconciliation_required",
      ),
    ).toBe(true);
  });
  it("ignores an expired predecessor after a replacement was created", async () => {
    await checkout();
    await checkout({ cancelUrl: "https://example.com/new-cancel" });
    await webhook("checkout.session.expired", sessions.get("cs_1"));
    expect((await booking()).stripeSessionId).toBe("cs_2");
    expect((await booking()).status).toBe("pending_payment");
    expect(services.expired).not.toHaveBeenCalled();
  });
  it("does not treat an expired legacy link as abandonment during recovery of its replacement", async () => {
    await checkout();
    await testDb
      .delete(schema.activityLogTable)
      .where(eq(schema.activityLogTable.type, "_stripe_payment_attempt"));
    loseResponse = "checkout";
    expect((await checkout()).status).toBe(502);
    await webhook("checkout.session.expired", sessions.get("cs_1"));
    expect((await booking()).status).toBe("pending_payment");
    expect(services.expired).not.toHaveBeenCalled();
    expect((await checkout()).status).toBe(200);
    expect((await booking()).stripeSessionId).toBe("cs_2");
  });
  it("allows a naturally expired current checkout to be retried", async () => {
    await checkout();
    sessions.get("cs_1")!.status = "expired";
    await webhook("checkout.session.expired", sessions.get("cs_1"));
    expect((await booking()).status).toBe("partial");
    expect(services.expired).toHaveBeenCalledOnce();
    expect((await checkout()).status).toBe(200);
    expect((await booking()).stripeSessionId).toBe("cs_2");
  });
  it.each(["paid", "invoiced", "cancelled", "refunded", "disputed"] as const)(
    "does not create a new checkout for a %s booking",
    async (status) => {
      await testDb
        .update(schema.bookingsTable)
        .set({ status })
        .where(eq(schema.bookingsTable.id, 1));
      expect((await checkout()).status).toBe(409);
      expect(sessions.size).toBe(0);
    },
  );
});

describe("invoice retries and replacement safety", () => {
  it.each(["invoice", "item-49800", "finalize", "send"])(
    "resumes the same invoice after losing the %s response",
    async (stage) => {
      loseResponse = stage;
      expect((await issueInvoice()).status).toBe(502);
      expect((await issueInvoice()).status).toBe(200);
      expect(await booking()).toMatchObject({
        status: "invoiced",
        stripeInvoiceId: "in_1",
        stripeInvoicePaymentUrl: "https://example.com/pay",
      });
      expect(remoteCounts.invoice).toBe(1);
      expect(remoteCounts["item-49800"]).toBe(1);
      expect(remoteCounts.finalize).toBe(1);
      expect(remoteCounts.send).toBe(1);
      expect(services.receipt).toHaveBeenCalledOnce();
    },
  );
  it("serialises simultaneous invoice requests", async () => {
    const original = services.stripe.invoices.create.getMockImplementation()!;
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    services.stripe.invoices.create.mockImplementationOnce(async (...args) => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return original(...args);
    });
    const first = issueInvoice();
    await ready;
    expect((await issueInvoice()).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    expect(remoteCounts.invoice).toBe(1);
  });
  it("does not duplicate discount line items on retries", async () => {
    await testDb
      .update(schema.bookingsTable)
      .set({
        subtotalAmount: "400.00",
        groupDiscountAmount: "50.00",
        promoDiscountAmount: "48.00",
        promoCode: "TEST",
      })
      .where(eq(schema.bookingsTable.id, 1));
    loseResponse = "item--4800";
    expect((await issueInvoice()).status).toBe(502);
    expect((await issueInvoice()).status).toBe(200);
    expect(remoteCounts["item-49800"]).toBe(1);
    expect(remoteCounts["item--5000"]).toBe(1);
    expect(remoteCounts["item--4800"]).toBe(1);
  });
  it("persists the invoice reference before making it payable or sending", async () => {
    services.stripe.invoices.finalizeInvoice.mockImplementationOnce(async () => {
      expect((await booking()).stripeInvoiceId).toBe("in_1");
      throw new Error("finalization unavailable");
    });
    expect((await issueInvoice()).status).toBe(502);
    expect((await booking()).stripeInvoiceId).toBe("in_1");
    expect(services.stripe.invoices.sendInvoice).not.toHaveBeenCalled();
    expect((await issueInvoice()).status).toBe(200);
  });
  it("keeps references available when sending fails and reuses the invoice on retry", async () => {
    services.stripe.invoices.sendInvoice.mockRejectedValueOnce(new Error("temporary outage"));
    expect((await issueInvoice()).status).toBe(502);
    expect(await booking()).toMatchObject({
      stripeInvoiceId: "in_1",
      stripeInvoicePaymentUrl: "https://example.com/pay",
    });
    expect((await issueInvoice()).status).toBe(200);
    expect(remoteCounts.invoice).toBe(1);
  });
  it.each(["invoice", "item-passes", "send"])(
    "stops an old uncertain %s step rather than making a fresh request after key expiry",
    async (step) => {
      loseResponse = step === "item-passes" ? "item-49800" : step;
      await issueInvoice();
      await ageUncertainStep(step);
      idempotentResults.clear();
      expect((await issueInvoice()).status).toBe(409);
      expect(remoteCounts.invoice).toBe(1);
      expect((await journal())[0].status).toBe("review");
    },
  );
  it("closes the card link before issuing an invoice and ignores its later expiry event", async () => {
    await checkout();
    expect((await issueInvoice()).status).toBe(200);
    expect(sessions.get("cs_1")!.status).toBe("expired");
    await webhook("checkout.session.expired", sessions.get("cs_1"));
    expect((await booking()).status).toBe("invoiced");
    expect(services.expired).not.toHaveBeenCalled();
    expect((await checkout()).status).toBe(409);
  });
  it("will not issue an invoice while an earlier card payment is already paid", async () => {
    await checkout();
    paid();
    expect((await issueInvoice()).status).toBe(409);
    expect(invoices.size).toBe(0);
  });
  it("will not start a card checkout during an uncertain invoice attempt", async () => {
    loseResponse = "invoice";
    await issueInvoice();
    expect((await checkout()).status).toBe(409);
    expect(sessions.size).toBe(0);
  });
  it("does not create a replacement if the previous invoice cannot be voided", async () => {
    await issueInvoice();
    await testDb
      .update(schema.bookingsTable)
      .set({ billingName: "Updated Name" })
      .where(eq(schema.bookingsTable.id, 1));
    services.stripe.invoices.voidInvoice.mockRejectedValueOnce(new Error("void failed"));
    await expect(reissueBookingInvoice(stripe, 1)).rejects.toThrow("void failed");
    expect(invoices.size).toBe(1);
    expect(invoices.get("in_1")!.status).toBe("open");
    const result = await reissueBookingInvoice(stripe, 1);
    expect(result).toMatchObject({ alreadyPaid: false, invoiceId: "in_2" });
    expect(invoices.get("in_1")!.status).toBe("void");
  });
  it("recovers a completed void when its response is lost", async () => {
    await issueInvoice();
    await testDb
      .update(schema.bookingsTable)
      .set({ billingName: "Updated Name" })
      .where(eq(schema.bookingsTable.id, 1));
    loseResponse = "void";
    expect(await reissueBookingInvoice(stripe, 1)).toMatchObject({
      alreadyPaid: false,
      invoiceId: "in_2",
    });
    expect(remoteCounts.void).toBe(1);
    expect(remoteCounts.invoice).toBe(2);
  });
  it("recovers a lost draft deletion response before creating a changed revision", async () => {
    loseResponse = "item-49800";
    await issueInvoice();
    await testDb
      .update(schema.bookingsTable)
      .set({ billingName: "Updated Name" })
      .where(eq(schema.bookingsTable.id, 1));
    loseResponse = "delete";
    await reissueBookingInvoice(stripe, 1).catch(() => undefined);
    const result = await reissueBookingInvoice(stripe, 1);
    expect(result.alreadyPaid).toBe(false);
    expect(remoteCounts.delete).toBe(1);
    expect(remoteCounts.invoice).toBe(2);
  });
  it("does not cancel a pending replacement on an old void callback or status refresh", async () => {
    await issueInvoice();
    await testDb
      .update(schema.bookingsTable)
      .set({ billingName: "Updated Name" })
      .where(eq(schema.bookingsTable.id, 1));
    services.stripe.invoices.create.mockRejectedValueOnce(
      new Error("new invoice temporarily unavailable"),
    );
    await expect(reissueBookingInvoice(stripe, 1)).rejects.toThrow();
    expect(invoices.get("in_1")!.status).toBe("void");
    await webhook("invoice.voided", { id: "in_1", status: "void" });
    await refreshStripeInvoiceUrls(stripe, 1);
    expect((await booking()).status).toBe("invoiced");
    expect(services.release).not.toHaveBeenCalled();
    expect(await reissueBookingInvoice(stripe, 1)).toMatchObject({
      alreadyPaid: false,
      invoiceId: "in_2",
    });
  });
  it("protects a replacement when its predecessor was already voided before setup began", async () => {
    await issueInvoice();
    invoices.get("in_1")!.status = "void";
    await testDb
      .update(schema.bookingsTable)
      .set({ billingName: "Updated Name" })
      .where(eq(schema.bookingsTable.id, 1));
    services.stripe.invoices.create.mockRejectedValueOnce(new Error("temporarily unavailable"));
    await expect(reissueBookingInvoice(stripe, 1)).rejects.toThrow();
    await webhook("invoice.voided", { id: "in_1", status: "void" });
    expect((await booking()).status).toBe("invoiced");
    expect(services.release).not.toHaveBeenCalled();
    expect(await reissueBookingInvoice(stripe, 1)).toMatchObject({
      alreadyPaid: false,
      invoiceId: "in_2",
    });
  });
  it("retains a recovered paid invoice's reference and does not send another invoice", async () => {
    loseResponse = "invoice";
    await issueInvoice();
    invoices.get("in_1")!.status = "paid";
    expect((await issueInvoice()).status).toBe(200);
    expect(await booking()).toMatchObject({ status: "paid", stripeInvoiceId: "in_1" });
    expect(services.stripe.invoices.sendInvoice).not.toHaveBeenCalled();
  });
  it("cannot reset a booking to invoiced after payment confirmation won a race", async () => {
    await testDb
      .update(schema.bookingsTable)
      .set({ status: "paid" })
      .where(eq(schema.bookingsTable.id, 1));
    await testDb.transaction((tx) =>
      applyReissueInvoiceResultTx(
        tx as unknown as Parameters<typeof applyReissueInvoiceResultTx>[0],
        1,
        {
          alreadyPaid: false,
          invoiceId: "in_stale",
          pdfUrl: null,
          paymentUrl: null,
          dueDate: new Date(),
        },
      ),
    );
    expect((await booking()).status).toBe("paid");
    expect((await booking()).stripeInvoiceId).toBeNull();
  });
  it("cannot overwrite a newer invoice with a stale replacement result", async () => {
    await testDb
      .update(schema.bookingsTable)
      .set({ status: "invoiced", stripeInvoiceId: "in_newer" })
      .where(eq(schema.bookingsTable.id, 1));
    await testDb.transaction((tx) =>
      applyReissueInvoiceResultTx(
        tx as unknown as Parameters<typeof applyReissueInvoiceResultTx>[0],
        1,
        {
          alreadyPaid: false,
          invoiceId: "in_older",
          pdfUrl: null,
          paymentUrl: null,
          dueDate: new Date(),
        },
      ),
    );
    expect((await booking()).stripeInvoiceId).toBe("in_newer");
  });
  it("resumes an incomplete replacement even when the booking was already invoiced", async () => {
    await issueInvoice();
    await testDb
      .update(schema.bookingsTable)
      .set({ billingName: "Updated Name" })
      .where(eq(schema.bookingsTable.id, 1));
    loseResponse = "finalize";
    await expect(reissueBookingInvoice(stripe, 1)).rejects.toThrow();
    expect((await booking()).status).toBe("invoiced");
    expect((await issueInvoice()).status).toBe(200);
    expect(remoteCounts.invoice).toBe(2);
    expect(remoteCounts.send).toBe(2);
    expect((await booking()).stripeInvoiceId).toBe("in_2");
  });
  it("keeps a sponsor allocation reserved after an uncertain invoice response", async () => {
    await testDb.insert(schema.promoCodesTable).values({
      id: 1,
      code: "SPONSOR",
      discountType: "percentage",
      discountValue: "10",
      oncePerCustomer: false,
    });
    await testDb
      .insert(schema.sponsorPromoCodesTable)
      .values({ sponsorId: 1, promoCodeId: 1, kind: "public" });
    await testDb
      .update(schema.bookingsTable)
      .set({ promoCode: "SPONSOR" })
      .where(eq(schema.bookingsTable.id, 1));
    loseResponse = "invoice";
    expect((await issueInvoice()).status).toBe(502);
    expect(services.reserve).toHaveBeenCalledOnce();
    expect(services.release).not.toHaveBeenCalled();
    expect((await issueInvoice()).status).toBe(200);
    expect(remoteCounts.invoice).toBe(1);
  });
  it("does not contact Stripe when sponsor capacity is unavailable", async () => {
    await testDb.insert(schema.promoCodesTable).values({
      id: 1,
      code: "SPONSOR",
      discountType: "percentage",
      discountValue: "10",
      oncePerCustomer: false,
    });
    await testDb
      .insert(schema.sponsorPromoCodesTable)
      .values({ sponsorId: 1, promoCodeId: 1, kind: "public" });
    await testDb
      .update(schema.bookingsTable)
      .set({ promoCode: "SPONSOR" })
      .where(eq(schema.bookingsTable.id, 1));
    services.reserve.mockResolvedValueOnce(false);
    expect((await issueInvoice()).status).toBe(409);
    expect(invoices.size).toBe(0);
  });
});

describe("modern and legacy invoice failure details", () => {
  const failure = {
    id: "pi_failed",
    status: "requires_payment_method",
    customer: "cus_1",
    last_payment_error: { decline_code: "insufficient_funds" },
  };
  async function seedInvoice() {
    await testDb
      .update(schema.bookingsTable)
      .set({ stripeInvoiceId: "in_failed", status: "invoiced" })
      .where(eq(schema.bookingsTable.id, 1));
  }
  it("resolves an expanded legacy PaymentIntent", async () => {
    await seedInvoice();
    expect(
      (
        await webhook("invoice.payment_failed", {
          id: "in_failed",
          customer: "cus_1",
          payment_intent: failure,
          attempt_count: 2,
        })
      ).status,
    ).toBe(200);
    expect(services.failedPayment).toHaveBeenCalledWith(1, "Insufficient funds", 2);
    expect(services.stripe.invoicePayments.list).not.toHaveBeenCalled();
  });
  it("resolves a legacy PaymentIntent ID", async () => {
    await seedInvoice();
    services.stripe.paymentIntents.retrieve.mockResolvedValue(failure);
    await webhook("invoice.payment_failed", {
      id: "in_failed",
      customer: "cus_1",
      payment_intent: "pi_failed",
    });
    expect(services.failedPayment).toHaveBeenCalledWith(1, "Insufficient funds", undefined);
  });
  it("finds the relevant modern failure across paginated InvoicePayment records", async () => {
    await seedInvoice();
    services.stripe.invoicePayments.list
      .mockResolvedValueOnce({
        data: [
          {
            id: "inpay_paid",
            status: "paid",
            is_default: true,
            payment: { payment_intent: { ...failure, id: "pi_paid", status: "succeeded" } },
          },
        ],
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: "inpay_failed",
            status: "open",
            is_default: true,
            payment: { payment_intent: failure },
          },
        ],
        has_more: false,
      });
    await webhook("invoice.payment_failed", {
      id: "in_failed",
      customer: "cus_1",
      attempt_count: 3,
    });
    expect(services.stripe.invoicePayments.list.mock.calls[1][0].starting_after).toBe("inpay_paid");
    expect(services.failedPayment).toHaveBeenCalledWith(1, "Insufficient funds", 3);
  });
  it("uses expanded modern payments and excludes unrelated attached payments", async () => {
    await seedInvoice();
    await webhook("invoice.payment_failed", {
      id: "in_failed",
      customer: "cus_1",
      payments: {
        data: [
          {
            id: "inpay_attached",
            is_default: false,
            status: "open",
            payment: { payment_intent: { ...failure, id: "pi_unrelated" } },
          },
          {
            id: "inpay_own",
            is_default: true,
            status: "open",
            payment: { payment_intent: failure },
          },
        ],
        has_more: false,
      },
    });
    expect(services.stripe.invoicePayments.list).not.toHaveBeenCalled();
    expect(services.failedPayment).toHaveBeenCalledWith(1, "Insufficient funds", undefined);
    expect(services.stripe.paymentIntents.update).not.toHaveBeenCalled();
  });
  it("retries a temporary lookup failure before sending a reasonless message", async () => {
    await seedInvoice();
    services.stripe.invoicePayments.list.mockRejectedValueOnce(
      new Error("temporary Stripe outage"),
    );
    expect(
      (await webhook("invoice.payment_failed", { id: "in_failed", customer: "cus_1" })).status,
    ).toBe(500);
    expect(services.failedPayment).not.toHaveBeenCalled();
    services.stripe.invoicePayments.list.mockResolvedValueOnce({
      data: [
        { id: "inpay_1", status: "open", is_default: true, payment: { payment_intent: failure } },
      ],
      has_more: false,
    });
    expect(
      (await webhook("invoice.payment_failed", { id: "in_failed", customer: "cus_1" })).status,
    ).toBe(200);
    expect(services.failedPayment).toHaveBeenCalledWith(1, "Insufficient funds", undefined);
  });
  it("sends a general failure message when Stripe supplies no payment error", async () => {
    await seedInvoice();
    await webhook("invoice.payment_failed", { id: "in_failed", customer: "cus_1" });
    expect(services.failedPayment).toHaveBeenCalledWith(1, undefined, undefined);
  });
  it("does not send a delayed failure notice for an already paid booking", async () => {
    await seedInvoice();
    await testDb
      .update(schema.bookingsTable)
      .set({ status: "paid" })
      .where(eq(schema.bookingsTable.id, 1));
    await webhook("invoice.payment_failed", {
      id: "in_failed",
      customer: "cus_1",
      payment_intent: failure,
    });
    expect(services.failedPayment).not.toHaveBeenCalled();
  });
  it("resolves an expanded legacy failed charge without a PaymentIntent", async () => {
    await seedInvoice();
    await webhook("invoice.payment_failed", {
      id: "in_failed",
      customer: "cus_1",
      charge: {
        id: "ch_failed",
        customer: "cus_1",
        status: "failed",
        paid: false,
        failure_code: "card_declined",
        failure_message: "Declined",
      },
    });
    expect(services.failedPayment).toHaveBeenCalledWith(1, "Card declined by your bank", undefined);
  });
  it("follows a legacy charge ID to its failed PaymentIntent", async () => {
    await seedInvoice();
    services.stripe.charges.retrieve.mockResolvedValue({
      id: "ch_failed",
      customer: "cus_1",
      paid: false,
      status: "failed",
      payment_intent: "pi_failed",
    });
    services.stripe.paymentIntents.retrieve.mockResolvedValue(failure);
    await webhook("invoice.payment_failed", {
      id: "in_failed",
      customer: "cus_1",
      charge: "ch_failed",
    });
    expect(services.failedPayment).toHaveBeenCalledWith(1, "Insufficient funds", undefined);
  });
  it("does not use another customer's legacy charge failure", async () => {
    await seedInvoice();
    expect(
      (
        await webhook("invoice.payment_failed", {
          id: "in_failed",
          customer: "cus_1",
          charge: {
            id: "ch_wrong",
            customer: "cus_other",
            paid: false,
            status: "failed",
            failure_code: "card_declined",
          },
        })
      ).status,
    ).toBe(500);
    expect(services.failedPayment).not.toHaveBeenCalled();
  });
});

describe("organiser actions during payment recovery", () => {
  it("blocks cancellation while an invoice replacement owns the booking lock", async () => {
    await issueInvoice();
    await testDb
      .update(schema.bookingsTable)
      .set({ billingName: "Updated Name" })
      .where(eq(schema.bookingsTable.id, 1));
    const original = services.stripe.invoices.create.getMockImplementation()!;
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    services.stripe.invoices.create.mockImplementationOnce(async (...args) => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return original(...args);
    });
    const replacing = reissueBookingInvoice(stripe, 1);
    await ready;
    expect((await adminStatus("cancelled")).status).toBe(409);
    expect((await booking()).status).toBe("invoiced");
    release();
    await replacing;
    expect((await adminStatus("cancelled")).status).toBe(200);
    expect((await booking()).status).toBe("cancelled");
    expect([...invoices.values()].every((invoice) => invoice.status === "void")).toBe(true);
  });
  it("blocks new payment setup while an admin cancellation is in progress", async () => {
    await issueInvoice();
    const original = services.stripe.invoices.voidInvoice.getMockImplementation()!;
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    services.stripe.invoices.voidInvoice.mockImplementationOnce(async (...args) => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return original(...args);
    });
    const cancelling = adminStatus("cancelled");
    await ready;
    await expect(reissueBookingInvoice(stripe, 1)).rejects.toBeInstanceOf(PaymentOperationBusy);
    release();
    expect((await cancelling).status).toBe(200);
    expect(invoices.size).toBe(1);
  });
  it("keeps the booking active when invoice cancellation cannot be verified", async () => {
    await issueInvoice();
    services.stripe.invoices.voidInvoice.mockRejectedValueOnce(new Error("Stripe unavailable"));
    expect((await adminStatus("cancelled")).status).toBe(502);
    expect((await booking()).status).toBe("invoiced");
    expect(invoices.get("in_1")!.status).toBe("open");
    expect(services.release).not.toHaveBeenCalled();
    expect((await adminStatus("cancelled")).status).toBe(200);
  });
  it("closes an open invoice left by an interrupted initial send before cancellation", async () => {
    await testDb
      .update(schema.bookingsTable)
      .set({ sponsorId: 1 })
      .where(eq(schema.bookingsTable.id, 1));
    services.stripe.invoices.sendInvoice.mockRejectedValueOnce(new Error("unavailable"));
    await issueInvoice();
    expect((await booking()).status).toBe("partial");
    expect(invoices.get("in_1")!.status).toBe("open");
    expect((await adminStatus("cancelled")).status).toBe(200);
    expect(invoices.get("in_1")!.status).toBe("void");
    expect(services.release).toHaveBeenCalledWith(
      1,
      "admin_status_cancelled",
      expect.objectContaining({ connection: testDb, deferNotification: expect.any(Function) }),
    );
  });
  it("blocks cancellation while the initial invoice reference is still uncertain", async () => {
    loseResponse = "invoice";
    await issueInvoice();
    expect((await adminStatus("cancelled")).status).toBe(409);
    expect((await booking()).status).toBe("partial");
    expect(services.release).not.toHaveBeenCalled();
  });
  it("closes an unpaid checkout before cancelling its booking", async () => {
    await checkout();
    expect((await adminStatus("cancelled")).status).toBe(200);
    expect(sessions.get("cs_1")!.status).toBe("expired");
    expect((await checkout()).status).toBe(409);
  });
  it("flags an allocation conflict after payment without an endless webhook retry or losing its refund reference", async () => {
    await testDb
      .update(schema.bookingsTable)
      .set({ promoCode: "LAST_SLOT" })
      .where(eq(schema.bookingsTable.id, 1));
    await checkout();
    services.reserve.mockResolvedValue(false);
    expect((await webhook("checkout.session.completed", paid())).status).toBe(200);
    expect((await booking()).stripePaymentIntentId).toBe("pi_1");
    expect((await booking()).status).toBe("pending_payment");
    expect(services.receipt).not.toHaveBeenCalled();
    expect((await post("confirm-card-payment", { bookingId: 1, sessionId: "cs_1" })).status).toBe(
      409,
    );
    const alerts = (await testDb.select().from(schema.activityLogTable)).filter(
      (row) => row.type === "payment_reconciliation_required",
    );
    expect(alerts).toHaveLength(1);
    expect((await adminStatus("cancelled")).status).toBe(200);
    expect(services.stripe.refunds.create).toHaveBeenCalledWith({ payment_intent: "pi_1" });
    expect((await booking()).status).toBe("refunded");
  });
  it("links a failed card intent to its saved attempt before successful settlement", async () => {
    await checkout();
    await webhook("payment_intent.payment_failed", {
      id: "pi_declined",
      metadata: sessions.get("cs_1")!.metadata,
      customer: "cus_1",
      last_payment_error: { decline_code: "insufficient_funds" },
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: 1, piId: "pi_declined" }),
      "payment_intent.payment_failed: card decline logged",
    );
    expect((await booking()).stripePaymentIntentId).toBeNull();
  });
  it("does not associate a declined intent with a different saved customer", async () => {
    await checkout();
    await webhook("payment_intent.payment_failed", {
      id: "pi_declined",
      metadata: sessions.get("cs_1")!.metadata,
      customer: "cus_other",
      last_payment_error: { decline_code: "insufficient_funds" },
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: null }),
      "payment_intent.payment_failed: card decline logged",
    );
  });
});
