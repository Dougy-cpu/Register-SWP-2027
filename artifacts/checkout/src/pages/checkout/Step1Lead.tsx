import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  useUpdateBooking,
  useCreateAttendee,
  useUpdateAttendee,
  customFetch,
} from "@workspace/api-client-react";
import { Checkbox } from "@/components/ui/checkbox";
import { useQueryClient } from "@tanstack/react-query";
import SaveAndReturnButton from "@/components/checkout/SaveAndReturnButton";
import type { BookingWithAttendees } from "@/types/booking";

const formSchema = z.object({
  attendeeType: z.enum(["hr_professional", "consultant_vendor"]),
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  jobTitle: z.string().min(1, "Job title is required"),
  company: z.string().min(1, "Company is required"),
  workEmail: z.string().email("Valid email is required"),
  phone: z.string().optional(),
  gdprConsent: z.boolean().refine((val) => val === true, {
    message: "You must agree to the terms and data processing",
  }),
});

type FormValues = z.infer<typeof formSchema>;

function bookingSaveErrorMessage(error: unknown) {
  const candidate = error as { data?: { error?: string }; message?: string } | null;
  const apiMessage = candidate?.data?.error || candidate?.message;

  if (apiMessage?.toLowerCase().includes("session token")) {
    return "We could not verify this booking session. Please refresh the page and try again.";
  }

  return apiMessage || "Something went wrong saving your details. Please try again.";
}

export default function Step1Lead({
  sessionToken,
  booking,
  onAdvance,
  submitError,
  onSubmitError,
}: {
  sessionToken: string;
  booking: BookingWithAttendees | undefined;
  onAdvance: (
    step: number | null,
    formData?: { attendeeType: string; sessionToken: string },
  ) => void;
  submitError: string | null;
  onSubmitError: (error: string | null) => void;
}) {
  const leadAttendee = booking?.attendees?.find((a) => a.isLead);

  const passParam =
    typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("pass") : null;
  const urlPreselect =
    passParam === "business" ? "consultant_vendor" : passParam === "hr" ? "hr_professional" : null;

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      attendeeType: booking?.attendeeType || urlPreselect || "hr_professional",
      firstName: leadAttendee?.firstName || "",
      lastName: leadAttendee?.lastName || "",
      jobTitle: leadAttendee?.jobTitle || "",
      company: leadAttendee?.company || "",
      workEmail: leadAttendee?.workEmail || "",
      phone: leadAttendee?.phone || "",
      gdprConsent: leadAttendee?.gdprConsent || false,
    },
  });

  const queryClient = useQueryClient();
  const updateBooking = useUpdateBooking();
  const createAttendee = useCreateAttendee();
  const updateAttendee = useUpdateAttendee();

  const saveLeadDetails = async (data: FormValues, currentStep: 1 | 2) => {
    if (!booking) {
      await customFetch("/api/bookings/start", {
        method: "POST",
        body: JSON.stringify({
          sessionToken,
          attendeeType: data.attendeeType,
          passType: "single",
          quantity: 1,
          firstName: data.firstName,
          lastName: data.lastName,
          jobTitle: data.jobTitle,
          company: data.company,
          workEmail: data.workEmail,
          phone: data.phone || null,
          gdprConsent: data.gdprConsent,
          currentStep,
        }),
      });
    } else {
      await updateBooking.mutateAsync({
        id: booking.id,
        data: { attendeeType: data.attendeeType, currentStep },
      });

      if (!leadAttendee) {
        await createAttendee.mutateAsync({
          bookingId: booking.id,
          data: {
            isLead: true,
            firstName: data.firstName,
            lastName: data.lastName,
            jobTitle: data.jobTitle,
            company: data.company,
            workEmail: data.workEmail,
            phone: data.phone || null,
            gdprConsent: data.gdprConsent,
            seatIndex: 0,
          },
        });
      } else {
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
            gdprConsent: data.gdprConsent,
          },
        });
      }
    }

    queryClient.invalidateQueries({ queryKey: ["booking", sessionToken] });
  };

  const onSubmit = async (data: FormValues) => {
    onSubmitError(null);

    try {
      await saveLeadDetails(data, 2);
      onAdvance(2, { attendeeType: data.attendeeType, sessionToken });
    } catch (error) {
      onAdvance(null);
      onSubmitError(bookingSaveErrorMessage(error));
    }
  };

  const handleSaveAndReturn = async () => {
    await form.handleSubmit(
      async (data) => {
        onSubmitError(null);
        try {
          await saveLeadDetails(data, 1);
        } catch (error) {
          throw new Error(bookingSaveErrorMessage(error), { cause: error });
        }
      },
      async () => {
        throw new Error("Please complete the required fields before saving.");
      },
    )();
  };

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <div className="space-y-3">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary">Step 1 of 4</p>
        <h1 className="text-4xl font-bold md:text-5xl">Who is attending?</h1>
        <p className="text-lg text-muted-foreground">
          Please tell us a bit about yourself so we can tailor your experience.
        </p>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
          <section className="swp-card rounded-2xl p-6 md:p-8">
            <h2 className="text-2xl font-bold mb-6">I am registering as a:</h2>
            <FormField
              control={form.control}
              name="attendeeType"
              render={({ field }) => (
                <FormItem className="space-y-3">
                  <FormControl>
                    <RadioGroup
                      onValueChange={field.onChange}
                      defaultValue={field.value}
                      className="grid grid-cols-1 md:grid-cols-2 gap-4"
                    >
                      <FormItem>
                        <FormControl>
                          <label
                            className={`swp-option-card relative flex min-h-[132px] cursor-pointer flex-col p-5 transition-all ${
                              field.value === "hr_professional"
                                ? "border-primary bg-primary/5 ring-1 ring-primary/15"
                                : ""
                            }`}
                          >
                            {field.value === "hr_professional" && (
                              <span className="absolute right-4 top-4 rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-primary">
                                Selected
                              </span>
                            )}
                            <div
                              className={`mb-2 flex items-center gap-2 ${
                                field.value === "hr_professional" ? "pr-20" : ""
                              }`}
                            >
                              <RadioGroupItem value="hr_professional" className="sr-only" />
                              <div
                                className={`w-5 h-5 rounded-full border flex items-center justify-center ${field.value === "hr_professional" ? "border-primary" : "border-input"}`}
                              >
                                {field.value === "hr_professional" && (
                                  <div className="w-2.5 h-2.5 bg-primary rounded-full" />
                                )}
                              </div>
                              <span className="font-bold text-lg">Employer-side attendee</span>
                            </div>
                            <span className="text-sm text-muted-foreground ml-7">
                              In-house HR, strategic workforce planning, people analytics, talent,
                              skills, organisation design, transformation and business-facing
                              workforce teams.
                            </span>
                          </label>
                        </FormControl>
                      </FormItem>
                      <FormItem>
                        <FormControl>
                          <label
                            className={`swp-option-card relative flex min-h-[132px] cursor-pointer flex-col p-5 transition-all ${
                              field.value === "consultant_vendor"
                                ? "border-primary bg-primary/5 ring-1 ring-primary/15"
                                : ""
                            }`}
                          >
                            {field.value === "consultant_vendor" && (
                              <span className="absolute right-4 top-4 rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-primary">
                                Selected
                              </span>
                            )}
                            <div
                              className={`mb-2 flex items-center gap-2 ${
                                field.value === "consultant_vendor" ? "pr-20" : ""
                              }`}
                            >
                              <RadioGroupItem value="consultant_vendor" className="sr-only" />
                              <div
                                className={`w-5 h-5 rounded-full border flex items-center justify-center ${field.value === "consultant_vendor" ? "border-primary" : "border-input"}`}
                              >
                                {field.value === "consultant_vendor" && (
                                  <div className="w-2.5 h-2.5 bg-primary rounded-full" />
                                )}
                              </div>
                              <span className="font-bold text-lg">Commercial attendee</span>
                            </div>
                            <span className="text-sm text-muted-foreground ml-7">
                              Vendors, consultants, advisory firms, recruiters, technology
                              providers and commercial service providers.
                            </span>
                          </label>
                        </FormControl>
                      </FormItem>
                    </RadioGroup>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </section>

          <section className="swp-card space-y-6 rounded-2xl p-6 md:p-8">
            <h2 className="text-2xl font-bold mb-6">Your Details</h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <FormField
                control={form.control}
                name="firstName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>First Name *</FormLabel>
                    <FormControl>
                      <Input placeholder="Jane" {...field} className="h-12 bg-white" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="lastName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Last Name *</FormLabel>
                    <FormControl>
                      <Input placeholder="Doe" {...field} className="h-12 bg-white" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="workEmail"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Work Email *</FormLabel>
                    <FormControl>
                      <Input
                        type="email"
                        placeholder="jane@company.com"
                        {...field}
                        className="h-12 bg-white"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="phone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Emergency contact phone (optional)</FormLabel>
                    <FormControl>
                      <Input placeholder="+44 7700 900077" {...field} className="h-12 bg-white" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="jobTitle"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Job Title *</FormLabel>
                    <FormControl>
                      <Input placeholder="VP of People" {...field} className="h-12 bg-white" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="company"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Company *</FormLabel>
                    <FormControl>
                      <Input placeholder="Acme Corp" {...field} className="h-12 bg-white" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="pt-4 mt-6 border-t border-border">
              <FormField
                control={form.control}
                name="gdprConsent"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        className="mt-1"
                      />
                    </FormControl>
                    <div className="space-y-1 leading-none">
                      <FormLabel className="font-normal text-base cursor-pointer">
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
                          href="https://swpsummit.com/terms-and-conditions"
                          target="_blank"
                          rel="noreferrer"
                          className="underline text-primary hover:text-primary/80"
                        >
                          Conference T&Cs
                        </a>
                      </FormLabel>
                      <FormMessage />
                    </div>
                  </FormItem>
                )}
              />
            </div>
          </section>

          {submitError && (
            <div className="text-sm text-destructive border border-destructive/30 bg-destructive/5 rounded p-3">
              {submitError}
            </div>
          )}

          <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3 pt-4">
            <SaveAndReturnButton onSave={handleSaveAndReturn} className="sm:items-start" />
            <Button
              type="submit"
              size="lg"
              className="swp-primary-btn h-14 w-full min-w-0 px-8 text-lg sm:w-auto"
            >
              Continue to Passes
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
