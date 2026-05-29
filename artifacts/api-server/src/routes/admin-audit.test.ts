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

const { mockDb, getRows, resetStore, makeTable } = vi.hoisted(() => {
  const stores = new Map<string, Array<Record<string, unknown>>>();

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
  sendAttendeeChangeNotification: async () => undefined,
  sendWelcomeEmail: async () => undefined,
  sendIncompleteFormNotification: async () => undefined,
  sendReissuedInvoiceEmail: async () => undefined,
  sendBillingEditNotification: async () => undefined,
  diffBillingFields: () => ({}),
  getEventSettings: async () => null,
  resolveLatestBookingPdf: async () => null,
  resendConfirmationAndReceipt: async () => undefined,
}));

vi.mock("../lib/google-sheets", () => ({
  syncBookingToSheets: async () => undefined,
}));

vi.mock("../lib/booking-confirmation", () => ({
  runConfirmationSideEffects: async () => ({ ran: [], failed: [] }),
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
        gdprConsent: true,
      }),
    });
    expect(res.status).toBe(200);

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
  });
});
