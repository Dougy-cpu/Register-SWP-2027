import { Router, type IRouter } from "express";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import { bookingsTable, attendeesTable, eventSettingsTable } from "@workspace/db";
import { calculatePricing, incrementPromoUsage } from "../lib/pricing";
import { DEFAULT_REF_PREFIX, DEFAULT_REF_OFFSET } from "../lib/order-reference";
import { promoCodesTable } from "@workspace/db";
import { isCodeUsedByEmail } from "./promo-codes";
import { v4 as uuidv4 } from "uuid";
import { verifyAdminToken, getAdminPassword } from "../middleware/admin-auth";
import { logAdminAction } from "../lib/audit";
import {
  sendIncompleteFormNotification,
  sendReissuedInvoiceEmail,
  sendBillingEditNotification,
  diffBillingFields,
  getEventSettings,
  resolveLatestBookingPdf,
  resendConfirmationAndReceipt,
} from "../lib/email";
import { runConfirmationSideEffects } from "../lib/booking-confirmation";
import { logger } from "../lib/logger";
import {
  reissueBookingInvoice,
  applyReissueInvoiceResultTx,
  getStripeInvoiceStatus,
  refreshStripeInvoiceStatusIfStale,
  refreshStripeInvoiceUrls,
} from "../lib/invoice";
import { deriveInvoiceBadge } from "../lib/invoice-status";
import { getStripe } from "../lib/stripe-client";

function isAdminRequest(req: import("express").Request): boolean {
  const token = req.headers["x-admin-token"] as string | undefined;
  if (!token) return false;
  const password = getAdminPassword();
  if (!password) return false;
  return verifyAdminToken(token, password).valid;
}

const router: IRouter = Router();

async function generateOrderRef(bookingId?: number): Promise<string> {
  const [settings] = await db
    .select({
      refPrefix: eventSettingsTable.refPrefix,
      refOffset: eventSettingsTable.refOffset,
    })
    .from(eventSettingsTable)
    .limit(1);
  const prefix = settings?.refPrefix ?? DEFAULT_REF_PREFIX;
  const offset = settings?.refOffset ?? DEFAULT_REF_OFFSET;
  if (bookingId) {
    return `${prefix}-${offset + bookingId}`;
  }
  return `${prefix}-${offset + Math.floor(10000 + Math.random() * 90000)}`;
}

function formatBooking(b: typeof bookingsTable.$inferSelect) {
  return {
    ...b,
    subtotalAmount: parseFloat(b.subtotalAmount?.toString() || "0"),
    vatAmount: parseFloat(b.vatAmount?.toString() || "0"),
    totalAmount: parseFloat(b.totalAmount?.toString() || "0"),
    promoDiscountAmount: b.promoDiscountAmount
      ? parseFloat(b.promoDiscountAmount.toString())
      : null,
    groupDiscountAmount: b.groupDiscountAmount
      ? parseFloat(b.groupDiscountAmount.toString())
      : null,
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

router.post("/bookings", async (req, res): Promise<void> => {
  const { sessionToken, passType, attendeeType, quantity = 1, currentStep = 1 } = req.body;

  if (!sessionToken || !passType || !attendeeType) {
    res.status(400).json({ error: "sessionToken, passType, and attendeeType are required" });
    return;
  }

  if (!Number.isInteger(quantity) || quantity <= 0) {
    res.status(400).json({ error: "quantity must be a positive integer" });
    return;
  }

  const existing = await db
    .select()
    .from(bookingsTable)
    .where(eq(bookingsTable.sessionToken, sessionToken));

  if (existing.length > 0) {
    const pricing = await calculatePricing(passType, quantity);
    const [updated] = await db
      .update(bookingsTable)
      .set({
        passType,
        attendeeType,
        quantity,
        subtotalAmount: pricing.subtotalAfterDiscounts.toString(),
        vatAmount: pricing.vatAmount.toString(),
        totalAmount: pricing.total.toString(),
        groupDiscountAmount:
          pricing.groupDiscountAmount > 0 ? pricing.groupDiscountAmount.toString() : null,
        currentStep: Math.max(currentStep, existing[0].currentStep),
      })
      .where(eq(bookingsTable.id, existing[0].id))
      .returning();
    res.status(201).json(formatBooking(updated));
    return;
  }

  const pricing = await calculatePricing(passType, quantity);

  const [booking] = await db
    .insert(bookingsTable)
    .values({
      sessionToken,
      passType,
      attendeeType,
      quantity,
      status: "partial",
      subtotalAmount: pricing.subtotalAfterDiscounts.toString(),
      vatAmount: pricing.vatAmount.toString(),
      totalAmount: pricing.total.toString(),
      groupDiscountAmount:
        pricing.groupDiscountAmount > 0 ? pricing.groupDiscountAmount.toString() : null,
      currentStep,
      managementToken: uuidv4(),
    })
    .returning();

  res.status(201).json(formatBooking(booking));
});

router.post("/bookings/start", async (req, res): Promise<void> => {
  const {
    sessionToken,
    attendeeType,
    passType = "single",
    quantity = 1,
    firstName,
    lastName,
    jobTitle,
    company,
    workEmail,
    phone,
    gdprConsent,
    currentStep = 2,
  } = req.body;

  if (
    !sessionToken ||
    !attendeeType ||
    !firstName ||
    !lastName ||
    !jobTitle ||
    !company ||
    !workEmail
  ) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  if (!Number.isInteger(quantity) || quantity <= 0) {
    res.status(400).json({ error: "quantity must be a positive integer" });
    return;
  }

  const requestedCurrentStep =
    Number.isInteger(currentStep) && currentStep >= 1 && currentStep <= 2 ? currentStep : 2;

  const [existing] = await db
    .select()
    .from(bookingsTable)
    .where(eq(bookingsTable.sessionToken, sessionToken));

  const pricing = await calculatePricing(passType, quantity);
  const gdprConsentAt = gdprConsent ? new Date() : null;
  const managementToken = uuidv4();

  const { finalBooking } = await db.transaction(async (tx) => {
    let bookingId: number;

    if (existing) {
      const [updated] = await tx
        .update(bookingsTable)
        .set({
          passType,
          attendeeType,
          quantity,
          subtotalAmount: pricing.subtotalAfterDiscounts.toString(),
          vatAmount: pricing.vatAmount.toString(),
          totalAmount: pricing.total.toString(),
          groupDiscountAmount:
            pricing.groupDiscountAmount > 0 ? pricing.groupDiscountAmount.toString() : null,
          currentStep: Math.max(requestedCurrentStep, existing.currentStep),
        })
        .where(eq(bookingsTable.id, existing.id))
        .returning();
      bookingId = updated.id;
    } else {
      const [created] = await tx
        .insert(bookingsTable)
        .values({
          sessionToken,
          passType,
          attendeeType,
          quantity,
          status: "partial",
          subtotalAmount: pricing.subtotalAfterDiscounts.toString(),
          vatAmount: pricing.vatAmount.toString(),
          totalAmount: pricing.total.toString(),
          groupDiscountAmount:
            pricing.groupDiscountAmount > 0 ? pricing.groupDiscountAmount.toString() : null,
          currentStep: requestedCurrentStep,
          managementToken,
        })
        .returning();
      bookingId = created.id;
    }

    const [existingAttendee] = existing
      ? await tx
          .select()
          .from(attendeesTable)
          .where(and(eq(attendeesTable.bookingId, bookingId), eq(attendeesTable.isLead, true)))
      : [undefined];

    let attendee: typeof attendeesTable.$inferSelect;

    if (existingAttendee) {
      const [updated] = await tx
        .update(attendeesTable)
        .set({
          firstName,
          lastName,
          jobTitle,
          company,
          workEmail,
          phone: phone || null,
          gdprConsent: gdprConsent ?? false,
          gdprConsentAt,
        })
        .where(eq(attendeesTable.id, existingAttendee.id))
        .returning();
      attendee = updated;
    } else {
      const [created] = await tx
        .insert(attendeesTable)
        .values({
          bookingId,
          isLead: true,
          firstName,
          lastName,
          jobTitle,
          company,
          workEmail,
          phone: phone || null,
          gdprConsent: gdprConsent ?? false,
          gdprConsentAt,
          seatIndex: 0,
        })
        .returning();
      attendee = created;
    }

    const [finalBooking] = await tx
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, bookingId));

    return { finalBooking, attendee };
  });

  const allAttendees = await db
    .select()
    .from(attendeesTable)
    .where(eq(attendeesTable.bookingId, finalBooking.id));

  res.status(existing ? 200 : 201).json({
    ...formatBooking(finalBooking),
    attendees: allAttendees.map(formatAttendee),
  });
});

router.get("/bookings/by-session/:sessionToken", async (req, res): Promise<void> => {
  const { sessionToken } = req.params;
  const [initial] = await db
    .select()
    .from(bookingsTable)
    .where(eq(bookingsTable.sessionToken, sessionToken));

  if (!initial) {
    res.json(null);
    return;
  }

  // Live re-poll Stripe if our cached invoice status is stale (or unset) so the
  // Confirmation page badge reflects reality even if the webhook hasn't fired yet.
  await refreshStripeInvoiceStatusIfStale(getStripe(), initial.id);

  const [[booking], attendees] = await Promise.all([
    db.select().from(bookingsTable).where(eq(bookingsTable.id, initial.id)),
    db.select().from(attendeesTable).where(eq(attendeesTable.bookingId, initial.id)),
  ]);

  res.json({
    ...formatBooking(booking),
    attendees: attendees.map(formatAttendee),
  });
});

router.get("/bookings/by-management-token/:token", async (req, res): Promise<void> => {
  const { token } = req.params;

  const [initial] = await db
    .select()
    .from(bookingsTable)
    .where(eq(bookingsTable.managementToken, token));

  if (!initial) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }

  // Live re-poll Stripe if our cached invoice status is stale (or unset). Errors are
  // swallowed so a Stripe blip doesn't break the page.
  await refreshStripeInvoiceStatusIfStale(getStripe(), initial.id);

  const [[booking], attendees, settingsRows] = await Promise.all([
    db.select().from(bookingsTable).where(eq(bookingsTable.id, initial.id)),
    db.select().from(attendeesTable).where(eq(attendeesTable.bookingId, initial.id)),
    db.select().from(eventSettingsTable).limit(1),
  ]);

  const settings = settingsRows[0];
  const changesLocked = settings?.attendeeChangesLocked ?? false;
  const lockedMessage = settings?.attendeeChangesLockedMessage ?? null;

  res.json({
    ...formatBooking(booking),
    attendees: attendees.map(formatAttendee),
    changesLocked,
    lockedMessage,
  });
});

router.get("/bookings/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);

  const [initial] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, id));
  if (!initial) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }

  const sessionHeader = req.headers["x-booking-session"] as string | undefined;
  const ownsBooking =
    sessionHeader && initial.sessionToken && sessionHeader === initial.sessionToken;
  if (!ownsBooking && !isAdminRequest(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  // Live re-poll Stripe if our cached invoice status is stale (or unset).
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

router.patch("/bookings/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);

  const [existing] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }

  const admin = isAdminRequest(req);

  if (!admin) {
    const sessionToken = req.headers["x-booking-session"] as string | undefined;
    if (!sessionToken || sessionToken !== existing.sessionToken) {
      res.status(403).json({ error: "Forbidden — session token mismatch" });
      return;
    }
  }

  const {
    passType,
    attendeeType,
    quantity,
    promoCode,
    hearAboutUs,
    paymentMethod,
    currentStep,
    billingName,
    billingCompany,
    billingEmail,
    billingAddress,
    billingAddressLine1,
    billingAddressLine2,
    billingTown,
    billingRegion,
    billingPostcode,
    billingCountry,
    billingPhone,
    billingVatNumber,
    poNumber,
    // status is admin/webhook-only — excluded from public PATCH body
    status,
  } = req.body;

  const newPassType = passType ?? existing.passType;
  const newQuantity = quantity ?? existing.quantity;

  if (!Number.isInteger(newQuantity) || newQuantity <= 0) {
    res.status(400).json({ error: "quantity must be a positive integer" });
    return;
  }
  const newPromoCode =
    promoCode !== undefined ? (promoCode ? promoCode.toUpperCase() : null) : existing.promoCode;

  const pricing = await calculatePricing(newPassType, newQuantity, newPromoCode);

  const updateData: Partial<typeof bookingsTable.$inferInsert> = {
    subtotalAmount: pricing.subtotalAfterDiscounts.toString(),
    vatAmount: pricing.vatAmount.toString(),
    totalAmount: pricing.total.toString(),
    groupDiscountAmount:
      pricing.groupDiscountAmount > 0 ? pricing.groupDiscountAmount.toString() : null,
    promoDiscountAmount:
      pricing.promoDiscountAmount > 0 ? pricing.promoDiscountAmount.toString() : null,
  };

  if (passType !== undefined) updateData.passType = passType;
  if (attendeeType !== undefined) updateData.attendeeType = attendeeType;
  if (quantity !== undefined) updateData.quantity = quantity;
  if (promoCode !== undefined) updateData.promoCode = promoCode ? promoCode.toUpperCase() : null;
  if (paymentMethod !== undefined) updateData.paymentMethod = paymentMethod;
  if (currentStep !== undefined) updateData.currentStep = currentStep;
  if (billingName !== undefined) updateData.billingName = billingName;
  if (billingCompany !== undefined) updateData.billingCompany = billingCompany;
  if (billingEmail !== undefined) updateData.billingEmail = billingEmail;
  if (billingAddress !== undefined) updateData.billingAddress = billingAddress;
  if (billingAddressLine1 !== undefined) updateData.billingAddressLine1 = billingAddressLine1;
  if (billingAddressLine2 !== undefined) updateData.billingAddressLine2 = billingAddressLine2;
  if (billingTown !== undefined) updateData.billingTown = billingTown;
  if (billingRegion !== undefined) updateData.billingRegion = billingRegion;
  if (billingPostcode !== undefined) updateData.billingPostcode = billingPostcode;
  if (billingCountry !== undefined) updateData.billingCountry = billingCountry;
  if (billingPhone !== undefined) updateData.billingPhone = billingPhone || null;
  if (billingVatNumber !== undefined) updateData.billingVatNumber = billingVatNumber || null;
  if (poNumber !== undefined) updateData.poNumber = (poNumber ?? "").toString().trim() || null;
  if (hearAboutUs !== undefined) updateData.hearAboutUs = hearAboutUs || null;

  // Only admin requests may mutate status
  if (admin && status !== undefined) {
    updateData.status = status;
    if ((status === "paid" || status === "invoiced") && !existing.orderReference) {
      updateData.orderReference = await generateOrderRef(id);
    }
  }

  const [updated] = await db
    .update(bookingsTable)
    .set(updateData)
    .where(eq(bookingsTable.id, id))
    .returning();

  // If admin edited billing/PO on an invoice booking that already has a Stripe
  // invoice, re-issue it so the customer gets an updated PDF/email.
  let reissueResult: { reissued?: boolean; alreadyPaid?: boolean; error?: string } = {};
  const billingTouched =
    billingName !== undefined ||
    billingCompany !== undefined ||
    billingEmail !== undefined ||
    billingAddressLine1 !== undefined ||
    billingAddressLine2 !== undefined ||
    billingTown !== undefined ||
    billingRegion !== undefined ||
    billingPostcode !== undefined ||
    billingCountry !== undefined ||
    billingPhone !== undefined ||
    billingVatNumber !== undefined ||
    poNumber !== undefined;

  if (admin && billingTouched && updated.paymentMethod === "invoice" && updated.stripeInvoiceId) {
    const stripe = getStripe();
    if (stripe) {
      try {
        const result = await reissueBookingInvoice(stripe, id);
        // Persist the new invoice metadata (or paid flip) inside a tx so the
        // booking-row write is atomic.
        await db.transaction(async (tx) => {
          await applyReissueInvoiceResultTx(tx, id, result);
        });
        reissueResult = result.alreadyPaid ? { alreadyPaid: true } : { reissued: true };
        if (!result.alreadyPaid) {
          try {
            await sendReissuedInvoiceEmail(id);
          } catch (err) {
            logger.error({ err }, "Failed to send re-issued invoice email");
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Re-issue failed";
        reissueResult = { error: message };
        logger.error({ err, bookingId: id }, "Failed to re-issue invoice after admin edit");
      }
    }
  }

  const [refreshed] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, id));

  if (admin) {
    const trackedKeys = Object.keys(updateData) as Array<keyof typeof updateData>;
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const k of trackedKeys) {
      before[k] = (existing as unknown as Record<string, unknown>)[k] ?? null;
      after[k] = (refreshed as unknown as Record<string, unknown>)[k] ?? null;
    }
    await logAdminAction({
      type: "admin_booking_updated",
      bookingId: id,
      summary: `Admin edited booking ${existing.orderReference || `#${id}`}`,
      before,
      after,
      meta: { reissue: reissueResult },
    });
  }

  res.json({ ...formatBooking(refreshed), reissue: reissueResult });
});

// ----- Self-serve billing/PO management (token-authed) -----

router.get("/bookings/by-management-token/:token/billing", async (req, res): Promise<void> => {
  const { token } = req.params;
  const [booking] = await db
    .select()
    .from(bookingsTable)
    .where(eq(bookingsTable.managementToken, token));
  if (!booking) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }

  let alreadyPaid = booking.status === "paid";
  if (!alreadyPaid && booking.stripeInvoiceId) {
    const stripe = getStripe();
    if (stripe) {
      const { paid } = await getStripeInvoiceStatus(stripe, booking.stripeInvoiceId);
      if (paid) {
        alreadyPaid = true;
        await db
          .update(bookingsTable)
          .set({ status: "paid" })
          .where(eq(bookingsTable.id, booking.id));
      }
    }
  }

  const settings = await getEventSettings();
  const locked = !!settings?.attendeeChangesLocked;
  const lockedMessage = settings?.attendeeChangesLockedMessage ?? null;

  res.json({
    id: booking.id,
    orderReference: booking.orderReference,
    paymentMethod: booking.paymentMethod,
    status: alreadyPaid ? "paid" : booking.status,
    alreadyPaid,
    locked,
    lockedMessage,
    billingName: booking.billingName,
    billingCompany: booking.billingCompany,
    billingEmail: booking.billingEmail,
    billingAddressLine1: booking.billingAddressLine1,
    billingAddressLine2: booking.billingAddressLine2,
    billingTown: booking.billingTown,
    billingRegion: booking.billingRegion,
    billingPostcode: booking.billingPostcode,
    billingCountry: booking.billingCountry,
    billingPhone: booking.billingPhone,
    billingVatNumber: booking.billingVatNumber,
    poNumber: booking.poNumber,
    stripeInvoicePaymentUrl: booking.stripeInvoicePaymentUrl,
    stripeInvoicePdfUrl: booking.stripeInvoicePdfUrl,
  });
});

router.post("/bookings/by-management-token/:token/billing", async (req, res): Promise<void> => {
  const { token } = req.params;
  const [booking] = await db
    .select()
    .from(bookingsTable)
    .where(eq(bookingsTable.managementToken, token));
  if (!booking) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }
  if (booking.paymentMethod !== "invoice") {
    res.status(400).json({ error: "Billing details can only be edited for invoice bookings" });
    return;
  }

  // Lock check — once admin freezes attendee/booking edits, billing edits are locked too
  const settings = await getEventSettings();
  if (settings?.attendeeChangesLocked) {
    res.status(423).json({
      error:
        settings.attendeeChangesLockedMessage ||
        "Booking edits are currently locked. Please contact us.",
      locked: true,
    });
    return;
  }

  // Pre-flight paid check BEFORE any DB writes — catches Stripe-side payments
  // that have not yet been webhooked into our DB.
  if (booking.status === "paid") {
    res.status(409).json({ error: "Invoice has already been paid", alreadyPaid: true });
    return;
  }
  if (booking.stripeInvoiceId) {
    const stripe = getStripe();
    if (stripe) {
      const { paid } = await getStripeInvoiceStatus(stripe, booking.stripeInvoiceId);
      if (paid) {
        await db
          .update(bookingsTable)
          .set({ status: "paid" })
          .where(eq(bookingsTable.id, booking.id));
        res.status(409).json({ error: "Invoice has already been paid", alreadyPaid: true });
        return;
      }
    }
  }

  const {
    poNumber,
    billingName,
    billingCompany,
    billingEmail,
    billingAddressLine1,
    billingAddressLine2,
    billingTown,
    billingRegion,
    billingPostcode,
    billingCountry,
    billingPhone,
    billingVatNumber,
  } = req.body ?? {};

  const updates: Partial<typeof bookingsTable.$inferInsert> = {};
  if (poNumber !== undefined) updates.poNumber = (poNumber ?? "").toString().trim() || null;
  if (billingName !== undefined) updates.billingName = billingName || null;
  if (billingCompany !== undefined) updates.billingCompany = billingCompany || null;
  if (billingEmail !== undefined) updates.billingEmail = billingEmail || null;
  if (billingAddressLine1 !== undefined) updates.billingAddressLine1 = billingAddressLine1 || null;
  if (billingAddressLine2 !== undefined) updates.billingAddressLine2 = billingAddressLine2 || null;
  if (billingTown !== undefined) updates.billingTown = billingTown || null;
  if (billingRegion !== undefined) updates.billingRegion = billingRegion || null;
  if (billingPostcode !== undefined) updates.billingPostcode = billingPostcode || null;
  if (billingCountry !== undefined) updates.billingCountry = billingCountry || null;
  if (billingPhone !== undefined) updates.billingPhone = billingPhone || null;
  if (billingVatNumber !== undefined) updates.billingVatNumber = billingVatNumber || null;

  if (Object.keys(updates).length > 0) {
    await db.update(bookingsTable).set(updates).where(eq(bookingsTable.id, booking.id));
  }

  // Diff old vs new billing fields BEFORE the re-issue step so the organiser
  // notification reflects exactly what the customer changed (rather than any
  // post-reissue Stripe-driven rewrites).
  const [postUpdate] = await db
    .select()
    .from(bookingsTable)
    .where(eq(bookingsTable.id, booking.id));
  const billingChanges = diffBillingFields(
    booking as unknown as Record<string, unknown>,
    postUpdate as unknown as Record<string, unknown>,
  );

  // Re-issue the Stripe invoice (if any) so the PO + new billing details show.
  let reissue: { alreadyPaid?: boolean; reissued?: boolean; error?: string } = {};
  if (booking.stripeInvoiceId) {
    const stripe = getStripe();
    if (!stripe) {
      reissue = { error: "Stripe is not configured" };
    } else {
      try {
        const result = await reissueBookingInvoice(stripe, booking.id);
        await db.transaction(async (tx) => {
          await applyReissueInvoiceResultTx(tx, booking.id, result);
        });
        if (result.alreadyPaid) {
          reissue = { alreadyPaid: true };
        } else {
          reissue = { reissued: true };
          try {
            await sendReissuedInvoiceEmail(booking.id);
          } catch (err) {
            logger.error({ err }, "Failed to send re-issued invoice email");
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to re-issue invoice";
        reissue = { error: message };
        logger.error(
          { err, bookingId: booking.id },
          "Failed to re-issue invoice on self-serve billing edit",
        );
      }
    }
  }

  const [refreshed] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, booking.id));

  // Fire-and-forget organiser notification (best-effort; never block the
  // customer-facing response on email delivery). Honours notifyBillingEdit
  // opt-in flags on notificationEmailsTable.
  if (billingChanges.length > 0) {
    sendBillingEditNotification(booking.id, billingChanges).catch((err) => {
      logger.error(
        { err, bookingId: booking.id },
        "Failed to send billing-edit organiser notification",
      );
    });
  }

  res.json({
    ok: true,
    reissue,
    poNumber: refreshed.poNumber,
    status: refreshed.status,
    stripeInvoicePaymentUrl: refreshed.stripeInvoicePaymentUrl,
    stripeInvoicePdfUrl: refreshed.stripeInvoicePdfUrl,
  });
});

// ----- Self-serve invoice/receipt download + email re-send (token-authed) -----

// Per-token in-memory rate limit: at most 1 re-send per RESEND_WINDOW_MS.
// In-memory is fine here because (a) management tokens are stable per booking
// and (b) the worst case of a process restart bypassing the limit is a
// single extra email, which is acceptable spam protection for a self-serve
// action.
const RESEND_WINDOW_MS = 60_000;
const resendLastSentAt = new Map<string, number>();

router.get("/bookings/by-management-token/:token/invoice-pdf", async (req, res): Promise<void> => {
  const { token } = req.params;
  const [booking] = await db
    .select()
    .from(bookingsTable)
    .where(eq(bookingsTable.managementToken, token));
  if (!booking) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }
  if (booking.status !== "invoiced" && booking.status !== "paid") {
    res.status(409).json({ error: "No invoice available yet for this booking" });
    return;
  }
  // Refresh Stripe-cached fields so we always serve the latest PDF (e.g.
  // immediately after a re-issue) without waiting for the webhook.
  if (booking.stripeInvoiceId) {
    await refreshStripeInvoiceUrls(getStripe(), booking.id);
  }

  const pdf = await resolveLatestBookingPdf(booking.id);
  if (!pdf) {
    res.status(500).json({ error: "Could not generate invoice PDF" });
    return;
  }
  const safeName = pdf.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
  res.setHeader("Content-Length", pdf.buffer.length.toString());
  res.setHeader("Cache-Control", "private, no-store");
  res.send(pdf.buffer);
});

router.post(
  "/bookings/by-management-token/:token/resend-email",
  async (req, res): Promise<void> => {
    const { token } = req.params;
    const [booking] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.managementToken, token));
    if (!booking) {
      res.status(404).json({ error: "Booking not found" });
      return;
    }
    if (booking.status !== "invoiced" && booking.status !== "paid") {
      res.status(409).json({ error: "No confirmation email available yet for this booking" });
      return;
    }

    const now = Date.now();
    const last = resendLastSentAt.get(token) ?? 0;
    const elapsed = now - last;
    if (elapsed < RESEND_WINDOW_MS) {
      const retryAfter = Math.ceil((RESEND_WINDOW_MS - elapsed) / 1000);
      res.setHeader("Retry-After", retryAfter.toString());
      res.status(429).json({
        error: `Please wait ${retryAfter}s before requesting another email.`,
        retryAfter,
      });
      return;
    }
    // Set the timestamp BEFORE awaiting send so concurrent requests are
    // throttled even if the send is slow. If the send ultimately fails we
    // clear the entry below so the customer isn't punished for our error.
    resendLastSentAt.set(token, now);

    // Make sure any freshly re-issued Stripe invoice URL/status is reflected
    // before the email is built, so the attachment matches what /invoice-pdf
    // would serve.
    if (booking.stripeInvoiceId) {
      await refreshStripeInvoiceUrls(getStripe(), booking.id);
    }

    try {
      const result = await resendConfirmationAndReceipt(booking.id);
      if (!result) {
        // Send failed (SMTP not configured or rejected). Allow immediate retry
        // by clearing the throttle entry.
        resendLastSentAt.delete(token);
        res.status(500).json({ error: "Failed to send email — please try again shortly." });
        return;
      }
      res.json({ ok: true, recipient: result.recipient });
    } catch (err) {
      logger.error({ err, bookingId: booking.id }, "Self-serve resend email failed");
      resendLastSentAt.delete(token);
      res.status(500).json({ error: "Failed to send email — please try again shortly." });
    }
  },
);

// Fire-and-forget endpoint called by the frontend via sendBeacon or setTimeout when the
// user leaves Step 4 without completing payment. Uses the same atomic partialNotificationSent
// flag to guarantee the notification is sent at most once.
router.post("/bookings/:id/incomplete-ping", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);

  res.status(202).json({ ok: true }); // Respond immediately — processing continues async

  try {
    const [booking] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, id));
    if (!booking || booking.status !== "partial" || booking.partialNotificationSent) return;

    const sessionToken =
      (req.headers["x-booking-session"] as string | undefined) ||
      (typeof req.body?.sessionToken === "string" ? req.body.sessionToken : undefined);

    if (!sessionToken || sessionToken !== booking.sessionToken) {
      logger.warn({ bookingId: id }, "Rejected incomplete-ping with invalid booking session");
      return;
    }

    const claimed = await db
      .update(bookingsTable)
      .set({ partialNotificationSent: true })
      .where(and(eq(bookingsTable.id, id), eq(bookingsTable.partialNotificationSent, false)))
      .returning({ id: bookingsTable.id });

    if (claimed.length > 0) {
      await sendIncompleteFormNotification(id);
    }
  } catch (err) {
    logger.error({ err, bookingId: id }, "Failed to process incomplete-ping");
  }
});

// Confirm a booking that has a total of £0 (fully covered by promo code).
// Marks the booking as paid and sends confirmation emails.
router.post("/bookings/:id/confirm-free", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);

  const [existing] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }

  const sessionToken = req.headers["x-booking-session"] as string | undefined;
  if (!sessionToken || sessionToken !== existing.sessionToken) {
    res.status(403).json({ error: "Forbidden — session token mismatch" });
    return;
  }

  if (existing.status === "paid" || existing.status === "invoiced") {
    // Replay safety — if a previous confirm left a side-effect stuck
    // (e.g. SMTP blip on confirmation email), retry it here.
    await runConfirmationSideEffects(id);
    res.json({ alreadyConfirmed: true, orderReference: existing.orderReference });
    return;
  }

  const pricing = await calculatePricing(existing.passType, existing.quantity, existing.promoCode);

  if (pricing.total > 0) {
    res.status(400).json({ error: "Booking total is not zero — payment required" });
    return;
  }

  if (existing.promoCode) {
    const [promo] = await db
      .select()
      .from(promoCodesTable)
      .where(eq(promoCodesTable.code, existing.promoCode));
    if (promo?.oncePerCustomer) {
      const [lead] = await db
        .select()
        .from(attendeesTable)
        .where(and(eq(attendeesTable.bookingId, id), eq(attendeesTable.isLead, true)));
      const email = (lead?.workEmail || "").trim().toLowerCase();
      if (email && (await isCodeUsedByEmail(existing.promoCode, email))) {
        res.status(400).json({
          error: "This promo code has already been used on a previous booking with this email",
        });
        return;
      }
    }
  }

  // Reserve the promo seats AND atomically flip the booking from
  // partial/pending_payment → paid in a single transaction. The status
  // flip uses a `WHERE status IN (...)` claim so two concurrent
  // /confirm-free calls cannot both win — the loser sees an empty
  // RETURNING, throws the sentinel, rolls back the promo increment, and
  // returns the alreadyConfirmed branch on its retry/poll.
  class PromoCapExceededError extends Error {
    constructor(public clientMessage: string) {
      super(clientMessage);
    }
  }
  class ConfirmRaceLostError extends Error {}

  const orderRef = await generateOrderRef(id);

  try {
    await db.transaction(async (tx) => {
      if (existing.promoCode) {
        const reserved = await incrementPromoUsage(existing.promoCode, existing.quantity, tx);
        if (!reserved) {
          const [promo] = await tx
            .select()
            .from(promoCodesTable)
            .where(eq(promoCodesTable.code, existing.promoCode));
          const remaining =
            promo && promo.maxUses !== null ? Math.max(0, promo.maxUses - promo.usedCount) : 0;
          const msg =
            promo?.discountType === "complimentary"
              ? remaining === 0
                ? "This complimentary code has been fully redeemed — no passes remain"
                : `Only ${remaining} complimentary pass${remaining === 1 ? "" : "es"} remain on this code — please reduce your quantity`
              : "This promo code has already been used up";
          throw new PromoCapExceededError(msg);
        }
      }

      const claimed = await tx
        .update(bookingsTable)
        .set({
          status: "paid",
          currentStep: 5,
          orderReference: orderRef,
          paidAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(bookingsTable.id, id),
            inArray(bookingsTable.status, ["partial", "pending_payment"]),
          ),
        )
        .returning({ id: bookingsTable.id });

      if (claimed.length === 0) {
        // Another caller flipped this booking first (or it was cancelled
        // in the meantime). Roll back the promo increment.
        throw new ConfirmRaceLostError();
      }
    });
  } catch (err) {
    if (err instanceof PromoCapExceededError) {
      res.status(400).json({ error: err.clientMessage });
      return;
    }
    if (err instanceof ConfirmRaceLostError) {
      const [latest] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, id));
      if (latest && (latest.status === "paid" || latest.status === "invoiced")) {
        await runConfirmationSideEffects(id);
        res.json({ alreadyConfirmed: true, orderReference: latest.orderReference });
        return;
      }
      res.status(409).json({ error: "Booking is no longer in a confirmable state" });
      return;
    }
    throw err;
  }

  await runConfirmationSideEffects(id);

  res.json({ confirmed: true, orderReference: orderRef });
});

router.get("/bookings/:id/pricing", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);

  const [booking] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, id));
  if (!booking) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }

  const promoCode = req.query.promoCode as string | undefined;
  const pricing = await calculatePricing(
    booking.passType,
    booking.quantity,
    promoCode || booking.promoCode,
  );

  res.json(pricing);
});

export default router;
