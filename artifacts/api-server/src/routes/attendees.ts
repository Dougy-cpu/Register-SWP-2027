import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "@workspace/db";
import { attendeesTable, bookingsTable, eventSettingsTable, activityLogTable } from "@workspace/db";
import { verifyAdminToken, getAdminPassword } from "../middleware/admin-auth";
import { sendAttendeeChangeNotification, sendWelcomeEmail } from "../lib/email";
import { logAdminAction } from "../lib/audit";

const router: IRouter = Router();

function formatAttendee(a: typeof attendeesTable.$inferSelect) {
  return {
    ...a,
    gdprConsentAt: a.gdprConsentAt ? a.gdprConsentAt.toISOString() : null,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

function isAdminRequest(req: import("express").Request): boolean {
  const token = req.headers["x-admin-token"] as string | undefined;
  if (!token) return false;
  const password = getAdminPassword();
  if (!password) return false;
  return verifyAdminToken(token, password).valid;
}

router.post("/bookings/:bookingId/attendees", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.bookingId) ? req.params.bookingId[0] : req.params.bookingId;
  const bookingId = parseInt(raw, 10);

  const [booking] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, bookingId));
  if (!booking) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }

  if (!isAdminRequest(req)) {
    const sessionToken = req.headers["x-booking-session"] as string | undefined;
    if (!sessionToken || sessionToken !== booking.sessionToken) {
      res.status(403).json({ error: "Forbidden — session token mismatch" });
      return;
    }
  }

  const {
    firstName,
    lastName,
    jobTitle,
    company,
    workEmail,
    phone,
    dietaryAccessibility,
    gdprConsent,
    isLead,
    seatIndex,
    isTbc,
  } = req.body;

  if (!isTbc && (!firstName || !lastName || !jobTitle || !company || !workEmail)) {
    res
      .status(400)
      .json({ error: "firstName, lastName, jobTitle, company, workEmail are required" });
    return;
  }

  const resolvedSeatIndex = seatIndex ?? 0;
  const tbcEmail = `tbc-${bookingId}-${resolvedSeatIndex}@tbc.placeholder`;

  const values = {
    bookingId,
    isTbc: !!isTbc,
    firstName: isTbc ? "TBC" : firstName,
    lastName: isTbc ? "TBC" : lastName,
    jobTitle: isTbc ? "TBC" : jobTitle,
    company: isTbc ? company || "TBC" : company,
    workEmail: isTbc ? tbcEmail : workEmail,
    phone: phone || null,
    dietaryAccessibility: isTbc ? null : dietaryAccessibility || null,
    gdprConsent: isTbc ? false : !!gdprConsent,
    gdprConsentAt: !isTbc && gdprConsent ? new Date() : null,
    isLead: !!isLead,
    seatIndex: resolvedSeatIndex,
  };

  // Upsert: check if an attendee already exists for this booking at this seatIndex
  // (or as lead if isLead is true). Update instead of inserting to prevent duplicates.
  const whereClause = isLead
    ? and(eq(attendeesTable.bookingId, bookingId), eq(attendeesTable.isLead, true))
    : and(eq(attendeesTable.bookingId, bookingId), eq(attendeesTable.seatIndex, resolvedSeatIndex));

  const [existing] = await db.select().from(attendeesTable).where(whereClause);

  let attendee;
  if (existing) {
    [attendee] = await db
      .update(attendeesTable)
      .set(values)
      .where(eq(attendeesTable.id, existing.id))
      .returning();
  } else {
    [attendee] = await db.insert(attendeesTable).values(values).returning();
  }

  if (isAdminRequest(req)) {
    await logAdminAction({
      type: "admin_attendee_added",
      bookingId,
      attendeeId: attendee.id,
      summary: `Admin ${existing ? "updated" : "added"} attendee ${attendee.firstName} ${attendee.lastName} on booking #${bookingId}`,
      before: existing
        ? {
            firstName: existing.firstName,
            lastName: existing.lastName,
            workEmail: existing.workEmail,
            isTbc: existing.isTbc,
          }
        : undefined,
      after: {
        firstName: attendee.firstName,
        lastName: attendee.lastName,
        workEmail: attendee.workEmail,
        isTbc: attendee.isTbc,
      },
    });
  }

  res.status(existing ? 200 : 201).json(formatAttendee(attendee));
});

router.patch("/bookings/:bookingId/attendees/:attendeeId", async (req, res): Promise<void> => {
  const rawBooking = Array.isArray(req.params.bookingId)
    ? req.params.bookingId[0]
    : req.params.bookingId;
  const rawAttendee = Array.isArray(req.params.attendeeId)
    ? req.params.attendeeId[0]
    : req.params.attendeeId;
  const bookingId = parseInt(rawBooking, 10);
  const attendeeId = parseInt(rawAttendee, 10);

  const [booking] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, bookingId));
  if (!booking) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }

  if (!isAdminRequest(req)) {
    const sessionToken = req.headers["x-booking-session"] as string | undefined;
    if (!sessionToken || sessionToken !== booking.sessionToken) {
      res.status(403).json({ error: "Forbidden — session token mismatch" });
      return;
    }
  }

  const [existing] = await db
    .select()
    .from(attendeesTable)
    .where(and(eq(attendeesTable.id, attendeeId), eq(attendeesTable.bookingId, bookingId)));

  if (!existing) {
    res.status(404).json({ error: "Attendee not found" });
    return;
  }

  const {
    firstName,
    lastName,
    jobTitle,
    company,
    workEmail,
    phone,
    dietaryAccessibility,
    gdprConsent,
    isTbc,
  } = req.body;

  const updateData: Partial<typeof attendeesTable.$inferInsert> = {};

  if (isTbc && existing.isLead) {
    res.status(400).json({ error: "The lead attendee cannot be marked as TBC" });
    return;
  }

  if (isTbc !== undefined) {
    updateData.isTbc = !!isTbc;
    if (isTbc) {
      updateData.firstName = "TBC";
      updateData.lastName = "TBC";
      updateData.jobTitle = "TBC";
      updateData.company = company || existing.company || "TBC";
      updateData.workEmail = `tbc-${bookingId}-${existing.seatIndex}@tbc.placeholder`;
      updateData.phone = null;
      updateData.dietaryAccessibility = null;
      updateData.gdprConsent = false;
      updateData.gdprConsentAt = null;
    }
  }

  if (!isTbc) {
    if (firstName !== undefined) updateData.firstName = firstName;
    if (lastName !== undefined) updateData.lastName = lastName;
    if (jobTitle !== undefined) updateData.jobTitle = jobTitle;
    if (company !== undefined) updateData.company = company;
    if (workEmail !== undefined) updateData.workEmail = workEmail;
    if (phone !== undefined) updateData.phone = phone || null;
    if (dietaryAccessibility !== undefined)
      updateData.dietaryAccessibility = dietaryAccessibility || null;
    if (gdprConsent !== undefined) {
      updateData.gdprConsent = !!gdprConsent;
      updateData.gdprConsentAt = gdprConsent ? new Date() : null;
    }
  }

  const [updated] = await db
    .update(attendeesTable)
    .set(updateData)
    .where(eq(attendeesTable.id, attendeeId))
    .returning();

  if (isAdminRequest(req)) {
    await logAdminAction({
      type: "admin_attendee_updated",
      bookingId,
      attendeeId,
      summary: `Admin edited attendee ${updated.firstName} ${updated.lastName} on booking #${bookingId}`,
      before: {
        firstName: existing.firstName,
        lastName: existing.lastName,
        jobTitle: existing.jobTitle,
        company: existing.company,
        workEmail: existing.workEmail,
        isTbc: existing.isTbc,
      },
      after: {
        firstName: updated.firstName,
        lastName: updated.lastName,
        jobTitle: updated.jobTitle,
        company: updated.company,
        workEmail: updated.workEmail,
        isTbc: updated.isTbc,
      },
    });
  }

  res.json(formatAttendee(updated));
});

// Management token-authenticated attendee update (no session required — token IS the auth)
// Only allowed when booking status is paid or invoiced.
router.patch("/attendees/:id/managed", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const attendeeId = parseInt(raw, 10);

  const {
    managementToken,
    firstName,
    lastName,
    jobTitle,
    company,
    workEmail,
    phone,
    dietaryAccessibility,
    gdprConsent,
  } = req.body;

  if (!managementToken) {
    res.status(400).json({ error: "managementToken is required" });
    return;
  }

  const [attendee] = await db
    .select()
    .from(attendeesTable)
    .where(eq(attendeesTable.id, attendeeId));
  if (!attendee) {
    res.status(404).json({ error: "Attendee not found" });
    return;
  }

  const [booking] = await db
    .select()
    .from(bookingsTable)
    .where(eq(bookingsTable.id, attendee.bookingId));

  if (!booking) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }

  if (booking.managementToken !== managementToken) {
    res.status(403).json({ error: "Invalid management token" });
    return;
  }

  if (booking.status !== "paid" && booking.status !== "invoiced") {
    res.status(400).json({ error: "Attendee details can only be updated on confirmed bookings" });
    return;
  }

  // Enforce self-service lock — check event settings before allowing the update
  const [eventSettings] = await db.select().from(eventSettingsTable).limit(1);
  if (eventSettings?.attendeeChangesLocked) {
    const msg =
      eventSettings.attendeeChangesLockedMessage ||
      "Attendee changes are now closed. Please contact the organiser if you need to make a change.";
    res.status(423).json({ error: msg });
    return;
  }

  if (!firstName || !lastName || !jobTitle || !company || !workEmail) {
    res
      .status(400)
      .json({ error: "firstName, lastName, jobTitle, company, workEmail are required" });
    return;
  }

  const wasTbc = attendee.isTbc;

  const [updated] = await db
    .update(attendeesTable)
    .set({
      firstName,
      lastName,
      jobTitle,
      company,
      workEmail,
      phone: phone || null,
      dietaryAccessibility: dietaryAccessibility || null,
      isTbc: false,
      gdprConsent: !!gdprConsent,
      gdprConsentAt: gdprConsent ? new Date() : null,
    })
    .where(eq(attendeesTable.id, attendeeId))
    .returning();

  res.json(formatAttendee(updated));

  // Log to activity_log
  db.insert(activityLogTable)
    .values({
      type: wasTbc ? "tbc_filled" : "attendee_change",
      bookingId: booking.id,
      attendeeId,
      data: { firstName, lastName, jobTitle, company, workEmail, wasTbc },
    })
    .catch(() => {});

  // Send welcome email to the attendee who just registered/updated
  sendWelcomeEmail(booking.id, firstName, workEmail).catch(() => {});

  // Fire and forget — notify organisers that an attendee updated their details
  sendAttendeeChangeNotification(booking.id, attendeeId, {
    firstName,
    lastName,
    jobTitle,
    company,
    workEmail,
  }).catch(() => {});
});

export default router;
