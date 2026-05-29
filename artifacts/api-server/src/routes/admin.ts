import { Router, type IRouter } from "express";
import { eq, desc, asc, or, and, sql, count, notInArray, isNull } from "drizzle-orm";
import ExcelJS from "exceljs";
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
import { getStripe } from "../lib/stripe-client";

const router: IRouter = Router();

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
  const partial = allBookings.filter((b) => b.status === "partial");

  const totalRevenue = completed.reduce(
    (sum, b) => sum + parseFloat(b.totalAmount?.toString() || "0"),
    0,
  );
  const totalVat = completed.reduce(
    (sum, b) => sum + parseFloat(b.vatAmount?.toString() || "0"),
    0,
  );

  const passCounts = {
    single: completed.filter((b) => b.passType === "single").length,
    business: completed.filter((b) => b.passType === "business").length,
  };

  const paymentMethodCounts = {
    card: completed.filter((b) => b.paymentMethod === "card").length,
    invoice: completed.filter((b) => b.paymentMethod === "invoice").length,
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
    completedRegistrations: completed.length,
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
    const searchLower = search.toLowerCase();
    const matchingAttendeeBookingIds = allAttendees
      .filter(
        (a) =>
          a.firstName.toLowerCase().includes(searchLower) ||
          a.lastName.toLowerCase().includes(searchLower) ||
          a.workEmail.toLowerCase().includes(searchLower) ||
          a.company.toLowerCase().includes(searchLower),
      )
      .map((a) => a.bookingId);

    filtered = filtered.filter(
      (b) =>
        matchingAttendeeBookingIds.includes(b.id) ||
        (b.orderReference && b.orderReference.toLowerCase().includes(searchLower)),
    );
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
    const bookingAttendees = allAttendees
      .filter((a) => a.bookingId === booking.id)
      .sort((a, b) => (a.seatIndex ?? 0) - (b.seatIndex ?? 0));

    if (bookingAttendees.length === 0) {
      sheet.addRow({
        bookingRef: booking.orderReference || "",
        status: booking.status,
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
        gdpr: "",
        registeredAt: booking.createdAt.toISOString(),
      });
      continue;
    }

    for (const a of bookingAttendees) {
      const row = sheet.addRow({
        bookingRef: booking.orderReference || "",
        status: booking.status,
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
        gdpr: a.isTbc ? "" : a.gdprConsent ? "Yes" : "No",
        registeredAt: booking.createdAt.toISOString(),
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

router.patch("/admin/registrations/:id/status", adminAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const { status } = req.body as { status: string };

  const allowed = [
    "paid",
    "invoiced",
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

  let finalStatus = status;
  let stripeAction: "refund_issued" | "invoice_voided" | "skipped" | "failed" = "skipped";

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

  const [updated] = await db
    .update(bookingsTable)
    .set({ status: finalStatus as typeof existing.status, updatedAt: new Date() })
    .where(eq(bookingsTable.id, id))
    .returning();

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
  const { email, label, notifyComplete, notifyIncomplete, notifyBillingEdit } = req.body;
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
        notifyBillingEdit: notifyBillingEdit !== false,
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
        notifyBillingEdit: inserted.notifyBillingEdit,
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
  const { notifyComplete, notifyIncomplete, notifyBillingEdit } = req.body;
  const updates: Record<string, boolean> = {};
  if (typeof notifyComplete === "boolean") updates.notifyComplete = notifyComplete;
  if (typeof notifyIncomplete === "boolean") updates.notifyIncomplete = notifyIncomplete;
  if (typeof notifyBillingEdit === "boolean") updates.notifyBillingEdit = notifyBillingEdit;
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
          notifyBillingEdit: prev.notifyBillingEdit,
        }
      : undefined,
    after: {
      notifyComplete: updated.notifyComplete,
      notifyIncomplete: updated.notifyIncomplete,
      notifyBillingEdit: updated.notifyBillingEdit,
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

  const [prev] = await db
    .select()
    .from(passConfigTable)
    .where(eq(passConfigTable.passType, passType));

  const [row] = await db
    .insert(passConfigTable)
    .values({
      passType,
      currentPrice: updates.currentPrice ?? "199",
      originalPrice: updates.originalPrice ?? "429",
      pricingPeriodName: updates.pricingPeriodName ?? "Early Bird",
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
