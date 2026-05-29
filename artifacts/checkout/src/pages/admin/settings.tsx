import { useState, useEffect, useRef, useCallback } from "react";
import AdminLayout from "@/components/layout/AdminLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Check,
  Lock,
  Unlock,
  Settings2,
  Loader2,
  Globe,
  ShieldCheck,
  CalendarDays,
  ChevronUp,
  ChevronDown,
  Trash2,
  Plus,
  ListChecks,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";

interface EventSettings {
  eventName: string;
  eventDate: string;
  eventVenue: string;
  eventVenuePostcode: string;
  orgName: string;
  orgAddress: string;
  orgWebsite: string;
  fromName: string;
  fromEmail: string;
  attendeeChangesLocked: boolean;
  attendeeChangesLockedMessage: string | null;
  refPrefix: string;
  refOffset: number;
  eventStartAt: string | null;
  eventEndAt: string | null;
  eventTimezone: string;
  eventDescription: string | null;
  socialEnabled: boolean;
  socialName: string | null;
  socialStartAt: string | null;
  socialEndAt: string | null;
  socialVenue: string | null;
  socialDescription: string | null;
  invoiceHelpContent: string | null;
}

// Built-in default copy for the "How invoicing works" help block. Mirrors the
// server-side DEFAULT_INVOICE_HELP_CONTENT constant in api-server/src/lib/email.ts -
// shown as the placeholder when an admin hasn't overridden the copy.
const DEFAULT_INVOICE_HELP_CONTENT = `When will I receive the invoice?
We email a VAT invoice to the billing address you provide as soon as your registration is confirmed, usually within a few minutes.

What are the payment terms?
Invoices are due within 14 days, or before the event date if sooner. Your seats are reserved as soon as the invoice is issued.

How can I pay?
The invoice email includes company information, bank details and payment instructions.
Your finance team can settle the invoice by bank transfer or through the secure Stripe payment link on the invoice.

Where do I send remittance advice?
Email remittance to douglas@peoplestrategyhub.com so we can match your payment quickly.

Need a PO number on the invoice?
You can add or update a PO number before payment using the secure billing link in your confirmation email. We will re-issue the invoice automatically after billing or PO updates.

Questions?
Email douglas@peoplestrategyhub.com and we'll come back to you within one working day.`;

// Compute a timezone's UTC offset (in minutes) for a given UTC instant.
// Uses Intl.DateTimeFormat to render the moment in the target tz then diff.
function tzOffsetMinutes(tz: string, utcDate: Date): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const parts = fmt.formatToParts(utcDate);
    const map: Record<string, string> = {};
    for (const p of parts) if (p.type !== "literal") map[p.type] = p.value;
    const asUtc = Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      Number(map.hour),
      Number(map.minute),
      Number(map.second),
    );
    return (asUtc - utcDate.getTime()) / 60000;
  } catch {
    return 0;
  }
}

// Convert a UTC ISO string into a "YYYY-MM-DDTHH:mm" wall-clock string in tz,
// suitable for <input type="datetime-local"> value.
function isoToTzWallClock(iso: string | null | undefined, tz: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const parts = fmt.formatToParts(d);
    const map: Record<string, string> = {};
    for (const p of parts) if (p.type !== "literal") map[p.type] = p.value;
    return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}`;
  } catch {
    return "";
  }
}

// Interpret a "YYYY-MM-DDTHH:mm" wall-clock value as being in tz, return UTC ISO.
// Iterates twice to settle DST boundaries.
function tzWallClockToIso(value: string, tz: string): string | null {
  if (!value) return null;
  const naiveUtc = new Date(value + ":00Z").getTime();
  if (isNaN(naiveUtc)) return null;
  let utc = naiveUtc;
  for (let i = 0; i < 2; i++) {
    const offset = tzOffsetMinutes(tz, new Date(utc));
    utc = naiveUtc - offset * 60000;
  }
  return new Date(utc).toISOString();
}

const DEFAULT_LOCKED_MESSAGE =
  "Attendee changes are now closed. If you need to make a change, please contact us at douglas@peoplestrategyhub.com";

function adminFetch(path: string, init?: RequestInit) {
  const token = localStorage.getItem("admin_token") || "";
  return fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": token,
      ...(init?.headers as Record<string, string>),
    },
  });
}

async function saveLockSettings(
  locked: boolean,
  message: string | null,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await adminFetch("/api/admin/event-settings", {
      method: "PUT",
      body: JSON.stringify({
        attendeeChangesLocked: locked,
        attendeeChangesLockedMessage: message || DEFAULT_LOCKED_MESSAGE,
      }),
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({}));
    return { ok: false, error: body.error || "Failed to save" };
  } catch {
    return { ok: false, error: "Network error" };
  }
}

export default function AdminSettings() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const [lockSaving, setLockSaving] = useState(false);
  const [lockSaved, setLockSaved] = useState(false);
  const [lockError, setLockError] = useState("");

  const [form, setForm] = useState<EventSettings>({
    eventName: "SWP Summit",
    eventDate: "Wednesday, 3 March 2027",
    eventVenue: "1 Basinghall Avenue, London",
    eventVenuePostcode: "EC2V 5DD",
    orgName: "Dynamic Business Leaders Limited",
    orgAddress: "London, UK",
    orgWebsite: "https://swpsummit.com",
    fromName: "SWP Summit",
    fromEmail: "douglas@peoplestrategyhub.com",
    attendeeChangesLocked: false,
    attendeeChangesLockedMessage: null,
    refPrefix: "SWP27",
    refOffset: 6541,
    eventStartAt: null,
    eventEndAt: null,
    eventTimezone: "Europe/London",
    eventDescription: null,
    socialEnabled: false,
    socialName: null,
    socialStartAt: null,
    socialEndAt: null,
    socialVenue: null,
    socialDescription: null,
    invoiceHelpContent: null,
  });

  const [helpSaving, setHelpSaving] = useState(false);
  const [helpSaved, setHelpSaved] = useState(false);
  const [helpError, setHelpError] = useState("");

  const [calSaving, setCalSaving] = useState(false);
  const [calSaved, setCalSaved] = useState(false);
  const [calError, setCalError] = useState("");

  const [refSaving, setRefSaving] = useState(false);
  const [refSaved, setRefSaved] = useState(false);
  const [refError, setRefError] = useState("");

  // ── Hear-about-us option management ──────────────────────────────────────
  type HauOption = { id: number; label: string; position: number; responseCount: number };
  const [hauOptions, setHauOptions] = useState<HauOption[]>([]);
  const [hauTotalAnswered, setHauTotalAnswered] = useState(0);
  const [hauTotalBookings, setHauTotalBookings] = useState(0);
  const [hauNewLabel, setHauNewLabel] = useState("");
  const [hauAdding, setHauAdding] = useState(false);
  const [hauLoading, setHauLoading] = useState(true);

  const loadHauOptions = useCallback(async () => {
    setHauLoading(true);
    try {
      const res = await adminFetch("/api/admin/hear-about-us-options");
      if (res.ok) {
        const data = await res.json();
        setHauOptions(data.options ?? []);
        setHauTotalAnswered(data.totalAnswered ?? 0);
        setHauTotalBookings(data.totalBookings ?? 0);
      }
    } catch {
      /* ignore */
    }
    setHauLoading(false);
  }, []);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestLockRef = useRef<{ locked: boolean; message: string | null }>({
    locked: false,
    message: null,
  });

  useEffect(() => {
    setLoading(true);
    adminFetch("/api/admin/event-settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: EventSettings | null) => {
        if (data) {
          const lockState = {
            locked: data.attendeeChangesLocked ?? false,
            message: data.attendeeChangesLockedMessage ?? null,
          };
          latestLockRef.current = lockState;
          setForm({
            eventName: data.eventName,
            eventDate: data.eventDate,
            eventVenue: data.eventVenue,
            eventVenuePostcode: data.eventVenuePostcode,
            orgName: data.orgName,
            orgAddress: data.orgAddress,
            orgWebsite: data.orgWebsite,
            fromName: data.fromName,
            fromEmail: data.fromEmail,
            attendeeChangesLocked: lockState.locked,
            attendeeChangesLockedMessage: lockState.message,
            refPrefix: data.refPrefix ?? "SWP27",
            refOffset: data.refOffset ?? 6541,
            eventStartAt: data.eventStartAt ?? null,
            eventEndAt: data.eventEndAt ?? null,
            eventTimezone: data.eventTimezone ?? "Europe/London",
            eventDescription: data.eventDescription ?? null,
            socialEnabled: data.socialEnabled ?? false,
            socialName: data.socialName ?? null,
            socialStartAt: data.socialStartAt ?? null,
            socialEndAt: data.socialEndAt ?? null,
            socialVenue: data.socialVenue ?? null,
            socialDescription: data.socialDescription ?? null,
            invoiceHelpContent:
              (data as { invoiceHelpContent?: string | null }).invoiceHelpContent ?? null,
          });
        }
      })
      .finally(() => setLoading(false));
    loadHauOptions();
  }, [loadHauOptions]);

  const hauAddOption = async () => {
    const label = hauNewLabel.trim();
    if (!label) return;
    setHauAdding(true);
    const optimistic: HauOption = {
      id: Date.now(),
      label,
      position: hauOptions.length,
      responseCount: 0,
    };
    setHauOptions((prev) => [...prev, optimistic]);
    setHauNewLabel("");
    try {
      const res = await adminFetch("/api/admin/hear-about-us-options", {
        method: "POST",
        body: JSON.stringify({ label }),
      });
      if (res.ok) {
        await loadHauOptions();
      } else {
        setHauOptions((prev) => prev.filter((o) => o.id !== optimistic.id));
        setHauNewLabel(label);
      }
    } catch {
      setHauOptions((prev) => prev.filter((o) => o.id !== optimistic.id));
      setHauNewLabel(label);
    }
    setHauAdding(false);
  };

  const hauDeleteOption = async (id: number) => {
    const removedIdx = hauOptions.findIndex((o) => o.id === id);
    if (removedIdx === -1) return;
    const removed = hauOptions[removedIdx];

    setHauOptions((opt) => opt.filter((o) => o.id !== id));

    const restoreOption = () => {
      setHauOptions((curr) => {
        const next = [...curr];
        next.splice(Math.min(removedIdx, next.length), 0, removed);
        return next;
      });
    };

    try {
      const res = await adminFetch(`/api/admin/hear-about-us-options/${id}`, { method: "DELETE" });
      if (!res.ok) {
        restoreOption();
        toast({
          title: "Could not remove option",
          description: "The option was restored. Please try again.",
          variant: "destructive",
        });
        return;
      }
    } catch {
      restoreOption();
      toast({
        title: "Could not remove option",
        description: "Network error — the option was restored.",
        variant: "destructive",
      });
      return;
    }

    toast({
      title: "Option removed",
      description: `"${removed.label}" has been deleted.`,
      action: (
        <ToastAction
          altText="Undo"
          onClick={async () => {
            try {
              const res = await adminFetch("/api/admin/hear-about-us-options", {
                method: "POST",
                body: JSON.stringify({ label: removed.label }),
              });
              if (res.ok) {
                await loadHauOptions();
              }
            } catch {
              /* ignore — user can re-add manually */
            }
          }}
        >
          Undo
        </ToastAction>
      ),
    });
  };

  const hauMoveOption = async (id: number, direction: "up" | "down") => {
    const idx = hauOptions.findIndex((o) => o.id === id);
    if (idx === -1) return;
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= hauOptions.length) return;
    const next = [...hauOptions];
    [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
    setHauOptions(next);
    try {
      await adminFetch(`/api/admin/hear-about-us-options/${id}/move`, {
        method: "PUT",
        body: JSON.stringify({ direction }),
      });
    } catch {
      /* revert would be ideal but this is a rare path */
    }
  };

  const persistLock = useCallback(async (locked: boolean, message: string | null) => {
    setLockSaving(true);
    setLockError("");
    const result = await saveLockSettings(locked, message);
    setLockSaving(false);
    if (result.ok) {
      setLockSaved(true);
      setTimeout(() => setLockSaved(false), 2500);
    } else {
      setLockError(result.error || "Failed to save");
    }
  }, []);

  const handleToggleLock = (locked: boolean) => {
    const message = form.attendeeChangesLockedMessage || DEFAULT_LOCKED_MESSAGE;
    latestLockRef.current = { locked, message };
    setForm((f) => ({ ...f, attendeeChangesLocked: locked }));
    persistLock(locked, message);
  };

  const handleMessageChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const message = e.target.value;
    latestLockRef.current = { ...latestLockRef.current, message };
    setForm((f) => ({ ...f, attendeeChangesLockedMessage: message }));
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const { locked, message: msg } = latestLockRef.current;
      persistLock(locked, msg);
    }, 800);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      const res = await adminFetch("/api/admin/event-settings", {
        method: "PUT",
        body: JSON.stringify({
          eventName: form.eventName,
          eventDate: form.eventDate,
          eventVenue: form.eventVenue,
          eventVenuePostcode: form.eventVenuePostcode,
          orgName: form.orgName,
          orgAddress: form.orgAddress,
          orgWebsite: form.orgWebsite,
          fromName: form.fromName,
          fromEmail: form.fromEmail,
        }),
      });
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      } else {
        const body = await res.json().catch(() => ({}));
        setError(body.error || "Failed to save settings");
      }
    } finally {
      setSaving(false);
    }
  };

  const handleSaveCalendar = async () => {
    setCalSaving(true);
    setCalError("");
    setCalSaved(false);
    try {
      const res = await adminFetch("/api/admin/event-settings", {
        method: "PUT",
        body: JSON.stringify({
          eventStartAt: form.eventStartAt,
          eventEndAt: form.eventEndAt,
          eventTimezone: form.eventTimezone,
          eventDescription: form.eventDescription,
          socialEnabled: form.socialEnabled,
          socialName: form.socialName,
          socialStartAt: form.socialStartAt,
          socialEndAt: form.socialEndAt,
          socialVenue: form.socialVenue,
          socialDescription: form.socialDescription,
        }),
      });
      if (res.ok) {
        setCalSaved(true);
        setTimeout(() => setCalSaved(false), 2500);
      } else {
        const body = await res.json().catch(() => ({}));
        setCalError(body.error || "Failed to save");
      }
    } finally {
      setCalSaving(false);
    }
  };

  const handleSaveInvoiceHelp = async () => {
    setHelpSaving(true);
    setHelpError("");
    setHelpSaved(false);
    try {
      const res = await adminFetch("/api/admin/event-settings", {
        method: "PUT",
        body: JSON.stringify({
          // Empty string => server reverts to built-in default copy.
          invoiceHelpContent: (form.invoiceHelpContent ?? "").trim(),
        }),
      });
      if (res.ok) {
        setHelpSaved(true);
        setTimeout(() => setHelpSaved(false), 2500);
      } else {
        const body = await res.json().catch(() => ({}));
        setHelpError(body.error || "Failed to save");
      }
    } finally {
      setHelpSaving(false);
    }
  };

  const handleSaveRef = async () => {
    const prefix = form.refPrefix.trim();
    const offset = parseInt(String(form.refOffset), 10);
    if (!prefix) {
      setRefError("Prefix is required");
      return;
    }
    if (isNaN(offset) || offset < 0) {
      setRefError("Offset must be a non-negative number");
      return;
    }
    setRefSaving(true);
    setRefError("");
    setRefSaved(false);
    try {
      const res = await adminFetch("/api/admin/event-settings", {
        method: "PUT",
        body: JSON.stringify({ refPrefix: prefix, refOffset: offset }),
      });
      if (res.ok) {
        setRefSaved(true);
        setTimeout(() => setRefSaved(false), 2500);
      } else {
        const body = await res.json().catch(() => ({}));
        setRefError(body.error || "Failed to save");
      }
    } finally {
      setRefSaving(false);
    }
  };

  return (
    <AdminLayout title="Settings">
      {loading ? (
        <div className="flex justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      ) : (
        <div className="max-w-2xl space-y-8">
          {/* ── Event & Org Details ── */}
          <form onSubmit={handleSave} className="bg-white border border-border">
            <div className="px-6 py-4 border-b border-border flex items-center gap-3">
              <Settings2 className="w-5 h-5 text-primary" />
              <h2 className="font-bold text-base">Event &amp; Organisation Details</h2>
            </div>
            <div className="p-6 space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                    Event Name
                  </label>
                  <Input
                    value={form.eventName}
                    onChange={(e) => setForm((f) => ({ ...f, eventName: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                    Event Date
                  </label>
                  <Input
                    value={form.eventDate}
                    onChange={(e) => setForm((f) => ({ ...f, eventDate: e.target.value }))}
                  />
                  <p className="mt-1 text-[11px] text-muted-foreground leading-snug">
                    Display label only (shown in emails &amp; receipts). The exact start/end times
                    for calendar invites live in the Calendar &amp; Scheduling section below.
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                    Venue
                  </label>
                  <Input
                    value={form.eventVenue}
                    onChange={(e) => setForm((f) => ({ ...f, eventVenue: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                    Postcode
                  </label>
                  <Input
                    value={form.eventVenuePostcode}
                    onChange={(e) => setForm((f) => ({ ...f, eventVenuePostcode: e.target.value }))}
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                    Organisation Name
                  </label>
                  <Input
                    value={form.orgName}
                    onChange={(e) => setForm((f) => ({ ...f, orgName: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                    Organisation Address
                  </label>
                  <Input
                    value={form.orgAddress}
                    onChange={(e) => setForm((f) => ({ ...f, orgAddress: e.target.value }))}
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                  Website
                </label>
                <Input
                  value={form.orgWebsite}
                  onChange={(e) => setForm((f) => ({ ...f, orgWebsite: e.target.value }))}
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                    Email Sender Name
                  </label>
                  <Input
                    value={form.fromName}
                    onChange={(e) => setForm((f) => ({ ...f, fromName: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                    Email Sender Address
                  </label>
                  <Input
                    type="email"
                    value={form.fromEmail}
                    onChange={(e) => setForm((f) => ({ ...f, fromEmail: e.target.value }))}
                  />
                </div>
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}

              <div className="flex justify-end">
                <Button
                  type="submit"
                  disabled={saving}
                  className={`h-10 px-6 ${saved ? "bg-green-600 hover:bg-green-700" : "bg-primary hover:bg-primary/90"} text-white`}
                >
                  {saved ? (
                    <span className="flex items-center gap-1.5">
                      <Check className="w-4 h-4" /> Saved
                    </span>
                  ) : saving ? (
                    "Saving…"
                  ) : (
                    "Save Changes"
                  )}
                </Button>
              </div>
            </div>
          </form>

          {/* ── Event Times ── */}
          <div className="bg-white border border-border">
            <div className="px-6 py-4 border-b border-border flex items-center gap-3">
              <CalendarDays className="w-5 h-5 text-primary" />
              <h2 className="font-bold text-base">Event Times</h2>
            </div>
            <div className="p-6 space-y-6">
              <p className="text-sm text-muted-foreground">
                Times entered here are interpreted in{" "}
                <code className="text-xs bg-muted px-1 py-0.5 rounded">
                  {form.eventTimezone || "Europe/London"}
                </code>{" "}
                and used to build the Google / Outlook / .ics calendar invites. The{" "}
                <code className="text-xs bg-muted px-1 py-0.5 rounded">
                  {"{{eventCalendarLinks}}"}
                </code>{" "}
                placeholder in welcome &amp; confirmation emails renders once both start &amp; end
                are set.
              </p>

              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                      Starts At ({form.eventTimezone || "Europe/London"})
                    </label>
                    <Input
                      type="datetime-local"
                      value={isoToTzWallClock(
                        form.eventStartAt,
                        form.eventTimezone || "Europe/London",
                      )}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          eventStartAt: tzWallClockToIso(
                            e.target.value,
                            f.eventTimezone || "Europe/London",
                          ),
                        }))
                      }
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                      Ends At ({form.eventTimezone || "Europe/London"})
                    </label>
                    <Input
                      type="datetime-local"
                      value={isoToTzWallClock(
                        form.eventEndAt,
                        form.eventTimezone || "Europe/London",
                      )}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          eventEndAt: tzWallClockToIso(
                            e.target.value,
                            f.eventTimezone || "Europe/London",
                          ),
                        }))
                      }
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                    Timezone (IANA)
                  </label>
                  <Input
                    value={form.eventTimezone}
                    onChange={(e) => setForm((f) => ({ ...f, eventTimezone: e.target.value }))}
                    placeholder="Europe/London"
                  />
                  <p className="mt-1 text-[11px] text-muted-foreground leading-snug">
                    Examples: Europe/London, America/New_York, Asia/Singapore. Recipients' calendar
                    apps will translate to their own local time automatically.
                  </p>
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                    Description (shown in calendar invite)
                  </label>
                  <Textarea
                    rows={3}
                    value={form.eventDescription ?? ""}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, eventDescription: e.target.value || null }))
                    }
                    placeholder="Join the UK's leading HR analytics conference…"
                  />
                </div>
              </div>

              <div className="space-y-4 pt-2 border-t border-border">
                <div className="flex items-center justify-between pt-4">
                  <h3 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
                    Pre-Event Social (Optional)
                  </h3>
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.socialEnabled}
                      onChange={(e) => setForm((f) => ({ ...f, socialEnabled: e.target.checked }))}
                      className="w-4 h-4 accent-primary"
                    />
                    <span className="font-semibold">Enabled</span>
                  </label>
                </div>
                <fieldset
                  disabled={!form.socialEnabled}
                  className={form.socialEnabled ? "space-y-4" : "space-y-4 opacity-50"}
                >
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                      Event Name
                    </label>
                    <Input
                      value={form.socialName ?? ""}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, socialName: e.target.value || null }))
                      }
                      placeholder="Pre-Summit Drinks"
                    />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                        Starts At
                      </label>
                      <Input
                        type="datetime-local"
                        value={isoToTzWallClock(
                          form.socialStartAt,
                          form.eventTimezone || "Europe/London",
                        )}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            socialStartAt: tzWallClockToIso(
                              e.target.value,
                              f.eventTimezone || "Europe/London",
                            ),
                          }))
                        }
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                        Ends At
                      </label>
                      <Input
                        type="datetime-local"
                        value={isoToTzWallClock(
                          form.socialEndAt,
                          form.eventTimezone || "Europe/London",
                        )}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            socialEndAt: tzWallClockToIso(
                              e.target.value,
                              f.eventTimezone || "Europe/London",
                            ),
                          }))
                        }
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                      Venue
                    </label>
                    <Input
                      value={form.socialVenue ?? ""}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, socialVenue: e.target.value || null }))
                      }
                      placeholder="The Botanist, Broadgate Circle"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                      Description
                    </label>
                    <Textarea
                      rows={2}
                      value={form.socialDescription ?? ""}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, socialDescription: e.target.value || null }))
                      }
                      placeholder="Drinks &amp; networking the evening before the summit."
                    />
                  </div>
                </fieldset>
              </div>

              {calError && <p className="text-sm text-destructive">{calError}</p>}

              <div className="flex justify-end">
                <Button
                  type="button"
                  onClick={handleSaveCalendar}
                  disabled={calSaving}
                  className={`h-10 px-6 ${calSaved ? "bg-green-600 hover:bg-green-700" : "bg-primary hover:bg-primary/90"} text-white`}
                >
                  {calSaved ? (
                    <span className="flex items-center gap-1.5">
                      <Check className="w-4 h-4" /> Saved
                    </span>
                  ) : calSaving ? (
                    "Saving…"
                  ) : (
                    "Save Calendar Settings"
                  )}
                </Button>
              </div>
            </div>
          </div>

          {/* ── Attendee Self-Service ── */}
          <div className="bg-white border border-border">
            <div className="px-6 py-4 border-b border-border flex items-center gap-3">
              {form.attendeeChangesLocked ? (
                <Lock className="w-5 h-5 text-red-500" />
              ) : (
                <Unlock className="w-5 h-5 text-green-600" />
              )}
              <h2 className="font-bold text-base">Attendee Self-Service</h2>
              <div className="ml-auto flex items-center gap-2">
                {lockSaving && (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
                )}
                {lockSaved && !lockSaving && <Check className="w-3.5 h-3.5 text-green-600" />}
                <span
                  className={`text-xs font-semibold px-2.5 py-1 rounded-full ${form.attendeeChangesLocked ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"}`}
                >
                  {form.attendeeChangesLocked ? "Locked" : "Open"}
                </span>
              </div>
            </div>
            <div className="p-6 space-y-5">
              <p className="text-sm text-muted-foreground">
                Control whether attendees can update their own details via the self-service
                management link. When locked, all{" "}
                <code className="text-xs bg-muted px-1 py-0.5 rounded">/manage/:token</code> links
                show a message instead of edit controls. Changes save immediately.
              </p>

              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={() => handleToggleLock(false)}
                  disabled={!form.attendeeChangesLocked && !lockSaving}
                  className={`flex-1 flex items-center gap-3 px-4 py-3 border-2 transition-all disabled:cursor-default ${
                    !form.attendeeChangesLocked
                      ? "border-green-500 bg-green-50"
                      : "border-border bg-white hover:border-muted-foreground"
                  }`}
                >
                  <Unlock
                    className={`w-5 h-5 flex-shrink-0 ${!form.attendeeChangesLocked ? "text-green-600" : "text-muted-foreground"}`}
                  />
                  <div className="text-left">
                    <p
                      className={`font-semibold text-sm ${!form.attendeeChangesLocked ? "text-green-700" : "text-foreground"}`}
                    >
                      Allow changes
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Attendees can update their details
                    </p>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => handleToggleLock(true)}
                  disabled={form.attendeeChangesLocked && !lockSaving}
                  className={`flex-1 flex items-center gap-3 px-4 py-3 border-2 transition-all disabled:cursor-default ${
                    form.attendeeChangesLocked
                      ? "border-red-400 bg-red-50"
                      : "border-border bg-white hover:border-muted-foreground"
                  }`}
                >
                  <Lock
                    className={`w-5 h-5 flex-shrink-0 ${form.attendeeChangesLocked ? "text-red-500" : "text-muted-foreground"}`}
                  />
                  <div className="text-left">
                    <p
                      className={`font-semibold text-sm ${form.attendeeChangesLocked ? "text-red-700" : "text-foreground"}`}
                    >
                      Lock changes
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Show message, disable edit controls
                    </p>
                  </div>
                </button>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                  Message shown when locked
                </label>
                <Textarea
                  rows={3}
                  value={form.attendeeChangesLockedMessage || DEFAULT_LOCKED_MESSAGE}
                  onChange={handleMessageChange}
                  className="text-sm resize-none"
                  placeholder={DEFAULT_LOCKED_MESSAGE}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Displayed prominently on the attendee management page when the lock is active.
                  Saves automatically after you stop typing.
                </p>
              </div>

              {lockError && <p className="text-sm text-destructive">{lockError}</p>}
            </div>
          </div>

          {/* ── Invoice Help Content ── */}
          <div className="bg-white border border-border">
            <div className="px-6 py-4 border-b border-border flex items-center gap-3">
              <Settings2 className="w-5 h-5 text-primary" />
              <h2 className="font-bold text-base">Invoice Help Content</h2>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-sm text-muted-foreground">
                Plain-text copy shown in the expandable <strong>"How invoicing works"</strong> block
                on the checkout payment step (when "Pay by Invoice" is selected) and embedded in
                invoice confirmation emails. Use blank lines to separate paragraphs; lines starting
                with <code className="text-xs bg-muted px-1 py-0.5 rounded">- </code> become
                bullets; the first line of a multi-line block is rendered as a bold heading. Leave
                empty to revert to the built-in default, or click{" "}
                <strong>Load default into editor</strong> below to start from the default and tweak
                it.
              </p>
              <Textarea
                rows={16}
                value={form.invoiceHelpContent ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, invoiceHelpContent: e.target.value }))}
                placeholder={DEFAULT_INVOICE_HELP_CONTENT}
                className="text-sm font-mono leading-relaxed"
              />
              {helpError && <p className="text-sm text-destructive">{helpError}</p>}
              <div className="flex justify-between items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    setForm((f) => ({ ...f, invoiceHelpContent: DEFAULT_INVOICE_HELP_CONTENT }))
                  }
                  disabled={helpSaving}
                  className="h-10 px-4"
                  title="Copy the built-in default into the editor so you can tweak it"
                >
                  Load default into editor
                </Button>
                <Button
                  type="button"
                  onClick={handleSaveInvoiceHelp}
                  disabled={helpSaving}
                  className={`h-10 px-6 ${helpSaved ? "bg-green-600 hover:bg-green-700" : "bg-primary hover:bg-primary/90"} text-white`}
                >
                  {helpSaved ? (
                    <span className="flex items-center gap-1.5">
                      <Check className="w-4 h-4" /> Saved
                    </span>
                  ) : helpSaving ? (
                    <span className="flex items-center gap-1.5">
                      <Loader2 className="w-4 h-4 animate-spin" /> Saving…
                    </span>
                  ) : (
                    "Save Invoice Help Content"
                  )}
                </Button>
              </div>
            </div>
          </div>

          {/* ── Booking Reference Format ── */}
          <div className="bg-white border border-border">
            <div className="px-6 py-4 border-b border-border flex items-center gap-3">
              <Settings2 className="w-5 h-5 text-primary" />
              <h2 className="font-bold text-base">Booking Reference Format</h2>
            </div>
            <div className="p-6 space-y-5">
              <p className="text-sm text-muted-foreground">
                References are generated as <strong>PREFIX-[OFFSET + booking ID]</strong>. Adjust
                these when re-running the system for a new event to keep reference sequences clean
                and avoid conflicts with previous years.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                    Prefix
                  </label>
                  <Input
                    value={form.refPrefix}
                    onChange={(e) => setForm((f) => ({ ...f, refPrefix: e.target.value }))}
                    placeholder="SWP27"
                    className="font-mono"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    e.g. SWP27 for next year's event
                  </p>
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                    Offset
                  </label>
                  <Input
                    type="number"
                    min={0}
                    value={form.refOffset}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, refOffset: parseInt(e.target.value, 10) || 0 }))
                    }
                    placeholder="6541"
                    className="font-mono"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Added to the booking ID to form the number
                  </p>
                </div>
              </div>

              {/* Preview */}
              <div className="bg-muted/40 border border-border rounded p-3 flex items-center gap-3">
                <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                  Preview:
                </span>
                <span className="font-mono text-sm font-semibold text-foreground">
                  {form.refPrefix.trim() || "PREFIX"}-{(form.refOffset || 0) + 1} &nbsp;/&nbsp;{" "}
                  {form.refPrefix.trim() || "PREFIX"}-{(form.refOffset || 0) + 2} &nbsp;/&nbsp; …
                </span>
              </div>

              {refError && <p className="text-sm text-destructive">{refError}</p>}

              <div className="flex justify-end">
                <Button
                  type="button"
                  onClick={handleSaveRef}
                  disabled={refSaving}
                  className={`h-10 px-6 ${refSaved ? "bg-green-600 hover:bg-green-700" : "bg-primary hover:bg-primary/90"} text-white`}
                >
                  {refSaved ? (
                    <span className="flex items-center gap-1.5">
                      <Check className="w-4 h-4" /> Saved
                    </span>
                  ) : refSaving ? (
                    <span className="flex items-center gap-1.5">
                      <Loader2 className="w-4 h-4 animate-spin" /> Saving…
                    </span>
                  ) : (
                    "Save Reference Format"
                  )}
                </Button>
              </div>
            </div>
          </div>

          {/* ── Production Secrets Checklist ── */}
          <div className="bg-white border border-border">
            <div className="px-6 py-4 border-b border-border flex items-center gap-3">
              <ShieldCheck className="w-5 h-5 text-primary" />
              <h2 className="font-bold text-base">Production Environment Secrets</h2>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-sm text-muted-foreground">
                All secrets below must be set in <strong>Replit → Secrets</strong> (the padlock icon
                in the sidebar) before publishing. These are never stored in code.
              </p>

              <div className="space-y-2">
                {(
                  [
                    {
                      key: "STRIPE_SECRET_KEY",
                      description:
                        "Stripe live secret key (starts with sk_live_…). Found in the Stripe Dashboard → Developers → API keys.",
                      required: true,
                    },
                    {
                      key: "STRIPE_WEBHOOK_SECRET",
                      description:
                        "Webhook signing secret from the Stripe Dashboard → Webhooks endpoint. Must point to https://register.swpsummit.com/api/stripe/webhook.",
                      required: true,
                    },
                    {
                      key: "DATABASE_URL",
                      description:
                        "PostgreSQL connection string. Auto-provisioned by Replit — do not change unless migrating to an external database.",
                      required: true,
                    },
                    {
                      key: "ADMIN_PASSWORD",
                      description:
                        "Password to log in to the admin panel at /admin. Choose a strong, unique password.",
                      required: true,
                    },
                    {
                      key: "SMTP_HOST",
                      description:
                        "Outbound email server hostname (e.g. smtp.resend.com or smtp.sendgrid.net).",
                      required: false,
                    },
                    {
                      key: "SMTP_PORT",
                      description: "SMTP port (typically 587 for TLS or 465 for SSL).",
                      required: false,
                    },
                    {
                      key: "SMTP_USER",
                      description: "SMTP username / API key for authentication.",
                      required: false,
                    },
                    {
                      key: "SMTP_PASS",
                      description: "SMTP password or API secret.",
                      required: false,
                    },
                  ] as { key: string; description: string; required: boolean }[]
                ).map(({ key, description, required }) => (
                  <div
                    key={key}
                    className="flex gap-3 items-start p-3 border border-border rounded bg-muted/20"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <code className="font-mono text-xs font-semibold text-foreground">
                          {key}
                        </code>
                        {required ? (
                          <span className="text-xs font-semibold px-1.5 py-0.5 rounded bg-red-100 text-red-700">
                            Required
                          </span>
                        ) : (
                          <span className="text-xs font-semibold px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                            Optional
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">{description}</p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded p-3 text-xs text-blue-800">
                <strong>Stripe live mode:</strong> Ensure{" "}
                <code className="bg-blue-100 px-1 py-0.5 rounded">STRIPE_SECRET_KEY</code> begins
                with <code className="bg-blue-100 px-1 py-0.5 rounded">sk_live_</code> (not{" "}
                <code className="bg-blue-100 px-1 py-0.5 rounded">sk_test_</code>) before
                publishing. The app uses whichever key is present — no code changes are needed to
                switch from test to live mode.
              </div>
            </div>
          </div>

          {/* ── Registration Form — Hear About Us Options ── */}
          <div className="bg-white border border-border">
            <div className="px-6 py-4 border-b border-border flex items-center gap-3">
              <ListChecks className="w-5 h-5 text-primary" />
              <h2 className="font-bold text-base">
                Registration Form — "How did you hear about us?"
              </h2>
            </div>
            <div className="p-6 space-y-6">
              <p className="text-sm text-muted-foreground">
                Manage the options shown in the "How did you hear about the event?" dropdown on the
                booking form. Changes take effect immediately for new registrations.
              </p>

              {hauLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading options…
                </div>
              ) : (
                <>
                  {/* Option list */}
                  <div className="border border-border rounded overflow-hidden divide-y divide-border">
                    {hauOptions.map((opt, idx) => (
                      <div
                        key={opt.id}
                        className="flex items-center gap-3 px-4 py-2.5 bg-white hover:bg-muted/20 transition-colors"
                      >
                        <div className="flex flex-col gap-0.5">
                          <button
                            type="button"
                            onClick={() => hauMoveOption(opt.id, "up")}
                            disabled={idx === 0}
                            className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-20 disabled:cursor-not-allowed transition-colors"
                          >
                            <ChevronUp className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => hauMoveOption(opt.id, "down")}
                            disabled={idx === hauOptions.length - 1}
                            className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-20 disabled:cursor-not-allowed transition-colors"
                          >
                            <ChevronDown className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <span className="flex-1 text-sm">{opt.label}</span>
                        <span
                          className={`text-xs font-semibold px-2 py-0.5 rounded-full ${opt.responseCount > 0 ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}
                        >
                          {opt.responseCount > 0 ? opt.responseCount : "—"}
                        </span>
                        <button
                          type="button"
                          onClick={() => hauDeleteOption(opt.id)}
                          className="p-1.5 rounded text-muted-foreground hover:text-red-600 hover:bg-red-50 transition-colors"
                          title="Delete option"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                    {hauOptions.length === 0 && (
                      <div className="px-4 py-6 text-sm text-muted-foreground text-center">
                        No options yet — add one below.
                      </div>
                    )}
                  </div>

                  {/* Add new option */}
                  <div className="flex gap-2">
                    <Input
                      value={hauNewLabel}
                      onChange={(e) => setHauNewLabel(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && hauAddOption()}
                      placeholder="New option label…"
                      className="h-9 flex-1"
                      disabled={hauAdding}
                    />
                    <Button
                      type="button"
                      onClick={hauAddOption}
                      disabled={hauAdding || !hauNewLabel.trim()}
                      size="sm"
                      className="h-9 px-4"
                    >
                      {hauAdding ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <>
                          <Plus className="w-4 h-4 mr-1.5" />
                          Add
                        </>
                      )}
                    </Button>
                  </div>

                  {/* Analytics summary */}
                  {hauTotalBookings > 0 && (
                    <div className="border border-border rounded p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                          Response Breakdown
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {hauTotalAnswered} of {hauTotalBookings} booking
                          {hauTotalBookings !== 1 ? "s" : ""} answered
                        </p>
                      </div>
                      {hauTotalAnswered > 0 ? (
                        <div className="space-y-2">
                          {hauOptions
                            .filter((o) => o.responseCount > 0)
                            .sort((a, b) => b.responseCount - a.responseCount)
                            .map((opt) => {
                              const pct = Math.round((opt.responseCount / hauTotalAnswered) * 100);
                              return (
                                <div key={opt.id} className="space-y-0.5">
                                  <div className="flex justify-between text-xs">
                                    <span className="text-foreground">{opt.label}</span>
                                    <span className="text-muted-foreground font-semibold">
                                      {opt.responseCount} ({pct}%)
                                    </span>
                                  </div>
                                  <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                                    <div
                                      className="h-full bg-primary rounded-full transition-all"
                                      style={{ width: `${pct}%` }}
                                    />
                                  </div>
                                </div>
                              );
                            })}
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">No responses recorded yet.</p>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* ── DNS / Domain Setup ── */}
          <div className="bg-white border border-border">
            <div className="px-6 py-4 border-b border-border flex items-center gap-3">
              <Globe className="w-5 h-5 text-primary" />
              <h2 className="font-bold text-base">Domain Setup — register.swpsummit.com</h2>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-sm text-muted-foreground">
                To make this app live at <strong>register.swpsummit.com</strong>, add a single DNS
                record in your Squarespace domain settings. No changes are needed to your main
                Squarespace website.
              </p>

              <div className="bg-amber-50 border border-amber-200 rounded p-4">
                <p className="text-sm font-semibold text-amber-800 mb-3">
                  Step-by-step instructions (Squarespace)
                </p>
                <ol className="text-sm text-amber-900 space-y-2 list-decimal list-inside">
                  <li>
                    Log in to <strong>Squarespace</strong> and go to{" "}
                    <strong>Settings → Domains</strong>.
                  </li>
                  <li>
                    Click on <strong>swpsummit.com</strong>, then open <strong>DNS Settings</strong>
                    .
                  </li>
                  <li>
                    Click <strong>Add Record</strong> and choose <strong>CNAME</strong>.
                  </li>
                  <li>
                    Set the fields as follows:
                    <div className="mt-2 font-mono text-xs bg-white border border-amber-300 rounded p-3 space-y-1">
                      <div>
                        <span className="text-muted-foreground w-16 inline-block">Type:</span> CNAME
                      </div>
                      <div>
                        <span className="text-muted-foreground w-16 inline-block">Host:</span>{" "}
                        register
                      </div>
                      <div>
                        <span className="text-muted-foreground w-16 inline-block">Points to:</span>{" "}
                        <em className="not-italic text-amber-800">
                          [Your Replit deployment domain — e.g. my-app.replit.app]
                        </em>
                      </div>
                    </div>
                  </li>
                  <li>Save the record.</li>
                </ol>
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded p-4 text-sm text-blue-800 space-y-1">
                <p>
                  <strong>Where to find your Replit deployment domain:</strong>
                </p>
                <p>
                  After publishing this project in Replit, click{" "}
                  <strong>Publish → View site</strong>. The domain shown (ending in{" "}
                  <code className="text-xs bg-blue-100 px-1 py-0.5 rounded">.replit.app</code>) is
                  what you enter in the <em>Points to</em> field above.
                </p>
              </div>

              <p className="text-xs text-muted-foreground">
                DNS propagation typically takes a few minutes on Squarespace, but may take up to 24
                hours in rare cases. Once propagated, the app will be live at{" "}
                <strong>https://register.swpsummit.com</strong> with a valid SSL certificate
                provided automatically by Replit.
              </p>

              <div className="bg-muted/40 border border-border rounded p-4 text-sm space-y-1">
                <p className="font-semibold text-xs uppercase tracking-wide text-muted-foreground mb-2">
                  Stripe Webhook — update after DNS is live
                </p>
                <p className="text-muted-foreground text-xs">
                  In the{" "}
                  <a
                    href="https://dashboard.stripe.com/webhooks"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-foreground"
                  >
                    Stripe Dashboard → Webhooks
                  </a>
                  , update the endpoint URL to:
                </p>
                <p className="font-mono text-xs bg-white border border-border rounded px-3 py-2 select-all">
                  https://register.swpsummit.com/api/stripe/webhook
                </p>
                <p className="text-muted-foreground text-xs">
                  Copy the new webhook signing secret and add it as the{" "}
                  <code className="text-xs bg-muted px-1 py-0.5 rounded">
                    STRIPE_WEBHOOK_SECRET
                  </code>{" "}
                  environment variable in Replit Secrets.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
