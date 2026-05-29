import { useState, useEffect, useRef } from "react";
import { z } from "zod";
import {
  useUpdateBooking,
  useCreateAttendee,
  useUpdateAttendee,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import SaveAndReturnButton from "@/components/checkout/SaveAndReturnButton";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Checkbox } from "@/components/ui/checkbox";
import { User, Clock, Info, AlertTriangle } from "lucide-react";
import type { BookingWithAttendees } from "@/types/booking";

const attendeeSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  jobTitle: z.string().min(1, "Job title is required"),
  company: z.string().min(1, "Company is required"),
  workEmail: z.string().email("Valid email is required"),
  phone: z.string().optional(),
  gdprConsent: z.boolean().refine((val) => val === true, {
    message: "You must agree to the terms",
  }),
});

interface AttendeeFormData {
  firstName: string;
  lastName: string;
  jobTitle: string;
  company: string;
  workEmail: string;
  phone: string;
  dietaryAccessibility: string;
  gdprConsent: boolean;
  id?: number;
}

interface Step3AttendeesProps {
  booking: BookingWithAttendees;
  onAdvance?: (step: number) => void;
}

export default function Step3Attendees({ booking, onAdvance }: Step3AttendeesProps) {
  const updateBooking = useUpdateBooking();
  const createAttendee = useCreateAttendee();
  const updateAttendee = useUpdateAttendee();
  const queryClient = useQueryClient();

  const totalSeats = booking.quantity;
  const leadAttendee = booking.attendees?.find((a) => a.isLead);
  const additionalAttendees = booking.attendees?.filter((a) => !a.isLead) || [];

  const leadDefaults: AttendeeFormData = {
    firstName: leadAttendee?.firstName || "",
    lastName: leadAttendee?.lastName || "",
    jobTitle: leadAttendee?.jobTitle || "",
    company: leadAttendee?.company || "",
    workEmail: leadAttendee?.workEmail || "",
    phone: leadAttendee?.phone || "",
    dietaryAccessibility: leadAttendee?.dietaryAccessibility || "",
    gdprConsent: leadAttendee?.gdprConsent || false,
    id: leadAttendee?.id,
  };

  const [openItem, setOpenItem] = useState<string>("attendee-0");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [formsData, setFormsData] = useState<AttendeeFormData[]>(() => {
    const forms: AttendeeFormData[] = [];
    for (let i = 0; i < totalSeats; i++) {
      if (i === 0) {
        forms.push({ ...leadDefaults });
      } else {
        const existing = additionalAttendees[i - 1];
        forms.push({
          firstName: existing?.isTbc ? "" : existing?.firstName || "",
          lastName: existing?.isTbc ? "" : existing?.lastName || "",
          jobTitle: existing?.isTbc ? "" : existing?.jobTitle || "",
          company: existing?.isTbc
            ? leadAttendee?.company || ""
            : existing?.company || leadAttendee?.company || "",
          workEmail: existing?.isTbc ? "" : existing?.workEmail || "",
          phone: existing?.isTbc ? "" : existing?.phone || "",
          dietaryAccessibility: existing?.isTbc ? "" : existing?.dietaryAccessibility || "",
          gdprConsent: existing?.isTbc ? false : existing?.gdprConsent || false,
          id: existing?.id,
        });
      }
    }
    return forms;
  });

  const [forMeFlags, setForMeFlags] = useState<boolean[]>(() =>
    Array.from({ length: totalSeats }, (_, i) => i === 0),
  );

  const [tbcFlags, setTbcFlags] = useState<boolean[]>(() =>
    Array.from({ length: totalSeats }, (_, i) => {
      if (i === 0) return false;
      const existing = additionalAttendees[i - 1];
      return existing?.isTbc ?? false;
    }),
  );

  const [errors, setErrors] = useState<(Partial<Record<keyof AttendeeFormData, string>> | null)[]>(
    Array(totalSeats).fill(null),
  );

  const autosaveIdsRef = useRef<(number | undefined)[]>(formsData.map((f) => f.id));

  // Autosave status surfacing. The previous implementation swallowed every
  // network/server error silently — buyers could fill in 10 attendees and
  // click Continue without realising none of it had been persisted. We now
  // track an explicit status and surface failures via an inline banner +
  // disable the Continue button until the next autosave cycle succeeds.
  // Each user keystroke retriggers the effect, providing implicit retry.
  const [autosaveStatus, setAutosaveStatus] = useState<"idle" | "saving" | "error">("idle");
  const [autosaveAttempt, setAutosaveAttempt] = useState(0); // bump to force-retry
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Bounded exponential backoff for transient autosave failures: if a save
  // cycle fails we automatically re-trigger the effect at 2s, then 6s, then
  // 18s before giving up and waiting for the user (banner / manual retry /
  // next keystroke). This is reset whenever the user edits or a save
  // succeeds so the next failure window starts fresh.
  const autoRetryCountRef = useRef(0);
  const autoRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const AUTO_RETRY_DELAYS_MS = [2000, 6000, 18000];

  useEffect(() => {
    if (formsData.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      // Decide whether anything is actually pending a save this cycle. If no
      // attendee row has the minimum fields needed for a save, stay idle so
      // the Continue button isn't gated for empty rows.
      let anyEligible = false;
      for (let i = 0; i < formsData.length; i++) {
        const form = formsData[i];
        const isTbc = tbcFlags[i];
        if (isTbc) {
          // TBC rows only need a save if they don't yet have a server id
          if (!(form.id ?? autosaveIdsRef.current[i])) anyEligible = true;
          else anyEligible = true; // re-saving isTbc=true is cheap and safe
        } else if (form.firstName && form.workEmail) {
          anyEligible = true;
        }
        if (anyEligible) break;
      }
      if (!anyEligible) {
        setAutosaveStatus("idle");
        return;
      }

      setAutosaveStatus("saving");
      let hadError = false;

      for (let i = 0; i < formsData.length; i++) {
        if (cancelled) return;
        const form = formsData[i];
        const isTbc = tbcFlags[i];

        if (!isTbc && (!form.firstName || !form.workEmail)) continue;

        if (i === 0) {
          if (leadAttendee?.id) {
            try {
              await updateAttendee.mutateAsync({
                bookingId: booking.id,
                attendeeId: leadAttendee.id,
                data: {
                  firstName: form.firstName,
                  lastName: form.lastName,
                  jobTitle: form.jobTitle,
                  company: form.company,
                  workEmail: form.workEmail,
                  phone: form.phone || null,
                  dietaryAccessibility: form.dietaryAccessibility || null,
                  gdprConsent: form.gdprConsent,
                },
              });
            } catch (e) {
              hadError = true;
              console.warn("autosave: lead attendee update failed", e);
            }
          }
        } else {
          const existingId = form.id ?? autosaveIdsRef.current[i];
          try {
            if (existingId) {
              await updateAttendee.mutateAsync({
                bookingId: booking.id,
                attendeeId: existingId,
                data: isTbc
                  ? { isTbc: true, company: leadDefaults.company }
                  : {
                      isTbc: false,
                      firstName: form.firstName,
                      lastName: form.lastName,
                      jobTitle: form.jobTitle,
                      company: form.company,
                      workEmail: form.workEmail,
                      phone: form.phone || null,
                      dietaryAccessibility: form.dietaryAccessibility || null,
                      gdprConsent: form.gdprConsent,
                    },
              });
            } else {
              const created = await createAttendee.mutateAsync({
                bookingId: booking.id,
                data: isTbc
                  ? {
                      isLead: false,
                      isTbc: true,
                      gdprConsent: false,
                      company: leadDefaults.company || "TBC",
                      seatIndex: i,
                    }
                  : {
                      isLead: false,
                      isTbc: false,
                      firstName: form.firstName,
                      lastName: form.lastName,
                      jobTitle: form.jobTitle,
                      company: form.company,
                      workEmail: form.workEmail,
                      phone: form.phone || null,
                      dietaryAccessibility: form.dietaryAccessibility || null,
                      gdprConsent: form.gdprConsent,
                      seatIndex: i,
                    },
              });
              autosaveIdsRef.current[i] = created.id;
            }
          } catch (e) {
            hadError = true;
            console.warn(`autosave: attendee ${i} save failed`, e);
          }
        }
      }

      if (cancelled) return;
      setAutosaveStatus(hadError ? "error" : "idle");
      if (hadError) {
        const nextAttempt = autoRetryCountRef.current;
        if (nextAttempt < AUTO_RETRY_DELAYS_MS.length) {
          const delay = AUTO_RETRY_DELAYS_MS[nextAttempt];
          autoRetryCountRef.current = nextAttempt + 1;
          if (autoRetryTimerRef.current) clearTimeout(autoRetryTimerRef.current);
          autoRetryTimerRef.current = setTimeout(() => {
            setAutosaveAttempt((n) => n + 1);
          }, delay);
        }
      } else {
        autoRetryCountRef.current = 0;
        if (autoRetryTimerRef.current) {
          clearTimeout(autoRetryTimerRef.current);
          autoRetryTimerRef.current = null;
        }
      }
    }, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formsData, tbcFlags, autosaveAttempt]);

  // Reset the backoff counter whenever the user edits — a fresh keystroke
  // implies a fresh attempt window and we shouldn't carry old retry counts.
  useEffect(() => {
    autoRetryCountRef.current = 0;
    if (autoRetryTimerRef.current) {
      clearTimeout(autoRetryTimerRef.current);
      autoRetryTimerRef.current = null;
    }
  }, [formsData, tbcFlags]);

  // Cleanup retry timer on unmount.
  useEffect(() => {
    return () => {
      if (autoRetryTimerRef.current) clearTimeout(autoRetryTimerRef.current);
    };
  }, []);

  const handleForMeToggle = (index: number, checked: boolean) => {
    const newFlags = [...forMeFlags];
    newFlags[index] = checked;
    setForMeFlags(newFlags);

    const newForms = [...formsData];
    if (checked) {
      newForms[index] = {
        ...newForms[index],
        firstName: leadDefaults.firstName,
        lastName: leadDefaults.lastName,
        jobTitle: leadDefaults.jobTitle,
        company: leadDefaults.company,
        workEmail: leadDefaults.workEmail,
        phone: leadDefaults.phone,
        dietaryAccessibility: leadDefaults.dietaryAccessibility,
        gdprConsent: newForms[index].gdprConsent,
      };
    } else {
      newForms[index] = {
        ...newForms[index],
        firstName: "",
        lastName: "",
        jobTitle: "",
        company: leadDefaults.company,
        workEmail: "",
        phone: "",
        dietaryAccessibility: "",
      };
    }
    setFormsData(newForms);
  };

  const handleTbcToggle = (index: number, checked: boolean) => {
    const newTbc = [...tbcFlags];
    newTbc[index] = checked;
    setTbcFlags(newTbc);

    if (checked) {
      const newForms = [...formsData];
      newForms[index] = {
        ...newForms[index],
        firstName: "",
        lastName: "",
        jobTitle: "",
        company: leadDefaults.company,
        workEmail: "",
        phone: "",
        gdprConsent: false,
      };
      setFormsData(newForms);
      const newErrors = [...errors];
      newErrors[index] = null;
      setErrors(newErrors);
    }
  };

  const copyLeadCompanyToAdditionalAttendees = () => {
    if (!leadDefaults.company) return;
    setFormsData((current) =>
      current.map((form, index) =>
        index === 0 || tbcFlags[index] ? form : { ...form, company: leadDefaults.company },
      ),
    );
  };

  const markAdditionalAttendeesTbc = () => {
    setTbcFlags((current) => current.map((flag, index) => (index === 0 ? false : true)));
    setFormsData((current) =>
      current.map((form, index) =>
        index === 0
          ? form
          : {
              ...form,
              firstName: "",
              lastName: "",
              jobTitle: "",
              company: leadDefaults.company,
              workEmail: "",
              phone: "",
              dietaryAccessibility: "",
              gdprConsent: false,
            },
      ),
    );
    setErrors(Array(totalSeats).fill(null));
  };

  const updateFormData = <K extends keyof AttendeeFormData>(
    index: number,
    field: K,
    value: AttendeeFormData[K],
  ) => {
    const newFormsData = [...formsData];
    newFormsData[index] = { ...newFormsData[index], [field]: value };
    setFormsData(newFormsData);
    if (field !== "gdprConsent") {
      const newFlags = [...forMeFlags];
      newFlags[index] = false;
      setForMeFlags(newFlags);
    }
  };

  const saveAttendeesProgress = async () => {
    setAutosaveStatus("saving");

    try {
      for (let i = 0; i < totalSeats; i++) {
        const data = formsData[i];
        const isTbc = tbcFlags[i];
        const existingId = data.id ?? autosaveIdsRef.current[i];
        const hasRequiredFields =
          !!data.firstName &&
          !!data.lastName &&
          !!data.jobTitle &&
          !!data.company &&
          !!data.workEmail;

        if (i === 0) {
          if (leadAttendee?.id) {
            await updateAttendee.mutateAsync({
              bookingId: booking.id,
              attendeeId: leadAttendee.id,
              data: {
                firstName: data.firstName,
                lastName: data.lastName,
                jobTitle: data.jobTitle,
                company: data.company,
                workEmail: data.workEmail,
                phone: data.phone || null,
                dietaryAccessibility: data.dietaryAccessibility || null,
                gdprConsent: data.gdprConsent,
              },
            });
          } else if (hasRequiredFields) {
            const created = await createAttendee.mutateAsync({
              bookingId: booking.id,
              data: {
                isLead: true,
                firstName: data.firstName,
                lastName: data.lastName,
                jobTitle: data.jobTitle,
                company: data.company,
                workEmail: data.workEmail,
                phone: data.phone || null,
                dietaryAccessibility: data.dietaryAccessibility || null,
                gdprConsent: data.gdprConsent,
                seatIndex: 0,
              },
            });
            autosaveIdsRef.current[i] = created.id;
          }
          continue;
        }

        if (existingId) {
          await updateAttendee.mutateAsync({
            bookingId: booking.id,
            attendeeId: existingId,
            data: isTbc
              ? { isTbc: true, company: leadDefaults.company }
              : {
                  isTbc: false,
                  firstName: data.firstName,
                  lastName: data.lastName,
                  jobTitle: data.jobTitle,
                  company: data.company,
                  workEmail: data.workEmail,
                  phone: data.phone || null,
                  dietaryAccessibility: data.dietaryAccessibility || null,
                  gdprConsent: data.gdprConsent,
                },
          });
        } else if (isTbc || hasRequiredFields) {
          const created = await createAttendee.mutateAsync({
            bookingId: booking.id,
            data: isTbc
              ? {
                  isLead: false,
                  isTbc: true,
                  gdprConsent: false,
                  company: leadDefaults.company || "TBC",
                  seatIndex: i,
                }
              : {
                  isLead: false,
                  isTbc: false,
                  firstName: data.firstName,
                  lastName: data.lastName,
                  jobTitle: data.jobTitle,
                  company: data.company,
                  workEmail: data.workEmail,
                  phone: data.phone || null,
                  dietaryAccessibility: data.dietaryAccessibility || null,
                  gdprConsent: data.gdprConsent,
                  seatIndex: i,
                },
          });
          autosaveIdsRef.current[i] = created.id;
        }
      }

      await updateBooking.mutateAsync({
        id: booking.id,
        data: { currentStep: 3 },
      });
      queryClient.invalidateQueries({ queryKey: ["booking"] });
      setAutosaveStatus("idle");
    } catch (e) {
      console.error(e);
      setAutosaveStatus("error");
      throw e;
    }
  };

  const handleContinue = async () => {
    setSubmitError(null);
    let allValid = true;
    const newErrors: (Partial<Record<keyof AttendeeFormData, string>> | null)[] =
      Array(totalSeats).fill(null);

    for (let i = 0; i < totalSeats; i++) {
      if (tbcFlags[i]) continue;
      const result = attendeeSchema.safeParse(formsData[i]);
      if (!result.success) {
        allValid = false;
        const fieldErrors: Partial<Record<keyof AttendeeFormData, string>> = {};
        for (const issue of result.error.issues) {
          const field = issue.path[0] as keyof AttendeeFormData;
          if (!fieldErrors[field]) fieldErrors[field] = issue.message;
        }
        newErrors[i] = fieldErrors;
        if (allValid === false && i === 0) setOpenItem("attendee-0");
        else if (!allValid) setOpenItem(`attendee-${i}`);
      }
    }

    setErrors(newErrors);
    if (!allValid) return;

    setIsSubmitting(true);
    try {
      for (let i = 0; i < totalSeats; i++) {
        const data = formsData[i];
        const isTbc = tbcFlags[i];

        if (i === 0) {
          if (leadAttendee?.id) {
            await updateAttendee.mutateAsync({
              bookingId: booking.id,
              attendeeId: leadAttendee.id,
              data: {
                firstName: data.firstName,
                lastName: data.lastName,
                jobTitle: data.jobTitle,
                company: data.company,
                workEmail: data.workEmail,
                phone: data.phone || null,
                dietaryAccessibility: data.dietaryAccessibility || null,
                gdprConsent: data.gdprConsent,
              },
            });
          }
        } else {
          const existingId = data.id ?? autosaveIdsRef.current[i];
          if (existingId) {
            await updateAttendee.mutateAsync({
              bookingId: booking.id,
              attendeeId: existingId,
              data: isTbc
                ? { isTbc: true, company: leadDefaults.company }
                : {
                    isTbc: false,
                    firstName: data.firstName,
                    lastName: data.lastName,
                    jobTitle: data.jobTitle,
                    company: data.company,
                    workEmail: data.workEmail,
                    phone: data.phone || null,
                    dietaryAccessibility: data.dietaryAccessibility || null,
                    gdprConsent: data.gdprConsent,
                  },
            });
          } else {
            const created = await createAttendee.mutateAsync({
              bookingId: booking.id,
              data: isTbc
                ? {
                    isLead: false,
                    isTbc: true,
                    gdprConsent: false,
                    company: leadDefaults.company || "TBC",
                    seatIndex: i,
                  }
                : {
                    isLead: false,
                    isTbc: false,
                    firstName: data.firstName,
                    lastName: data.lastName,
                    jobTitle: data.jobTitle,
                    company: data.company,
                    workEmail: data.workEmail,
                    phone: data.phone || null,
                    dietaryAccessibility: data.dietaryAccessibility || null,
                    gdprConsent: data.gdprConsent,
                    seatIndex: i,
                  },
            });
            autosaveIdsRef.current[i] = created.id;
          }
        }
      }

      await updateBooking.mutateAsync({
        id: booking.id,
        data: { currentStep: 4 },
      });
      queryClient.invalidateQueries({ queryKey: ["booking"] });
      onAdvance?.(4);
    } catch (e) {
      console.error(e);
      setSubmitError("We could not save attendee details. Please try again before continuing.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const readySeatCount = formsData.reduce((count, form, index) => {
    if (tbcFlags[index]) return count + 1;
    return attendeeSchema.safeParse(form).success ? count + 1 : count;
  }, 0);

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <div>
        <h1 className="text-4xl md:text-5xl font-bold mb-4">Attendee Details</h1>
        <p className="text-lg text-muted-foreground">
          {totalSeats === 1
            ? "Please confirm who this ticket is for."
            : `Please confirm who each of the ${totalSeats} tickets is for.`}
        </p>
      </div>

      {totalSeats > 1 && (
        <div className="flex gap-3 bg-blue-50 border border-blue-200 rounded p-4 text-sm text-blue-800">
          <Info className="w-4 h-4 shrink-0 mt-0.5" />
          <p>
            <span className="font-semibold">Not sure who's attending yet?</span> Mark any additional
            ticket as <span className="font-semibold">TBC</span> to complete your booking now and
            confirm the attendee details later — just contact us after booking.
          </p>
        </div>
      )}

      <div className="bg-white border border-border p-4 md:p-5 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="border border-border p-3">
            <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
              Seats
            </p>
            <p className="text-xl font-bold mt-1">{totalSeats}</p>
          </div>
          <div className="border border-border p-3">
            <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
              Ready
            </p>
            <p className="text-xl font-bold mt-1">
              {readySeatCount}/{totalSeats}
            </p>
          </div>
          <div className="border border-border p-3">
            <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
              Lead company
            </p>
            <p className="text-sm font-semibold mt-1 truncate">
              {leadDefaults.company || "Not set"}
            </p>
          </div>
        </div>

        {totalSeats > 1 && (
          <div className="flex flex-col sm:flex-row gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={copyLeadCompanyToAdditionalAttendees}
              disabled={!leadDefaults.company}
              className="justify-center"
            >
              Copy company to all
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={markAdditionalAttendeesTbc}
              className="justify-center"
            >
              Mark additional seats TBC
            </Button>
          </div>
        )}
      </div>

      <Accordion type="single" value={openItem} onValueChange={setOpenItem} className="space-y-4">
        {formsData.map((data, index) => {
          const fieldErrors = errors[index];
          const isForMe = forMeFlags[index];
          const isTbc = tbcFlags[index];
          const label = isTbc
            ? "TBC — details to be confirmed"
            : data.firstName && data.lastName
              ? `${data.firstName} ${data.lastName}`
              : "Pending details";

          return (
            <AccordionItem
              key={index}
              value={`attendee-${index}`}
              className="bg-white border border-border px-6"
            >
              <AccordionTrigger className="hover:no-underline py-6">
                <div className="flex flex-col text-left">
                  <span className="font-bold text-xl">Attendee {index + 1}</span>
                  <span
                    className={`text-sm font-normal ${isTbc ? "text-amber-600 font-medium" : "text-muted-foreground"}`}
                  >
                    {label}
                  </span>
                </div>
              </AccordionTrigger>
              <AccordionContent className="pb-6">
                <div className="mb-5 pt-4 border-t border-border flex flex-wrap gap-2">
                  {index === 0 && (
                    <>
                      <button
                        type="button"
                        onClick={() => handleForMeToggle(index, !isForMe)}
                        className={`inline-flex items-center gap-2 px-4 py-2 rounded-full border text-sm font-medium transition-all ${
                          isForMe
                            ? "bg-primary text-white border-primary"
                            : "bg-white text-foreground border-border hover:border-primary/50"
                        }`}
                      >
                        <User className="w-4 h-4" />
                        This ticket is for me
                      </button>
                      {isForMe && (
                        <p className="w-full mt-1 text-xs text-muted-foreground">
                          Pre-filled from your profile. Edit any field to customise.
                        </p>
                      )}
                    </>
                  )}

                  {index > 0 && (
                    <button
                      type="button"
                      onClick={() => handleTbcToggle(index, !isTbc)}
                      className={`inline-flex items-center gap-2 px-4 py-2 rounded-full border text-sm font-medium transition-all ${
                        isTbc
                          ? "bg-amber-500 text-white border-amber-500"
                          : "bg-white text-foreground border-border hover:border-amber-400"
                      }`}
                    >
                      <Clock className="w-4 h-4" />
                      Not confirmed yet (TBC)
                    </button>
                  )}
                </div>

                {isTbc ? (
                  <div className="bg-amber-50 border border-amber-200 rounded p-4 text-sm text-amber-800">
                    <p className="font-semibold mb-1">This ticket is marked as TBC</p>
                    <p>
                      You can confirm this attendee's details later — just contact us after booking
                      and we'll update the registration for you.
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="space-y-2">
                        <label className="text-sm font-medium">First Name *</label>
                        <Input
                          value={data.firstName}
                          onChange={(e) => updateFormData(index, "firstName", e.target.value)}
                          className={`h-12 bg-white ${fieldErrors?.firstName ? "border-destructive" : ""}`}
                        />
                        {fieldErrors?.firstName && (
                          <p className="text-xs text-destructive">{fieldErrors.firstName}</p>
                        )}
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Last Name *</label>
                        <Input
                          value={data.lastName}
                          onChange={(e) => updateFormData(index, "lastName", e.target.value)}
                          className={`h-12 bg-white ${fieldErrors?.lastName ? "border-destructive" : ""}`}
                        />
                        {fieldErrors?.lastName && (
                          <p className="text-xs text-destructive">{fieldErrors.lastName}</p>
                        )}
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Work Email *</label>
                        <Input
                          type="email"
                          value={data.workEmail}
                          onChange={(e) => updateFormData(index, "workEmail", e.target.value)}
                          className={`h-12 bg-white ${fieldErrors?.workEmail ? "border-destructive" : ""}`}
                        />
                        {fieldErrors?.workEmail && (
                          <p className="text-xs text-destructive">{fieldErrors.workEmail}</p>
                        )}
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Phone (optional)</label>
                        <Input
                          value={data.phone}
                          onChange={(e) => updateFormData(index, "phone", e.target.value)}
                          className="h-12 bg-white"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Job Title *</label>
                        <Input
                          value={data.jobTitle}
                          onChange={(e) => updateFormData(index, "jobTitle", e.target.value)}
                          className={`h-12 bg-white ${fieldErrors?.jobTitle ? "border-destructive" : ""}`}
                        />
                        {fieldErrors?.jobTitle && (
                          <p className="text-xs text-destructive">{fieldErrors.jobTitle}</p>
                        )}
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Company *</label>
                        <Input
                          value={data.company}
                          onChange={(e) => updateFormData(index, "company", e.target.value)}
                          className={`h-12 bg-white ${fieldErrors?.company ? "border-destructive" : ""}`}
                        />
                        {fieldErrors?.company && (
                          <p className="text-xs text-destructive">{fieldErrors.company}</p>
                        )}
                      </div>
                    </div>

                    <div className="mt-6 space-y-2">
                      <label className="text-sm font-medium">
                        Dietary requirements or accessibility needs (optional)
                      </label>
                      <textarea
                        value={data.dietaryAccessibility}
                        onChange={(e) =>
                          updateFormData(index, "dietaryAccessibility", e.target.value)
                        }
                        placeholder="e.g. vegetarian, gluten free, wheelchair access, hearing loop..."
                        rows={3}
                        className="w-full rounded-md border border-input bg-white px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-none"
                      />
                    </div>

                    <div className="pt-6 mt-6 border-t border-border">
                      <div className="flex items-start space-x-3">
                        <Checkbox
                          checked={data.gdprConsent}
                          onCheckedChange={(val) => updateFormData(index, "gdprConsent", !!val)}
                          className="mt-1"
                        />
                        <div className="space-y-1 leading-none">
                          <label className="font-normal text-base cursor-pointer">
                            I understand how my data will be processed in accordance with{" "}
                            <a
                              href="https://peoplestrategyhub.com/your-data-gdpr"
                              target="_blank"
                              rel="noreferrer"
                              className="underline text-primary hover:text-primary/80"
                            >
                              GDPR
                            </a>{" "}
                            and{" "}
                            <a
                              href="https://www.hranalyticssummit.com/terms-and-conditions"
                              target="_blank"
                              rel="noreferrer"
                              className="underline text-primary hover:text-primary/80"
                            >
                              Conference T&Cs
                            </a>
                          </label>
                          {fieldErrors?.gdprConsent && (
                            <p className="text-xs text-destructive">{fieldErrors.gdprConsent}</p>
                          )}
                        </div>
                      </div>
                    </div>
                  </>
                )}

                {index < totalSeats - 1 && (
                  <div className="flex justify-end mt-6">
                    <Button type="button" onClick={() => setOpenItem(`attendee-${index + 1}`)}>
                      Next Attendee
                    </Button>
                  </div>
                )}
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>

      {autosaveStatus === "error" && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded p-4 text-sm text-amber-800">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-semibold">We couldn't save your last change</p>
            <p>
              Please check your connection. We'll retry automatically as you keep typing, or you can{" "}
              <button
                type="button"
                onClick={() => setAutosaveAttempt((n) => n + 1)}
                className="underline font-semibold hover:text-amber-900"
              >
                retry now
              </button>
              .
            </p>
          </div>
        </div>
      )}

      {submitError && (
        <div className="text-sm text-destructive border border-destructive/30 bg-destructive/5 rounded-md p-3">
          {submitError}
        </div>
      )}

      <div className="flex flex-col gap-3 border-t border-border pt-6">
        <Button
          variant="outline"
          size="lg"
          className="h-14 w-full min-w-0 px-6 text-base border-border"
          onClick={async () => {
            await updateBooking.mutateAsync({ id: booking.id, data: { currentStep: 2 } });
            queryClient.invalidateQueries({ queryKey: ["booking"] });
          }}
          disabled={isSubmitting || updateBooking.isPending}
        >
          Back
        </Button>
        <SaveAndReturnButton
          onSave={saveAttendeesProgress}
          disabled={isSubmitting || autosaveStatus === "saving"}
          buttonClassName="text-base"
        />
        <Button
          size="lg"
          className="h-14 w-full min-w-0 px-6 text-base bg-primary hover:bg-primary/90 text-white border-none"
          onClick={handleContinue}
          disabled={isSubmitting || autosaveStatus === "saving" || autosaveStatus === "error"}
        >
          {isSubmitting
            ? "Saving..."
            : autosaveStatus === "saving"
              ? "Saving changes..."
              : autosaveStatus === "error"
                ? "Save failed - retrying"
                : "Continue to Payment"}
        </Button>
      </div>
    </div>
  );
}
