import { useState, useEffect, useRef, useCallback } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { useListEmailLogs, useResendBookingEmails } from "@workspace/api-client-react";
import AdminLayout from "@/components/layout/AdminLayout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  RefreshCcw,
  Send,
  Bold,
  Italic,
  Heading2,
  List,
  ListOrdered,
  Link2,
  Code,
  RotateCcw,
  ImageIcon,
  Upload,
  X,
  Loader2,
  CheckCircle2,
  FileCode2,
  Eye,
  Smartphone,
  Monitor,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const API_BASE = `${import.meta.env.BASE_URL}api`;

const EMAIL_LOG_TYPE_LABELS: Record<string, string> = {
  confirmation: "Confirmation",
  receipt: "Receipt",
  welcome: "Welcome",
  invoice: "Invoice",
  community_social: "Community Social",
  test: "Test",
};

function getAdminToken() {
  return localStorage.getItem("admin_token") || "";
}

// ─── TipTap Toolbar ───────────────────────────────────────────────────────────

function TipTapToolbar({
  editor,
  onImageUpload,
  htmlMode,
  onToggleHtmlMode,
}: {
  editor: ReturnType<typeof useEditor>;
  onImageUpload: () => void;
  htmlMode: boolean;
  onToggleHtmlMode: () => void;
}) {
  if (!editor) return null;

  const handleSetLink = () => {
    const url = window.prompt("Enter URL:");
    if (url) editor.chain().focus().setLink({ href: url }).run();
    else editor.chain().focus().unsetLink().run();
  };

  const btn = (
    active: boolean,
    onClick: () => void,
    title: string,
    children: React.ReactNode,
    disabled = false,
  ) => (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`p-1.5 rounded text-sm transition-colors ${
        disabled
          ? "text-muted-foreground/30 cursor-not-allowed"
          : active
            ? "bg-primary/10 text-primary"
            : "hover:bg-muted text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );

  const fmtDisabled = htmlMode;

  return (
    <div className="flex flex-wrap items-center gap-0.5 p-2 border-b border-border bg-muted/30">
      {btn(
        editor.isActive("bold"),
        () => editor.chain().focus().toggleBold().run(),
        "Bold",
        <Bold className="w-4 h-4" />,
        fmtDisabled,
      )}
      {btn(
        editor.isActive("italic"),
        () => editor.chain().focus().toggleItalic().run(),
        "Italic",
        <Italic className="w-4 h-4" />,
        fmtDisabled,
      )}
      <span className="w-px bg-border mx-1 self-stretch" />
      {btn(
        editor.isActive("heading", { level: 2 }),
        () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
        "Heading 2",
        <Heading2 className="w-4 h-4" />,
        fmtDisabled,
      )}
      <span className="w-px bg-border mx-1 self-stretch" />
      {btn(
        editor.isActive("bulletList"),
        () => editor.chain().focus().toggleBulletList().run(),
        "Bullet List",
        <List className="w-4 h-4" />,
        fmtDisabled,
      )}
      {btn(
        editor.isActive("orderedList"),
        () => editor.chain().focus().toggleOrderedList().run(),
        "Ordered List",
        <ListOrdered className="w-4 h-4" />,
        fmtDisabled,
      )}
      <span className="w-px bg-border mx-1 self-stretch" />
      {btn(
        editor.isActive("link"),
        handleSetLink,
        "Link",
        <Link2 className="w-4 h-4" />,
        fmtDisabled,
      )}
      {btn(
        editor.isActive("code"),
        () => editor.chain().focus().toggleCode().run(),
        "Inline Code",
        <Code className="w-4 h-4" />,
        fmtDisabled,
      )}
      {btn(false, onImageUpload, "Insert Image", <ImageIcon className="w-4 h-4" />)}
      <span className="w-px bg-border mx-1 self-stretch" />
      {btn(
        false,
        () => editor.chain().focus().undo().run(),
        "Undo",
        <RotateCcw className="w-4 h-4" />,
        fmtDisabled,
      )}
      <span className="ml-auto" />
      <button
        type="button"
        title={htmlMode ? "Switch to Visual editor" : "Switch to HTML / Source editor"}
        onClick={onToggleHtmlMode}
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-semibold transition-colors ${
          htmlMode
            ? "bg-primary text-primary-foreground"
            : "hover:bg-muted text-muted-foreground hover:text-foreground"
        }`}
      >
        <FileCode2 className="w-4 h-4" />
        {htmlMode ? "Visual" : "Source"}
      </button>
    </div>
  );
}

// ─── Template Editor ──────────────────────────────────────────────────────────

type TemplateType = "welcome" | "confirmation" | "community_social" | "invoice_reminder";

const TEMPLATE_LABELS: Record<TemplateType, string> = {
  welcome: "Welcome Email",
  confirmation: "Booking Confirmation",
  community_social: "Community Social",
  invoice_reminder: "Invoice Reminder",
};

type TemplateVariable = {
  tag: string;
  label: string;
  description: string;
};

const TEMPLATE_VARIABLES: Record<TemplateType, TemplateVariable[]> = {
  welcome: [
    { tag: "{{firstName}}", label: "First Name", description: "Recipient's first name" },
    {
      tag: "{{managementLink}}",
      label: "Manage Attendees Button",
      description:
        "Secure self-service button to manage attendee details — auto-generates a unique link per booking",
    },
    {
      tag: "{{eventCalendarLinks}}",
      label: "Main Event Calendar Block",
      description:
        "Branded block with Google / Outlook / .ics buttons for the main event. Renders only when start & end times are set in Settings.",
    },
    {
      tag: "{{socialCalendarLinks}}",
      label: "Social Calendar Block",
      description:
        "Branded block for an optional additional networking social. Empty unless the admin enables the social and saves its times.",
    },
    {
      tag: "{{calendarLinks}}",
      label: "Both Calendar Blocks",
      description:
        "Combined main event + social blocks. Use this if you want one placeholder for everything.",
    },
    {
      tag: "{{googleCalendarUrl}}",
      label: "Main Google URL",
      description: "Raw Google Calendar URL for the main event — drop into a custom button",
    },
    {
      tag: "{{outlookCalendarUrl}}",
      label: "Main Outlook URL",
      description: "Raw Outlook web deeplink for the main event",
    },
    {
      tag: "{{icsCalendarUrl}}",
      label: "Main .ics URL",
      description: "Public download URL for the main event .ics file",
    },
    {
      tag: "{{socialGoogleCalendarUrl}}",
      label: "Social Google URL",
      description: "Raw Google Calendar URL for the social (empty until enabled)",
    },
    {
      tag: "{{socialOutlookCalendarUrl}}",
      label: "Social Outlook URL",
      description: "Raw Outlook deeplink for the social (empty until enabled)",
    },
    {
      tag: "{{socialIcsCalendarUrl}}",
      label: "Social .ics URL",
      description: "Public download URL for the social .ics file (empty until enabled)",
    },
  ],
  confirmation: [
    { tag: "{{firstName}}", label: "First Name", description: "Lead attendee's first name" },
    {
      tag: "{{orderReference}}",
      label: "Order Reference",
      description: "Unique booking reference (e.g. SWP27-6542)",
    },
    {
      tag: "{{passLabel}}",
      label: "Pass Label",
      description: "Pass type name (e.g. Workforce Pass)",
    },
    { tag: "{{quantity}}", label: "Quantity", description: "Number of passes booked" },
    {
      tag: "{{quantityLabel}}",
      label: "Quantity Label",
      description: '"pass" or "passes" (singular/plural)',
    },
    {
      tag: "{{attendeesTable}}",
      label: "Attendees Table",
      description: "HTML table listing all registered attendees on this booking",
    },
    {
      tag: "{{priceSummary}}",
      label: "Price Summary",
      description: "Itemised price breakdown including subtotal, VAT, and any discounts",
    },
    { tag: "{{eventDate}}", label: "Event Date", description: "Date of the event (from Settings)" },
    { tag: "{{eventVenue}}", label: "Venue", description: "Venue name (from Settings)" },
    {
      tag: "{{eventVenuePostcode}}",
      label: "Venue Postcode",
      description: "Venue postcode (from Settings)",
    },
    {
      tag: "{{managementLink}}",
      label: "Manage Attendees Button",
      description:
        "Secure self-service button — lets the booking contact manage all attendee details",
    },
    {
      tag: "{{invoicePaymentButton}}",
      label: "Invoice Pay Button",
      description:
        "Online payment button — only rendered for invoice bookings, empty for card payments",
    },
    {
      tag: "{{poNumberSection}}",
      label: "PO Number Row",
      description:
        "Pre-built 'PO Number' row (label + value) — automatically empty when no PO is set, so it's safe to drop into the booking summary block.",
    },
    {
      tag: "{{poNumber}}",
      label: "PO Number (raw value)",
      description:
        "Just the PO number itself with no label or styling — empty when no PO is set. Use this if you want to position the label yourself.",
    },
    {
      tag: "{{eventCalendarLinks}}",
      label: "Main Event Calendar Block",
      description:
        "Branded block with Google / Outlook / .ics buttons for the main event. Renders only when start & end times are set in Settings.",
    },
    {
      tag: "{{socialCalendarLinks}}",
      label: "Social Calendar Block",
      description:
        "Branded block for an optional additional networking social. Empty unless the admin enables the social and saves its times.",
    },
    {
      tag: "{{calendarLinks}}",
      label: "Both Calendar Blocks",
      description:
        "Combined main event + social blocks. Use this if you want one placeholder for everything.",
    },
    {
      tag: "{{googleCalendarUrl}}",
      label: "Main Google URL",
      description: "Raw Google Calendar URL for the main event — drop into a custom button",
    },
    {
      tag: "{{outlookCalendarUrl}}",
      label: "Main Outlook URL",
      description: "Raw Outlook web deeplink for the main event",
    },
    {
      tag: "{{icsCalendarUrl}}",
      label: "Main .ics URL",
      description: "Public download URL for the main event .ics file",
    },
    {
      tag: "{{socialGoogleCalendarUrl}}",
      label: "Social Google URL",
      description: "Raw Google Calendar URL for the social (empty until enabled)",
    },
    {
      tag: "{{socialOutlookCalendarUrl}}",
      label: "Social Outlook URL",
      description: "Raw Outlook deeplink for the social (empty until enabled)",
    },
    {
      tag: "{{socialIcsCalendarUrl}}",
      label: "Social .ics URL",
      description: "Public download URL for the social .ics file (empty until enabled)",
    },
  ],
  community_social: [
    { tag: "{{firstName}}", label: "First Name", description: "Attendee's first name" },
    {
      tag: "{{eventName}}",
      label: "Event Name",
      description: "Event name from Event Settings",
    },
    {
      tag: "{{socialName}}",
      label: "Social Name",
      description: "Community Social name from Event Settings",
    },
    {
      tag: "{{socialVenue}}",
      label: "Social Venue",
      description: "Community Social venue and address from Event Settings",
    },
    {
      tag: "{{socialDate}}",
      label: "Social Date",
      description: "Community Social date from Event Settings",
    },
    {
      tag: "{{socialTime}}",
      label: "Social Time",
      description: "Community Social start time from Event Settings",
    },
    {
      tag: "{{socialDescription}}",
      label: "Social Description",
      description: "Community Social description from Event Settings",
    },
    {
      tag: "{{socialDetailsUrl}}",
      label: "Event Website URL",
      description: "SWP Summit website URL from Event Settings",
    },
    {
      tag: "{{socialMapUrl}}",
      label: "Venue Map URL",
      description: "Google Maps link generated from the Community Social venue",
    },
    {
      tag: "{{socialCalendarLinks}}",
      label: "Social Calendar Block",
      description: "Google, Outlook and calendar download links when the social is enabled",
    },
  ],
  invoice_reminder: [
    { tag: "{{firstName}}", label: "First Name", description: "Recipient's first name" },
    { tag: "{{recipientName}}", label: "Full Name", description: "Recipient's full name" },
    {
      tag: "{{orderReference}}",
      label: "Order Reference",
      description: "Unique booking reference",
    },
    { tag: "{{dueDate}}", label: "Due Date", description: "Invoice payment due date" },
    {
      tag: "{{payOnlineButton}}",
      label: "Pay Online Button",
      description: "Button linking to the online payment page for this booking",
    },
  ],
};

const TEMPLATE_DESCRIPTIONS: Record<TemplateType, string> = {
  welcome: "Sent as a personal follow-up after registration. Use this for a warm welcome message.",
  confirmation:
    "Sent automatically after every successful booking (card or invoice). Contains the attendee's order details.",
  community_social:
    "Sent manually from Registrations to every known non-TBC attendee on a confirmed booking. It is never sent automatically. Replies go to the configured From email address.",
  invoice_reminder:
    "Sent manually from the Registrations panel when clicking 'Send Reminder' on an invoiced booking. The order summary table, payment button, and bank transfer details are automatically appended — edit only the intro message here. The subject supports {{orderReference}}.",
};

const TEMPLATE_ATTACHMENTS: Record<TemplateType, string[]> = {
  welcome: [],
  confirmation: ["PDF VAT receipt (covers all attendees on the booking)"],
  community_social: [],
  invoice_reminder: ["Invoice PDF (itemised, with bank transfer and company details)"],
};

function TemplateEditor({ type }: { type: TemplateType }) {
  const { toast } = useToast();
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [subject, setSubject] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [testEmail, setTestEmail] = useState("");
  const [testName, setTestName] = useState("");
  const [isSendingTest, setIsSendingTest] = useState(false);

  // Source/HTML mode state
  const [htmlMode, setHtmlMode] = useState(false);
  const [rawHtml, setRawHtml] = useState("");

  // Live preview state
  const [previewHtml, setPreviewHtml] = useState<string>("");
  const [previewSubject, setPreviewSubject] = useState<string>("");
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [previewViewport, setPreviewViewport] = useState<"desktop" | "mobile">("desktop");
  const previewDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Recipient name used for the live preview ({{firstName}}, attendee row, etc).
  // Admins can type a name freely or pick from the most recent bookings so the
  // preview reads like the real thing instead of "Test User".
  const [previewName, setPreviewName] = useState<string>("");
  const [recentBookings, setRecentBookings] = useState<
    { id: number; leadName: string | null; orderReference: string | null }[]
  >([]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      Image.configure({ inline: false, allowBase64: true }),
    ],
    content: "",
    editorProps: {
      attributes: { class: "prose prose-sm max-w-none focus:outline-none min-h-[360px] px-4 py-3" },
    },
  });

  // Helper: get the current body text depending on which mode the admin is in.
  const getCurrentBody = useCallback(() => {
    if (htmlMode) return rawHtml;
    return editor?.getHTML() || "";
  }, [editor, htmlMode, rawHtml]);

  useEffect(() => {
    async function loadTemplate() {
      setIsLoading(true);
      try {
        const resp = await fetch(`${API_BASE}/email-templates/${type}`, {
          headers: { "x-admin-token": getAdminToken() },
        });
        if (resp.ok) {
          const data = await resp.json();
          setSubject(data.subject || "");
          if (editor && data.htmlBody) editor.commands.setContent(data.htmlBody);
          // Seed rawHtml so toggling to Source mode before any edit shows real content.
          setRawHtml(data.htmlBody || "");
        }
      } catch {
        /* ignore */
      }
      setIsLoading(false);
    }
    if (editor) loadTemplate();
  }, [type, editor]);

  // Pull a small set of recent bookings so the admin can preview the email as
  // a real recipient instead of "Test User". We only need the lead name + ref.
  useEffect(() => {
    let cancelled = false;
    async function loadRecent() {
      try {
        const resp = await fetch(`${API_BASE}/admin/registrations?page=1&limit=10`, {
          headers: { "x-admin-token": getAdminToken() },
        });
        if (!resp.ok) return;
        const data = await resp.json();
        if (cancelled) return;
        const items = (data.registrations || [])
          .map((r: { id: number; leadName: string | null; orderReference: string | null }) => ({
            id: r.id,
            leadName: r.leadName,
            orderReference: r.orderReference,
          }))
          .filter((r: { leadName: string | null }) => r.leadName && r.leadName.trim());
        setRecentBookings(items);
      } catch {
        /* ignore */
      }
    }
    loadRecent();
    return () => {
      cancelled = true;
    };
  }, []);

  // Toggle between Visual (TipTap) and Source (HTML textarea) modes.
  // Push the latest content across so neither side loses work.
  const handleToggleHtmlMode = useCallback(() => {
    if (!editor) return;
    if (!htmlMode) {
      // Visual -> Source: take the editor's current HTML.
      setRawHtml(editor.getHTML());
      setHtmlMode(true);
    } else {
      // Source -> Visual: push raw HTML back into TipTap. TipTap may strip
      // unknown tags/attributes; that's expected and matches editor capability.
      editor.commands.setContent(rawHtml);
      setHtmlMode(false);
    }
  }, [editor, htmlMode, rawHtml]);

  // Fetch the live preview from the server, which uses the same render path
  // as the real send so what admins see matches what recipients receive.
  const fetchPreview = useCallback(
    async (bodyOverride?: string, subjectOverride?: string) => {
      setIsPreviewLoading(true);
      try {
        const resp = await fetch(`${API_BASE}/email-templates/${type}/preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-admin-token": getAdminToken() },
          body: JSON.stringify({
            subject: subjectOverride ?? subject,
            htmlBody: bodyOverride ?? getCurrentBody(),
            toName: previewName || undefined,
          }),
        });
        if (resp.ok) {
          const data = await resp.json();
          setPreviewHtml(data.html || "");
          setPreviewSubject(data.subject || "");
        }
      } catch {
        /* ignore */
      }
      setIsPreviewLoading(false);
    },
    [type, subject, getCurrentBody, previewName],
  );

  // Debounce-refresh the preview whenever the body or subject changes.
  // We poll the editor body (TipTap doesn't expose a stable change ref here).
  const triggerPreviewRefresh = useCallback(() => {
    if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current);
    previewDebounceRef.current = setTimeout(() => {
      void fetchPreview();
    }, 400);
  }, [fetchPreview]);

  // Initial preview load + refresh when subject/rawHtml/htmlMode change.
  useEffect(() => {
    if (isLoading) return;
    triggerPreviewRefresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject, rawHtml, htmlMode, isLoading, previewName]);

  // Listen for TipTap content updates so the preview keeps up when typing in Visual mode.
  useEffect(() => {
    if (!editor || htmlMode) return;
    const handler = () => triggerPreviewRefresh();
    editor.on("update", handler);
    return () => {
      editor.off("update", handler);
    };
  }, [editor, htmlMode, triggerPreviewRefresh]);

  const handleSave = async () => {
    if (!editor) return;
    setIsSaving(true);
    try {
      const body = getCurrentBody();
      const resp = await fetch(`${API_BASE}/email-templates/${type}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-admin-token": getAdminToken() },
        body: JSON.stringify({ subject, htmlBody: body }),
      });
      if (!resp.ok) throw new Error("Failed to save");
      // After save, sync the other view so both modes show the canonical body.
      if (htmlMode) {
        editor.commands.setContent(body);
      } else {
        setRawHtml(body);
      }
      toast({
        title: "Template Saved",
        description: `${TEMPLATE_LABELS[type]} template updated successfully.`,
      });
    } catch {
      toast({
        title: "Save Failed",
        description: "Could not save the template.",
        variant: "destructive",
      });
    }
    setIsSaving(false);
  };

  const handleTestSend = async () => {
    if (!testEmail) {
      toast({
        title: "Email required",
        description: "Enter a recipient email address.",
        variant: "destructive",
      });
      return;
    }
    setIsSendingTest(true);
    try {
      const resp = await fetch(`${API_BASE}/email-templates/${type}/test-send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-token": getAdminToken() },
        body: JSON.stringify({ toEmail: testEmail, toName: testName || "Test User" }),
      });
      if (!resp.ok) throw new Error("Failed to send");
      toast({ title: "Test Email Sent", description: `Test sent to ${testEmail}.` });
    } catch {
      toast({
        title: "Send Failed",
        description: "Could not send test email.",
        variant: "destructive",
      });
    }
    setIsSendingTest(false);
  };

  const handleImageUpload = () => imageInputRef.current?.click();

  const handleImageFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !editor) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const src = ev.target?.result as string;
      if (src) editor.chain().focus().setImage({ src }).run();
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-white p-6 border border-border shadow-sm space-y-6">
        <div className="space-y-3">
          <div>
            <h3 className="text-lg font-bold mb-1">{TEMPLATE_LABELS[type]}</h3>
            <p className="text-sm text-muted-foreground">{TEMPLATE_DESCRIPTIONS[type]}</p>
          </div>
          {TEMPLATE_ATTACHMENTS[type].length > 0 && (
            <div className="flex items-start gap-2 text-sm bg-amber-50 border border-amber-200 rounded px-3 py-2">
              <span className="text-amber-600 mt-0.5">📎</span>
              <div>
                <span className="font-semibold text-amber-800">
                  Attachments sent with this email:
                </span>
                <ul className="mt-0.5 space-y-0.5 text-amber-700 list-disc list-inside">
                  {TEMPLATE_ATTACHMENTS[type].map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-bold uppercase tracking-wider">Subject Line</label>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} className="h-12" />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-bold uppercase tracking-wider">Email Body</label>
            <div className="border border-border rounded bg-slate-50 p-3 space-y-2">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
                Available Variables — click to insert at cursor
              </p>
              <div className="flex flex-wrap gap-2">
                {TEMPLATE_VARIABLES[type].map((v) => (
                  <button
                    key={v.tag}
                    type="button"
                    title={v.description}
                    onClick={() => {
                      if (htmlMode) {
                        setRawHtml((prev) => prev + v.tag);
                      } else if (editor) {
                        editor.chain().focus().insertContent(v.tag).run();
                      }
                    }}
                    className="group relative inline-flex flex-col items-start gap-0.5 px-2.5 py-1.5 rounded border border-slate-300 bg-white hover:border-primary hover:bg-primary/5 transition-colors text-left cursor-pointer"
                  >
                    <span className="font-mono text-xs font-semibold text-primary leading-tight">
                      {v.tag}
                    </span>
                    <span className="text-[10px] text-slate-500 leading-tight">{v.label}</span>
                    <span className="pointer-events-none absolute bottom-full left-0 mb-1.5 w-56 rounded bg-slate-900 text-white text-xs px-2.5 py-1.5 opacity-0 group-hover:opacity-100 transition-opacity z-10 shadow-lg leading-snug">
                      {v.description}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleImageFileChange}
            />

            {/* Editor + Live Preview side-by-side on lg+, stacked below */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Editor pane */}
              <div className="border border-border rounded overflow-hidden bg-white flex flex-col">
                <TipTapToolbar
                  editor={editor}
                  onImageUpload={handleImageUpload}
                  htmlMode={htmlMode}
                  onToggleHtmlMode={handleToggleHtmlMode}
                />
                {htmlMode ? (
                  <>
                    <Textarea
                      value={rawHtml}
                      onChange={(e) => setRawHtml(e.target.value)}
                      className="font-mono text-xs leading-relaxed min-h-[400px] border-0 rounded-none focus-visible:ring-0 resize-y"
                      spellCheck={false}
                      placeholder="Raw HTML — full control over markup. Switch back to Visual to use rich-text editing."
                    />
                    <p className="text-[11px] text-amber-700 bg-amber-50 border-t border-amber-200 px-3 py-1.5 leading-snug">
                      Heads up: switching back to Visual may simplify advanced HTML (TipTap can
                      strip unknown tags or attributes). Save first if you want to keep the raw
                      version exactly as written.
                    </p>
                  </>
                ) : (
                  <EditorContent editor={editor} />
                )}
              </div>

              {/* Preview pane */}
              <div className="border border-border rounded overflow-hidden bg-slate-100 flex flex-col">
                <div className="flex items-center justify-between gap-2 p-2 border-b border-border bg-muted/30">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                    <Eye className="w-4 h-4" />
                    <span>Live Preview</span>
                    {isPreviewLoading && (
                      <span className="flex items-center gap-1 text-[10px] font-normal text-slate-400 ml-1">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Updating…
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      title="Desktop preview (600px)"
                      onClick={() => setPreviewViewport("desktop")}
                      className={`p-1.5 rounded transition-colors ${previewViewport === "desktop" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted"}`}
                    >
                      <Monitor className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      title="Mobile preview (375px)"
                      onClick={() => setPreviewViewport("mobile")}
                      className={`p-1.5 rounded transition-colors ${previewViewport === "mobile" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted"}`}
                    >
                      <Smartphone className="w-4 h-4" />
                    </button>
                    <span className="w-px bg-border mx-1 self-stretch" />
                    <button
                      type="button"
                      title="Refresh preview"
                      onClick={() => fetchPreview()}
                      className="p-1.5 rounded text-muted-foreground hover:bg-muted transition-colors"
                    >
                      <RefreshCcw className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs border-b border-border bg-white">
                  <span className="font-bold uppercase tracking-wider text-slate-500">
                    Preview as:
                  </span>
                  <Input
                    type="text"
                    value={previewName}
                    onChange={(e) => setPreviewName(e.target.value)}
                    placeholder="Test User"
                    className="h-7 text-xs w-44"
                  />
                  {recentBookings.length > 0 && (
                    <select
                      value=""
                      onChange={(e) => {
                        const name = e.target.value;
                        if (name) setPreviewName(name);
                      }}
                      className="h-7 text-xs border border-input bg-background rounded px-2"
                      title="Pick a recent booking's lead name"
                    >
                      <option value="">Recent bookings…</option>
                      {recentBookings.map((b) => (
                        <option key={b.id} value={b.leadName || ""}>
                          {b.leadName}
                          {b.orderReference ? ` — ${b.orderReference}` : ""}
                        </option>
                      ))}
                    </select>
                  )}
                  {previewName && (
                    <button
                      type="button"
                      onClick={() => setPreviewName("")}
                      className="text-[11px] text-slate-500 hover:text-slate-700 underline"
                    >
                      Reset
                    </button>
                  )}
                </div>
                {previewSubject && (
                  <div className="px-3 py-2 text-xs border-b border-border bg-white">
                    <span className="font-bold uppercase tracking-wider text-slate-500 mr-2">
                      Subject:
                    </span>
                    <span className="text-slate-700">{previewSubject}</span>
                  </div>
                )}
                <div className="flex-1 overflow-auto p-3 flex justify-center">
                  <iframe
                    title="Email Preview"
                    sandbox="allow-popups"
                    srcDoc={previewHtml}
                    className="bg-white border border-slate-200 shadow-sm"
                    style={{
                      width: previewViewport === "mobile" ? "375px" : "100%",
                      maxWidth: previewViewport === "mobile" ? "375px" : "600px",
                      minHeight: "600px",
                      height: "100%",
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="flex justify-end pt-4 border-t border-border">
          <Button onClick={handleSave} disabled={isSaving} size="lg" className="px-8">
            {isSaving ? "Saving..." : "Save Template"}
          </Button>
        </div>
      </div>

      <div className="bg-white p-6 border border-border shadow-sm space-y-4">
        <div>
          <h3 className="text-base font-bold mb-1">Send Test Email</h3>
          <p className="text-sm text-muted-foreground">
            Verify the current saved template before going live.
          </p>
        </div>
        <div className="flex gap-3 flex-wrap">
          <Input
            type="text"
            placeholder="Recipient name (optional)"
            value={testName}
            onChange={(e) => setTestName(e.target.value)}
            className="h-10 w-56"
          />
          <Input
            type="email"
            placeholder="test@example.com"
            value={testEmail}
            onChange={(e) => setTestEmail(e.target.value)}
            className="h-10 w-64"
          />
          <Button onClick={handleTestSend} disabled={isSendingTest} className="h-10 px-6">
            <Send className="w-4 h-4 mr-2" />
            {isSendingTest ? "Sending..." : "Send Test"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Branding Settings ────────────────────────────────────────────────────────

type EventSettingsData = {
  id: number;
  eventName: string;
  eventDate: string;
  eventVenue: string;
  eventVenuePostcode: string;
  orgName: string;
  orgAddress: string;
  orgWebsite: string;
  logoDataUrl: string | null;
  fromName: string;
  fromEmail: string;
};

function BrandingSettings() {
  const { toast } = useToast();
  const logoInputRef = useRef<HTMLInputElement>(null);
  const [settings, setSettings] = useState<EventSettingsData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    async function load() {
      setIsLoading(true);
      try {
        const resp = await fetch(`${API_BASE}/admin/event-settings`, {
          headers: { "x-admin-token": getAdminToken() },
        });
        if (resp.ok) setSettings(await resp.json());
      } catch {
        /* ignore */
      }
      setIsLoading(false);
    }
    load();
  }, []);

  const handleSave = async () => {
    if (!settings) return;
    setIsSaving(true);
    try {
      const resp = await fetch(`${API_BASE}/admin/event-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-admin-token": getAdminToken() },
        body: JSON.stringify(settings),
      });
      if (!resp.ok) throw new Error("Failed to save");
      const updated = await resp.json();
      setSettings(updated);
      toast({
        title: "Settings Saved",
        description:
          "Branding and event settings have been updated. All future emails will use the new settings.",
      });
    } catch {
      toast({
        title: "Save Failed",
        description: "Could not save settings.",
        variant: "destructive",
      });
    }
    setIsSaving(false);
  };

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !settings) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const src = ev.target?.result as string;
      if (src) setSettings((s) => (s ? { ...s, logoDataUrl: src } : s));
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const set = (key: keyof EventSettingsData, value: string | null) => {
    setSettings((s) => (s ? { ...s, [key]: value } : s));
  };

  if (isLoading || !settings) {
    return (
      <div className="flex justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  const field = (
    label: string,
    key: keyof EventSettingsData,
    placeholder?: string,
    hint?: string,
  ) => (
    <div className="space-y-1">
      <label className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
        {label}
      </label>
      <Input
        value={(settings[key] as string) || ""}
        onChange={(e) => set(key, e.target.value)}
        placeholder={placeholder}
        className="h-11"
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Logo */}
      <div className="bg-white p-6 border border-border shadow-sm space-y-4">
        <div>
          <h3 className="text-lg font-bold mb-1">Logo</h3>
          <p className="text-sm text-muted-foreground">
            Upload your logo — it will appear at the top of all outgoing emails in place of the text
            header.
          </p>
        </div>
        <div className="flex items-center gap-6">
          {settings.logoDataUrl ? (
            <div className="relative border border-border rounded p-3 bg-muted/20">
              <img
                src={settings.logoDataUrl}
                alt="Logo preview"
                className="max-h-16 max-w-48 object-contain"
              />
              <button
                type="button"
                onClick={() => set("logoDataUrl", null)}
                className="absolute -top-2 -right-2 w-5 h-5 bg-destructive text-white rounded-full flex items-center justify-center text-xs"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ) : (
            <div className="border-2 border-dashed border-border rounded p-6 text-center text-muted-foreground w-48">
              <ImageIcon className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p className="text-xs">No logo uploaded</p>
            </div>
          )}
          <div>
            <input
              ref={logoInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleLogoUpload}
            />
            <Button
              variant="outline"
              onClick={() => logoInputRef.current?.click()}
              className="gap-2"
            >
              <Upload className="w-4 h-4" />
              {settings.logoDataUrl ? "Replace Logo" : "Upload Logo"}
            </Button>
            <p className="text-xs text-muted-foreground mt-2">
              PNG, JPG or SVG recommended. Max 2MB.
            </p>
          </div>
        </div>
      </div>

      {/* Event Details */}
      <div className="bg-white p-6 border border-border shadow-sm space-y-4">
        <h3 className="text-lg font-bold">Event Details</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {field(
            "Event Name",
            "eventName",
            "SWP Summit",
            "Appears in email subject lines and body text.",
          )}
          {field("Event Date", "eventDate", "Wednesday, 3 March 2027")}
          {field("Venue", "eventVenue", "1 Basinghall Avenue, London")}
          {field("Venue Postcode", "eventVenuePostcode", "EC2V 5DD")}
        </div>
      </div>

      {/* Organisation */}
      <div className="bg-white p-6 border border-border shadow-sm space-y-4">
        <h3 className="text-lg font-bold">Organisation</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {field(
            "Organisation Name",
            "orgName",
            "People Strategy Hub Ltd",
            "Shown in email footers.",
          )}
          {field("Organisation Address", "orgAddress", "London, UK")}
          {field("Website URL", "orgWebsite", "https://swpsummit.com")}
        </div>
      </div>

      {/* Sender Details */}
      <div className="bg-white p-6 border border-border shadow-sm space-y-4">
        <div>
          <h3 className="text-lg font-bold mb-1">Sender Details</h3>
          <p className="text-sm text-muted-foreground">
            The display name and address that appears in recipients' inboxes. Note: the SMTP server
            must be configured to allow this sender address.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {field(
            "Sender Name",
            "fromName",
            "SWP Summit",
            'Shown as the "From" name in email clients.',
          )}
          {field(
            "Sender Email",
            "fromEmail",
            "douglas@peoplestrategyhub.com",
            "Must match your SMTP authentication.",
          )}
        </div>
      </div>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={isSaving} size="lg" className="px-10">
          {isSaving ? "Saving..." : "Save All Settings"}
        </Button>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AdminEmails() {
  const { toast } = useToast();

  const [activeTab, setActiveTab] = useState("branding");
  const [page, setPage] = useState(1);

  const { data: logsData, isLoading: logsLoading } = useListEmailLogs(
    { page, limit: 20 },
    { query: { queryKey: ["emailLogs", page] } },
  );

  const resendEmails = useResendBookingEmails();
  const [sendingLogIds, setSendingLogIds] = useState<Set<number>>(new Set());
  const [sentLogIds, setSentLogIds] = useState<Set<number>>(new Set());

  const handleResend = async (logId: number, bookingId: number, type: string) => {
    if (sendingLogIds.has(logId)) return;
    setSendingLogIds((prev) => new Set(prev).add(logId));
    setSentLogIds((prev) => {
      const s = new Set(prev);
      s.delete(logId);
      return s;
    });
    try {
      if (type === "community_social") {
        const response = await fetch(
          `${API_BASE}/admin/registrations/${bookingId}/send-community-social-email`,
          {
            method: "POST",
            headers: { "x-admin-token": getAdminToken() },
          },
        );
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || "Community Social email could not be sent");
        }
      } else {
        await resendEmails.mutateAsync({ bookingId });
      }
      setSentLogIds((prev) => new Set(prev).add(logId));
      toast({
        title: type === "community_social" ? "Community Social email sent" : "Emails resent",
        description:
          type === "community_social"
            ? `Community Social emails for booking #${bookingId} have been sent.`
            : `Confirmation emails for booking #${bookingId} have been resent.`,
      });
      setTimeout(
        () =>
          setSentLogIds((prev) => {
            const s = new Set(prev);
            s.delete(logId);
            return s;
          }),
        3000,
      );
    } catch (error) {
      toast({
        title: "Failed to resend",
        description:
          error instanceof Error ? error.message : "Something went wrong. Please try again.",
        variant: "destructive",
      });
    } finally {
      setSendingLogIds((prev) => {
        const s = new Set(prev);
        s.delete(logId);
        return s;
      });
    }
  };

  return (
    <AdminLayout title="Email Communications">
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="bg-white border border-border h-12 w-full justify-start rounded-none mb-6 overflow-x-auto">
          <TabsTrigger
            value="branding"
            className="data-[state=active]:bg-primary/10 data-[state=active]:text-primary h-full px-6 rounded-none whitespace-nowrap"
          >
            Branding & Settings
          </TabsTrigger>
          <TabsTrigger
            value="welcome"
            className="data-[state=active]:bg-primary/10 data-[state=active]:text-primary h-full px-6 rounded-none whitespace-nowrap"
          >
            Welcome Email
          </TabsTrigger>
          <TabsTrigger
            value="confirmation"
            className="data-[state=active]:bg-primary/10 data-[state=active]:text-primary h-full px-6 rounded-none whitespace-nowrap"
          >
            Booking Confirmation
          </TabsTrigger>
          <TabsTrigger
            value="community_social"
            className="data-[state=active]:bg-primary/10 data-[state=active]:text-primary h-full px-6 rounded-none whitespace-nowrap"
          >
            Community Social
          </TabsTrigger>
          <TabsTrigger
            value="invoice_reminder"
            className="data-[state=active]:bg-primary/10 data-[state=active]:text-primary h-full px-6 rounded-none whitespace-nowrap"
          >
            Invoice Reminder
          </TabsTrigger>
          <TabsTrigger
            value="logs"
            className="data-[state=active]:bg-primary/10 data-[state=active]:text-primary h-full px-6 rounded-none whitespace-nowrap"
          >
            Email Logs
          </TabsTrigger>
        </TabsList>

        <TabsContent value="branding">
          <BrandingSettings />
        </TabsContent>

        <TabsContent value="welcome">
          <TemplateEditor type="welcome" />
        </TabsContent>

        <TabsContent value="confirmation">
          <TemplateEditor type="confirmation" />
        </TabsContent>

        <TabsContent value="community_social">
          <TemplateEditor type="community_social" />
        </TabsContent>

        <TabsContent value="invoice_reminder">
          <TemplateEditor type="invoice_reminder" />
        </TabsContent>

        <TabsContent value="logs">
          <div className="bg-white border border-border shadow-sm">
            {logsLoading ? (
              <div className="flex justify-center py-20">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
              </div>
            ) : (
              <>
                <Table>
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Recipient</TableHead>
                      <TableHead>Booking #</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {logsData?.logs.map((log) => (
                      <TableRow key={log.id}>
                        <TableCell className="text-sm">
                          {new Date(log.sentAt).toLocaleString()}
                        </TableCell>
                        <TableCell>{EMAIL_LOG_TYPE_LABELS[log.type] || log.type}</TableCell>
                        <TableCell>{log.recipient}</TableCell>
                        <TableCell>{log.bookingId || "-"}</TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              log.status === "sent"
                                ? "default"
                                : log.status === "failed"
                                  ? "destructive"
                                  : "secondary"
                            }
                            className="uppercase text-[10px]"
                          >
                            {log.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          {log.bookingId && (
                            <Button
                              variant={sentLogIds.has(log.id) ? "default" : "outline"}
                              size="sm"
                              onClick={() => handleResend(log.id, log.bookingId!, log.type)}
                              disabled={sendingLogIds.has(log.id)}
                              className={`h-8 px-3 min-w-[100px] transition-all ${sentLogIds.has(log.id) ? "bg-green-600 hover:bg-green-700 text-white border-green-600" : ""}`}
                            >
                              {sendingLogIds.has(log.id) ? (
                                <>
                                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Sending…
                                </>
                              ) : sentLogIds.has(log.id) ? (
                                <>
                                  <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" /> Sent
                                </>
                              ) : (
                                <>
                                  <RefreshCcw className="w-3.5 h-3.5 mr-1.5" /> Resend
                                </>
                              )}
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                    {logsData?.logs.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center py-12 text-muted-foreground">
                          No email logs found.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>

                {logsData && logsData.total > 0 && (
                  <div className="p-4 border-t border-border flex justify-between items-center bg-muted/20">
                    <p className="text-sm text-muted-foreground">
                      Showing {(page - 1) * logsData.limit + 1}–
                      {Math.min(page * logsData.limit, logsData.total)} of {logsData.total}
                    </p>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        disabled={page === 1}
                        onClick={() => setPage((p) => p - 1)}
                      >
                        Previous
                      </Button>
                      <Button
                        variant="outline"
                        disabled={page * logsData.limit >= logsData.total}
                        onClick={() => setPage((p) => p + 1)}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </AdminLayout>
  );
}
