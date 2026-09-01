import { Router, type IRouter } from "express";
import type Stripe from "stripe";
import { eq, desc, asc, or, and, sql, count, notInArray, isNull } from "drizzle-orm";
import ExcelJS from "exceljs";
import { v4 as uuidv4 } from "uuid";
import { db } from "@workspace/db";
import {
  bookingsTable,
  attendeesTable,
  promoCodesTable,
  discountTiersTable,
  notificationEmailsTable,
  passInventoryTable,
  passConfigTable,
  activityLogTable,
  emailLogsTable,
  sponsorsTable,
} from "@workspace/db";
import {
  adminAuth,
  issueAdminToken,
  getAdminPassword,
  timingSafeStringEqual,
} from "../middleware/admin-auth";
import { logAdminAction } from "../lib/audit";
import {
  recordAdminLoginFailure,
  recordAdminLoginSuccess,
} from "../middleware/admin-login-throttle";
import { logger } from "../lib/logger";
import { refreshStripeInvoiceStatusIfStale } from "../lib/invoice";
import { deriveInvoiceBadge } from "../lib/invoice-status";
import { deliveryStatusForBooking, runConfirmationSideEffects } from "../lib/booking-confirmation";
import {
  getEventSettings,
  sendCommunitySocialEmail,
  sendConfirmationAndReceiptEmail,
  sendWelcomeEmail,
} from "../lib/email";
import { getStripe } from "../lib/stripe-client";
import { getOrCreateArchivedReceiptPdf } from "../lib/receipt-documents";
import { calculatePricing } from "../lib/pricing";
import { defaultOrderRef } from "../lib/order-reference";
import {
  buildSessionSchedulerExportRows,
  createSessionSchedulerWorkbook,
  getSessionSchedulerExportFilename,
} from "../lib/session-scheduler-export";
import { releaseSponsorRedemption, restoreSponsorRedemption } from "../lib/sponsor-redemptions";

const router: IRouter = Router();
const INVOICE_PAYMENT_TERMS_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
type AdminStatusStripeAction =
  | "refund_issued"
  | "invoice_voided"
  | "invoice_paid_out_of_band"
  | "skipped"
  | "failed";

type BookingUpdate = Partial<typeof bookingsTable.$inferInsert>;

function applyStripeInvoiceUrlUpdates(updates: BookingUpdate, invoice: Stripe.Invoice): void {
  if (invoice.invoice_pdf) updates.stripeInvoicePdfUrl = invoice.invoice_pdf;
  if (invoice.hosted_invoice_url) updates.stripeInvoicePaymentUrl = invoice.hosted_invoice_url;
}

function getAdminRegistrationDate(booking: typeof bookingsTable.$inferSelect): Date {
  if (booking.paidAt) {
    return booking.paidAt;
  }

  if (booking.paymentMethod === "invoice" && booking.invoiceDueDate) {
    const invoiceCreatedAt = new Date(booking.invoiceDueDate);
    invoiceCreatedAt.setDate(invoiceCreatedAt.getDate() - INVOICE_PAYMENT_TERMS_DAYS);
    return invoiceCreatedAt;
  }

  if (
    booking.status === "paid" ||
    booking.status === "invoiced" ||
    booking.status === "transferred"
  ) {
    return booking.updatedAt ?? booking.createdAt;
  }

  return booking.createdAt;
}

function formatBooking(b: typeof bookingsTable.$inferSelect) {
  return {
    ...b,
    ...deliveryStatusForBooking(b),
    subtotalAmount: parseFloat(b.subtotalAmount?.toString() || "0"),
    vatAmount: parseFloat(b.vatAmount?.toString() || "0"),
    totalAmount: parseFloat(b.totalAmount?.toString() || "0"),
    promoDiscountAmount: b.promoDiscountAmount
      ? parseFloat(b.promoDiscountAmount.toString())
      : null,
    groupDiscountAmount: b.groupDiscountAmount
      ? parseFloat(b.groupDiscountAmount.toString())
      : null,
    invoiceDueDate: b.invoiceDueDate ? b.invoiceDueDate.toISOString() : null,
    paidAt: b.paidAt ? b.paidAt.toISOString() : null,
    stripeInvoiceStatusSyncedAt: b.stripeInvoiceStatusSyncedAt
      ? b.stripeInvoiceStatusSyncedAt.toISOString()
      : null,
    lastInvoiceReminderSentAt: b.lastInvoiceReminderSentAt
      ? b.lastInvoiceReminderSentAt.toISOString()
      : null,
    invoiceBadgeStatus: deriveInvoiceBadge({
      status: b.status,
      paymentMethod: b.paymentMethod,
      stripeInvoiceId: b.stripeInvoiceId,
      stripeInvoiceStatus: b.stripeInvoiceStatus,
      invoiceDueDate: b.invoiceDueDate,
      paidAt: b.paidAt,
    }),
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}

function formatAttendee(a: typeof attendeesTable.$inferSelect) {
  return {
    ...a,
    gdprConsentAt: a.gdprConsentAt ? a.gdprConsentAt.toISOString() : null,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

function formatPromoCode(p: typeof promoCodesTable.$inferSelect) {
  return {
    ...p,
    discountValue: parseFloat(p.discountValue.toString()),
    maxDiscountAmount:
      p.maxDiscountAmount !== null ? parseFloat(p.maxDiscountAmount.toString()) : null,
    validFrom: p.validFrom ? p.validFrom.toISOString() : null,
    validUntil: p.validUntil ? p.validUntil.toISOString() : null,
    createdAt: p.createdAt.toISOString(),
  };
}

function formatTier(t: typeof discountTiersTable.$inferSelect) {
  return {
    ...t,
    discountPercent: parseFloat(t.discountPercent.toString()),
  };
}

router.post("/admin/login", async (req, res): Promise<void> => {
  const { password } = req.body;
  const adminPassword = getAdminPassword();
  const ip = req.ip || req.socket.remoteAddress || "unknown";

  if (!adminPassword) {
    res
      .status(503)
      .json({ error: "Admin authentication not configured — set a secure ADMIN_PASSWORD" });
    return;
  }

  const supplied = typeof password === "string" ? password : "";
  if (!supplied || !timingSafeStringEqual(supplied, adminPassword)) {
    const { failures, lockedForMs } = recordAdminLoginFailure(req);
    logger.warn({ ip, failures, lockedForMs }, "Admin login failed");
    await logAdminAction({
      type: "admin_login_failure",
      actor: ip,
      summary: `Failed admin login attempt (failure #${failures} from this IP)`,
      meta: { failures, lockedForMs },
    });
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  recordAdminLoginSuccess(req);
  const { token, expiresAt } = issueAdminToken(adminPassword);
  logger.info({ ip, expiresAt: expiresAt.toISOString() }, "Admin login succeeded");
  await logAdminAction({
    type: "admin_login_success",
    actor: ip,
    summary: "Admin logged in",
    meta: { expiresAt: expiresAt.toISOString() },
  });

  res.json({ token, expiresAt: expiresAt.toISOString() });
});

router.get("/admin/stats", adminAuth, async (_req, res): Promise<void> => {
  const allBookings = await db.select().from(bookingsTable);

  const completed = allBookings.filter((b) => b.status === "paid" || b.status === "invoiced");
  const sponsorStaff = completed.filter((b) => b.registrationSource === "sponsor_staff");
  const commercialCompleted = completed.filter((b) => b.registrationSource !== "sponsor_staff");
  const partial = allBookings.filter((b) => b.status === "partial");

  const totalRevenue = commercialCompleted.reduce(
    (sum, b) => sum + parseFloat(b.totalAmount?.toString() || "0"),
    0,
  );
  const totalVat = commercialCompleted.reduce(
    (sum, b) => sum + parseFloat(b.vatAmount?.toString() || "0"),
    0,
  );

  const passCounts = {
    single: commercialCompleted
      .filter((b) => b.passType === "single")
      .reduce((sum, booking) => sum + booking.quantity, 0),
    business: commercialCompleted
      .filter((b) => b.passType === "business")
      .reduce((sum, booking) => sum + booking.quantity, 0),
  };

  const paymentMethodCounts = {
    card: commercialCompleted.filter((b) => b.paymentMethod === "card").length,
    invoice: commercialCompleted.filter((b) => b.paymentMethod === "invoice").length,
  };

  const allAttendees = await db.select().from(attendeesTable);

  function withLead(booking: typeof bookingsTable.$inferSelect) {
    const lead = allAttendees.find((a) => a.bookingId === booking.id && a.isLead);
    return {
      ...formatBooking(booking),
      leadName: lead ? `${lead.firstName} ${lead.lastName}` : null,
      leadEmail: lead?.workEmail || null,
      leadPhone: lead?.phone || booking.billingPhone || null,
      leadJobTitle: lead?.jobTitle || null,
      leadCompany: lead?.company || booking.billingCompany || null,
    };
  }

  const sortedAll = [...allBookings].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const recentCompleted = sortedAll
    .filter((b) => b.status === "paid" || b.status === "invoiced")
    .slice(0, 10)
    .map(withLead);

  const recentPartials = sortedAll
    .filter((b) => b.status === "partial")
    .slice(0, 15)
    .map(withLead);

  res.json({
    totalRegistrations: allBookings.length,
    completedRegistrations: commercialCompleted.length,
    sponsorStaffCount: sponsorStaff.reduce((sum, booking) => sum + booking.quantity, 0),
    partialRegistrations: partial.length,
    totalRevenue: parseFloat(totalRevenue.toFixed(2)),
    totalVat: parseFloat(totalVat.toFixed(2)),
    passCounts,
    paymentMethodCounts,
    recentRegistrations: recentCompleted,
    recentPartials,
  });
});

router.get("/admin/registrations", adminAuth, async (req, res): Promise<void> => {
  const page = parseInt((req.query.page as string) || "1", 10);
  const limit = parseInt((req.query.limit as string) || "25", 10);
  const offset = (page - 1) * limit;
  const statusFilter = req.query.status as string | undefined;
  const passTypeFilter = req.query.passType as string | undefined;
  const search = req.query.search as string | undefined;
  const needsAttentionFilter =
    req.query.needsAttention === "true" || req.query.needsAttention === "1";

  const allBookings = await db.select().from(bookingsTable).orderBy(desc(bookingsTable.createdAt));
  const allAttendees = await db.select().from(attendeesTable);

  let filtered = allBookings;
  if (statusFilter) {
    filtered = filtered.filter((b) => b.status === statusFilter);
  }
  if (passTypeFilter) {
    filtered = filtered.filter((b) => b.passType === passTypeFilter);
  }
  if (needsAttentionFilter) {
    // "Needs attention" = paid/invoiced booking with at least one
    // confirmation side-effect still un-delivered. Keeps the panel honest
    // about silent failures (SMTP blip, Sheets API hiccup, etc).
    filtered = filtered.filter((b) => deliveryStatusForBooking(b).needsAttention);
  }

  if (search) {
    const searchLower = search.trim().toLowerCase();
    if (searchLower) {
      const matchingAttendeeBookingIds = allAttendees
        .filter(
          (a) =>
            a.firstName.toLowerCase().includes(searchLower) ||
            a.lastName.toLowerCase().includes(searchLower) ||
            a.workEmail.toLowerCase().includes(searchLower) ||
            a.company.toLowerCase().includes(searchLower) ||
            a.jobTitle.toLowerCase().includes(searchLower) ||
            a.notes?.toLowerCase().includes(searchLower),
        )
        .map((a) => a.bookingId);

      filtered = filtered.filter(
        (b) =>
          matchingAttendeeBookingIds.includes(b.id) ||
          b.orderReference?.toLowerCase().includes(searchLower) ||
          b.promoCode?.toLowerCase().includes(searchLower),
      );
    }
  }

  const total = filtered.length;
  const paginated = filtered.slice(offset, offset + limit);

  const result = paginated.map((booking) => {
    const lead = allAttendees.find((a) => a.bookingId === booking.id && a.isLead);
    return {
      ...formatBooking(booking),
      leadName: lead ? `${lead.firstName} ${lead.lastName}` : null,
      leadEmail: lead?.workEmail || null,
      leadCompany: lead?.company || null,
    };
  });

  res.json({ registrations: result, total, page, limit });
});

router.post("/admin/registrations", adminAuth, async (req, res): Promise<void> => {
  const {
    firstName,
    lastName,
    jobTitle,
    company,
    workEmail,
    phone,
    dietaryAccessibility,
    notes,
    passType = "single",
    status = "invoiced",
  } = req.body as Record<string, unknown>;

  const requiredText = { firstName, lastName, jobTitle, company, workEmail };
  for (const [field, value] of Object.entries(requiredText)) {
    if (typeof value !== "string" || !value.trim()) {
      res.status(400).json({ error: `${field} is required` });
      return;
    }
  }

  const email = String(workEmail).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: "workEmail must be a valid email address" });
    return;
  }
  if (passType !== "single" && passType !== "business") {
    res.status(400).json({ error: "passType must be single or business" });
    return;
  }
  if (status !== "invoiced" && status !== "paid") {
    res.status(400).json({ error: "status must be invoiced or paid" });
    return;
  }
  if (phone !== undefined && phone !== null && typeof phone !== "string") {
    res.status(400).json({ error: "phone must be a string" });
    return;
  }
  if (
    dietaryAccessibility !== undefined &&
    dietaryAccessibility !== null &&
    typeof dietaryAccessibility !== "string"
  ) {
    res.status(400).json({ error: "dietaryAccessibility must be a string" });
    return;
  }
  if (notes !== undefined && notes !== null && typeof notes !== "string") {
    res.status(400).json({ error: "notes must be a string" });
    return;
  }
  if (typeof notes === "string" && notes.length > 4000) {
    res.status(400).json({ error: "notes must be 4,000 characters or fewer" });
    return;
  }

  const pricing = await calculatePricing(passType, 1);
  const now = new Date();
  const invoiceDueDate =
    status === "invoiced" ? new Date(now.getTime() + INVOICE_PAYMENT_TERMS_DAYS * DAY_MS) : null;
  const attendeeType = passType === "business" ? "consultant_vendor" : "hr_professional";
  const cleanFirstName = String(firstName).trim();
  const cleanLastName = String(lastName).trim();
  const cleanJobTitle = String(jobTitle).trim();
  const cleanCompany = String(company).trim();

  const created = await db.transaction(async (tx) => {
    const [booking] = await tx
      .insert(bookingsTable)
      .values({
        sessionToken: `manual-${uuidv4()}`,
        status,
        passType,
        attendeeType,
        quantity: 1,
        subtotalAmount: pricing.subtotalAfterDiscounts.toFixed(2),
        vatAmount: pricing.vatAmount.toFixed(2),
        totalAmount: pricing.total.toFixed(2),
        groupDiscountAmount:
          pricing.groupDiscountAmount > 0 ? pricing.groupDiscountAmount.toFixed(2) : null,
        promoDiscountAmount: null,
        paymentMethod: "invoice",
        manualEntry: true,
        registrationSource: "manual",
        currentStep: 4,
        billingName: `${cleanFirstName} ${cleanLastName}`,
        billingCompany: cleanCompany,
        billingEmail: email,
        billingPhone: typeof phone === "string" ? phone.trim() || null : null,
        invoiceDueDate,
        paidAt: status === "paid" ? now : null,
        managementToken: uuidv4(),
      })
      .returning();

    const [bookingWithReference] = await tx
      .update(bookingsTable)
      .set({ orderReference: defaultOrderRef(booking.id) })
      .where(eq(bookingsTable.id, booking.id))
      .returning();

    const [attendee] = await tx
      .insert(attendeesTable)
      .values({
        bookingId: booking.id,
        isLead: true,
        seatIndex: 0,
        firstName: cleanFirstName,
        lastName: cleanLastName,
        jobTitle: cleanJobTitle,
        company: cleanCompany,
        workEmail: email,
        phone: typeof phone === "string" ? phone.trim() || null : null,
        dietaryAccessibility:
          typeof dietaryAccessibility === "string" ? dietaryAccessibility.trim() || null : null,
        notes: typeof notes === "string" ? notes.trim() || null : null,
        isTbc: false,
        gdprConsent: false,
        gdprConsentAt: null,
      })
      .returning();

    return { booking: bookingWithReference, attendee };
  });

  await logAdminAction({
    type: "admin_attendee_added",
    bookingId: created.booking.id,
    attendeeId: created.attendee.id,
    summary: `Admin manually added delegate ${cleanFirstName} ${cleanLastName} as a direct-invoice registration`,
    after: {
      firstName: cleanFirstName,
      lastName: cleanLastName,
      jobTitle: cleanJobTitle,
      company: cleanCompany,
      workEmail: email,
      notes: created.attendee.notes,
      passType,
      status,
      manualEntry: true,
    },
  });

  res.status(201).json({
    ...formatBooking(created.booking),
    attendees: [formatAttendee(created.attendee)],
  });
});

router.get("/admin/registrations/export", adminAuth, async (req, res): Promise<void> => {
  const statusFilter = req.query.status as string | undefined;

  let bookings = await db.select().from(bookingsTable).orderBy(desc(bookingsTable.createdAt));
  if (statusFilter) {
    bookings = bookings.filter((b) => b.status === statusFilter);
  }

  const allAttendees = await db.select().from(attendeesTable);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "SWP Summit";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Registrations");

  const columns: ExcelJS.Column[] = [
    { header: "Booking Reference", key: "bookingRef", width: 18 },
    { header: "Status", key: "status", width: 14 },
    { header: "Entry Source", key: "entrySource", width: 16 },
    { header: "Pass Type", key: "passType", width: 14 },
    { header: "Qty", key: "qty", width: 6 },
    { header: "Subtotal (ex VAT) £", key: "subtotal", width: 18 },
    { header: "VAT £", key: "vat", width: 10 },
    { header: "Total £", key: "total", width: 10 },
    { header: "Payment Method", key: "paymentMethod", width: 16 },
    { header: "Invoice Ref", key: "invoiceRef", width: 16 },
    { header: "Billing Name", key: "billingName", width: 20 },
    { header: "Billing Company", key: "billingCompany", width: 24 },
    { header: "Billing Email", key: "billingEmail", width: 26 },
    { header: "Lead", key: "lead", width: 6 },
    { header: "First Name", key: "firstName", width: 16 },
    { header: "Last Name", key: "lastName", width: 16 },
    { header: "Job Title", key: "jobTitle", width: 26 },
    { header: "Company", key: "company", width: 24 },
    { header: "Work Email", key: "workEmail", width: 28 },
    { header: "Phone", key: "phone", width: 16 },
    { header: "Dietary / Access", key: "dietary", width: 22 },
    { header: "Attendee Notes", key: "notes", width: 36 },
    { header: "GDPR Consent", key: "gdpr", width: 14 },
    { header: "Registered At", key: "registeredAt", width: 22 },
  ] as ExcelJS.Column[];
  sheet.columns = columns;

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E293B" } };
  headerRow.alignment = { vertical: "middle" };
  headerRow.height = 22;

  for (const booking of bookings) {
    const registeredAt = getAdminRegistrationDate(booking).toISOString();
    const bookingAttendees = allAttendees
      .filter((a) => a.bookingId === booking.id)
      .sort((a, b) => (a.seatIndex ?? 0) - (b.seatIndex ?? 0));

    if (bookingAttendees.length === 0) {
      sheet.addRow({
        bookingRef: booking.orderReference || "",
        status: booking.status,
        entrySource: booking.manualEntry ? "Manual direct invoice" : "Online checkout",
        passType: booking.passType,
        qty: booking.quantity,
        subtotal: parseFloat(booking.subtotalAmount?.toString() || "0"),
        vat: parseFloat(booking.vatAmount?.toString() || "0"),
        total: parseFloat(booking.totalAmount?.toString() || "0"),
        paymentMethod: booking.paymentMethod || "",
        invoiceRef: booking.paymentMethod === "invoice" ? booking.orderReference || "" : "",
        billingName: booking.billingName || "",
        billingCompany: booking.billingCompany || "",
        billingEmail: booking.billingEmail || "",
        lead: "",
        firstName: "",
        lastName: "",
        jobTitle: "",
        company: "",
        workEmail: "",
        phone: "",
        dietary: "",
        notes: "",
        gdpr: "",
        registeredAt,
      });
      continue;
    }

    for (const a of bookingAttendees) {
      const row = sheet.addRow({
        bookingRef: booking.orderReference || "",
        status: booking.status,
        entrySource: booking.manualEntry ? "Manual direct invoice" : "Online checkout",
        passType: booking.passType,
        qty: booking.quantity,
        subtotal: parseFloat(booking.subtotalAmount?.toString() || "0"),
        vat: parseFloat(booking.vatAmount?.toString() || "0"),
        total: parseFloat(booking.totalAmount?.toString() || "0"),
        paymentMethod: booking.paymentMethod || "",
        invoiceRef: booking.paymentMethod === "invoice" ? booking.orderReference || "" : "",
        billingName: booking.billingName || "",
        billingCompany: booking.billingCompany || "",
        billingEmail: booking.billingEmail || "",
        lead: a.isLead ? "★" : "",
        firstName: a.isTbc ? "(TBC)" : a.firstName || "",
        lastName: a.isTbc ? "" : a.lastName || "",
        jobTitle: a.isTbc ? "" : a.jobTitle || "",
        company: a.isTbc ? "" : a.company || "",
        workEmail: a.isTbc ? "" : a.workEmail || "",
        phone: a.isTbc ? "" : a.phone || "",
        dietary: a.isTbc ? "" : a.dietaryAccessibility || "",
        notes: a.notes || "",
        gdpr: a.isTbc ? "" : a.gdprConsent ? "Yes" : "No",
        registeredAt,
      });
      if (a.isLead) {
        row.getCell("lead").font = { bold: true, color: { argb: "FF004EB9" } };
      }
    }
  }

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.eachCell((cell) => {
      cell.border = {
        top: { style: "thin", color: { argb: "FFE5E7EB" } },
        left: { style: "thin", color: { argb: "FFE5E7EB" } },
        bottom: { style: "thin", color: { argb: "FFE5E7EB" } },
        right: { style: "thin", color: { argb: "FFE5E7EB" } },
      };
    });
    if (rowNumber % 2 === 0) {
      row.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF9FAFB" } };
      });
    }
  });

  const date = new Date().toISOString().split("T")[0];
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader("Content-Disposition", `attachment; filename="swp27-registrations-${date}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
});

router.get("/admin/registrations/export/scheduler", adminAuth, async (_req, res): Promise<void> => {
  const [bookings, attendees] = await Promise.all([
    db.select().from(bookingsTable),
    db.select().from(attendeesTable),
  ]);
  const rows = buildSessionSchedulerExportRows(bookings, attendees);
  const workbook = createSessionSchedulerWorkbook(rows);
  const buffer = await workbook.xlsx.writeBuffer();

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${getSessionSchedulerExportFilename()}"`,
  );
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.send(Buffer.from(buffer));
});

router.get("/admin/registrations/:id", adminAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);

  const [initial] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, id));
  if (!initial) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }

  // Live re-poll Stripe if our cached invoice status is stale.
  await refreshStripeInvoiceStatusIfStale(getStripe(), id);

  const [[booking], attendees] = await Promise.all([
    db.select().from(bookingsTable).where(eq(bookingsTable.id, id)),
    db.select().from(attendeesTable).where(eq(attendeesTable.bookingId, id)),
  ]);

  res.json({
    ...formatBooking(booking),
    attendees: attendees.map(formatAttendee),
  });
});

router.get("/admin/registrations/:id/receipt-pdf", adminAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);

  let receipt: Awaited<ReturnType<typeof getOrCreateArchivedReceiptPdf>>;
  try {
    receipt = await getOrCreateArchivedReceiptPdf(id);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not generate VAT receipt";
    if (message === "Booking not found") {
      res.status(404).json({ error: message });
      return;
    }
    if (message.includes("after payment")) {
      res.status(409).json({ error: message });
      return;
    }
    logger.error({ err, bookingId: id }, "Admin VAT receipt download failed");
    res.status(500).json({ error: message });
    return;
  }

  const safeName = receipt.filename.replace(/[^a-zA-Z0-9._-]/g, "_");

  res.setHeader("Content-Type", receipt.contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
  res.setHeader("Content-Length", receipt.buffer.length.toString());
  res.setHeader("Cache-Control", "private, no-store");
  res.send(receipt.buffer);
});

/**
 * Manually re-run any post-confirmation side-effects that haven't yet
 * succeeded for this booking (confirmation email, welcome emails, organiser
 * notification, Sheets sync). Safe to call repeatedly — each side-effect is
 * gated on its own boolean flag, so already-delivered ones are skipped.
 *
 * Use case: a Stripe webhook delivered fine but our SMTP relay was down at
 * the time, so the confirmation email is stuck. Admin can flip the booking
 * back to "delivered" without manually replaying the Stripe event.
 */
router.post("/admin/registrations/:id/redeliver", adminAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);

  const [existing] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }

  if (existing.status !== "paid" && existing.status !== "invoiced") {
    res.status(400).json({
      error: "Only confirmed (paid/invoiced) bookings can be redelivered",
    });
    return;
  }

  const result = await runConfirmationSideEffects(id);

  await logAdminAction({
    type: "admin_booking_redelivered",
    bookingId: id,
    summary: `Redelivered booking ${existing.orderReference || `#${id}`}: ran=[${result.ran.join(",")}] failed=[${result.failed.join(",")}]`,
    meta: result,
  });

  const [refreshed] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, id));
  res.json({ ...formatBooking(refreshed), redelivery: result });
});

router.post(
  "/admin/registrations/:id/resend-confirmation-email",
  adminAuth,
  async (req, res): Promise<void> => {
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(raw, 10);

    const [[booking], attendees] = await Promise.all([
      db.select().from(bookingsTable).where(eq(bookingsTable.id, id)),
      db.select().from(attendeesTable).where(eq(attendeesTable.bookingId, id)),
    ]);

    if (!booking) {
      res.status(404).json({ error: "Booking not found" });
      return;
    }
    if (booking.registrationSource === "sponsor_staff") {
      res.status(409).json({
        error:
          "Sponsor staff do not receive a receipt email. Use Redeliver failed delivery instead.",
      });
      return;
    }
    if (booking.status !== "paid" && booking.status !== "invoiced") {
      res.status(400).json({
        error: "Only confirmed (paid/invoiced) bookings can have emails resent",
      });
      return;
    }

    const lead = attendees.find((attendee) => attendee.isLead) || attendees[0];
    const recipient = lead?.workEmail;
    if (!recipient) {
      res.status(409).json({ error: "No lead attendee email address is available" });
      return;
    }

    const sent = await sendConfirmationAndReceiptEmail(id);
    const resend = {
      type: "confirmation" as const,
      sent,
      recipients: sent ? [recipient] : [],
      failedRecipients: sent ? [] : [recipient],
    };

    if (!sent) {
      await logAdminAction({
        type: "admin_booking_redelivered",
        bookingId: id,
        summary: `Failed to resend confirmation email for booking ${booking.orderReference || `#${id}`}`,
        meta: { resend },
      });
      res.status(502).json({
        error: "Confirmation email could not be sent. Check API logs.",
        resend,
      });
      return;
    }

    await db
      .update(bookingsTable)
      .set({ confirmationEmailSent: true })
      .where(eq(bookingsTable.id, id));

    await logAdminAction({
      type: "admin_booking_redelivered",
      bookingId: id,
      summary: `Resent confirmation email for booking ${booking.orderReference || `#${id}`}`,
      meta: { resend },
    });

    const [refreshed] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, id));
    res.json({ ...formatBooking(refreshed), resend });
  },
);

router.post(
  "/admin/registrations/:id/resend-welcome-emails",
  adminAuth,
  async (req, res): Promise<void> => {
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(raw, 10);

    const [[booking], attendees] = await Promise.all([
      db.select().from(bookingsTable).where(eq(bookingsTable.id, id)),
      db.select().from(attendeesTable).where(eq(attendeesTable.bookingId, id)),
    ]);

    if (!booking) {
      res.status(404).json({ error: "Booking not found" });
      return;
    }
    if (booking.registrationSource === "sponsor_staff") {
      res.status(409).json({
        error: "Use Redeliver failed delivery for the sponsor staff welcome email.",
      });
      return;
    }
    if (booking.status !== "paid" && booking.status !== "invoiced") {
      res.status(400).json({
        error: "Only confirmed (paid/invoiced) bookings can have emails resent",
      });
      return;
    }

    const welcomeAttendees = attendees
      .filter((attendee) => !attendee.isTbc && !!attendee.workEmail)
      .sort((a, b) => (a.seatIndex ?? 0) - (b.seatIndex ?? 0));
    if (welcomeAttendees.length === 0) {
      res.status(409).json({ error: "No attendee welcome email addresses are available" });
      return;
    }

    const recipients: string[] = [];
    const failedRecipients: string[] = [];
    for (const attendee of welcomeAttendees) {
      const sent = await sendWelcomeEmail(id, attendee.firstName, attendee.workEmail);
      if (sent) {
        recipients.push(attendee.workEmail);
      } else {
        failedRecipients.push(attendee.workEmail);
      }
    }

    const sent = failedRecipients.length === 0;
    const resend = {
      type: "welcome" as const,
      sent,
      recipients,
      failedRecipients,
    };

    if (!sent) {
      await logAdminAction({
        type: "admin_booking_redelivered",
        bookingId: id,
        summary: `Failed to resend welcome emails for booking ${booking.orderReference || `#${id}`}`,
        meta: { resend },
      });
      res.status(502).json({
        error: "One or more welcome emails could not be sent. Check API logs.",
        resend,
      });
      return;
    }

    await db.update(bookingsTable).set({ welcomeEmailsSent: true }).where(eq(bookingsTable.id, id));

    await logAdminAction({
      type: "admin_booking_redelivered",
      bookingId: id,
      summary: `Resent welcome emails for booking ${booking.orderReference || `#${id}`}`,
      meta: { resend },
    });

    const [refreshed] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, id));
    res.json({ ...formatBooking(refreshed), resend });
  },
);

router.post(
  "/admin/registrations/:id/send-community-social-email",
  adminAuth,
  async (req, res): Promise<void> => {
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(raw, 10);

    const [[booking], attendees, settings] = await Promise.all([
      db.select().from(bookingsTable).where(eq(bookingsTable.id, id)),
      db.select().from(attendeesTable).where(eq(attendeesTable.bookingId, id)),
      getEventSettings(),
    ]);

    if (!booking) {
      res.status(404).json({ error: "Booking not found" });
      return;
    }
    if (booking.status !== "paid" && booking.status !== "invoiced") {
      res.status(400).json({
        error: "Only confirmed (paid/invoiced) bookings can receive the Community Social email",
      });
      return;
    }
    if (!settings.socialEnabled || !settings.socialStartAt || !settings.socialVenue?.trim()) {
      res.status(409).json({
        error:
          "Enable the Community Social and set its date, time and venue in Event Settings before sending.",
      });
      return;
    }

    const socialAttendees = attendees
      .filter((attendee) => !attendee.isTbc && !!attendee.workEmail)
      .sort((a, b) => (a.seatIndex ?? 0) - (b.seatIndex ?? 0));
    if (socialAttendees.length === 0) {
      res.status(409).json({ error: "No attendee email addresses are available" });
      return;
    }

    const recipients: string[] = [];
    const failedRecipients: string[] = [];
    for (const attendee of socialAttendees) {
      const sent = await sendCommunitySocialEmail(
        id,
        attendee.firstName || "there",
        attendee.workEmail,
      );
      if (sent) {
        recipients.push(attendee.workEmail);
      } else {
        failedRecipients.push(attendee.workEmail);
      }
    }

    const sent = failedRecipients.length === 0;
    const resend = {
      type: "community_social" as const,
      sent,
      recipients,
      failedRecipients,
    };

    if (!sent) {
      await logAdminAction({
        type: "admin_community_social_email_sent",
        bookingId: id,
        summary: `Community Social email delivery failed for booking ${booking.orderReference || `#${id}`}`,
        meta: { resend },
      });
      res.status(502).json({
        error: "One or more Community Social emails could not be sent. Check API logs.",
        resend,
      });
      return;
    }

    await db
      .update(bookingsTable)
      .set({ communitySocialEmailSent: true })
      .where(eq(bookingsTable.id, id));

    await logAdminAction({
      type: "admin_community_social_email_sent",
      bookingId: id,
      summary: `Sent Community Social emails for booking ${booking.orderReference || `#${id}`}`,
      meta: { resend },
    });

    const [refreshed] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, id));
    res.json({ ...formatBooking(refreshed), resend });
  },
);

router.patch("/admin/registrations/:id/status", adminAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const { status } = req.body as { status: string };

  const allowed = [
    "paid",
    "invoiced",
    "transferred",
    "partial",
    "pending_payment",
    "cancelled",
    "refunded",
    "disputed",
  ];
  if (!status || !allowed.includes(status)) {
    res.status(400).json({ error: `status must be one of: ${allowed.join(", ")}` });
    return;
  }

  const [existing] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }

  const terminalStatuses = new Set(["cancelled", "refunded", "transferred"]);
  const activeStatuses = new Set(["paid", "invoiced"]);

  let finalStatus = status;
  let stripeAction: AdminStatusStripeAction = "skipped";
  const statusUpdateOverrides: BookingUpdate = {};

  if (status === "paid" && existing.paymentMethod === "invoice" && existing.stripeInvoiceId) {
    const stripe = getStripe();
    const invoiceId = existing.stripeInvoiceId;

    if (!stripe) {
      logger.error(
        { bookingId: id, invoiceId },
        "Stripe not configured - cannot mark invoice paid from admin status override",
      );
      res.status(503).json({
        error: "Stripe is not configured; booking status was not changed",
        stripeAction: "failed",
      });
      return;
    }

    let paidInvoice: Stripe.Invoice;
    try {
      const currentInvoice = await stripe.invoices.retrieve(invoiceId);

      if (currentInvoice.status === "paid") {
        paidInvoice = currentInvoice;
      } else if (currentInvoice.status === "open") {
        paidInvoice = await stripe.invoices.pay(invoiceId, { paid_out_of_band: true });
      } else {
        logger.warn(
          { bookingId: id, invoiceId, stripeInvoiceStatus: currentInvoice.status },
          "Stripe invoice is not open or paid; admin paid override blocked",
        );
        res.status(409).json({
          error: `Stripe invoice is ${currentInvoice.status ?? "not payable"}; booking status was not changed`,
          stripeAction: "failed",
        });
        return;
      }
    } catch (err) {
      logger.error(
        { err, bookingId: id, invoiceId },
        "Failed to mark Stripe invoice paid from admin status override",
      );
      res.status(502).json({
        error: "Failed to mark Stripe invoice paid; booking status was not changed",
        stripeAction: "failed",
      });
      return;
    }

    if (paidInvoice.status !== "paid") {
      logger.error(
        { bookingId: id, invoiceId, stripeInvoiceStatus: paidInvoice.status },
        "Stripe invoice pay call did not return a paid invoice; admin paid override blocked",
      );
      res.status(502).json({
        error: "Stripe invoice was not marked paid; booking status was not changed",
        stripeAction: "failed",
      });
      return;
    }

    const syncedAt = new Date();
    stripeAction = "invoice_paid_out_of_band";
    statusUpdateOverrides.paidAt = existing.paidAt ?? syncedAt;
    statusUpdateOverrides.stripeInvoiceStatus = "paid";
    statusUpdateOverrides.stripeInvoiceStatusSyncedAt = syncedAt;
    applyStripeInvoiceUrlUpdates(statusUpdateOverrides, paidInvoice);
  }

  if (status === "cancelled") {
    const stripe = getStripe();
    const needsInvoiceVoid = existing.status === "invoiced" && !!existing.stripeInvoiceId;
    const needsCardRefund =
      existing.status === "paid" &&
      existing.paymentMethod === "card" &&
      !!existing.stripePaymentIntentId;

    if (!stripe && (needsInvoiceVoid || needsCardRefund)) {
      stripeAction = "failed";
      logger.error(
        { bookingId: id },
        "Stripe not configured — cannot void invoice or issue refund on cancellation",
      );
    } else if (stripe && needsInvoiceVoid) {
      try {
        await stripe.invoices.voidInvoice(existing.stripeInvoiceId!);
        stripeAction = "invoice_voided";
      } catch (err) {
        logger.error({ err, bookingId: id }, "Failed to void Stripe invoice on cancellation");
        stripeAction = "failed";
      }
    } else if (stripe && needsCardRefund) {
      try {
        await stripe.refunds.create({ payment_intent: existing.stripePaymentIntentId! });
        finalStatus = "refunded";
        stripeAction = "refund_issued";
      } catch (err) {
        logger.error({ err, bookingId: id }, "Failed to issue Stripe refund on cancellation");
        stripeAction = "failed";
      }
    }
  }

  let sponsorAllocationRestored = false;
  if (
    typeof existing.sponsorId === "number" &&
    existing.registrationSource !== "sponsor_staff" &&
    terminalStatuses.has(existing.status) &&
    activeStatuses.has(finalStatus)
  ) {
    sponsorAllocationRestored = await restoreSponsorRedemption(existing.id);
    if (!sponsorAllocationRestored) {
      res.status(409).json({
        error: "This sponsor allocation no longer has capacity, so the booking cannot be restored",
      });
      return;
    }
  }

  let updated: typeof bookingsTable.$inferSelect;
  try {
    if (
      existing.registrationSource === "sponsor_staff" &&
      typeof existing.sponsorId === "number" &&
      terminalStatuses.has(existing.status) &&
      activeStatuses.has(finalStatus)
    ) {
      const restored = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM sponsors WHERE id = ${existing.sponsorId} FOR UPDATE`);
        const [sponsor] = await tx
          .select({ staffAllocation: sponsorsTable.staffAllocation })
          .from(sponsorsTable)
          .where(eq(sponsorsTable.id, existing.sponsorId!));
        if (!sponsor) return null;
        const [usage] = await tx
          .select({ active: count() })
          .from(bookingsTable)
          .where(
            and(
              eq(bookingsTable.sponsorId, existing.sponsorId!),
              eq(bookingsTable.registrationSource, "sponsor_staff"),
              or(eq(bookingsTable.status, "paid"), eq(bookingsTable.status, "invoiced")),
            ),
          );
        if (Number(usage?.active ?? 0) + existing.quantity > sponsor.staffAllocation) return null;
        const [row] = await tx
          .update(bookingsTable)
          .set({
            status: finalStatus as typeof existing.status,
            updatedAt: new Date(),
            ...statusUpdateOverrides,
          })
          .where(eq(bookingsTable.id, id))
          .returning();
        return row ?? null;
      });
      if (!restored) {
        res.status(409).json({
          error: "This sponsor's staff allocation is full, so the registration cannot be restored",
        });
        return;
      }
      updated = restored;
    } else {
      [updated] = await db
        .update(bookingsTable)
        .set({
          status: finalStatus as typeof existing.status,
          updatedAt: new Date(),
          ...statusUpdateOverrides,
        })
        .where(eq(bookingsTable.id, id))
        .returning();
    }
  } catch (error) {
    if (sponsorAllocationRestored) {
      await releaseSponsorRedemption(existing.id, "admin_restore_database_update_failed");
    }
    throw error;
  }

  if (
    typeof existing.sponsorId === "number" &&
    existing.registrationSource !== "sponsor_staff" &&
    activeStatuses.has(existing.status) &&
    terminalStatuses.has(finalStatus)
  ) {
    await releaseSponsorRedemption(existing.id, `admin_status_${finalStatus}`);
  }

  await logAdminAction({
    type: "admin_booking_status_changed",
    bookingId: id,
    summary: `Booking ${existing.orderReference || `#${id}`}: ${existing.status} → ${finalStatus}`,
    before: { status: existing.status },
    after: { status: finalStatus },
    meta: { stripeAction, requestedStatus: status },
  });

  res.json({ ...formatBooking(updated), stripeAction });
});

router.delete("/admin/registrations", adminAuth, async (req, res): Promise<void> => {
  const { ids } = req.body as { ids: number[] };

  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "ids must be a non-empty array of booking IDs" });
    return;
  }

  const numericIds = ids.map(Number).filter((n) => !isNaN(n) && n > 0);
  if (numericIds.length === 0) {
    res.status(400).json({ error: "No valid IDs provided" });
    return;
  }

  const refMap = new Map<number, string>();
  for (const bookingId of numericIds) {
    const [b] = await db
      .select({ orderReference: bookingsTable.orderReference })
      .from(bookingsTable)
      .where(eq(bookingsTable.id, bookingId));
    if (b?.orderReference) refMap.set(bookingId, b.orderReference);

    await db.delete(activityLogTable).where(eq(activityLogTable.bookingId, bookingId));
    const attendees = await db
      .select({ id: attendeesTable.id })
      .from(attendeesTable)
      .where(eq(attendeesTable.bookingId, bookingId));
    for (const a of attendees) {
      await db.delete(activityLogTable).where(eq(activityLogTable.attendeeId, a.id));
    }
    await db.delete(attendeesTable).where(eq(attendeesTable.bookingId, bookingId));
    await db.delete(bookingsTable).where(eq(bookingsTable.id, bookingId));
  }

  await logAdminAction({
    type: "admin_booking_deleted",
    summary: `Deleted ${numericIds.length} booking(s)`,
    meta: {
      bookingIds: numericIds,
      orderReferences: numericIds.map((id) => refMap.get(id) ?? null),
    },
  });

  res.json({ deleted: numericIds.length });
});

router.get("/admin/promo-codes", adminAuth, async (_req, res): Promise<void> => {
  const codes = await db.select().from(promoCodesTable).orderBy(desc(promoCodesTable.createdAt));
  res.json(codes.map(formatPromoCode));
});

router.post("/admin/promo-codes", adminAuth, async (req, res): Promise<void> => {
  const {
    code,
    discountType,
    discountValue,
    maxUses,
    validFrom,
    validUntil,
    isActive,
    description,
    applicablePassTypes,
    oncePerCustomer,
    minQuantity,
    maxDiscountAmount,
    internalNote,
  } = req.body;

  if (!code || !discountType || discountValue === undefined) {
    res.status(400).json({ error: "code, discountType, and discountValue are required" });
    return;
  }

  const passTypes: string[] =
    Array.isArray(applicablePassTypes) && applicablePassTypes.length > 0
      ? applicablePassTypes
      : ["single", "business"];

  const [promo] = await db
    .insert(promoCodesTable)
    .values({
      code: (code as string).toUpperCase(),
      discountType,
      discountValue: discountValue.toString(),
      maxUses: maxUses || null,
      validFrom: validFrom ? new Date(validFrom) : null,
      validUntil: validUntil ? new Date(validUntil) : null,
      isActive: isActive !== false,
      applicablePassTypes: passTypes,
      description: description || null,
      oncePerCustomer: oncePerCustomer === true,
      minQuantity: minQuantity ?? null,
      maxDiscountAmount:
        maxDiscountAmount !== undefined && maxDiscountAmount !== null
          ? maxDiscountAmount.toString()
          : null,
      internalNote: internalNote || null,
    })
    .returning();

  await logAdminAction({
    type: "admin_promo_created",
    summary: `Created promo code ${promo.code}`,
    after: {
      code: promo.code,
      discountType: promo.discountType,
      discountValue: promo.discountValue,
      maxUses: promo.maxUses,
      isActive: promo.isActive,
      applicablePassTypes: promo.applicablePassTypes,
    },
    meta: { promoId: promo.id },
  });

  res.status(201).json(formatPromoCode(promo));
});

router.patch("/admin/promo-codes/:id", adminAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);

  const [existing] = await db.select().from(promoCodesTable).where(eq(promoCodesTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Promo code not found" });
    return;
  }

  const {
    code,
    discountType,
    discountValue,
    maxUses,
    validFrom,
    validUntil,
    isActive,
    description,
    applicablePassTypes,
    oncePerCustomer,
    minQuantity,
    maxDiscountAmount,
    internalNote,
  } = req.body;

  const updateData: Partial<typeof promoCodesTable.$inferInsert> = {};
  if (code !== undefined) updateData.code = (code as string).toUpperCase();
  if (discountType !== undefined) updateData.discountType = discountType;
  if (discountValue !== undefined) updateData.discountValue = discountValue.toString();
  if (maxUses !== undefined) updateData.maxUses = maxUses;
  if (validFrom !== undefined) updateData.validFrom = validFrom ? new Date(validFrom) : null;
  if (validUntil !== undefined) updateData.validUntil = validUntil ? new Date(validUntil) : null;
  if (isActive !== undefined) updateData.isActive = isActive;
  if (description !== undefined) updateData.description = description;
  if (Array.isArray(applicablePassTypes) && applicablePassTypes.length > 0) {
    updateData.applicablePassTypes = applicablePassTypes;
  }
  if (oncePerCustomer !== undefined) updateData.oncePerCustomer = oncePerCustomer === true;
  if (minQuantity !== undefined) updateData.minQuantity = minQuantity;
  if (maxDiscountAmount !== undefined) {
    updateData.maxDiscountAmount = maxDiscountAmount === null ? null : maxDiscountAmount.toString();
  }
  if (internalNote !== undefined) updateData.internalNote = internalNote;

  const [updated] = await db
    .update(promoCodesTable)
    .set(updateData)
    .where(eq(promoCodesTable.id, id))
    .returning();

  await logAdminAction({
    type: "admin_promo_updated",
    summary: `Updated promo code ${updated.code}`,
    before: {
      code: existing.code,
      discountType: existing.discountType,
      discountValue: existing.discountValue,
      maxUses: existing.maxUses,
      isActive: existing.isActive,
      applicablePassTypes: existing.applicablePassTypes,
    },
    after: {
      code: updated.code,
      discountType: updated.discountType,
      discountValue: updated.discountValue,
      maxUses: updated.maxUses,
      isActive: updated.isActive,
      applicablePassTypes: updated.applicablePassTypes,
    },
    meta: { promoId: id },
  });

  res.json(formatPromoCode(updated));
});

router.delete("/admin/promo-codes/:id", adminAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);

  const [existing] = await db.select().from(promoCodesTable).where(eq(promoCodesTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Promo code not found" });
    return;
  }

  await db.delete(promoCodesTable).where(eq(promoCodesTable.id, id));
  await logAdminAction({
    type: "admin_promo_deleted",
    summary: `Deleted promo code ${existing.code}`,
    before: {
      code: existing.code,
      discountType: existing.discountType,
      isActive: existing.isActive,
    },
    meta: { promoId: id },
  });
  res.sendStatus(204);
});

router.put("/admin/discount-tiers", adminAuth, async (req, res): Promise<void> => {
  const { passType, tiers } = req.body;

  if (!passType || !Array.isArray(tiers)) {
    res.status(400).json({ error: "passType and tiers array are required" });
    return;
  }

  const existing = await db
    .select()
    .from(discountTiersTable)
    .where(eq(discountTiersTable.passType, passType));

  await db.delete(discountTiersTable).where(eq(discountTiersTable.passType, passType));

  const inserted = await db
    .insert(discountTiersTable)
    .values(
      tiers.map((tier: { minQuantity: number; discountPercent: number; label?: string }) => ({
        passType,
        minQuantity: tier.minQuantity,
        discountPercent: tier.discountPercent.toString(),
        label: tier.label || null,
      })),
    )
    .returning();

  await logAdminAction({
    type: "admin_discount_tiers_updated",
    summary: `Replaced ${existing.length} discount tier(s) for ${passType} with ${inserted.length}`,
    before: { tiers: existing.map(formatTier) },
    after: { tiers: inserted.map(formatTier) },
    meta: { passType },
  });

  res.json(inserted.map(formatTier));
});

router.get("/admin/passes/inventory", adminAuth, async (_req, res): Promise<void> => {
  const rows = await db.select().from(passInventoryTable);
  res.json(rows);
});

router.put("/admin/passes/inventory/:passType", adminAuth, async (req, res): Promise<void> => {
  const passType = req.params["passType"] as string;
  if (!["single", "business"].includes(passType)) {
    res.status(400).json({ error: "Invalid pass type" });
    return;
  }
  const { remaining } = req.body;
  const val = remaining === null || remaining === "" ? null : parseInt(remaining, 10);
  if (val !== null && (isNaN(val) || val < 0)) {
    res.status(400).json({ error: "remaining must be a non-negative integer or null" });
    return;
  }
  const [prev] = await db
    .select()
    .from(passInventoryTable)
    .where(eq(passInventoryTable.passType, passType));

  await db
    .insert(passInventoryTable)
    .values({ passType, remaining: val, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: passInventoryTable.passType,
      set: { remaining: val, updatedAt: new Date() },
    });
  const [row] = await db
    .select()
    .from(passInventoryTable)
    .where(eq(passInventoryTable.passType, passType));

  await logAdminAction({
    type: "admin_pass_inventory_updated",
    summary: `Set ${passType} pass inventory to ${val ?? "unlimited"}`,
    before: { remaining: prev?.remaining ?? null },
    after: { remaining: val },
    meta: { passType },
  });

  res.json(row);
});

router.get("/admin/notification-emails", adminAuth, async (_req, res): Promise<void> => {
  const emails = await db
    .select()
    .from(notificationEmailsTable)
    .orderBy(notificationEmailsTable.createdAt);
  res.json(
    emails.map((e) => ({
      ...e,
      createdAt: e.createdAt.toISOString(),
    })),
  );
});

router.post("/admin/notification-emails", adminAuth, async (req, res): Promise<void> => {
  const {
    email,
    label,
    notifyComplete,
    notifyIncomplete,
    notifyCheckoutExpired,
    notifyBillingEdit,
    notifySponsorAdmin,
    notifySponsorPasses,
    notifySponsorContent,
    notifySponsorDeadlines,
  } = req.body;
  if (!email || typeof email !== "string" || !email.includes("@")) {
    res.status(400).json({ error: "A valid email address is required" });
    return;
  }
  try {
    const [inserted] = await db
      .insert(notificationEmailsTable)
      .values({
        email: email.trim().toLowerCase(),
        label: label?.trim() || null,
        notifyComplete: notifyComplete !== false,
        notifyIncomplete: notifyIncomplete !== false,
        notifyCheckoutExpired: notifyCheckoutExpired === true,
        notifyBillingEdit: notifyBillingEdit !== false,
        notifySponsorAdmin: notifySponsorAdmin !== false,
        notifySponsorPasses: notifySponsorPasses !== false,
        notifySponsorContent: notifySponsorContent !== false,
        notifySponsorDeadlines: notifySponsorDeadlines !== false,
      })
      .returning();
    await logAdminAction({
      type: "admin_notification_email_added",
      summary: `Added notification email ${inserted.email}`,
      after: {
        email: inserted.email,
        label: inserted.label,
        notifyComplete: inserted.notifyComplete,
        notifyIncomplete: inserted.notifyIncomplete,
        notifyCheckoutExpired: inserted.notifyCheckoutExpired,
        notifyBillingEdit: inserted.notifyBillingEdit,
        notifySponsorAdmin: inserted.notifySponsorAdmin,
        notifySponsorPasses: inserted.notifySponsorPasses,
        notifySponsorContent: inserted.notifySponsorContent,
        notifySponsorDeadlines: inserted.notifySponsorDeadlines,
      },
      meta: { notificationEmailId: inserted.id },
    });
    res.status(201).json({ ...inserted, createdAt: inserted.createdAt.toISOString() });
  } catch {
    res.status(409).json({ error: "This email address is already in the list" });
  }
});

router.patch("/admin/notification-emails/:id", adminAuth, async (req, res): Promise<void> => {
  const id = parseInt(req.params["id"] as string, 10);
  const {
    notifyComplete,
    notifyIncomplete,
    notifyCheckoutExpired,
    notifyBillingEdit,
    notifySponsorAdmin,
    notifySponsorPasses,
    notifySponsorContent,
    notifySponsorDeadlines,
  } = req.body;
  const updates: Record<string, boolean> = {};
  if (typeof notifyComplete === "boolean") updates.notifyComplete = notifyComplete;
  if (typeof notifyIncomplete === "boolean") updates.notifyIncomplete = notifyIncomplete;
  if (typeof notifyCheckoutExpired === "boolean")
    updates.notifyCheckoutExpired = notifyCheckoutExpired;
  if (typeof notifyBillingEdit === "boolean") updates.notifyBillingEdit = notifyBillingEdit;
  if (typeof notifySponsorAdmin === "boolean") updates.notifySponsorAdmin = notifySponsorAdmin;
  if (typeof notifySponsorPasses === "boolean") updates.notifySponsorPasses = notifySponsorPasses;
  if (typeof notifySponsorContent === "boolean")
    updates.notifySponsorContent = notifySponsorContent;
  if (typeof notifySponsorDeadlines === "boolean")
    updates.notifySponsorDeadlines = notifySponsorDeadlines;
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }
  const [prev] = await db
    .select()
    .from(notificationEmailsTable)
    .where(eq(notificationEmailsTable.id, id));
  const [updated] = await db
    .update(notificationEmailsTable)
    .set(updates)
    .where(eq(notificationEmailsTable.id, id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await logAdminAction({
    type: "admin_notification_email_updated",
    summary: `Updated notification preferences for ${updated.email}`,
    before: prev
      ? {
          notifyComplete: prev.notifyComplete,
          notifyIncomplete: prev.notifyIncomplete,
          notifyCheckoutExpired: prev.notifyCheckoutExpired,
          notifyBillingEdit: prev.notifyBillingEdit,
          notifySponsorAdmin: prev.notifySponsorAdmin,
          notifySponsorPasses: prev.notifySponsorPasses,
          notifySponsorContent: prev.notifySponsorContent,
          notifySponsorDeadlines: prev.notifySponsorDeadlines,
        }
      : undefined,
    after: {
      notifyComplete: updated.notifyComplete,
      notifyIncomplete: updated.notifyIncomplete,
      notifyCheckoutExpired: updated.notifyCheckoutExpired,
      notifyBillingEdit: updated.notifyBillingEdit,
      notifySponsorAdmin: updated.notifySponsorAdmin,
      notifySponsorPasses: updated.notifySponsorPasses,
      notifySponsorContent: updated.notifySponsorContent,
      notifySponsorDeadlines: updated.notifySponsorDeadlines,
    },
    meta: { notificationEmailId: id },
  });
  res.json({ ...updated, createdAt: updated.createdAt.toISOString() });
});

router.delete("/admin/notification-emails/:id", adminAuth, async (req, res): Promise<void> => {
  const id = parseInt(req.params["id"] as string, 10);
  const [prev] = await db
    .select()
    .from(notificationEmailsTable)
    .where(eq(notificationEmailsTable.id, id));
  await db.delete(notificationEmailsTable).where(eq(notificationEmailsTable.id, id));
  await logAdminAction({
    type: "admin_notification_email_deleted",
    summary: prev
      ? `Removed notification email ${prev.email}`
      : `Removed notification email #${id}`,
    before: prev ? { email: prev.email, label: prev.label } : undefined,
    meta: { notificationEmailId: id },
  });
  res.status(204).end();
});

router.get("/admin/passes/config", adminAuth, async (_req, res): Promise<void> => {
  const rows = await db.select().from(passConfigTable);
  const result: Record<string, (typeof rows)[0] | null> = { single: null, business: null };
  for (const row of rows) {
    result[row.passType] = row;
  }
  res.json(result);
});

router.put("/admin/passes/config/:passType", adminAuth, async (req, res): Promise<void> => {
  const { passType } = req.params as { passType: string };
  if (!["single", "business"].includes(passType)) {
    res.status(400).json({ error: "Invalid pass type" });
    return;
  }
  const { currentPrice, originalPrice, pricingPeriodName, benefits, extraBenefits } = req.body;

  if (
    currentPrice !== undefined &&
    (isNaN(parseFloat(currentPrice)) || parseFloat(currentPrice) < 0)
  ) {
    res.status(400).json({ error: "Invalid current price" });
    return;
  }
  if (
    originalPrice !== undefined &&
    (isNaN(parseFloat(originalPrice)) || parseFloat(originalPrice) < 0)
  ) {
    res.status(400).json({ error: "Invalid original price" });
    return;
  }

  const updates: Partial<typeof passConfigTable.$inferInsert> = {};
  if (currentPrice !== undefined) updates.currentPrice = parseFloat(currentPrice).toFixed(2);
  if (originalPrice !== undefined) updates.originalPrice = parseFloat(originalPrice).toFixed(2);
  if (pricingPeriodName !== undefined) updates.pricingPeriodName = String(pricingPeriodName).trim();
  if (benefits !== undefined) updates.benefits = Array.isArray(benefits) ? benefits : [];
  if (extraBenefits !== undefined)
    updates.extraBenefits = Array.isArray(extraBenefits) ? extraBenefits : [];

  const defaultCurrentPrice = passType === "business" ? "499" : "249";
  const defaultOriginalPrice = passType === "business" ? "999" : "429";

  const [prev] = await db
    .select()
    .from(passConfigTable)
    .where(eq(passConfigTable.passType, passType));

  const [row] = await db
    .insert(passConfigTable)
    .values({
      passType,
      currentPrice: updates.currentPrice ?? defaultCurrentPrice,
      originalPrice: updates.originalPrice ?? defaultOriginalPrice,
      pricingPeriodName: updates.pricingPeriodName ?? "Super Early Bird",
      benefits: updates.benefits ?? [],
      extraBenefits: updates.extraBenefits ?? [],
    })
    .onConflictDoUpdate({
      target: passConfigTable.passType,
      set: updates,
    })
    .returning();

  await logAdminAction({
    type: "admin_pass_config_updated",
    summary: `Updated ${passType} pass config`,
    before: prev
      ? {
          currentPrice: prev.currentPrice,
          originalPrice: prev.originalPrice,
          pricingPeriodName: prev.pricingPeriodName,
        }
      : undefined,
    after: {
      currentPrice: row.currentPrice,
      originalPrice: row.originalPrice,
      pricingPeriodName: row.pricingPeriodName,
    },
    meta: { passType },
  });

  res.json(row);
});

// ──────────────────────────────────────────────────────────────────────────────
// Activity Feed
// ──────────────────────────────────────────────────────────────────────────────
router.get("/admin/activity", adminAuth, async (req, res): Promise<void> => {
  // 1a. Recent bookings (paid + invoiced), last 90 days
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const recentBookings = await db
    .select()
    .from(bookingsTable)
    .where(
      and(
        or(eq(bookingsTable.status, "paid"), eq(bookingsTable.status, "invoiced")),
        sql`${bookingsTable.createdAt} >= ${ninetyDaysAgo}`,
      ),
    )
    .orderBy(desc(bookingsTable.createdAt))
    .limit(100);

  // 1b. Partial checkouts (last 90 days)
  const partialBookings = await db
    .select()
    .from(bookingsTable)
    .where(
      and(eq(bookingsTable.status, "partial"), sql`${bookingsTable.createdAt} >= ${ninetyDaysAgo}`),
    )
    .orderBy(desc(bookingsTable.createdAt))
    .limit(100);

  // Lead attendees for partial bookings
  const partialBookingIds = partialBookings.map((b) => b.id);
  const partialLeads =
    partialBookingIds.length > 0
      ? await db
          .select()
          .from(attendeesTable)
          .where(eq(attendeesTable.isLead, true))
          .then((rows) => rows.filter((a) => partialBookingIds.includes(a.bookingId!)))
      : [];

  // 2. Attendee change log
  const changeLog = await db
    .select({
      log: activityLogTable,
      attendee: attendeesTable,
      booking: bookingsTable,
    })
    .from(activityLogTable)
    .leftJoin(attendeesTable, eq(activityLogTable.attendeeId, attendeesTable.id))
    .leftJoin(bookingsTable, eq(activityLogTable.bookingId, bookingsTable.id))
    .orderBy(desc(activityLogTable.createdAt))
    .limit(200);

  // 3. Email failures (last 30 days)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const emailFailures = await db
    .select()
    .from(emailLogsTable)
    .where(
      and(eq(emailLogsTable.status, "failed"), sql`${emailLogsTable.sentAt} >= ${thirtyDaysAgo}`),
    )
    .orderBy(desc(emailLogsTable.sentAt))
    .limit(50);

  // 4. Stats
  const [unpaidResult] = await db
    .select({ count: count() })
    .from(bookingsTable)
    .where(and(eq(bookingsTable.paymentMethod, "invoice"), eq(bookingsTable.status, "invoiced")));

  const [tbcResult] = await db
    .select({ count: count() })
    .from(attendeesTable)
    .where(eq(attendeesTable.isTbc, true));

  // 5. Bookings this calendar month
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const [monthResult] = await db
    .select({ count: count() })
    .from(bookingsTable)
    .where(
      and(
        or(eq(bookingsTable.status, "paid"), eq(bookingsTable.status, "invoiced")),
        sql`${bookingsTable.createdAt} >= ${startOfMonth}`,
      ),
    );

  // Build combined feed
  const feed: Array<{
    type: string;
    timestamp: string;
    booking?: ReturnType<typeof formatBooking> | null;
    attendee?: ReturnType<typeof formatAttendee> | null;
    data?: Record<string, unknown>;
    actor?: string;
  }> = [];

  for (const b of recentBookings) {
    const isInvoice = b.paymentMethod === "invoice";
    const isPaid = b.status === "paid";
    const type = isInvoice ? (isPaid ? "invoice_paid" : "invoice_overdue") : "new_booking_card";

    const isNew = Date.now() - b.createdAt.getTime() < 7 * 24 * 60 * 60 * 1000;
    const resolvedType =
      isInvoice && !isPaid
        ? isNew
          ? "new_booking_invoice"
          : b.invoiceDueDate && b.invoiceDueDate < new Date()
            ? "invoice_overdue"
            : "new_booking_invoice"
        : type;

    feed.push({
      type: resolvedType,
      timestamp: b.createdAt.toISOString(),
      booking: formatBooking(b),
    });
  }

  for (const b of partialBookings) {
    const lead = partialLeads.find((a) => a.bookingId === b.id);
    feed.push({
      type: "partial_checkout",
      timestamp: b.createdAt.toISOString(),
      booking: formatBooking(b),
      attendee: lead ? formatAttendee(lead) : null,
    });
  }

  for (const row of changeLog) {
    if (!row.log) continue;
    feed.push({
      type: row.log.type,
      timestamp: row.log.createdAt.toISOString(),
      booking: row.booking ? formatBooking(row.booking) : null,
      attendee: row.attendee ? formatAttendee(row.attendee) : null,
      data: (row.log.data as Record<string, unknown>) ?? undefined,
      actor: row.log.actor ?? undefined,
    });
  }

  for (const ef of emailFailures) {
    feed.push({
      type: "email_failure",
      timestamp: ef.sentAt.toISOString(),
      data: {
        emailType: ef.type,
        toEmail: ef.recipient,
        error: ef.errorMessage,
        bookingId: ef.bookingId,
      },
    });
  }

  // Sort combined feed by timestamp descending
  feed.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  // Unpaid invoice list (for the alert panel)
  const unpaidInvoiceList = await db
    .select()
    .from(bookingsTable)
    .where(and(eq(bookingsTable.paymentMethod, "invoice"), eq(bookingsTable.status, "invoiced")))
    .orderBy(bookingsTable.invoiceDueDate);

  res.json({
    feed: feed.slice(0, 200),
    stats: {
      unpaidInvoices: Number(unpaidResult?.count ?? 0),
      tbcAttendees: Number(tbcResult?.count ?? 0),
      emailFailures: emailFailures.length,
      totalThisMonth: Number(monthResult?.count ?? 0),
      partialCheckouts: partialBookings.length,
    },
    unpaidInvoiceList: unpaidInvoiceList.map(formatBooking),
  });
});

// ==================== UNPAID INVOICES DASHBOARD WIDGET ====================
//
// Aging buckets for the admin dashboard "Unpaid Invoices" widget. We measure
// "days outstanding" from the booking's createdAt — close enough to the actual
// invoice issue time for chasing purposes (a Stripe invoice is created within
// seconds of the booking flipping to `invoiced`).
//
// Buckets:
//   0-7   : freshly issued, no chasing needed yet
//   8-14  : approaching due date, gentle reminder appropriate
//   15+   : overdue (assumes standard 14-day terms) — bulk reminder allowed

type AgingBucket = "0-7" | "8-14" | "15+";

const BUCKET_VALUES: AgingBucket[] = ["0-7", "8-14", "15+"];

// Common SQL fragments — kept in one place so the summary, list, and bulk
// endpoints all use the exact same definition of "unpaid invoice" and the
// exact same bucket boundaries.
//
// daysOutstanding = floor((now - created_at) / 1 day). createdAt is a close
// proxy for invoice issue time (Stripe invoices are created seconds after
// the booking flips to `invoiced`), so we don't need a separate issue-date
// column.
const daysOutstandingSql = sql<number>`
    GREATEST(
      0,
      FLOOR(EXTRACT(EPOCH FROM (NOW() - ${bookingsTable.createdAt})) / 86400)
    )::int
  `;

const bucketSql = sql<AgingBucket>`
    CASE
      WHEN ${daysOutstandingSql} <= 7 THEN '0-7'
      WHEN ${daysOutstandingSql} <= 14 THEN '8-14'
      ELSE '15+'
    END
  `;

// Stripe-cached terminal states are excluded so paid/voided/uncollectible
// invoices never reappear in the widget even if booking.status hasn't been
// refreshed yet.
const unpaidInvoiceWhereSql = and(
  eq(bookingsTable.paymentMethod, "invoice"),
  eq(bookingsTable.status, "invoiced"),
  eq(bookingsTable.manualEntry, false),
  or(
    isNull(bookingsTable.stripeInvoiceStatus),
    notInArray(bookingsTable.stripeInvoiceStatus, ["paid", "void", "uncollectible"]),
  ),
);

router.get("/admin/unpaid-invoices/summary", adminAuth, async (_req, res): Promise<void> => {
  // Single aggregate query: COUNT + SUM grouped by the SQL CASE bucket.
  const grouped = await db
    .select({
      bucket: bucketSql,
      count: sql<number>`COUNT(*)::int`,
      totalAmount: sql<string>`COALESCE(SUM(${bookingsTable.totalAmount}), 0)::text`,
    })
    .from(bookingsTable)
    .where(unpaidInvoiceWhereSql)
    .groupBy(bucketSql);

  const buckets: Record<AgingBucket, { count: number; totalAmount: number }> = {
    "0-7": { count: 0, totalAmount: 0 },
    "8-14": { count: 0, totalAmount: 0 },
    "15+": { count: 0, totalAmount: 0 },
  };
  let totalUnpaid = 0;
  let totalOutstanding = 0;
  for (const row of grouped) {
    const b = row.bucket as AgingBucket;
    if (!buckets[b]) continue;
    const amt = parseFloat(row.totalAmount || "0");
    buckets[b] = { count: row.count, totalAmount: parseFloat(amt.toFixed(2)) };
    totalUnpaid += row.count;
    totalOutstanding += amt;
  }

  res.json({
    totalUnpaid,
    totalOutstanding: parseFloat(totalOutstanding.toFixed(2)),
    buckets,
  });
});

router.get("/admin/unpaid-invoices", adminAuth, async (req, res): Promise<void> => {
  const bucketFilter = req.query.bucket as AgingBucket | undefined;
  const page = Math.max(1, parseInt((req.query.page as string) || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || "25", 10)));
  const sortRaw = (req.query.sort as string) || "daysOutstanding";
  const order = (req.query.order as string) === "asc" ? "asc" : "desc";

  if (bucketFilter && !BUCKET_VALUES.includes(bucketFilter)) {
    res.status(400).json({ error: "Invalid bucket — must be one of 0-7, 8-14, 15+" });
    return;
  }

  // Whitelist sortable columns — never trust the raw query parameter as a
  // SQL identifier.
  const sortColumns = {
    daysOutstanding: bookingsTable.createdAt,
    totalAmount: bookingsTable.totalAmount,
    lastReminder: bookingsTable.lastInvoiceReminderSentAt,
    orderReference: bookingsTable.orderReference,
  } as const;
  const sortKey: keyof typeof sortColumns = (
    Object.keys(sortColumns) as Array<keyof typeof sortColumns>
  ).includes(sortRaw as keyof typeof sortColumns)
    ? (sortRaw as keyof typeof sortColumns)
    : "daysOutstanding";
  const sortColumn = sortColumns[sortKey];
  // For "daysOutstanding" the underlying column is createdAt and the relation
  // is inverted: more days ⇒ older createdAt ⇒ ascending createdAt.
  const dirFn =
    sortKey === "daysOutstanding" ? (order === "asc" ? desc : asc) : order === "asc" ? asc : desc;

  // Apply bucket filter at the DB layer using the same SQL CASE expression.
  const whereSql = bucketFilter
    ? and(unpaidInvoiceWhereSql, sql`${bucketSql} = ${bucketFilter}`)
    : unpaidInvoiceWhereSql;

  // Total count for pagination.
  const totalRow = await db
    .select({ c: sql<number>`COUNT(*)::int` })
    .from(bookingsTable)
    .where(whereSql);
  const total = totalRow[0]?.c ?? 0;

  // Paginated list with LEFT JOIN to the lead attendee (single SQL round trip).
  const offset = (page - 1) * limit;
  const rowsRaw = await db
    .select({
      id: bookingsTable.id,
      orderReference: bookingsTable.orderReference,
      billingEmail: bookingsTable.billingEmail,
      totalAmount: bookingsTable.totalAmount,
      createdAt: bookingsTable.createdAt,
      invoiceDueDate: bookingsTable.invoiceDueDate,
      lastInvoiceReminderSentAt: bookingsTable.lastInvoiceReminderSentAt,
      stripeInvoiceId: bookingsTable.stripeInvoiceId,
      stripeInvoiceStatus: bookingsTable.stripeInvoiceStatus,
      paidAt: bookingsTable.paidAt,
      status: bookingsTable.status,
      paymentMethod: bookingsTable.paymentMethod,
      daysOutstanding: daysOutstandingSql,
      bucket: bucketSql,
      leadFirst: attendeesTable.firstName,
      leadLast: attendeesTable.lastName,
      leadEmail: attendeesTable.workEmail,
    })
    .from(bookingsTable)
    .leftJoin(
      attendeesTable,
      and(eq(attendeesTable.bookingId, bookingsTable.id), eq(attendeesTable.isLead, true)),
    )
    .where(whereSql)
    .orderBy(dirFn(sortColumn), desc(bookingsTable.id))
    .limit(limit)
    .offset(offset);

  const rows = rowsRaw.map((r) => ({
    id: r.id,
    orderReference: r.orderReference,
    leadName: r.leadFirst && r.leadLast ? `${r.leadFirst} ${r.leadLast}` : null,
    billingEmail: r.billingEmail || r.leadEmail || null,
    totalAmount: parseFloat(r.totalAmount?.toString() || "0"),
    daysOutstanding: Number(r.daysOutstanding),
    bucket: r.bucket as AgingBucket,
    invoiceDueDate: r.invoiceDueDate ? r.invoiceDueDate.toISOString() : null,
    lastInvoiceReminderSentAt: r.lastInvoiceReminderSentAt
      ? r.lastInvoiceReminderSentAt.toISOString()
      : null,
    invoiceBadgeStatus: deriveInvoiceBadge({
      status: r.status,
      paymentMethod: r.paymentMethod,
      stripeInvoiceId: r.stripeInvoiceId,
      stripeInvoiceStatus: r.stripeInvoiceStatus,
      invoiceDueDate: r.invoiceDueDate,
      paidAt: r.paidAt,
    }),
  }));

  res.json({ rows, total, page, limit });
});

router.post("/admin/unpaid-invoices/bulk-remind", adminAuth, async (req, res): Promise<void> => {
  const bucket = req.body?.bucket as AgingBucket | undefined;
  // Only the 15+ bucket can be bulk-reminded — to avoid spamming customers who
  // just received their invoice. The UI enforces this too, but the backend is
  // the source of truth.
  if (bucket !== "15+") {
    res.status(400).json({ error: "Bulk reminders are only allowed for the 15+ days bucket" });
    return;
  }

  // Single SQL round trip — only fetch booking ids in the 15+ bucket.
  const targets = await db
    .select({ id: bookingsTable.id })
    .from(bookingsTable)
    .where(and(unpaidInvoiceWhereSql, sql`${bucketSql} = '15+'`));

  const { sendInvoiceReminder } = await import("../lib/email");
  let sent = 0;
  const failures: Array<{ bookingId: number; error: string }> = [];
  for (const b of targets) {
    try {
      await sendInvoiceReminder(b.id);
      sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      failures.push({ bookingId: b.id, error: message });
      logger.error({ err, bookingId: b.id }, "bulk-remind: failed to send reminder");
    }
  }

  await logAdminAction({
    type: "admin_invoice_reminder_sent",
    summary: `Bulk-sent invoice reminders to ${sent} of ${targets.length} 15+day overdue bookings`,
    meta: { bucket, attempted: targets.length, sent, failed: failures.length },
  });

  res.json({
    success: true,
    attempted: targets.length,
    sent,
    failed: failures.length,
    failures,
  });
});

export default router;
