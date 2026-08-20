/**
 * End-to-end integration test for the admin audit trail.
 *
 * Drives a few representative admin endpoints (login, status change, promo
 * create, attendee edit) against a real Express server (ephemeral port) and
 * asserts that each one writes a matching row into `activity_log` with the
 * expected `type`, `actor`, summary, and (where applicable) before/after diff.
 *
 * The DB layer is mocked with an in-memory store so the suite can run under
 * `pnpm test` without a Postgres dependency, but every other layer
 * (Express routing, JSON parsing, admin auth, audit helper) runs for real —
 * which is exactly the surface area this test is meant to protect.
 */

process.env.ADMIN_PASSWORD = "Test-Password-Long-Enough-123!";
process.env.ADMIN_TOKEN_SECRET = "x".repeat(48);

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

const { mockDb, getRows, resetStore, makeTable, stripeMock, setStripeAvailable, getStripeMock } =
  vi.hoisted(() => {
    const stores = new Map<string, Array<Record<string, unknown>>>();
    let stripeAvailable = false;

    const stripeMockImpl = {
      invoices: {
        retrieve: vi.fn(),
        pay: vi.fn(),
        voidInvoice: vi.fn(),
      },
      refunds: {
        create: vi.fn(),
      },
    };

    function getRowsImpl(table: { _name: string }): Array<Record<string, unknown>> {
      if (!stores.has(table._name)) stores.set(table._name, []);
      return stores.get(table._name)!;
    }

    function makeTableImpl(name: string): { _name: string } {
      return new Proxy(
        { _name: name },
        {
          get(target, prop: string) {
            if (prop === "_name") return name;
            if (prop in target) return (target as Record<string, unknown>)[prop];
            if (prop === "then") return undefined;
            return { _table: name, _col: prop };
          },
        },
      ) as { _name: string };
    }

    function resetStoreImpl() {
      stores.clear();
      stripeAvailable = false;
      stripeMockImpl.invoices.retrieve.mockReset();
      stripeMockImpl.invoices.pay.mockReset();
      stripeMockImpl.invoices.voidInvoice.mockReset();
      stripeMockImpl.refunds.create.mockReset();
    }

    type Pred =
      | undefined
      | null
      | boolean
      | { op: string; col?: { _col: string }; val?: unknown; preds?: Pred[]; vals?: unknown[] };

    function evalPred(pred: Pred, row: Record<string, unknown>): boolean {
      if (pred === undefined || pred === null) return true;
      if (typeof pred === "boolean") return pred;
      const p = pred as {
        op: string;
        col?: { _col: string };
        val?: unknown;
        preds?: Pred[];
        vals?: unknown[];
      };
      switch (p.op) {
        case "eq":
          return row[p.col!._col] === p.val;
        case "and":
          return (p.preds ?? []).every((q) => evalPred(q, row));
        case "or":
          return (p.preds ?? []).some((q) => evalPred(q, row));
        case "isNull":
          return row[p.col!._col] == null;
        case "inArray":
          return (p.vals ?? []).includes(row[p.col!._col]);
        case "notInArray":
          return !(p.vals ?? []).includes(row[p.col!._col]);
        default:
          return true;
      }
    }

    function nextId(store: Array<Record<string, unknown>>): number {
      let max = 0;
      for (const r of store) {
        const id = Number(r.id);
        if (Number.isFinite(id) && id > max) max = id;
      }
      return max + 1;
    }

    const db = {
      select(cols?: unknown) {
        let table: { _name: string };
        let pred: Pred;
        let limitN: number | undefined;
        const joins: Array<{ table: { _name: string }; on: Pred }> = [];
        const builder: Record<string, unknown> = {
          from(t: { _name: string }) {
            table = t;
            return builder;
          },
          where(p: Pred) {
            pred = p;
            return builder;
          },
          orderBy(..._args: unknown[]) {
            return builder;
          },
          limit(n: number) {
            limitN = n;
            return builder;
          },
          groupBy(..._args: unknown[]) {
            return builder;
          },
          leftJoin(t: { _name: string }, on: Pred) {
            joins.push({ table: t, on });
            return builder;
          },
          then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
            try {
              const baseRows = getRowsImpl(table).filter((r) => evalPred(pred, r));

              // Detect "shape select" — caller passed an object whose values
              // are table proxies, e.g. db.select({log, attendee, booking}).
              // In that case we resolve to rows shaped {key: rowFromThatTable}.
              const isShape =
                cols &&
                typeof cols === "object" &&
                Object.values(cols as Record<string, unknown>).some(
                  (v) => v && typeof v === "object" && "_name" in (v as Record<string, unknown>),
                );

              if (isShape) {
                const shape = cols as Record<string, { _name: string }>;
                const baseKey = Object.entries(shape).find(
                  ([, v]) => v && (v as { _name?: string })._name === table._name,
                )?.[0];

                const out = baseRows.map((baseRow) => {
                  const wrapped: Record<string, unknown> = {};
                  if (baseKey) wrapped[baseKey] = { ...baseRow };

                  for (const join of joins) {
                    const joinKey = Object.entries(shape).find(
                      ([, v]) => v && (v as { _name?: string })._name === join.table._name,
                    )?.[0];
                    if (!joinKey) continue;
                    // Synthetic row exposing fields from BOTH base and join
                    // candidate so an `eq(activityLog.attendeeId, attendees.id)`
                    // predicate can resolve in either order.
                    const candidates = getRowsImpl(join.table);
                    const matched =
                      candidates.find((c) => {
                        const synthetic = { ...baseRow, ...c };
                        return evalPred(join.on, synthetic);
                      }) ?? null;
                    wrapped[joinKey] = matched ? { ...matched } : null;
                  }
                  return wrapped;
                });

                const sliced = limitN !== undefined ? out.slice(0, limitN) : out;
                resolve(sliced);
                return;
              }

              const rows = limitN !== undefined ? baseRows.slice(0, limitN) : baseRows;
              resolve(rows.map((r) => ({ ...r })));
            } catch (e) {
              reject(e);
            }
          },
        };
        return builder;
      },
      insert(table: { _name: string }) {
        return {
          values(data: Record<string, unknown> | Array<Record<string, unknown>>) {
            const rows = Array.isArray(data) ? data : [data];
            const store = getRowsImpl(table);
            const inserted: Array<Record<string, unknown>> = [];
            for (const r of rows) {
              const row: Record<string, unknown> = {
                id: nextId(store),
                createdAt: new Date(),
                updatedAt: new Date(),
                ...r,
              };
              store.push(row);
              inserted.push(row);
            }
            const out: Record<string, unknown> = {
              returning() {
                return Promise.resolve(inserted.map((r) => ({ ...r })));
              },
              onConflictDoUpdate(_opts: unknown) {
                return out;
              },
              then(resolve: (v: unknown) => void) {
                resolve(undefined);
              },
              catch() {
                return Promise.resolve(undefined);
              },
            };
            return out;
          },
        };
      },
      update(table: { _name: string }) {
        let setData: Record<string, unknown> = {};
        let pred: Pred;
        const builder: Record<string, unknown> = {
          set(d: Record<string, unknown>) {
            setData = d;
            return builder;
          },
          where(p: Pred) {
            pred = p;
            return builder;
          },
          returning() {
            const store = getRowsImpl(table);
            const updated: Array<Record<string, unknown>> = [];
            for (const r of store) {
              if (evalPred(pred, r)) {
                Object.assign(r, setData);
                updated.push({ ...r });
              }
            }
            return Promise.resolve(updated);
          },
          then(resolve: (v: unknown) => void) {
            const store = getRowsImpl(table);
            for (const r of store) {
              if (evalPred(pred, r)) Object.assign(r, setData);
            }
            resolve(undefined);
          },
        };
        return builder;
      },
      delete(table: { _name: string }) {
        let pred: Pred;
        const builder: Record<string, unknown> = {
          where(p: Pred) {
            pred = p;
            return builder;
          },
          then(resolve: (v: unknown) => void) {
            const store = getRowsImpl(table);
            for (let i = store.length - 1; i >= 0; i--) {
              if (evalPred(pred, store[i])) store.splice(i, 1);
            }
            resolve(undefined);
          },
        };
        return builder;
      },
      transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(db),
    };

    return {
      mockDb: db,
      getRows: getRowsImpl,
      resetStore: resetStoreImpl,
      makeTable: makeTableImpl,
      stripeMock: stripeMockImpl,
      setStripeAvailable: (available: boolean) => {
        stripeAvailable = available;
      },
      getStripeMock: () => (stripeAvailable ? stripeMockImpl : null),
    };
  });

const {
  sendConfirmationAndReceiptEmailMock,
  sendAttendeeChangeNotificationMock,
  sendWelcomeEmailMock,
  sendCommunitySocialEmailMock,
  getEventSettingsMock,
  runConfirmationSideEffectsMock,
  resetDeliveryMocks,
} = vi.hoisted(() => {
  const sendConfirmationAndReceiptEmailMock = vi.fn();
  const sendAttendeeChangeNotificationMock = vi.fn();
  const sendWelcomeEmailMock = vi.fn();
  const sendCommunitySocialEmailMock = vi.fn();
  const getEventSettingsMock = vi.fn();
  const runConfirmationSideEffectsMock = vi.fn();

  return {
    sendConfirmationAndReceiptEmailMock,
    sendAttendeeChangeNotificationMock,
    sendWelcomeEmailMock,
    sendCommunitySocialEmailMock,
    getEventSettingsMock,
    runConfirmationSideEffectsMock,
    resetDeliveryMocks: () => {
      sendConfirmationAndReceiptEmailMock.mockReset();
      sendConfirmationAndReceiptEmailMock.mockResolvedValue(true);
      sendAttendeeChangeNotificationMock.mockReset();
      sendAttendeeChangeNotificationMock.mockResolvedValue(undefined);
      sendWelcomeEmailMock.mockReset();
      sendWelcomeEmailMock.mockResolvedValue(true);
      sendCommunitySocialEmailMock.mockReset();
      sendCommunitySocialEmailMock.mockResolvedValue(true);
      getEventSettingsMock.mockReset();
      getEventSettingsMock.mockResolvedValue({
        socialEnabled: true,
        socialStartAt: new Date("2027-03-02T18:00:00Z"),
        socialVenue: "Configured SWP social venue",
      });
      runConfirmationSideEffectsMock.mockReset();
      runConfirmationSideEffectsMock.mockResolvedValue({ ran: [], skipped: [], failed: [] });
    },
  };
});

vi.mock("@workspace/db", () => {
  const tableNames = [
    "bookingsTable",
    "attendeesTable",
    "promoCodesTable",
    "discountTiersTable",
    "notificationEmailsTable",
    "passInventoryTable",
    "passConfigTable",
    "activityLogTable",
    "emailLogsTable",
    "emailTemplatesTable",
    "eventSettingsTable",
    "hearAboutUsTable",
  ];
  const out: Record<string, unknown> = { db: mockDb };
  for (const n of tableNames) out[n] = makeTable(n);
  return out;
});

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  and: (...preds: unknown[]) => ({ op: "and", preds }),
  or: (...preds: unknown[]) => ({ op: "or", preds }),
  desc: (col: unknown) => ({ op: "desc", col }),
  asc: (col: unknown) => ({ op: "asc", col }),
  isNull: (col: unknown) => ({ op: "isNull", col }),
  inArray: (col: unknown, vals: unknown[]) => ({ op: "inArray", col, vals }),
  notInArray: (col: unknown, vals: unknown[]) => ({ op: "notInArray", col, vals }),
  count: () => ({ op: "count" }),
  not: (p: unknown) => ({ op: "not", preds: [p] }),
  lte: () => ({ op: "lte" }),
  gte: () => ({ op: "gte" }),
  sql: Object.assign((..._a: unknown[]) => ({ op: "sql" }), {
    raw: () => ({ op: "sql" }),
  }),
}));

// Side-effect-free email + integration helpers — we don't want the test to
// try to send mail or call Stripe.
vi.mock("../lib/email", () => ({
  sendAttendeeChangeNotification: sendAttendeeChangeNotificationMock,
  sendWelcomeEmail: sendWelcomeEmailMock,
  sendCommunitySocialEmail: sendCommunitySocialEmailMock,
  sendConfirmationAndReceiptEmail: sendConfirmationAndReceiptEmailMock,
  sendIncompleteFormNotification: async () => undefined,
  sendReissuedInvoiceEmail: async () => undefined,
  sendBillingEditNotification: async () => undefined,
  diffBillingFields: () => ({}),
  getEventSettings: getEventSettingsMock,
  resolveLatestBookingPdf: async () => null,
  resendConfirmationAndReceipt: async () => undefined,
}));

vi.mock("../lib/google-sheets", () => ({
  syncBookingToSheets: async () => undefined,
}));

vi.mock("../lib/booking-confirmation", () => ({
  runConfirmationSideEffects: runConfirmationSideEffectsMock,
  deliveryStatusForBooking: () => ({ needsAttention: false }),
  claimBookingConfirmation: async () => null,
}));

vi.mock("../lib/invoice", () => ({
  refreshStripeInvoiceStatusIfStale: async () => undefined,
  reissueBookingInvoice: async () => ({ alreadyPaid: false }),
  applyReissueInvoiceResultTx: async () => undefined,
  getStripeInvoiceStatus: async () => ({ paid: false }),
  refreshStripeInvoiceUrls: async () => undefined,
}));

vi.mock("../lib/stripe-client", () => ({
  getStripe: () => getStripeMock(),
}));

vi.mock("../middleware/admin-login-throttle", () => ({
  adminLoginThrottle: (_req: unknown, _res: unknown, next: () => void) => next(),
  recordAdminLoginFailure: () => ({ failures: 1, lockedForMs: 0 }),
  recordAdminLoginSuccess: () => undefined,
  _resetAdminLoginThrottleForTests: () => undefined,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}));

// Imported after the mocks above so the modules see the mocked DB.
import adminRouter from "./admin";
import attendeesRouter from "./attendees";
import { issueAdminToken } from "../middleware/admin-auth";

let server: http.Server;
let baseUrl: string;
let adminToken: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", adminRouter);
  app.use("/api", attendeesRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}/api`;
  adminToken = issueAdminToken(process.env.ADMIN_PASSWORD!).token;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  resetStore();
  resetDeliveryMocks();
});

function activityRows(): Array<Record<string, unknown>> {
  return getRows({ _name: "activityLogTable" });
}

function seedBooking(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const store = getRows({ _name: "bookingsTable" });
  const row: Record<string, unknown> = {
    id: 101,
    sessionToken: "sess-101",
    status: "partial",
    passType: "single",
    attendeeType: "hr_professional",
    quantity: 1,
    subtotalAmount: "199",
    vatAmount: "39.80",
    totalAmount: "238.80",
    paymentMethod: null,
    manualEntry: false,
    stripeInvoiceId: null,
    stripePaymentIntentId: null,
    stripeInvoiceStatus: null,
    invoiceDueDate: null,
    paidAt: null,
    stripeInvoiceStatusSyncedAt: null,
    lastInvoiceReminderSentAt: null,
    orderReference: "SWP-12345",
    currentStep: 4,
    managementToken: "mgmt-101",
    billingName: null,
    billingEmail: null,
    billingCompany: null,
    confirmationEmailSent: false,
    welcomeEmailsSent: false,
    communitySocialEmailSent: false,
    organiserNotified: false,
    sheetsSynced: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
  store.push(row);
  return row;
}

function seedAttendee(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const store = getRows({ _name: "attendeesTable" });
  const row: Record<string, unknown> = {
    id: 201,
    bookingId: 101,
    isLead: true,
    seatIndex: 0,
    firstName: "Alice",
    lastName: "Smith",
    jobTitle: "Head of People",
    company: "Acme",
    workEmail: "alice@acme.test",
    phone: null,
    dietaryAccessibility: null,
    notes: null,
    isTbc: false,
    gdprConsent: true,
    gdprConsentAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
  store.push(row);
  return row;
}

describe("admin audit trail — integration", () => {
  it("POST /admin/login records a admin_login_success row with the IP as actor", async () => {
    const res = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(body.token).toMatch(/^[0-9a-f]{64}\./);

    const rows = activityRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.type).toBe("admin_login_success");
    // The actor should be a non-empty IP string (loopback in this test).
    expect(typeof row.actor).toBe("string");
    expect(row.actor).not.toBe("admin");
    expect((row.actor as string).length).toBeGreaterThan(0);
    const data = row.data as Record<string, unknown>;
    expect(data.summary).toBe("Admin logged in");
    expect(typeof data.expiresAt).toBe("string");
  });

  it("POST /admin/login with the wrong password records a admin_login_failure row", async () => {
    const res = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "definitely-not-the-password" }),
    });
    expect(res.status).toBe(401);

    const rows = activityRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("admin_login_failure");
    const data = rows[0].data as Record<string, unknown>;
    expect(typeof data.summary).toBe("string");
    expect((data.summary as string).toLowerCase()).toMatch(/failed admin login/);
    expect(data.failures).toBe(1);
  });

  it("GET /admin/registrations searches company, job title, organiser notes and promo code case-insensitively", async () => {
    seedBooking({
      id: 101,
      orderReference: "SWP-SEARCH-1",
      promoCode: "VIPTEAM",
    });
    seedAttendee({
      id: 201,
      bookingId: 101,
      firstName: "Alex",
      lastName: "Taylor",
      workEmail: "alex@example.test",
      company: "Northwind Foods",
      jobTitle: "Director of Workforce Strategy",
      notes: "Transferred from HRAS 2026",
    });
    seedBooking({
      id: 102,
      orderReference: "SWP-SEARCH-2",
      promoCode: "EARLYBIRD",
    });
    seedAttendee({
      id: 202,
      bookingId: 102,
      firstName: "Morgan",
      lastName: "Jones",
      workEmail: "morgan@example.test",
      company: "Contoso Retail",
      jobTitle: "HR Manager",
    });

    for (const query of [
      "northwind",
      "workforce strategy",
      "transferred from hras",
      "  vipteam  ",
    ]) {
      const res = await fetch(
        `${baseUrl}/admin/registrations?search=${encodeURIComponent(query)}`,
        { headers: { "x-admin-token": adminToken } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        total: number;
        registrations: Array<{ id: number }>;
      };
      expect(body.total, query).toBe(1);
      expect(
        body.registrations.map((registration) => registration.id),
        query,
      ).toEqual([101]);
    }
  });

  it("PATCH /admin/registrations/:id/status records a status change with before/after diff", async () => {
    seedBooking({ id: 101, status: "partial", orderReference: "SWP-12345" });

    const res = await fetch(`${baseUrl}/admin/registrations/101/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": adminToken,
      },
      body: JSON.stringify({ status: "paid" }),
    });
    expect(res.status).toBe(200);

    const rows = activityRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.type).toBe("admin_booking_status_changed");
    expect(row.actor).toBe("admin");
    expect(row.bookingId).toBe(101);

    const data = row.data as Record<string, unknown>;
    expect(data.summary).toBe("Booking SWP-12345: partial → paid");
    const changes = data.changes as Record<string, { from: unknown; to: unknown }>;
    expect(changes.status).toEqual({ from: "partial", to: "paid" });
    expect((data.before as Record<string, unknown>).status).toBe("partial");
    expect((data.after as Record<string, unknown>).status).toBe("paid");

    // Underlying booking row should have actually been updated too — guards
    // against the audit row being written from stale data.
    const booking = getRows({ _name: "bookingsTable" })[0];
    expect(booking.status).toBe("paid");
  });

  it("POST /admin/registrations creates a labelled direct-invoice delegate without Stripe side-effects", async () => {
    const res = await fetch(`${baseUrl}/admin/registrations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": adminToken,
      },
      body: JSON.stringify({
        firstName: "Jane",
        lastName: "Invoice",
        jobTitle: "People Director",
        company: "Example Ltd",
        workEmail: "Jane.Invoice@Example.test",
        phone: "+44 7700 900000",
        notes: "Invoice requested directly from the organiser",
        passType: "single",
        status: "invoiced",
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.manualEntry).toBe(true);
    expect(body.status).toBe("invoiced");
    expect(body.paymentMethod).toBe("invoice");
    expect(body.orderReference).toBe("SWP27-6542");
    expect(body.stripeInvoiceId).toBeUndefined();

    const booking = getRows({ _name: "bookingsTable" })[0];
    expect(booking.manualEntry).toBe(true);
    expect(booking.status).toBe("invoiced");
    expect(booking.invoiceDueDate).toBeInstanceOf(Date);
    expect(booking.totalAmount).toBe("298.80");

    const attendee = getRows({ _name: "attendeesTable" })[0];
    expect(attendee.firstName).toBe("Jane");
    expect(attendee.workEmail).toBe("jane.invoice@example.test");
    expect(attendee.notes).toBe("Invoice requested directly from the organiser");

    expect(stripeMock.invoices.pay).not.toHaveBeenCalled();
    expect(stripeMock.invoices.voidInvoice).not.toHaveBeenCalled();
    expect(stripeMock.refunds.create).not.toHaveBeenCalled();

    const [audit] = activityRows();
    expect(audit.type).toBe("admin_attendee_added");
    const auditData = audit.data as Record<string, unknown>;
    expect(auditData.summary).toContain("manually added delegate Jane Invoice");
  });

  it("PATCH /admin/registrations/:id/status marks a booking transferred without changing Stripe", async () => {
    seedBooking({
      id: 101,
      status: "paid",
      paymentMethod: "card",
      stripePaymentIntentId: "pi_transfer",
      paidAt: new Date(),
      orderReference: "SWP-12345",
    });

    const res = await fetch(`${baseUrl}/admin/registrations/101/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": adminToken,
      },
      body: JSON.stringify({ status: "transferred" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("transferred");
    expect(body.stripeAction).toBe("skipped");
    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
    expect(stripeMock.invoices.voidInvoice).not.toHaveBeenCalled();

    const booking = getRows({ _name: "bookingsTable" })[0];
    expect(booking.status).toBe("transferred");
    expect(booking.stripePaymentIntentId).toBe("pi_transfer");
    const auditData = activityRows()[0].data as Record<string, unknown>;
    expect(auditData.summary).toBe("Booking SWP-12345: paid → transferred");
  });

  it("PATCH /admin/registrations/:id/status marks an open Stripe invoice paid out of band before syncing local status", async () => {
    seedBooking({
      id: 101,
      status: "invoiced",
      paymentMethod: "invoice",
      stripeInvoiceId: "in_open_123",
      stripeInvoiceStatus: "open",
      stripeInvoicePdfUrl: "https://stripe.test/in_open_123-old.pdf",
      stripeInvoicePaymentUrl: "https://stripe.test/in_open_123-old",
    });
    setStripeAvailable(true);
    stripeMock.invoices.retrieve.mockResolvedValue({
      id: "in_open_123",
      status: "open",
      invoice_pdf: "https://stripe.test/in_open_123-before-pay.pdf",
      hosted_invoice_url: "https://stripe.test/in_open_123-before-pay",
    });
    stripeMock.invoices.pay.mockResolvedValue({
      id: "in_open_123",
      status: "paid",
      invoice_pdf: "https://stripe.test/in_open_123-paid.pdf",
      hosted_invoice_url: "https://stripe.test/in_open_123-paid",
    });

    const res = await fetch(`${baseUrl}/admin/registrations/101/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": adminToken,
      },
      body: JSON.stringify({ status: "paid" }),
    });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.stripeAction).toBe("invoice_paid_out_of_band");
    expect(stripeMock.invoices.retrieve).toHaveBeenCalledWith("in_open_123");
    expect(stripeMock.invoices.pay).toHaveBeenCalledWith("in_open_123", {
      paid_out_of_band: true,
    });

    const booking = getRows({ _name: "bookingsTable" })[0];
    expect(booking.status).toBe("paid");
    expect(booking.paidAt).toBeInstanceOf(Date);
    expect(booking.stripeInvoiceStatus).toBe("paid");
    expect(booking.stripeInvoiceStatusSyncedAt).toBeInstanceOf(Date);
    expect(booking.stripeInvoicePdfUrl).toBe("https://stripe.test/in_open_123-paid.pdf");
    expect(booking.stripeInvoicePaymentUrl).toBe("https://stripe.test/in_open_123-paid");
  });

  it("PATCH /admin/registrations/:id/status syncs an already-paid Stripe invoice without paying it again", async () => {
    seedBooking({
      id: 101,
      status: "invoiced",
      paymentMethod: "invoice",
      stripeInvoiceId: "in_paid_123",
      stripeInvoiceStatus: "open",
    });
    setStripeAvailable(true);
    stripeMock.invoices.retrieve.mockResolvedValue({
      id: "in_paid_123",
      status: "paid",
      invoice_pdf: "https://stripe.test/in_paid_123.pdf",
      hosted_invoice_url: "https://stripe.test/in_paid_123",
    });

    const res = await fetch(`${baseUrl}/admin/registrations/101/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": adminToken,
      },
      body: JSON.stringify({ status: "paid" }),
    });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.stripeAction).toBe("invoice_paid_out_of_band");
    expect(stripeMock.invoices.retrieve).toHaveBeenCalledWith("in_paid_123");
    expect(stripeMock.invoices.pay).not.toHaveBeenCalled();

    const booking = getRows({ _name: "bookingsTable" })[0];
    expect(booking.status).toBe("paid");
    expect(booking.paidAt).toBeInstanceOf(Date);
    expect(booking.stripeInvoiceStatus).toBe("paid");
    expect(booking.stripeInvoiceStatusSyncedAt).toBeInstanceOf(Date);
    expect(booking.stripeInvoicePdfUrl).toBe("https://stripe.test/in_paid_123.pdf");
    expect(booking.stripeInvoicePaymentUrl).toBe("https://stripe.test/in_paid_123");
  });

  it("PATCH /admin/registrations/:id/status returns an error and leaves booking invoiced when Stripe invoice payment fails", async () => {
    seedBooking({
      id: 101,
      status: "invoiced",
      paymentMethod: "invoice",
      stripeInvoiceId: "in_open_123",
      stripeInvoiceStatus: "open",
      paidAt: null,
    });
    setStripeAvailable(true);
    stripeMock.invoices.retrieve.mockResolvedValue({
      id: "in_open_123",
      status: "open",
    });
    stripeMock.invoices.pay.mockRejectedValue(new Error("Stripe unavailable"));

    const res = await fetch(`${baseUrl}/admin/registrations/101/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": adminToken,
      },
      body: JSON.stringify({ status: "paid" }),
    });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(502);
    expect(body.stripeAction).toBe("failed");
    expect(stripeMock.invoices.pay).toHaveBeenCalledWith("in_open_123", {
      paid_out_of_band: true,
    });

    const booking = getRows({ _name: "bookingsTable" })[0];
    expect(booking.status).toBe("invoiced");
    expect(booking.paidAt).toBeNull();
    expect(booking.stripeInvoiceStatus).toBe("open");
    expect(activityRows()).toHaveLength(0);
  });

  it("PATCH /admin/registrations/:id/status still voids open invoices when cancelling invoiced bookings", async () => {
    seedBooking({
      id: 101,
      status: "invoiced",
      paymentMethod: "invoice",
      stripeInvoiceId: "in_open_123",
    });
    setStripeAvailable(true);
    stripeMock.invoices.voidInvoice.mockResolvedValue({ id: "in_open_123", status: "void" });

    const res = await fetch(`${baseUrl}/admin/registrations/101/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": adminToken,
      },
      body: JSON.stringify({ status: "cancelled" }),
    });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.stripeAction).toBe("invoice_voided");
    expect(stripeMock.invoices.voidInvoice).toHaveBeenCalledWith("in_open_123");
    expect(getRows({ _name: "bookingsTable" })[0].status).toBe("cancelled");
  });

  it("PATCH /admin/registrations/:id/status still issues card refunds when cancelling paid card bookings", async () => {
    seedBooking({
      id: 101,
      status: "paid",
      paymentMethod: "card",
      stripePaymentIntentId: "pi_123",
      paidAt: new Date(),
    });
    setStripeAvailable(true);
    stripeMock.refunds.create.mockResolvedValue({ id: "re_123" });

    const res = await fetch(`${baseUrl}/admin/registrations/101/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": adminToken,
      },
      body: JSON.stringify({ status: "cancelled" }),
    });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.stripeAction).toBe("refund_issued");
    expect(stripeMock.refunds.create).toHaveBeenCalledWith({ payment_intent: "pi_123" });
    expect(getRows({ _name: "bookingsTable" })[0].status).toBe("refunded");
  });

  it("POST /admin/registrations/:id/resend-confirmation-email resends only the confirmation email", async () => {
    seedBooking({
      id: 101,
      status: "paid",
      confirmationEmailSent: true,
      welcomeEmailsSent: true,
      organiserNotified: true,
      sheetsSynced: true,
      orderReference: "SWP27-12345",
    });
    seedAttendee({ bookingId: 101, isLead: true, workEmail: "lead@example.test" });

    const res = await fetch(`${baseUrl}/admin/registrations/101/resend-confirmation-email`, {
      method: "POST",
      headers: { "x-admin-token": adminToken },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.resend).toEqual({
      type: "confirmation",
      sent: true,
      recipients: ["lead@example.test"],
      failedRecipients: [],
    });
    expect(sendConfirmationAndReceiptEmailMock).toHaveBeenCalledWith(101);
    expect(sendWelcomeEmailMock).not.toHaveBeenCalled();
    expect(runConfirmationSideEffectsMock).not.toHaveBeenCalled();

    const booking = getRows({ _name: "bookingsTable" })[0];
    expect(booking.confirmationEmailSent).toBe(true);
    expect(booking.welcomeEmailsSent).toBe(true);
    expect(booking.organiserNotified).toBe(true);
    expect(booking.sheetsSynced).toBe(true);
  });

  it("POST /admin/registrations/:id/resend-welcome-emails resends only to non-TBC attendees", async () => {
    seedBooking({
      id: 101,
      status: "invoiced",
      confirmationEmailSent: true,
      welcomeEmailsSent: true,
      organiserNotified: false,
      sheetsSynced: false,
      orderReference: "SWP27-12345",
    });
    seedAttendee({
      id: 201,
      bookingId: 101,
      isLead: true,
      firstName: "Alice",
      workEmail: "alice@example.test",
    });
    seedAttendee({
      id: 202,
      bookingId: 101,
      isLead: false,
      firstName: "Ben",
      workEmail: "ben@example.test",
      seatIndex: 1,
    });
    seedAttendee({
      id: 203,
      bookingId: 101,
      isLead: false,
      firstName: "TBC",
      workEmail: "tbc@example.test",
      isTbc: true,
      seatIndex: 2,
    });

    const res = await fetch(`${baseUrl}/admin/registrations/101/resend-welcome-emails`, {
      method: "POST",
      headers: { "x-admin-token": adminToken },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.resend).toEqual({
      type: "welcome",
      sent: true,
      recipients: ["alice@example.test", "ben@example.test"],
      failedRecipients: [],
    });
    expect(sendWelcomeEmailMock).toHaveBeenCalledTimes(2);
    expect(sendWelcomeEmailMock).toHaveBeenNthCalledWith(1, 101, "Alice", "alice@example.test");
    expect(sendWelcomeEmailMock).toHaveBeenNthCalledWith(2, 101, "Ben", "ben@example.test");
    expect(sendConfirmationAndReceiptEmailMock).not.toHaveBeenCalled();
    expect(runConfirmationSideEffectsMock).not.toHaveBeenCalled();

    const booking = getRows({ _name: "bookingsTable" })[0];
    expect(booking.confirmationEmailSent).toBe(true);
    expect(booking.welcomeEmailsSent).toBe(true);
    expect(booking.organiserNotified).toBe(false);
    expect(booking.sheetsSynced).toBe(false);
  });

  it("POST /admin/registrations/:id/send-community-social-email sends only to non-TBC attendees", async () => {
    seedBooking({
      id: 101,
      status: "paid",
      confirmationEmailSent: true,
      welcomeEmailsSent: true,
      communitySocialEmailSent: false,
      organiserNotified: true,
      sheetsSynced: true,
    });
    seedAttendee({
      id: 201,
      bookingId: 101,
      isLead: true,
      firstName: "Alice",
      workEmail: "alice@example.test",
    });
    seedAttendee({
      id: 202,
      bookingId: 101,
      isLead: false,
      firstName: "Ben",
      workEmail: "ben@example.test",
      seatIndex: 1,
    });
    seedAttendee({
      id: 203,
      bookingId: 101,
      isLead: false,
      firstName: "TBC",
      workEmail: "tbc@example.test",
      isTbc: true,
      seatIndex: 2,
    });

    const res = await fetch(`${baseUrl}/admin/registrations/101/send-community-social-email`, {
      method: "POST",
      headers: { "x-admin-token": adminToken },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.resend).toEqual({
      type: "community_social",
      sent: true,
      recipients: ["alice@example.test", "ben@example.test"],
      failedRecipients: [],
    });
    expect(sendCommunitySocialEmailMock).toHaveBeenCalledTimes(2);
    expect(sendCommunitySocialEmailMock).toHaveBeenNthCalledWith(
      1,
      101,
      "Alice",
      "alice@example.test",
    );
    expect(sendCommunitySocialEmailMock).toHaveBeenNthCalledWith(2, 101, "Ben", "ben@example.test");
    expect(sendConfirmationAndReceiptEmailMock).not.toHaveBeenCalled();
    expect(sendWelcomeEmailMock).not.toHaveBeenCalled();
    expect(runConfirmationSideEffectsMock).not.toHaveBeenCalled();

    const booking = getRows({ _name: "bookingsTable" })[0];
    expect(booking.communitySocialEmailSent).toBe(true);
    expect(booking.organiserNotified).toBe(true);
    expect(booking.sheetsSynced).toBe(true);
  });

  it("Community Social send is blocked until its SWP settings are configured", async () => {
    seedBooking({ id: 101, status: "invoiced", communitySocialEmailSent: false });
    seedAttendee({ bookingId: 101, firstName: "Alice", workEmail: "alice@example.test" });
    getEventSettingsMock.mockResolvedValue({
      socialEnabled: false,
      socialStartAt: null,
      socialVenue: null,
    });

    const res = await fetch(`${baseUrl}/admin/registrations/101/send-community-social-email`, {
      method: "POST",
      headers: { "x-admin-token": adminToken },
    });

    expect(res.status).toBe(409);
    expect(sendCommunitySocialEmailMock).not.toHaveBeenCalled();
    expect(getRows({ _name: "bookingsTable" })[0].communitySocialEmailSent).toBe(false);
  });

  it("failed confirmation resend leaves all delivery flags unchanged", async () => {
    seedBooking({
      id: 101,
      status: "paid",
      confirmationEmailSent: false,
      welcomeEmailsSent: true,
      organiserNotified: true,
      sheetsSynced: true,
    });
    seedAttendee({ bookingId: 101, isLead: true, workEmail: "lead@example.test" });
    sendConfirmationAndReceiptEmailMock.mockResolvedValue(false);

    const res = await fetch(`${baseUrl}/admin/registrations/101/resend-confirmation-email`, {
      method: "POST",
      headers: { "x-admin-token": adminToken },
    });

    expect(res.status).toBe(502);
    const booking = getRows({ _name: "bookingsTable" })[0];
    expect(booking.confirmationEmailSent).toBe(false);
    expect(booking.welcomeEmailsSent).toBe(true);
    expect(booking.organiserNotified).toBe(true);
    expect(booking.sheetsSynced).toBe(true);
  });

  it("POST /admin/promo-codes records an admin_promo_created row with the new promo's after-state", async () => {
    const res = await fetch(`${baseUrl}/admin/promo-codes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": adminToken,
      },
      body: JSON.stringify({
        code: "earlybird",
        discountType: "percentage",
        discountValue: 10,
        maxUses: 50,
        isActive: true,
        applicablePassTypes: ["single", "business"],
      }),
    });
    expect(res.status).toBe(201);

    const rows = activityRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.type).toBe("admin_promo_created");
    expect(row.actor).toBe("admin");

    const data = row.data as Record<string, unknown>;
    expect(data.summary).toBe("Created promo code EARLYBIRD");
    const after = data.after as Record<string, unknown>;
    expect(after.code).toBe("EARLYBIRD");
    expect(after.discountType).toBe("percentage");
    expect(after.maxUses).toBe(50);
    expect(after.isActive).toBe(true);
    // No `before` for a creation — so changes should reflect "from null → ..."
    const changes = data.changes as Record<string, { from: unknown; to: unknown }>;
    expect(changes.code.from).toBeNull();
    expect(changes.code.to).toBe("EARLYBIRD");
  });

  it("GET /admin/activity surfaces a freshly-written audit row in the feed", async () => {
    seedBooking({ id: 101, status: "partial", orderReference: "SWP-12345" });

    // Drive a real mutation so an audit row is written.
    const mutateRes = await fetch(`${baseUrl}/admin/registrations/101/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ status: "paid" }),
    });
    expect(mutateRes.status).toBe(200);

    const feedRes = await fetch(`${baseUrl}/admin/activity`, {
      headers: { "x-admin-token": adminToken },
    });
    expect(feedRes.status).toBe(200);
    const body = (await feedRes.json()) as {
      feed: Array<{ type: string; actor?: string; data?: Record<string, unknown> }>;
    };

    const auditEntry = body.feed.find((f) => f.type === "admin_booking_status_changed");
    expect(auditEntry).toBeDefined();
    expect(auditEntry!.actor).toBe("admin");
    const data = auditEntry!.data as Record<string, unknown>;
    expect(data.summary).toBe("Booking SWP-12345: partial → paid");
    const changes = data.changes as Record<string, { from: unknown; to: unknown }>;
    expect(changes.status).toEqual({ from: "partial", to: "paid" });
  });

  it("PATCH /bookings/:bookingId/attendees/:attendeeId records an admin_attendee_updated row with masked PII before/after", async () => {
    seedBooking({ id: 101, sessionToken: "sess-101" });
    seedAttendee({
      id: 201,
      bookingId: 101,
      firstName: "Alice",
      lastName: "Smith",
      workEmail: "alice@acme.test",
      notes: "Transferred to HR Analytics Summit 2027",
      isTbc: false,
    });

    const res = await fetch(`${baseUrl}/bookings/101/attendees/201`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": adminToken,
      },
      body: JSON.stringify({
        firstName: "Alicia",
        lastName: "Smithson",
        jobTitle: "Head of People",
        company: "Acme",
        workEmail: "alicia@acme.test",
        notes: "Transferred to HR Analytics Summit 2027",
        gdprConsent: true,
      }),
    });
    expect(res.status).toBe(200);
    const responseBody = (await res.json()) as Record<string, unknown>;
    expect(responseBody).not.toHaveProperty("notes");

    const rows = activityRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.type).toBe("admin_attendee_updated");
    expect(row.actor).toBe("admin");
    expect(row.bookingId).toBe(101);
    expect(row.attendeeId).toBe(201);

    const data = row.data as Record<string, unknown>;
    expect(data.summary).toBe("Admin edited attendee Alicia Smithson on booking #101");

    // PII must be masked in the persisted before/after even though the diff
    // was real (firstName/lastName/workEmail are all in the PII allowlist).
    const before = data.before as Record<string, unknown>;
    const after = data.after as Record<string, unknown>;
    expect(before.firstName).toBe("***(5)"); // "Alice"
    expect(after.firstName).toBe("***(6)"); // "Alicia"
    expect(before.workEmail).toMatch(/^\*\*\*\(/);
    expect(after.workEmail).toMatch(/^\*\*\*\(/);
    expect(after.notes).toMatch(/^\*\*\*\(/);
    expect(before.isTbc).toBe(false);
    expect(after.isTbc).toBe(false);

    const changes = data.changes as Record<string, { from: unknown; to: unknown }>;
    expect(changes.firstName).toEqual({ from: "***(5)", to: "***(6)" });
    expect(changes.workEmail.from).toMatch(/^\*\*\*\(/);
    expect(changes.workEmail.to).toMatch(/^\*\*\*\(/);

    // Underlying attendee should actually be updated.
    const attendee = getRows({ _name: "attendeesTable" })[0];
    expect(attendee.firstName).toBe("Alicia");
    expect(attendee.workEmail).toBe("alicia@acme.test");
    expect(attendee.notes).toBe("Transferred to HR Analytics Summit 2027");
    expect(sendAttendeeChangeNotificationMock).not.toHaveBeenCalled();

    const detailRes = await fetch(`${baseUrl}/admin/registrations/101`, {
      headers: { "x-admin-token": adminToken },
    });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      attendees: Array<{ notes?: string | null }>;
    };
    expect(detail.attendees[0]?.notes).toBe("Transferred to HR Analytics Summit 2027");
  });

  it("PATCH /bookings/:bookingId/attendees/:attendeeId clears organiser notes with null", async () => {
    seedBooking({ id: 101, sessionToken: "sess-101" });
    seedAttendee({ id: 201, bookingId: 101, notes: "Move to another event" });

    const res = await fetch(`${baseUrl}/bookings/101/attendees/201`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": adminToken,
      },
      body: JSON.stringify({ notes: null }),
    });

    expect(res.status).toBe(200);
    expect(getRows({ _name: "attendeesTable" })[0].notes).toBeNull();

    const detailRes = await fetch(`${baseUrl}/admin/registrations/101`, {
      headers: { "x-admin-token": adminToken },
    });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      attendees: Array<{ notes?: string | null }>;
    };
    expect(detail.attendees[0]?.notes).toBeNull();
  });

  it("non-admin attendee create and update requests cannot change organiser notes", async () => {
    seedBooking({ id: 101, sessionToken: "sess-101" });
    seedAttendee({
      id: 201,
      bookingId: 101,
      notes: "Internal organiser context",
    });

    const patchRes = await fetch(`${baseUrl}/bookings/101/attendees/201`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-booking-session": "sess-101",
      },
      body: JSON.stringify({
        phone: "+44 7700 900123",
        notes: "Attempted public overwrite",
      }),
    });
    expect(patchRes.status).toBe(200);
    expect((await patchRes.json()) as Record<string, unknown>).not.toHaveProperty("notes");
    expect(getRows({ _name: "attendeesTable" })[0].notes).toBe("Internal organiser context");

    const upsertRes = await fetch(`${baseUrl}/bookings/101/attendees`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-booking-session": "sess-101",
      },
      body: JSON.stringify({
        isLead: true,
        seatIndex: 0,
        firstName: "Alice",
        lastName: "Smith",
        jobTitle: "Head of People",
        company: "Acme",
        workEmail: "alice@acme.test",
        gdprConsent: true,
        notes: "Second attempted public overwrite",
      }),
    });
    expect(upsertRes.status).toBe(200);
    expect((await upsertRes.json()) as Record<string, unknown>).not.toHaveProperty("notes");
    expect(getRows({ _name: "attendeesTable" })[0].notes).toBe("Internal organiser context");
  });

  it("PATCH /attendees/:id/managed sends organisers the stored before-and-after attendee changes", async () => {
    seedBooking({
      id: 101,
      status: "paid",
      quantity: 4,
      managementToken: "mgmt-101",
      orderReference: "SWP27-12345",
    });
    seedAttendee({
      id: 202,
      bookingId: 101,
      isLead: false,
      seatIndex: 2,
      firstName: "Alice",
      lastName: "Smith",
      jobTitle: "Head of People",
      company: "Acme",
      workEmail: "alice@acme.test",
      phone: "+44 7000 000 001",
      dietaryAccessibility: "Vegetarian",
      gdprConsent: true,
      isTbc: false,
    });

    const res = await fetch(`${baseUrl}/attendees/202/managed`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        managementToken: "mgmt-101",
        firstName: "Alicia",
        lastName: "Smith",
        jobTitle: "Chief People Officer",
        company: "Acme",
        workEmail: "alicia@acme.test",
        phone: "+44 7000 000 002",
        dietaryAccessibility: "Vegan and step-free access",
        gdprConsent: true,
      }),
    });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(sendWelcomeEmailMock).toHaveBeenCalledWith(101, "Alicia", "alicia@acme.test");
      expect(sendAttendeeChangeNotificationMock).toHaveBeenCalledTimes(1);
    });

    const [bookingId, attendeeId, changeSet] = sendAttendeeChangeNotificationMock.mock.calls[0];
    expect(bookingId).toBe(101);
    expect(attendeeId).toBe(202);
    expect(changeSet.previous).toMatchObject({
      firstName: "Alice",
      jobTitle: "Head of People",
      workEmail: "alice@acme.test",
      seatIndex: 2,
    });
    expect(changeSet.current).toMatchObject({
      firstName: "Alicia",
      jobTitle: "Chief People Officer",
      workEmail: "alicia@acme.test",
      seatIndex: 2,
    });
    expect(changeSet.changes.map((change: { field: string }) => change.field)).toEqual([
      "firstName",
      "jobTitle",
      "workEmail",
      "phone",
      "dietaryAccessibility",
    ]);

    expect(activityRows()[0]?.type).toBe("attendee_change");
    expect(activityRows()[0]?.attendeeId).toBe(202);
  });

  it("PATCH /attendees/:id/managed does not notify organisers when stored values are unchanged", async () => {
    seedBooking({
      id: 101,
      status: "invoiced",
      managementToken: "mgmt-101",
    });
    seedAttendee({
      id: 202,
      bookingId: 101,
      isLead: false,
      seatIndex: 1,
      firstName: "Ben",
      lastName: "Jones",
      jobTitle: "People Director",
      company: "Example Ltd",
      workEmail: "ben@example.test",
      phone: null,
      dietaryAccessibility: null,
      gdprConsent: true,
      isTbc: false,
    });

    const res = await fetch(`${baseUrl}/attendees/202/managed`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        managementToken: "mgmt-101",
        firstName: "Ben",
        lastName: "Jones",
        jobTitle: "People Director",
        company: "Example Ltd",
        workEmail: "ben@example.test",
        phone: "",
        dietaryAccessibility: "",
        gdprConsent: true,
      }),
    });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(sendWelcomeEmailMock).toHaveBeenCalledWith(101, "Ben", "ben@example.test");
      expect(activityRows()[0]?.type).toBe("attendee_change");
    });
    expect(sendAttendeeChangeNotificationMock).not.toHaveBeenCalled();
  });
});
