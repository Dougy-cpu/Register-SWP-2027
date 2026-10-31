import { createRequire } from "node:module";
import { randomUUID, randomBytes, createHmac, createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { Readable } from "node:stream";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import express from "express";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import * as schema from "../../../../lib/db/src/schema";

let db: ReturnType<typeof drizzle<typeof schema>>;
let pool: typeof import("@workspace/db").pool;
type TestResponse = Omit<Response, "json"> & { json<T>(): Promise<T> };
const testFetch = (input: string, init?: RequestInit) =>
  fetch(input, init) as Promise<TestResponse>;
type CreatedBooking = { id: number; attendees: unknown[] };
type ManagementView = { changesLocked: boolean; sessionToken?: string };
type CardSession = { sessionId: string };
type InvoiceView = { invoiceId: string };
type StaffView = { bookingId: number; workEmail: string; marketingConsent: boolean };
type PortalView = {
  codes: { redemptions: Record<string, unknown>[] }[];
  documents: { acknowledgementVersion: number; acknowledgedAt: string | null }[];
};
type FileView = { id: string; originalName: string; version: number; checksumSha256: string };
type PhoneView = { id: string; token: string };
type SyncView = {
  scans: { status: string; reason?: string }[];
  leads: { scanCount: number; notes: { note: string }[] }[];
};
type BackupPlan = { batches: { assetIds: string[] }[] };

let pg: { exec: (sql: string) => Promise<unknown> };
let server: Server;
let origin: string;
const intercepted = vi.hoisted(() => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  expireSession: vi.fn(),
  invoice: vi.fn(),
  sendInvoice: vi.fn(),
  welcome: vi.fn(async () => true),
  notify: vi.fn(async () => true),
  sideEffects: vi.fn(),
  signature: vi.fn(),
}));
vi.mock("@workspace/db", async () => ({
  ...(await import("../../../../lib/db/src/schema")),
  db: new Proxy({}, { get: (_, key) => Reflect.get(db, key) }),
}));
vi.mock("../lib/stripe-client", () => ({
  getStripe: () => ({
    checkout: {
      sessions: {
        create: intercepted.createSession,
        retrieve: intercepted.getSession,
        expire: intercepted.expireSession,
      },
    },
    webhooks: { constructEvent: intercepted.signature },
    customers: {
      list: async () => ({ data: [{ id: "cus_fixture" }] }),
      update: async () => ({ id: "cus_fixture" }),
    },
    taxRates: {
      list: async () => ({
        data: [
          {
            id: "txr_fixture",
            percentage: 20,
            inclusive: false,
            active: true,
            display_name: "VAT",
          },
        ],
      }),
      create: async () => ({ id: "txr_fixture" }),
    },
    invoiceItems: { create: async () => ({}) },
    invoices: {
      create: intercepted.invoice,
      finalizeInvoice: async (id: string) => ({ id }),
      sendInvoice: intercepted.sendInvoice,
      retrieve: async (id: string) => ({ id, status: "open" }),
    },
  }),
}));
vi.mock("../lib/booking-confirmation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/booking-confirmation")>()),
  runConfirmationSideEffects: intercepted.sideEffects,
}));
vi.mock("../lib/email", () => ({
  getEventSettings: async () => ({}),
  diffBillingFields: () => [],
  sendIncompleteFormNotification: vi.fn(),
  sendAttendeeChangeNotification: vi.fn(),
  sendWelcomeEmail: vi.fn(),
  sendReissuedInvoiceEmail: vi.fn(),
  sendBillingEditNotification: vi.fn(),
  sendCheckoutExpiredEmail: vi.fn(),
  sendRefundConfirmationEmail: vi.fn(),
  sendDisputeAlertEmail: vi.fn(),
  sendInvoicePaymentFailedEmail: vi.fn(),
  sendConfirmationAndReceiptEmail: vi.fn(),
  sendAttendeeWelcomeEmails: vi.fn(),
  sendOrganiserNotification: vi.fn(),
}));
vi.mock("../lib/sponsor-email", () => ({
  sendSponsorInternalNotification: intercepted.notify,
  sendSponsorStaffWelcome: intercepted.welcome,
  previewSponsorWelcomeEmail: vi.fn(),
  sendSponsorWelcomeEmail: vi.fn(),
}));
vi.mock("../lib/google-sheets", () => ({ syncBookingToSheets: vi.fn(async () => {}) }));
vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
import bookings from "./bookings";
import attendees from "./attendees";
import stripe from "./stripe";
import sponsorRoutes from "./sponsor-workspace";
import adminSponsorRoutes from "./admin-sponsors";
import scannerRoutes from "./lead-scanner";
import pricingRoutes from "./pricing";
import tiers from "./discount-tiers";
import promos from "./promo-codes";
import heard from "./hear-about-us";
import { issueSponsorAccessToken } from "../middleware/sponsor-auth";
import { issueAdminToken } from "../middleware/admin-auth";
import {
  MemorySponsorObjectStorage,
  setSponsorObjectStorageForTests,
} from "../lib/sponsor-storage";
import { confirmSponsor, createSponsorDraft } from "../lib/sponsor-service";
import { releaseSponsorRedemption, restoreSponsorRedemption } from "../lib/sponsor-redemptions";
const storage = new MemorySponsorObjectStorage();
type FixtureCard = {
  id: string;
  url: string;
  mode: string;
  status: string;
  currency: string;
  payment_status: string;
  amount_total: number;
  metadata: Record<string, string>;
};
const cards = new Map<string, FixtureCard>(),
  cardKeys = new Map<string, string>();
beforeEach(() => {
  intercepted.getSession.mockImplementation(async (id: string) => cards.get(id));
  intercepted.expireSession.mockImplementation(async (id: string) => {
    const session = cards.get(id);
    if (!session || session.status !== "open") throw new Error("Test session cannot expire");
    session.status = "expired";
    return session;
  });
});
const syntheticPhoneToken = randomBytes(32).toString("base64url");
const errors: string[] = [];
beforeAll(async () => {
  vi.stubEnv("SPONSOR_TOKEN_SECRET", "isolated-synthetic-qa-sponsor-signing-value");
  vi.stubEnv("ADMIN_TOKEN_SECRET", "isolated-synthetic-qa-admin-signing-value");
  vi.stubEnv("SWP_ADMIN_PASSWORD", "isolated-qa-password");
  vi.stubEnv("ADMIN_PASSWORD", "isolated-qa-password");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
  vi.stubEnv("NODE_ENV", "test");
  const kit = createRequire(new URL("../../../../lib/db/package.json", import.meta.url))(
    "drizzle-kit/api",
  );
  const { Pool } = createRequire(new URL("../../../../lib/db/package.json", import.meta.url))("pg");
  const local = {
    host: "127.0.0.1",
    port: 54549,
    user: "qa_runner",
    max: 8,
    connectionTimeoutMillis: 4000,
  };
  const database = "registration_qa_" + randomUUID().replaceAll("-", "");
  const bootstrap = new Pool({ ...local, database: "postgres" });
  try {
    const { rows } = await bootstrap.query(
      "select current_user as usr,inet_server_addr()::text as addr,inet_server_port() as port",
    );
    expect(rows[0]).toEqual({ usr: "qa_runner", addr: "127.0.0.1/32", port: 54549 });
    await bootstrap.query("CREATE DATABASE " + database);
  } finally {
    await bootstrap.end();
  }
  pool = new Pool({ ...local, database });
  pg = { exec: (sql) => pool.query(sql) };
  db = drizzle(pool, { schema });
  const ddl = await kit.generateMigration(
    kit.generateDrizzleJson({}),
    kit.generateDrizzleJson(schema),
  );
  for (const statement of ddl) await pg.exec(statement);
  setSponsorObjectStorageForTests(storage);
  await db.insert(schema.passConfigTable).values([
    { passType: "single", currentPrice: "189", originalPrice: "429" },
    { passType: "business", currentPrice: "399", originalPrice: "999" },
  ]);
  await db.insert(schema.discountTiersTable).values([
    { passType: "single", minQuantity: 3, discountPercent: "15" },
    { passType: "single", minQuantity: 5, discountPercent: "20" },
  ]);
  const app = express();
  app.use("/api/stripe/webhook", express.raw({ type: "application/json" }));
  app.use(express.json());
  app.use(
    "/api",
    bookings,
    attendees,
    stripe,
    sponsorRoutes,
    adminSponsorRoutes,
    scannerRoutes,
    pricingRoutes,
    tiers,
    promos,
    heard,
  );
  app.get("/api/event-settings/public", (_req, res) =>
    res.json({ invoiceHelpContent: "Test invoice support" }),
  );
  if (process.env.QA_EDGE_BROWSER === "1" || process.env.QA_EDGE_SCANNER === "1") {
    const dir = fileURLToPath(new URL("../../../checkout/dist/public/", import.meta.url));
    if (process.env.QA_EDGE_SCANNER === "1")
      app.get("/__qa-scanner-start", (_req, res) =>
        res.redirect("/sponsor/scanner#activate=" + syntheticPhoneToken),
      );
    app.use(express.static(dir));
    app.get(/^(?!\/api\/).*$/, (_req, res) => res.sendFile("index.html", { root: dir }));
  }
  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      errors.push(err.message);
      res.status(500).json({ error: err.message });
    },
  );
  server = createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(
      process.env.QA_EDGE_SCANNER === "1" ? 4256 : process.env.QA_EDGE_BROWSER === "1" ? 4255 : 0,
      "127.0.0.1",
      resolve,
    ),
  );
  const addr = server.address();
  if (!addr || typeof addr === "string") throw Error("isolated port unavailable");
  origin = "http://127.0.0.1:" + addr.port + "/api";
  let cardNo = 0,
    invNo = 0;
  intercepted.createSession.mockImplementation(
    async (
      params: {
        metadata: Record<string, string>;
        line_items: { price_data: { unit_amount: number } }[];
      },
      options: { idempotencyKey: string },
    ) => {
      const prior = cardKeys.get(options.idempotencyKey);
      if (prior) return cards.get(prior);
      const id = "cs_qa_" + ++cardNo;
      const session = {
        id,
        url: "https://example.invalid/" + id,
        metadata: params.metadata,
        mode: "payment",
        status: "open",
        currency: "gbp",
        payment_status: "unpaid",
        amount_total: params.line_items.reduce((n, item) => n + item.price_data.unit_amount, 0),
      };
      cardKeys.set(options.idempotencyKey, id);
      cards.set(id, session);
      return session;
    },
  );
  intercepted.invoice.mockImplementation(async () => ({ id: "in_qa_" + ++invNo }));
  intercepted.sendInvoice.mockImplementation(async (id: string) => ({
    id,
    invoice_pdf: null,
    hosted_invoice_url: null,
  }));
}, 60_000);
afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool?.end();
  setSponsorObjectStorageForTests();
  vi.unstubAllEnvs();
});
async function http(
  path: string,
  method = "GET",
  data?: unknown,
  hdrs: Record<string, string> = {},
) {
  return testFetch(origin + path, {
    method,
    headers: { "content-type": "application/json", ...hdrs },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}
const person = {
  firstName: "QA",
  lastName: "Example",
  jobTitle: "Analyst",
  company: "QA Synthetic",
  workEmail: "test@example.invalid",
};
async function makeBooking(status: typeof schema.bookingsTable.$inferSelect.status = "partial") {
  const [b] = await db
    .insert(schema.bookingsTable)
    .values({
      sessionToken: randomUUID(),
      managementToken: randomUUID(),
      status,
      passType: "single",
      attendeeType: "hr_professional",
      subtotalAmount: "189",
      vatAmount: "37.8",
      totalAmount: "226.8",
      quantity: 1,
      currentStep: status === "partial" ? 3 : 5,
    })
    .returning();
  const [a] = await db
    .insert(schema.attendeesTable)
    .values({
      ...person,
      isLead: true,
      seatIndex: 0,
      bookingId: b.id,
      workEmail: b.id + "@example.invalid",
    })
    .returning();
  return { b, a, owner: { "x-booking-session": b.sessionToken } };
}
async function readBooking(id: number) {
  return (await db.select().from(schema.bookingsTable).where(eq(schema.bookingsTable.id, id)))[0];
}
function newCard(id: number) {
  return {
    bookingId: id,
    successUrl: "https://example.invalid/done",
    cancelUrl: "https://example.invalid/back",
  };
}
async function sponsor(staffAllocation = 1) {
  const company = "QA" + randomUUID().replaceAll("-", "").slice(0, 8);
  const [s] = await db
    .insert(schema.sponsorsTable)
    .values({
      company,
      packageLabel: "Test",
      status: "confirmed",
      vipAllocation: 1,
      staffAllocation,
      vipCodeDraft: company + "VIP",
      publicCodeDraft: company,
    })
    .returning();
  const token = issueSponsorAccessToken(s.id, 1);
  const access = await http("/sponsor/access/" + token, "POST", {});
  expect(access.status).toBe(204);
  const bits = access.headers.getSetCookie().map((v) => v.split(";")[0]);
  const csrf = bits.find((v) => v.startsWith("swp_sponsor_csrf="))!.split("=")[1];
  return { s, token, headers: { cookie: bits.join("; "), "x-sponsor-csrf": csrf } };
}
const admin = () => ({ "x-admin-token": issueAdminToken("isolated-qa-password").token });
function observed(label: string, value: unknown) {
  console.log("OBSERVED", label, JSON.stringify(value));
}
it("control: fresh start, repeat save and wrong-owner protection", async () => {
  const sessionToken = randomUUID(),
    started = { sessionToken, attendeeType: "hr_professional", ...person };
  const first = await http("/bookings/start", "POST", started);
  expect(first.status).toBe(201);
  const one = await first.json<CreatedBooking>();
  expect(one.attendees).toHaveLength(1);
  const retry = await http("/bookings/start", "POST", started);
  expect(retry.status).toBe(200);
  expect((await retry.json<CreatedBooking>()).id).toBe(one.id);
  expect((await http("/bookings/" + one.id)).status).toBe(403);
  expect(
    (await http("/bookings/" + one.id, "PATCH", { quantity: 2 }, { "x-booking-session": "wrong" }))
      .status,
  ).toBe(403);
  expect(
    (
      await http("/stripe/create-checkout-session", "POST", newCard(one.id), {
        "x-booking-session": "wrong",
      })
    ).status,
  ).toBe(403);
});
it.each(["paid", "invoiced", "cancelled", "refunded", "transferred"] as const)(
  "a repeated creation request must not rewrite a %s booking",
  async (status) => {
    const { b } = await makeBooking(status);
    const response = await http("/bookings", "POST", {
      sessionToken: b.sessionToken,
      passType: "business",
      attendeeType: "consultant_vendor",
      quantity: 2,
    });
    const stored = await readBooking(b.id);
    observed("repeat creation " + status, [
      response.status,
      stored.status,
      stored.quantity,
      stored.totalAmount,
    ]);
    expect([stored.quantity, stored.totalAmount]).toEqual([1, "226.80"]);
  },
);
it("an old start-form submission must not replace a paid lead or price", async () => {
  const { b, a } = await makeBooking("paid");
  const res = await http("/bookings/start", "POST", {
    ...person,
    firstName: "Replayed",
    sessionToken: b.sessionToken,
    passType: "business",
    attendeeType: "consultant_vendor",
    quantity: 2,
  });
  const stored = await readBooking(b.id),
    [attendee] = await db
      .select()
      .from(schema.attendeesTable)
      .where(eq(schema.attendeesTable.id, a.id));
  observed("paid identity replay", [
    res.status,
    stored.quantity,
    stored.totalAmount,
    attendee.firstName,
  ]);
  expect([stored.totalAmount, attendee.firstName]).toEqual(["226.80", "QA"]);
});
it("a one-pass paid booking must not create a second attendee with the checkout token", async () => {
  const { b, owner } = await makeBooking("paid");
  const res = await http(
    "/bookings/" + b.id + "/attendees",
    "POST",
    { ...person, workEmail: "extra@example.invalid", seatIndex: 1 },
    owner,
  );
  const rows = await db
    .select()
    .from(schema.attendeesTable)
    .where(eq(schema.attendeesTable.bookingId, b.id));
  observed("extra attendee", [res.status, b.quantity, rows.length]);
  expect(rows).toHaveLength(1);
});
it("the management edit lock must also cover the checkout credential returned by the management link", async () => {
  const { b, a } = await makeBooking("paid");
  await db.insert(schema.eventSettingsTable).values({ attendeeChangesLocked: true });
  try {
    const read = await http("/bookings/by-management-token/" + b.managementToken);
    const data = await read.json<ManagementView>();
    expect(data.changesLocked).toBe(true);
    const managed = await http("/attendees/" + a.id + "/managed", "PATCH", {
      managementToken: b.managementToken,
      firstName: "Blocked",
    });
    const alternate = await http(
      "/bookings/" + b.id + "/attendees/" + a.id,
      "PATCH",
      { firstName: "Changed" },
      { "x-booking-session": data.sessionToken ?? "" },
    );
    const [stored] = await db
      .select()
      .from(schema.attendeesTable)
      .where(eq(schema.attendeesTable.id, a.id));
    observed("registration lock", [
      read.status,
      Boolean(data.sessionToken),
      managed.status,
      alternate.status,
      stored.firstName,
    ]);
    expect(data.sessionToken).toBeUndefined();
    expect(managed.status).toBe(423);
    expect(stored.firstName).toBe("QA");
  } finally {
    await pg.exec("DELETE FROM event_settings");
  }
});
it.each(["paid", "invoiced", "cancelled", "refunded"] as const)(
  "card creation must not reopen a %s booking",
  async (status) => {
    const { b, owner } = await makeBooking(status);
    const count = intercepted.createSession.mock.calls.length;
    const res = await http("/stripe/create-checkout-session", "POST", newCard(b.id), owner);
    const stored = await readBooking(b.id);
    observed("card reopen " + status, [
      res.status,
      stored.status,
      intercepted.createSession.mock.calls.length - count,
    ]);
    expect([stored.status, intercepted.createSession.mock.calls.length - count]).toEqual([
      status,
      0,
    ]);
  },
);
it("a multi-tab card retry must leave at most one payable session or honour the first successful payment", async () => {
  const { b, owner } = await makeBooking();
  const first = await (
    await http("/stripe/create-checkout-session", "POST", newCard(b.id), owner)
  ).json<CardSession>();
  const second = await (
    await http("/stripe/create-checkout-session", "POST", newCard(b.id), owner)
  ).json<CardSession>();
  expect(second.sessionId).toBe(first.sessionId);
  intercepted.getSession.mockResolvedValue({
    id: first.sessionId,
    metadata: { registrationApp: "swp-2027", bookingId: String(b.id) },
    amount_total: 22680,
    currency: "gbp",
    mode: "payment",
    payment_status: "paid",
    payment_intent: "pi_fixture",
  });
  const confirm = await http(
    "/stripe/confirm-card-payment",
    "POST",
    { bookingId: b.id, sessionId: first.sessionId },
    owner,
  );
  observed("two card tabs", [
    first.sessionId,
    second.sessionId,
    confirm.status,
    (await readBooking(b.id)).status,
  ]);
  expect(
    first.sessionId === second.sessionId ||
      ((await readBooking(b.id)).status === "paid" && confirm.ok),
  ).toBe(true);
});
it.each([
  ["wrong amount", 1, "gbp"],
  ["wrong currency", 22680, "usd"],
])("browser return must enforce the webhook's %s check", async (_, amount, currency) => {
  const { b, owner } = await makeBooking("pending_payment");
  const sessionId = "cs_fixture_" + b.id;
  await db
    .update(schema.bookingsTable)
    .set({ stripeSessionId: sessionId })
    .where(eq(schema.bookingsTable.id, b.id));
  const stripeSession = {
    id: sessionId,
    metadata: { bookingId: String(b.id), registrationApp: "swp-2027" },
    amount_total: amount,
    currency,
    mode: "payment",
    payment_status: "paid",
    payment_intent: "pi_fixture",
  };
  intercepted.getSession.mockResolvedValue(stripeSession);
  const webhook = await http("/stripe/webhook", "POST", {
    type: "checkout.session.completed",
    data: { object: stripeSession },
  });
  const afterWebhook = await readBooking(b.id);
  const ret = await http(
    "/stripe/confirm-card-payment",
    "POST",
    { bookingId: b.id, sessionId },
    owner,
  );
  const end = await readBooking(b.id);
  observed("card " + _, [webhook.status, afterWebhook.status, ret.status, end.status]);
  expect(afterWebhook.status).toBe("pending_payment");
  expect(end.status).toBe("pending_payment");
});
it("control: correct card webhook, duplicate delivery and browser return settle once", async () => {
  const { b, owner } = await makeBooking("pending_payment"),
    sessionId = "cs_fixture_" + b.id;
  await db
    .update(schema.bookingsTable)
    .set({ stripeSessionId: sessionId })
    .where(eq(schema.bookingsTable.id, b.id));
  const session = {
    id: sessionId,
    metadata: { bookingId: String(b.id), registrationApp: "swp-2027" },
    amount_total: 22680,
    currency: "gbp",
    mode: "payment",
    payment_status: "paid",
    payment_intent: "pi_fixture_" + b.id,
  };
  intercepted.getSession.mockResolvedValue(session);
  for (let i = 0; i < 2; i++)
    expect(
      (
        await http("/stripe/webhook", "POST", {
          type: "checkout.session.completed",
          data: { object: session },
        })
      ).status,
    ).toBe(200);
  const before = await readBooking(b.id);
  expect(
    (await http("/stripe/confirm-card-payment", "POST", { bookingId: b.id, sessionId }, owner))
      .status,
  ).toBe(200);
  const after = await readBooking(b.id);
  expect(after.status).toBe("paid");
  expect(after.paidAt).toEqual(before.paidAt);
});
it("overlapping invoice requests must issue only one invoice", async () => {
  const { b, owner } = await makeBooking(),
    count = intercepted.sendInvoice.mock.calls.length;
  let entered!: () => void, resume!: () => void;
  const reached = new Promise<void>((r) => (entered = r)),
    pause = new Promise<void>((r) => (resume = r));
  intercepted.invoice.mockImplementationOnce(async () => {
    entered();
    await pause;
    return { id: "in_first_fixture" };
  });
  const first = http("/stripe/create-invoice", "POST", { bookingId: b.id }, owner);
  await reached;
  const second = await http("/stripe/create-invoice", "POST", { bookingId: b.id }, owner);
  resume();
  const one = await first,
    actual = await readBooking(b.id);
  observed("overlapping invoices", [
    one.status,
    second.status,
    intercepted.sendInvoice.mock.calls.length - count,
    actual.stripeInvoiceId,
  ]);
  expect(intercepted.sendInvoice.mock.calls.length - count).toBe(1);
}, 15000);
it("control: ordinary invoice retry returns the already-issued invoice", async () => {
  const { b, owner } = await makeBooking(),
    count = intercepted.sendInvoice.mock.calls.length;
  const first = await http("/stripe/create-invoice", "POST", { bookingId: b.id }, owner);
  const again = await http("/stripe/create-invoice", "POST", { bookingId: b.id }, owner);
  const [one, two] = await Promise.all([first.json<InvoiceView>(), again.json<InvoiceView>()]);
  observed("serial invoice retry", [first.status, again.status, one.invoiceId, two.invoiceId]);
  expect(first.status).toBe(200);
  expect(two.invoiceId).toBe(one.invoiceId);
  expect(intercepted.sendInvoice.mock.calls.length - count).toBe(1);
});

it("control: multi-slot confirmation, collision rollback, separate preview and public price", async () => {
  const input = {
    company: "QA Orbit",
    packageLabel: "Example",
    vipAllocation: 2,
    vipMaxPerBooking: 1,
    staffAllocation: 2,
    contacts: [
      { role: "primary" as const, firstName: "QA", lastName: "One", email: "qa@example.invalid" },
    ],
    sessions: [
      { type: "quickfire" as const, entitlementLabel: "Morning Quickfire" },
      { type: "keynote" as const, entitlementLabel: "Keynote" },
    ],
  };
  const draft = await createSponsorDraft(input);
  expect(draft.codes).toHaveLength(0);
  const confirmed = await confirmSponsor(draft.id);
  expect(confirmed.codes).toHaveLength(2);
  expect(confirmed.sessions).toHaveLength(2);
  expect(
    (await db.select().from(schema.sponsorsTable).where(eq(schema.sponsorsTable.id, draft.id)))[0]
      .welcomeEmailSentAt,
  ).toBeNull();
  const duplicate = await createSponsorDraft({
    ...input,
    company: "QA Orbit Duplicate",
    vipCode: "QAORBITVIP",
  });
  await expect(confirmSponsor(duplicate.id)).rejects.toThrow();
  expect(
    (
      await db.select().from(schema.sponsorsTable).where(eq(schema.sponsorsTable.id, duplicate.id))
    )[0].status,
  ).toBe("draft");
  const { calculatePricing } = await import("../lib/pricing");
  const publicQuote = await calculatePricing("single", 5, "QAORBIT");
  expect([publicQuote.subtotalAfterDiscounts, publicQuote.vatAmount]).toEqual([604.8, 120.96]);
  await expect(calculatePricing("business", 1, "QAORBITVIP")).rejects.toThrow();
  await expect(calculatePricing("single", 2, "QAORBITVIP")).rejects.toThrow();
});
it("control: sponsor session cookie, anti-forgery checks, old link and session revocation", async () => {
  const sp = await sponsor();
  expect((await http("/sponsor/workspace", "GET", undefined, sp.headers)).status).toBe(200);
  expect((await http("/sponsor/staff", "POST", person, { cookie: sp.headers.cookie })).status).toBe(
    403,
  );
  expect((await http("/sponsor/access/not-a-link", "POST", {})).status).toBe(401);
  await db
    .update(schema.sponsorsTable)
    .set({ portalAccessVersion: 2 })
    .where(eq(schema.sponsorsTable.id, sp.s.id));
  expect((await http("/sponsor/workspace", "GET", undefined, sp.headers)).status).toBe(401);
  expect((await http("/sponsor/access/" + sp.token, "POST", {})).status).toBe(401);
  expect(
    (await http("/sponsor/access/" + issueSponsorAccessToken(sp.s.id, 2), "POST", {})).status,
  ).toBe(204);
});
it("control: two concurrent staff claims for one place, replacement, cancellation and reuse", async () => {
  const sp = await sponsor(),
    alt = await sponsor(),
    initial = intercepted.welcome.mock.calls.length;
  const body = (email: string) => ({ ...person, workEmail: email });
  const both = await Promise.all(
    ["staff1@example.invalid", "staff2@example.invalid"].map((email) =>
      http("/sponsor/staff", "POST", body(email), sp.headers),
    ),
  );
  expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
  const active = await both.find((r) => r.status === 201)!.json<StaffView>();
  const b = await readBooking(active.bookingId);
  expect([b.totalAmount, b.registrationSource, b.passType, active.marketingConsent]).toEqual([
    "0.00",
    "sponsor_staff",
    "business",
    false,
  ]);
  expect(
    (
      await http(
        "/sponsor/staff",
        "POST",
        body(" " + active.workEmail.toUpperCase() + " "),
        alt.headers,
      )
    ).status,
  ).toBe(409);
  expect((await http("/sponsor/staff/" + b.id, "DELETE", undefined, alt.headers)).status).toBe(404);
  expect(
    (await http("/sponsor/staff/" + b.id, "PATCH", body("replace@example.invalid"), sp.headers))
      .status,
  ).toBe(200);
  expect(intercepted.welcome.mock.calls.length - initial).toBe(2);
  expect((await http("/sponsor/staff/" + b.id, "DELETE", undefined, sp.headers)).status).toBe(204);
  expect(
    (await http("/sponsor/staff", "POST", body("new@example.invalid"), sp.headers)).status,
  ).toBe(201);
});
async function untilBlocked(fragment: string) {
  for (let step = 0; step < 150; step++) {
    const hit = await pool.query(
      "select 1 from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock' and query ilike $1",
      [fragment],
    );
    if (hit.rowCount) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("Concurrency test setup did not reach database barrier: " + fragment);
}
it("a simultaneous admin reduction must not leave more registered staff than allocated places", async () => {
  const sp = await sponsor();
  const gate = await pool.connect();
  const hold = 745012;
  await pg.exec(
    "CREATE FUNCTION qa_staff_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(" +
      hold +
      "); RETURN NEW; END; $$; CREATE TRIGGER qa_staff_barrier BEFORE INSERT ON bookings FOR EACH ROW WHEN (NEW.registration_source='sponsor_staff') EXECUTE FUNCTION qa_staff_barrier();",
  );
  let registering: Promise<Response> | undefined, reducing: Promise<Response> | undefined;
  try {
    await gate.query("select pg_advisory_lock($1)", [hold]);
    registering = http(
      "/sponsor/staff",
      "POST",
      { ...person, workEmail: "laststaff@example.invalid" },
      sp.headers,
    );
    await untilBlocked('insert into "bookings"%');
    reducing = http(
      "/admin/sponsors/" + sp.s.id,
      "PATCH",
      {
        company: sp.s.company,
        packageLabel: "Test",
        vipAllocation: 1,
        vipMaxPerBooking: 1,
        staffAllocation: 0,
      },
      admin(),
    );
    await untilBlocked('%from "sponsors"%for update%');
  } finally {
    await gate.query("select pg_advisory_unlock($1)", [hold]);
    gate.release();
  }
  try {
    const [created, reduced] = await Promise.all([registering!, reducing!]);
    const counts = await pool.query(
      "select s.staff_allocation,(select count(*)::int from bookings b where b.sponsor_id=s.id and b.registration_source='sponsor_staff' and b.status='paid') as used from sponsors s where s.id=$1",
      [sp.s.id],
    );
    observed("allocation reduction", [created.status, reduced.status, counts.rows[0]]);
    expect(counts.rows[0].used).toBeLessThanOrEqual(counts.rows[0].staff_allocation);
  } finally {
    await pg.exec("DROP TRIGGER qa_staff_barrier ON bookings; DROP FUNCTION qa_staff_barrier()");
  }
});
it("control: simultaneous VIP claims, exact-once release, capacity-checked restore and redacted guest details", async () => {
  const { s, headers } = await sponsor();
  const [promo] = await db
    .insert(schema.promoCodesTable)
    .values({
      code: s.vipCodeDraft.toUpperCase(),
      discountType: "complimentary",
      discountValue: "100",
      applicablePassTypes: ["single"],
      maxUses: 1,
      maxQuantityPerBooking: 1,
    })
    .returning();
  await db
    .insert(schema.sponsorPromoCodesTable)
    .values({ sponsorId: s.id, promoCodeId: promo.id, kind: "vip" });
  const [one, two] = await Promise.all([makeBooking(), makeBooking()]);
  for (const x of [one, two])
    await db
      .update(schema.bookingsTable)
      .set({ promoCode: promo.code, totalAmount: "0", subtotalAmount: "0", vatAmount: "0" })
      .where(eq(schema.bookingsTable.id, x.b.id));
  const results = await Promise.all(
    [one, two].map((x) => http("/bookings/" + x.b.id + "/confirm-free", "POST", {}, x.owner)),
  );
  const persisted = await Promise.all([one, two].map((x) => readBooking(x.b.id)));
  const winners = persisted.filter((b) => b.status === "paid");
  observed("last VIP", [results.map((r) => r.status), winners.length]);
  expect(winners).toHaveLength(1);
  const win = winners[0],
    loser = one.b.id === win.id ? two : one;
  expect(
    (
      await http(
        "/bookings/" + win.id + "/confirm-free",
        "POST",
        {},
        { "x-booking-session": win.sessionToken },
      )
    ).status,
  ).toBe(200);
  const portal = await (
    await http("/sponsor/workspace", "GET", undefined, headers)
  ).json<PortalView>();
  const guest = portal.codes[0].redemptions[0];
  expect(guest).toMatchObject({ firstName: "QA", jobTitle: "Analyst" });
  expect(Object.keys(guest).sort()).toEqual(
    ["bookingId", "company", "firstName", "jobTitle", "lastName", "registeredAt"].sort(),
  );
  await Promise.all([
    releaseSponsorRedemption(win.id, "qa_cancel"),
    releaseSponsorRedemption(win.id, "qa_repeat"),
  ]);
  const count = async () =>
    (
      await db.select().from(schema.promoCodesTable).where(eq(schema.promoCodesTable.id, promo.id))
    )[0].usedCount;
  expect(await count()).toBe(0);
  expect(
    (await http("/bookings/" + loser.b.id + "/confirm-free", "POST", {}, loser.owner)).status,
  ).toBe(200);
  expect(await restoreSponsorRedemption(win.id)).toBe(false);
  expect(await count()).toBe(1);
  await releaseSponsorRedemption(loser.b.id, "qa_cancel");
  expect(await restoreSponsorRedemption(win.id)).toBe(true);
  expect(await count()).toBe(1);
});
function filePost(
  path: string,
  headers: Record<string, string>,
  bytes: Buffer,
  name: string,
  mime: string,
  fields: Record<string, string> = { category: "other" },
) {
  const form = new FormData();
  for (const [key, val] of Object.entries(fields)) form.set(key, val);
  form.set("file", new Blob([new Uint8Array(bytes)], { type: mime }), name);
  return testFetch(origin + path, { method: "POST", headers, body: form });
}
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/V1sAAAAASUVORK5CYII=",
  "base64",
);
async function addFile(headers: Record<string, string>, name = "logo.png") {
  const res = await filePost("/sponsor/assets", headers, png, name, "image/png", {
    category: "logo",
  });
  expect(res.status).toBe(201);
  return res.json<FileView>();
}
it("control: signed asset upload, type checks, private download, replacement and ZIP manifest", async () => {
  const sp = await sponsor(),
    other = await sponsor(),
    asset = await addFile(sp.headers);
  expect(
    (
      await filePost(
        "/sponsor/assets",
        sp.headers,
        Buffer.from("MZfixture"),
        "bad.png",
        "image/png",
      )
    ).status,
  ).toBe(400);
  expect(
    (await http("/sponsor/assets/" + asset.id + "/download", "GET", undefined, other.headers))
      .status,
  ).toBe(404);
  const file = await http(
    "/sponsor/assets/" + asset.id + "/download",
    "GET",
    undefined,
    sp.headers,
  );
  expect(file.headers.get("content-disposition")).toContain("attachment");
  expect(file.headers.get("x-content-type-options")).toBe("nosniff");
  expect(Buffer.from(await file.arrayBuffer())).toEqual(png);
  const replacement = await filePost(
    "/sponsor/assets/" + asset.id + "/replace",
    sp.headers,
    png,
    "replacement.png",
    "image/png",
  );
  expect(replacement.status).toBe(201);
  expect((await replacement.json<FileView>()).version).toBe(2);
  const old = (
    await db
      .select()
      .from(schema.sponsorAssetsTable)
      .where(eq(schema.sponsorAssetsTable.id, asset.id))
  )[0];
  expect(old.status).toBe("archived");
  expect(await storage.exists(old.storageKey)).toBe(true);
  const zip = await http(
    "/admin/sponsors/" + sp.s.id + "/assets/complete.zip",
    "GET",
    undefined,
    admin(),
  );
  expect(zip.headers.get("content-type")).toContain("application/zip");
  const bytes = Buffer.from(await zip.arrayBuffer());
  expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
  expect(bytes.includes(Buffer.from("manifest.csv"))).toBe(true);
  expect(bytes.includes(Buffer.from("replacement.png"))).toBe(true);
  expect(bytes.readUInt32LE(bytes.length - 22)).toBe(0x06054b50);
});
it("a complete folder must keep reporting missing objects on repeated download attempts", async () => {
  const sp = await sponsor(),
    good = await addFile(sp.headers, "retained.png"),
    gone = await addFile(sp.headers, "missing.png");
  const row = (
    await db
      .select()
      .from(schema.sponsorAssetsTable)
      .where(eq(schema.sponsorAssetsTable.id, gone.id))
  )[0];
  await storage.delete(row.storageKey);
  const request = () =>
    http("/admin/sponsors/" + sp.s.id + "/assets/complete.zip", "GET", undefined, admin());
  const first = await request(),
    next = await request();
  const bytes = Buffer.from(await next.arrayBuffer());
  observed("missing complete ZIP", [
    first.status,
    next.status,
    bytes.includes(Buffer.from(good.originalName)),
    bytes.includes(Buffer.from(gone.originalName)),
  ]);
  expect(first.status).toBe(409);
  expect(next.status).toBe(409);
  const backup = await http("/admin/sponsor-assets/backup-plan", "POST", {}, admin());
  expect(backup.status).toBe(409);
  // Repair this test's missing object so subsequent healthy backup cases start clean.
  await storage.put(row.storageKey, png);
  expect(
    (
      await http(
        "/admin/sponsors/" + sp.s.id + "/assets/" + gone.id,
        "PATCH",
        { status: "active" },
        admin(),
      )
    ).status,
  ).toBe(200);
});
it("two replacements of one file version must not both become the current file", async () => {
  const sp = await sponsor(),
    asset = await addFile(sp.headers);
  const original = storage.put.bind(storage);
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const spy = vi.spyOn(storage, "put").mockImplementation(async (k, v) => {
    if (++arrived === 2) release();
    await gate;
    await original(k, v);
  });
  try {
    const results = await Promise.all(
      ["first.png", "second.png"].map((n) =>
        filePost("/sponsor/assets/" + asset.id + "/replace", sp.headers, png, n, "image/png"),
      ),
    );
    const versions = (
      await db
        .select()
        .from(schema.sponsorAssetsTable)
        .where(eq(schema.sponsorAssetsTable.replacesAssetId, asset.id))
    ).filter((a) => a.status === "active");
    observed("simultaneous asset replacements", [
      results.map((r) => r.status),
      versions.map((a) => a.version),
    ]);
    expect(versions).toHaveLength(1);
  } finally {
    spy.mockRestore();
  }
}, 8000);
it("control: two sessions remain separate, stale drafts conflict, incomplete submission is rejected, approval exports", async () => {
  const sp = await sponsor();
  const slots = await db
    .insert(schema.sponsorSessionsTable)
    .values(
      ["Quickfire", "Keynote"].map((label) => ({
        sponsorId: sp.s.id,
        type: "other" as const,
        entitlementLabel: label,
        headshotRequired: false,
        takeawaysRequired: false,
      })),
    )
    .returning();
  const route = "/sponsor/sessions/" + slots[0].id;
  expect((await http(route + "/submit", "POST", { expectedRevision: 0 }, sp.headers)).status).toBe(
    400,
  );
  const data = {
    expectedRevision: 0,
    title: "Synthetic session",
    description: "A short description",
    presenters: [{ name: "QA Presenter", jobTitle: "Analyst", company: "Test" }],
  };
  expect((await http(route, "PATCH", data, sp.headers)).status).toBe(200);
  expect((await http(route, "PATCH", { ...data, title: "stale" }, sp.headers)).status).toBe(409);
  expect((await http(route + "/submit", "POST", { expectedRevision: 1 }, sp.headers)).status).toBe(
    200,
  );
  const review = await http(
    "/admin/sponsors/" + sp.s.id + "/sessions/" + slots[0].id + "/review",
    "PATCH",
    { status: "approved", expectedRevision: 1 },
    admin(),
  );
  expect(review.status).toBe(200);
  const csv = await http(
    "/admin/sponsors/" + sp.s.id + "/sessions/export.csv",
    "GET",
    undefined,
    admin(),
  );
  expect(csv.status).toBe(200);
  expect(await csv.text()).toContain("Synthetic session");
  const untouched = (
    await db
      .select()
      .from(schema.sponsorSessionsTable)
      .where(eq(schema.sponsorSessionsTable.id, slots[1].id))
  )[0];
  expect(untouched.status).toBe("draft");
  expect(untouched.title).toBeNull();
});

it("a card receipt for one seat must not settle a later five-seat booking", async () => {
  const { b, owner } = await makeBooking();
  const first = await http("/stripe/create-checkout-session", "POST", newCard(b.id), owner);
  const card = await first.json<CardSession>();
  const edit = await http("/bookings/" + b.id, "PATCH", { quantity: 5 }, owner);
  const amountBefore = await readBooking(b.id);
  expect(edit.status).toBe(200);
  expect(amountBefore.totalAmount).toBe("907.20");
  const session = {
    id: card.sessionId,
    metadata: { bookingId: String(b.id), registrationApp: "swp-2027" },
    amount_total: 22680,
    currency: "gbp",
    mode: "payment",
    payment_status: "paid",
    payment_intent: "pi_one_seat",
  };
  intercepted.getSession.mockResolvedValue(session);
  await http("/stripe/webhook", "POST", {
    type: "checkout.session.completed",
    data: { object: session },
  });
  const before = await readBooking(b.id);
  const ret = await http(
    "/stripe/confirm-card-payment",
    "POST",
    { bookingId: b.id, sessionId: card.sessionId },
    owner,
  );
  const end = await readBooking(b.id);
  observed("one-seat receipt vs five-seat booking", [
    226.8,
    end.totalAmount,
    before.status,
    ret.status,
    end.status,
  ]);
  expect(end.status).toBe("pending_payment");
});
it("control: Stripe signature verification rejects tampering and accepts an authentic fixture", async () => {
  const Stripe = createRequire(new URL("../../package.json", import.meta.url))("stripe");
  const localStripe = new Stripe("sk_test_offline_fixture");
  const verifier = localStripe.webhooks;
  intercepted.signature.mockImplementation((...args) => verifier.constructEvent(...args));
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_qa_local_only");
  try {
    const body = { type: "qa.ignored", data: { object: {} } },
      txt = JSON.stringify(body),
      now = Math.floor(Date.now() / 1000);
    const hash = createHmac("sha256", "whsec_qa_local_only")
      .update(now + "." + txt)
      .digest("hex");
    expect((await http("/stripe/webhook", "POST", body)).status).toBe(400);
    expect(
      (
        await http("/stripe/webhook", "POST", body, {
          "stripe-signature": "t=" + now + ",v1=wrong",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await http("/stripe/webhook", "POST", body, {
          "stripe-signature": "t=" + now + ",v1=" + hash,
        })
      ).status,
    ).toBe(200);
  } finally {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
  }
});
it("unauthenticated clients must not receive a specific booking's quantity and discounted total", async () => {
  const { b } = await makeBooking("paid");
  const result = await http("/bookings/" + b.id + "/pricing");
  const quote = await result.json<{ passType: string; quantity: number; total: number }>();
  observed("anonymous booking quote", [result.status, quote.passType, quote.quantity, quote.total]);
  expect([401, 403]).toContain(result.status);
});
it("control: scanner activation, unknown and opted-out badges, duplicate receipt, notes, export and revoked phone", async () => {
  const sp = await sponsor(),
    other = await sponsor();
  const phone = await (
    await http("/sponsor/scanner/devices", "POST", { operatorName: "QA Operator" }, sp.headers)
  ).json<PhoneView>();
  const auth = { authorization: "Bearer " + phone.token };
  expect((await http("/admin/sponsors", "GET", undefined, auth)).status).toBe(401);
  const { b, a } = await makeBooking("paid");
  await db
    .update(schema.attendeesTable)
    .set({ leadSharingNoticeAt: new Date() })
    .where(eq(schema.attendeesTable.id, a.id));
  await db.insert(schema.attendeeBadgesTable).values({ attendeeId: a.id, code: "AB17CF123456" });
  await db.insert(schema.eventSettingsTable).values({
    eventStartAt: new Date(Date.now() - 3600000),
    eventEndAt: new Date(Date.now() + 3600000),
  });
  try {
    const lookup = "/scanner/lookup";
    expect((await http(lookup, "POST", { code: "000000111111" }, auth)).status).toBe(404);
    expect((await http(lookup, "POST", { code: "ab17cf123456" }, auth)).status).toBe(200);
    const time = new Date().toISOString(),
      cap = { id: randomUUID(), code: "AB17CF123456", source: "camera", capturedAt: time };
    const sync = (body: unknown) => http("/scanner/sync", "POST", body, auth);
    const first = await (await sync({ scans: [cap] })).json<SyncView>();
    expect(first.scans[0].status).toBe("accepted");
    const again = await (await sync({ scans: [cap] })).json<SyncView>();
    expect(again.scans[0].status).toBe("duplicate");
    const note = {
      id: randomUUID(),
      scanId: cap.id,
      note: "Follow up next week",
      rating: 4,
      createdAt: time,
    };
    const annotated = await (await sync({ annotations: [note] })).json<SyncView>();
    expect(annotated.leads[0].notes[0].note).toBe(note.note);
    const staffExport = await http("/scanner/leads/export?format=csv", "GET", undefined, auth);
    expect(staffExport.status).toBe(403);
    const companyExport = await http(
      "/sponsor/leads/export?format=csv",
      "GET",
      undefined,
      sp.headers,
    );
    expect(companyExport.status).toBe(200);
    expect(await companyExport.text()).toContain(note.note);
    const oth = await (
      await http("/sponsor/leads", "GET", undefined, other.headers)
    ).json<SyncView>();
    expect(oth.leads).toHaveLength(0);
    await db
      .update(schema.attendeesTable)
      .set({ leadSharingExcluded: true })
      .where(eq(schema.attendeesTable.id, a.id));
    expect((await http(lookup, "POST", { code: cap.code }, auth)).status).toBe(404);
    await db
      .update(schema.sponsorScannerDevicesTable)
      .set({ revokedAt: new Date() })
      .where(eq(schema.sponsorScannerDevicesTable.id, phone.id));
    expect((await http("/scanner/leads", "GET", undefined, auth)).status).toBe(401);
    expect(
      (await http("/sponsor/scanner/devices/" + phone.id + "/restore", "POST", {}, other.headers))
        .status,
    ).toBe(404);
    const fixed = await (
      await http("/sponsor/scanner/devices/" + phone.id + "/restore", "POST", {}, sp.headers)
    ).json<PhoneView>();
    expect(fixed.id).toBe(phone.id);
    const returned = await http("/scanner/leads", "GET", undefined, {
      authorization: "Bearer " + fixed.token,
    });
    expect((await returned.json<SyncView>()).leads[0].scanCount).toBe(1);
    expect((await readBooking(b.id)).status).toBe("paid");
  } finally {
    await pg.exec("DELETE FROM event_settings");
  }
});
it("control: missing event end disables real badge capture but the readiness badge still succeeds", async () => {
  const sp = await sponsor();
  const phone = await (
    await http("/sponsor/scanner/devices", "POST", { operatorName: "QA Timing" }, sp.headers)
  ).json<PhoneView>();
  const auth = { authorization: "Bearer " + phone.token };
  const boot = await (
    await http("/scanner/bootstrap", "GET", undefined, auth)
  ).json<{ scannerWindow: { scanningOpen: boolean } }>();
  expect(boot.scannerWindow.scanningOpen).toBe(false);
  const scans = ["123456789ABC", "FFFFFFFFFFFF"].map((code) => ({
    id: randomUUID(),
    source: "camera",
    code,
    capturedAt: new Date().toISOString(),
  }));
  const result = await (await http("/scanner/sync", "POST", { scans }, auth)).json<SyncView>();
  observed("unconfigured event", [
    boot.scannerWindow.scanningOpen,
    result.scans.map((r: { status: string; reason?: string }) => [r.status, r.reason]),
  ]);
  expect(result.scans[0].reason).toBe("Event end time is not configured");
  expect(result.scans[1].status).toBe("accepted");
});
it("a broken Office file must not be accepted as submitted slides", async () => {
  const sp = await sponsor();
  const fake = Buffer.concat([
    Buffer.from([80, 75, 3, 4]),
    Buffer.from("[Content_Types].xml ppt/ deliberately not a ZIP archive"),
  ]);
  const res = await filePost(
    "/sponsor/assets",
    sp.headers,
    fake,
    "unopenable.pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    { category: "slides" },
  );
  observed("malformed slides", [fake.length, res.status]);
  expect(res.status).toBe(400);
});
it("a file above the maximum should give a clear client error", async () => {
  const sp = await sponsor();
  const res = await filePost(
    "/sponsor/assets",
    sp.headers,
    Buffer.alloc(25 * 1024 * 1024 + 1, 0x41),
    "too-large.pdf",
    "application/pdf",
  );
  observed("oversize response", [res.status]);
  expect([400, 413]).toContain(res.status);
});
function openZip(data: Buffer) {
  const end = data.lastIndexOf(Buffer.from([80, 75, 5, 6]));
  if (end < 0) throw Error("ZIP has no end of central directory");
  const files = new Map<string, Buffer>();
  let pos = data.readUInt32LE(end + 16);
  for (let i = 0; i < data.readUInt16LE(end + 10); i++) {
    if (data.readUInt32LE(pos) !== 0x02014b50) throw Error("Invalid central directory");
    const compressed = data.readUInt32LE(pos + 20),
      nameLen = data.readUInt16LE(pos + 28),
      local = data.readUInt32LE(pos + 42);
    const name = data.toString("utf8", pos + 46, pos + 46 + nameLen),
      method = data.readUInt16LE(pos + 10);
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    const bytes = data.subarray(start, start + compressed);
    files.set(name, method === 8 ? inflateRawSync(bytes) : bytes);
    pos += 46 + nameLen + data.readUInt16LE(pos + 30) + data.readUInt16LE(pos + 32);
  }
  return files;
}
it("control: selected and split sponsor backups stream intact files with matching checksums", async () => {
  const sp = await sponsor();
  const docs = await Promise.all(
    ["first.eps", "second.eps"].map(async (name) => {
      const contents = Buffer.from(
        "%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\n%" +
          randomBytes(5 * 1024 * 1024).toString("base64") +
          "\nshowpage\n%%EOF\n",
      );
      const res = await filePost(
        "/sponsor/assets",
        sp.headers,
        contents,
        name,
        "application/postscript",
        { category: "session_material" },
      );
      expect(res.status).toBe(201);
      const row = await res.json<FileView>();
      return { id: row.id, hash: row.checksumSha256, name };
    }),
  );
  const plan = await (
    await http(
      "/admin/sponsor-assets/backup-plan",
      "POST",
      { maxBytesPerZip: 10 * 1024 * 1024 },
      admin(),
    )
  ).json<BackupPlan>();
  const subset = plan.batches.filter((v: { assetIds: string[] }) =>
    docs.some((x) => v.assetIds.includes(x.id)),
  );
  expect(subset).toHaveLength(2);
  const selected = await http(
    "/admin/sponsors/" + sp.s.id + "/assets/download.zip",
    "POST",
    { assetIds: docs.map((x) => x.id) },
    admin(),
  );
  const files = openZip(Buffer.from(await selected.arrayBuffer()));
  for (const doc of docs) {
    const f = files.get("session_material/" + doc.name)!;
    expect(createHash("sha256").update(f).digest("hex")).toBe(doc.hash);
    expect(files.get("manifest.csv")?.toString()).toContain(doc.hash);
  }
  for (const batch of subset) {
    const res = await http(
      "/admin/sponsor-assets/backup.zip",
      "POST",
      { assetIds: batch.assetIds },
      admin(),
    );
    expect(res.status).toBe(200);
    expect(openZip(Buffer.from(await res.arrayBuffer())).has("manifest.csv")).toBe(true);
  }
}, 30000);
it("control: replacing a required logistics document requires a new acknowledgement", async () => {
  const sp = await sponsor(),
    up = await filePost("/sponsor/assets", sp.headers, png, "instructions.png", "image/png", {
      category: "logistics",
    });
  expect(up.status).toBe(201);
  const one = await up.json<FileView>();
  const [doc] = await db
    .insert(schema.sponsorDocumentsTable)
    .values({ sponsorId: sp.s.id, assetId: one.id, title: "Fixture logistics", required: true })
    .returning();
  const ack = "/sponsor/documents/" + doc.id + "/acknowledge";
  const response = await http(ack, "POST", { acknowledgedBy: "QA Organiser" }, sp.headers);
  expect(response.ok).toBe(true);
  expect(
    (
      await filePost(
        "/sponsor/assets/" + one.id + "/replace",
        sp.headers,
        png,
        "new.png",
        "image/png",
      )
    ).status,
  ).toBe(201);
  const portal = await (
    await http("/sponsor/workspace", "GET", undefined, sp.headers)
  ).json<PortalView>();
  expect(portal.documents[0].acknowledgementVersion).toBe(2);
  expect(portal.documents[0].acknowledgedAt ?? null).toBeNull();
  expect((await http(ack, "POST", { acknowledgedBy: "QA Organiser" }, sp.headers)).ok).toBe(true);
  expect(
    (
      await db
        .select()
        .from(schema.sponsorDocumentAcknowledgementsTable)
        .where(eq(schema.sponsorDocumentAcknowledgementsTable.documentId, doc.id))
    ).map((d) => d.version),
  ).toEqual([1, 2]);
});

it("overlapping fresh start requests should converge on one booking without showing a server error", async () => {
  const key = randomUUID(),
    body = {
      ...person,
      sessionToken: key,
      attendeeType: "hr_professional",
      passType: "single",
      gdprConsent: true,
    };
  const blocker = await pool.connect();
  await blocker.query("BEGIN");
  let a: Promise<Response> | undefined, b: Promise<Response> | undefined;
  try {
    await blocker.query("LOCK TABLE bookings IN SHARE MODE");
    a = http("/bookings/start", "POST", body);
    b = http("/bookings/start", "POST", body);
    let both = false;
    for (let n = 0; n < 150; n++) {
      const q = await pool.query(
        "select count(*)::int as waiting from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query ilike 'insert into \"bookings\"%'",
      );
      if (q.rows[0].waiting >= 2) {
        both = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(both).toBe(true);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
  const results = await Promise.all([a!, b!]);
  const rows = await db
    .select()
    .from(schema.bookingsTable)
    .where(eq(schema.bookingsTable.sessionToken, key));
  observed("two fresh start requests", [results.map((r) => r.status), rows.length]);
  expect(rows).toHaveLength(1);
  expect(results.every((r) => r.ok)).toBe(true);
});
it("a cancelled booking must not issue a fresh invoice from an old checkout", async () => {
  const { b, owner } = await makeBooking("cancelled");
  const before = intercepted.sendInvoice.mock.calls.length;
  const result = await http("/stripe/create-invoice", "POST", { bookingId: b.id }, owner);
  const stored = await readBooking(b.id);
  observed("cancelled invoice restart", [
    result.status,
    stored.status,
    intercepted.sendInvoice.mock.calls.length - before,
  ]);
  expect([stored.status, intercepted.sendInvoice.mock.calls.length - before]).toEqual([
    "cancelled",
    0,
  ]);
});
it("uses the same provider key after an interrupted invoice send", async () => {
  const { b, owner } = await makeBooking();
  const base = intercepted.invoice.mock.calls.length;
  intercepted.sendInvoice.mockRejectedValueOnce(new Error("Synthetic lost response"));
  expect((await http("/stripe/create-invoice", "POST", { bookingId: b.id }, owner)).status).toBe(
    502,
  );
  expect((await readBooking(b.id)).status).toBe("partial");
  const again = await http("/stripe/create-invoice", "POST", { bookingId: b.id }, owner);
  expect(again.status).toBe(200);
  const attempts = intercepted.invoice.mock.calls
    .slice(base)
    .map((call) => call[1]?.idempotencyKey);
  expect(attempts).toHaveLength(2);
  expect(typeof attempts[0]).toBe("string");
  expect(attempts[1]).toBe(attempts[0]);
  expect((await readBooking(b.id)).status).toBe("invoiced");
});

it("retires a superseded card before issuing an invoice", async () => {
  const { b, owner } = await makeBooking();
  const card = await (
    await http("/stripe/create-checkout-session", "POST", newCard(b.id), owner)
  ).json<CardSession>();
  expect(cards.get(card.sessionId)?.status).toBe("open");
  expect((await http("/stripe/create-invoice", "POST", { bookingId: b.id }, owner)).status).toBe(
    200,
  );
  expect(cards.get(card.sessionId)?.status).toBe("expired");
  expect((await readBooking(b.id)).stripeSessionId).toBeNull();
});

it("rejects a changed order even when the amount remains equal", async () => {
  const { b, owner } = await makeBooking();
  const card = await (
    await http("/stripe/create-checkout-session", "POST", newCard(b.id), owner)
  ).json<CardSession>();
  await db
    .update(schema.bookingsTable)
    .set({ passType: "business" })
    .where(eq(schema.bookingsTable.id, b.id));
  intercepted.getSession.mockResolvedValue({
    ...cards.get(card.sessionId),
    payment_status: "paid",
    payment_intent: "pi_qa_same_amount",
  });
  const ret = await http(
    "/stripe/confirm-card-payment",
    "POST",
    { bookingId: b.id, sessionId: card.sessionId },
    owner,
  );
  expect(ret.status).toBe(409);
  expect((await readBooking(b.id)).status).toBe("pending_payment");
});

it("does not replay an uncertain operation after the provider key window", async () => {
  const { b, owner } = await makeBooking();
  intercepted.invoice.mockRejectedValueOnce(new Error("Test connection interrupted"));
  expect((await http("/stripe/create-invoice", "POST", { bookingId: b.id }, owner)).status).toBe(
    502,
  );
  await pool.query(
    "update activity_log set created_at=now()-interval '25 hours' where booking_id=$1 and type='checkout_payment_attempt'",
    [b.id],
  );
  const calls = intercepted.invoice.mock.calls.length;
  expect((await http("/stripe/create-invoice", "POST", { bookingId: b.id }, owner)).status).toBe(
    409,
  );
  expect(intercepted.invoice.mock.calls).toHaveLength(calls);
});

it("keeps credentials out of new request URLs and accepts the original links", async () => {
  const { b } = await makeBooking("paid");
  const read = await http("/bookings/current", "GET", undefined, {
    "x-booking-session": b.sessionToken,
  });
  expect(read.status).toBe(200);
  expect((await read.json<CreatedBooking>()).id).toBe(b.id);
  expect((await http("/bookings/current")).status).toBe(403);
  expect(
    (
      await http("/bookings/manage", "GET", undefined, {
        authorization: "Bearer " + b.managementToken,
      })
    ).status,
  ).toBe(200);
  expect((await http("/bookings/manage")).status).toBe(403);
  const sp = await sponsor();
  expect((await http("/sponsor/access", "POST", { token: sp.token })).status).toBe(204);
});

it("never reopens a refunded invoice through a receipt refresh or a late void webhook", async () => {
  const { b, owner } = await makeBooking("refunded");
  await db
    .update(schema.bookingsTable)
    .set({ stripeInvoiceId: "in_refunded_fixture", paymentMethod: "invoice" })
    .where(eq(schema.bookingsTable.id, b.id));
  expect((await http("/bookings/" + b.id, "GET", undefined, owner)).status).toBe(200);
  await http("/stripe/webhook", "POST", {
    type: "invoice.voided",
    data: { object: { id: "in_refunded_fixture", status: "void" } },
  });
  expect((await readBooking(b.id)).status).toBe("refunded");
});

it("settles only an invoice whose amount and currency match the locked booking", async () => {
  const { b } = await makeBooking("invoiced"),
    invoiceId = "in_settle_fixture";
  await db
    .update(schema.bookingsTable)
    .set({ stripeInvoiceId: invoiceId, paymentMethod: "invoice" })
    .where(eq(schema.bookingsTable.id, b.id));
  const paid = (total: number, currency: string) =>
    http("/stripe/webhook", "POST", {
      type: "invoice.paid",
      data: { object: { id: invoiceId, status: "paid", currency, total } },
    });
  expect((await paid(1, "gbp")).status).toBe(200);
  expect((await readBooking(b.id)).status).toBe("invoiced");
  expect((await paid(22680, "usd")).status).toBe(200);
  expect((await readBooking(b.id)).status).toBe("invoiced");
  expect((await paid(22680, "gbp")).status).toBe(200);
  expect((await readBooking(b.id)).status).toBe("paid");
});

it("restoring an earlier file and replacing it keeps one current version and a monotonic history", async () => {
  const sp = await sponsor(),
    initial = await addFile(sp.headers, "one.png");
  const v2 = await (
    await filePost(
      "/sponsor/assets/" + initial.id + "/replace",
      sp.headers,
      png,
      "two.png",
      "image/png",
    )
  ).json<FileView>();
  const restore = await http(
    "/admin/sponsors/" + sp.s.id + "/assets/" + initial.id,
    "PATCH",
    { status: "active" },
    admin(),
  );
  expect(restore.status).toBe(200);
  const next = await filePost(
    "/sponsor/assets/" + initial.id + "/replace",
    sp.headers,
    png,
    "three.png",
    "image/png",
  );
  expect(next.status).toBe(201);
  const v3 = await next.json<FileView>();
  expect(v3.version).toBe(3);
  const rows = await db
    .select()
    .from(schema.sponsorAssetsTable)
    .where(eq(schema.sponsorAssetsTable.sponsorId, sp.s.id));
  expect(rows.filter((x) => x.status === "active").map((x) => x.id)).toEqual([v3.id]);
  expect(rows.find((x) => x.id === v2.id)?.status).toBe("archived");
});

it("cannot display confirmation on an open booking by advancing its step directly", async () => {
  const { b, owner } = await makeBooking();
  expect((await http("/bookings/" + b.id, "PATCH", { currentStep: 5 }, owner)).status).toBe(400);
  expect((await readBooking(b.id)).currentStep).toBe(3);
});

it("repairs a missing current asset by uploading a replacement", async () => {
  const sp = await sponsor(),
    file = await addFile(sp.headers);
  const [stored] = await db
    .select()
    .from(schema.sponsorAssetsTable)
    .where(eq(schema.sponsorAssetsTable.id, file.id));
  await storage.delete(stored.storageKey);
  expect(
    (await http("/admin/sponsors/" + sp.s.id + "/assets/complete.zip", "GET", undefined, admin()))
      .status,
  ).toBe(409);
  const replacement = await filePost(
    "/sponsor/assets/" + file.id + "/replace",
    sp.headers,
    png,
    "recovered.png",
    "image/png",
  );
  expect(replacement.status).toBe(201);
  const zip = await http(
    "/admin/sponsors/" + sp.s.id + "/assets/complete.zip",
    "GET",
    undefined,
    admin(),
  );
  expect(zip.status).toBe(200);
  expect(openZip(Buffer.from(await zip.arrayBuffer())).has("logo/recovered.png")).toBe(true);
});

it("returns a retryable response and records attention when storage preflight is unavailable", async () => {
  const sp = await sponsor();
  await addFile(sp.headers);
  const unavailable = vi
    .spyOn(storage, "exists")
    .mockRejectedValueOnce(new Error("Synthetic storage outage"));
  try {
    const zip = await http(
      "/admin/sponsors/" + sp.s.id + "/assets/complete.zip",
      "GET",
      undefined,
      admin(),
    );
    expect(zip.status).toBe(503);
    expect(await zip.text()).toContain("Retry");
    expect(
      (
        await pool.query(
          "select id from sponsor_tasks where sponsor_id=$1 and task_key='storage_error'",
          [sp.s.id],
        )
      ).rowCount,
    ).toBe(1);
  } finally {
    unavailable.mockRestore();
  }
});

if (process.env.QA_STREAM_FAILURE === "1") {
  it("a storage read failure after ZIP preflight must abort promptly and alert the admin", async () => {
    const sp = await sponsor();
    await addFile(sp.headers);
    const reader = vi.spyOn(storage, "stream").mockImplementation(() =>
      Readable.from(
        (async function* () {
          yield Buffer.from("QA bytes before interrupted stream");
          await new Promise((r) => setTimeout(r, 100));
          throw Error("synthetic object stream interruption after preflight");
        })(),
      ),
    );
    const start = Date.now();
    let responseStatus: number | null = null;
    let outcome: string;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2200);
    try {
      const zip = await fetch(origin + "/admin/sponsors/" + sp.s.id + "/assets/complete.zip", {
        headers: admin(),
        signal: controller.signal,
      });
      responseStatus = zip.status;
      const files = openZip(Buffer.from(await zip.arrayBuffer()));
      outcome = "complete archive " + files.size;
    } catch (err) {
      outcome = controller.signal.aborted ? "client timed out" : String((err as Error).message);
    } finally {
      clearTimeout(timer);
      reader.mockRestore();
    }
    const attention = await pool.query(
      "select count(*)::int as count from sponsor_tasks where sponsor_id=$1 and task_key='storage_error'",
      [sp.s.id],
    );
    observed("midstream object failure", {
      responseStatus,
      outcome,
      elapsedMs: Date.now() - start,
      attention: attention.rows[0].count,
    });
    expect(outcome).not.toBe("client timed out");
    expect(attention.rows[0].count).toBeGreaterThan(0);
  }, 10000);
}

if (process.env.QA_EDGE_SCANNER === "1") {
  it("isolated scanner offline browser", async () => {
    const sp = await sponsor();
    await db.insert(schema.sponsorScannerDevicesTable).values({
      id: randomUUID(),
      sponsorId: sp.s.id,
      accessVersion: 1,
      tokenHash: createHash("sha256").update(syntheticPhoneToken).digest("hex"),
      operatorName: "QA Event Staff",
    });
    const { a } = await makeBooking("paid");
    await db
      .update(schema.attendeesTable)
      .set({ firstName: "Casey", lastName: "Fixture", leadSharingNoticeAt: new Date() })
      .where(eq(schema.attendeesTable.id, a.id));
    await db.insert(schema.attendeeBadgesTable).values({ attendeeId: a.id, code: "5CA1AB171234" });
    await db.insert(schema.eventSettingsTable).values({
      eventStartAt: new Date(Date.now() - 3600000),
      eventEndAt: new Date(Date.now() + 3600000),
    });
    console.log("OFFLINE SCANNER DATABASE READY");
    for (let n = 0; n < 450; n++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const leads = await db
        .select()
        .from(schema.sponsorLeadsTable)
        .where(eq(schema.sponsorLeadsTable.sponsorId, sp.s.id));
      if (leads.length) {
        console.log("OBSERVED offline scan reached database", {
          leads: leads.length,
          scanCount: leads[0].scanCount,
        });
        expect(leads.length).toBe(1);
        expect(leads[0].scanCount).toBe(1);
        await new Promise((resolve) => setTimeout(resolve, 30000));
        return;
      }
    }
    throw Error("No confirmed scan reached the isolated database in time");
  }, 515000);
}

if (process.env.QA_EDGE_BROWSER === "1") {
  it("isolated browser checkout", async () => {
    for (let i = 0; i < 600; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const rows = await pool.query(
        "select id,status,quantity,total_amount as total,order_reference as reference from bookings where status='invoiced'",
      );
      if (rows.rows.length) {
        const facts = await pool.query(
          "select b.id,b.quantity,b.total_amount,b.current_step,b.status,count(a.id)::int as attendees,count(a.lead_sharing_notice_at)::int as notice_recorded from bookings b join attendees a on a.booking_id=b.id where b.status='invoiced' group by b.id",
        );
        observed("browser invoice saved", {
          bookings: facts.rows,
          providerSendCalls: intercepted.sendInvoice.mock.calls.length,
        });
        await new Promise((resolve) => setTimeout(resolve, 45000));
        expect(rows.rows.length).toBe(1);
        return;
      }
    }
    throw Error("Browser did not complete the local test checkout in time.");
  }, 680000);
}
