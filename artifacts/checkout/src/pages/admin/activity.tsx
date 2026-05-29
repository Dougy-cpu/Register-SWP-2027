import { useEffect, useState, useCallback } from "react";
import AdminLayout from "@/components/layout/AdminLayout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  AlertTriangle,
  CheckCircle2,
  Users,
  CreditCard,
  FileText,
  RefreshCw,
  UserCheck,
  Mail,
  Clock,
  TrendingUp,
  Hourglass,
  ShieldCheck,
  ShieldAlert,
  Shield,
  Tag,
  Percent,
  Ticket,
  Bell,
  Settings,
  Send,
} from "lucide-react";

function adminFetch(path: string, init?: RequestInit) {
  const token = localStorage.getItem("admin_token") || "";
  return fetch(path, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      "x-admin-token": token,
      "Content-Type": "application/json",
    },
  });
}

type FeedItem = {
  type: string;
  timestamp: string;
  booking?: {
    id: number;
    orderReference: string;
    billingName: string;
    billingCompany: string;
    billingEmail: string;
    billingPhone: string | null;
    totalAmount: number;
    quantity: number;
    passType: string;
    paymentMethod: string;
    status: string;
    invoiceDueDate: string | null;
  };
  attendee?: {
    id: number;
    firstName: string;
    lastName: string;
    jobTitle: string;
    company: string;
    workEmail: string;
    phone: string | null;
  };
  data?: Record<string, unknown>;
  actor?: string;
};

type Stats = {
  unpaidInvoices: number;
  tbcAttendees: number;
  emailFailures: number;
  totalThisMonth: number;
  partialCheckouts: number;
};

type ActivityResponse = {
  feed: FeedItem[];
  stats: Stats;
  unpaidInvoiceList: FeedItem["booking"][];
};

const EVENT_TYPE_CONFIG: Record<
  string,
  { label: string; icon: React.ElementType; color: string; bg: string }
> = {
  new_booking_card: {
    label: "New Card Payment",
    icon: CreditCard,
    color: "text-green-700",
    bg: "bg-green-50 border-green-200",
  },
  new_booking_invoice: {
    label: "New Invoice Request",
    icon: FileText,
    color: "text-blue-700",
    bg: "bg-blue-50 border-blue-200",
  },
  invoice_paid: {
    label: "Invoice Paid",
    icon: CheckCircle2,
    color: "text-emerald-700",
    bg: "bg-emerald-50 border-emerald-200",
  },
  invoice_overdue: {
    label: "Invoice Overdue",
    icon: AlertTriangle,
    color: "text-red-700",
    bg: "bg-red-50 border-red-200",
  },
  attendee_change: {
    label: "Attendee Updated",
    icon: UserCheck,
    color: "text-violet-700",
    bg: "bg-violet-50 border-violet-200",
  },
  tbc_filled: {
    label: "TBC Seat Filled",
    icon: Users,
    color: "text-orange-700",
    bg: "bg-orange-50 border-orange-200",
  },
  email_failure: {
    label: "Email Failed",
    icon: Mail,
    color: "text-red-700",
    bg: "bg-red-50 border-red-200",
  },
  partial_checkout: {
    label: "Partial Checkout",
    icon: Hourglass,
    color: "text-yellow-700",
    bg: "bg-yellow-50 border-yellow-200",
  },
  admin_login_success: {
    label: "Admin Login",
    icon: ShieldCheck,
    color: "text-slate-700",
    bg: "bg-slate-50 border-slate-200",
  },
  admin_login_failure: {
    label: "Failed Admin Login",
    icon: ShieldAlert,
    color: "text-red-700",
    bg: "bg-red-50 border-red-200",
  },
  admin_booking_status_changed: {
    label: "Booking Status Changed",
    icon: Shield,
    color: "text-indigo-700",
    bg: "bg-indigo-50 border-indigo-200",
  },
  admin_booking_updated: {
    label: "Booking Edited",
    icon: Shield,
    color: "text-indigo-700",
    bg: "bg-indigo-50 border-indigo-200",
  },
  admin_attendee_added: {
    label: "Attendee Added (Admin)",
    icon: UserCheck,
    color: "text-emerald-700",
    bg: "bg-emerald-50 border-emerald-200",
  },
  admin_attendee_updated: {
    label: "Attendee Edited (Admin)",
    icon: UserCheck,
    color: "text-indigo-700",
    bg: "bg-indigo-50 border-indigo-200",
  },
  admin_booking_deleted: {
    label: "Booking Deleted",
    icon: Shield,
    color: "text-red-700",
    bg: "bg-red-50 border-red-200",
  },
  admin_promo_created: {
    label: "Promo Code Created",
    icon: Tag,
    color: "text-emerald-700",
    bg: "bg-emerald-50 border-emerald-200",
  },
  admin_promo_updated: {
    label: "Promo Code Updated",
    icon: Tag,
    color: "text-indigo-700",
    bg: "bg-indigo-50 border-indigo-200",
  },
  admin_promo_deleted: {
    label: "Promo Code Deleted",
    icon: Tag,
    color: "text-red-700",
    bg: "bg-red-50 border-red-200",
  },
  admin_discount_tiers_updated: {
    label: "Discount Tiers Updated",
    icon: Percent,
    color: "text-indigo-700",
    bg: "bg-indigo-50 border-indigo-200",
  },
  admin_pass_inventory_updated: {
    label: "Pass Inventory Updated",
    icon: Ticket,
    color: "text-indigo-700",
    bg: "bg-indigo-50 border-indigo-200",
  },
  admin_pass_config_updated: {
    label: "Pass Config Updated",
    icon: Ticket,
    color: "text-indigo-700",
    bg: "bg-indigo-50 border-indigo-200",
  },
  admin_notification_email_added: {
    label: "Notification Email Added",
    icon: Bell,
    color: "text-emerald-700",
    bg: "bg-emerald-50 border-emerald-200",
  },
  admin_notification_email_updated: {
    label: "Notification Email Updated",
    icon: Bell,
    color: "text-indigo-700",
    bg: "bg-indigo-50 border-indigo-200",
  },
  admin_notification_email_deleted: {
    label: "Notification Email Deleted",
    icon: Bell,
    color: "text-red-700",
    bg: "bg-red-50 border-red-200",
  },
  admin_event_settings_updated: {
    label: "Event Settings Updated",
    icon: Settings,
    color: "text-indigo-700",
    bg: "bg-indigo-50 border-indigo-200",
  },
  admin_email_template_updated: {
    label: "Email Template Updated",
    icon: Mail,
    color: "text-indigo-700",
    bg: "bg-indigo-50 border-indigo-200",
  },
  admin_email_template_test_sent: {
    label: "Test Email Sent",
    icon: Send,
    color: "text-slate-700",
    bg: "bg-slate-50 border-slate-200",
  },
  admin_email_resent: {
    label: "Confirmation Resent",
    icon: Send,
    color: "text-slate-700",
    bg: "bg-slate-50 border-slate-200",
  },
  admin_invoice_reminder_sent: {
    label: "Invoice Reminder Sent",
    icon: Send,
    color: "text-slate-700",
    bg: "bg-slate-50 border-slate-200",
  },
  admin_hear_about_us_added: {
    label: "Channel Option Added",
    icon: Settings,
    color: "text-emerald-700",
    bg: "bg-emerald-50 border-emerald-200",
  },
  admin_hear_about_us_deleted: {
    label: "Channel Option Removed",
    icon: Settings,
    color: "text-red-700",
    bg: "bg-red-50 border-red-200",
  },
  admin_hear_about_us_moved: {
    label: "Channel Option Reordered",
    icon: Settings,
    color: "text-indigo-700",
    bg: "bg-indigo-50 border-indigo-200",
  },
};

const ADMIN_EVENT_TYPES = Object.keys(EVENT_TYPE_CONFIG).filter((k) => k.startsWith("admin_"));

function timeAgo(ts: string) {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatDate(ts: string) {
  return new Date(ts).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function FeedCard({ item }: { item: FeedItem }) {
  const cfg = EVENT_TYPE_CONFIG[item.type] || {
    label: item.type,
    icon: Clock,
    color: "text-slate-700",
    bg: "bg-slate-50 border-slate-200",
  };
  const Icon = cfg.icon;

  const passLabel = item.booking
    ? `${item.booking.quantity}× ${item.booking.passType === "single" ? "HR Pass" : "Business Pass"}`
    : null;

  const isOverdue =
    item.type === "invoice_overdue" ||
    (item.booking?.invoiceDueDate &&
      new Date(item.booking.invoiceDueDate) < new Date() &&
      item.booking.status === "invoiced");

  return (
    <div className={`flex gap-4 p-4 rounded-lg border ${cfg.bg}`}>
      <div
        className={`mt-0.5 w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${cfg.color} bg-white border border-current/20`}
      >
        <Icon className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div>
            <span className={`font-semibold text-sm ${cfg.color}`}>{cfg.label}</span>
            {item.booking && (
              <span className="ml-2 text-sm text-slate-600 font-mono">
                {item.booking.orderReference}
              </span>
            )}
            {isOverdue && (
              <Badge variant="destructive" className="ml-2 text-xs">
                Overdue
              </Badge>
            )}
          </div>
          <span
            className="text-xs text-slate-500 whitespace-nowrap"
            title={formatDate(item.timestamp)}
          >
            {timeAgo(item.timestamp)}
          </span>
        </div>

        {item.type === "partial_checkout" ? (
          <div className="mt-1.5 text-sm text-slate-700 space-y-0.5">
            {(item.attendee || item.booking) && (
              <div>
                <span className="font-semibold">
                  {item.attendee
                    ? `${item.attendee.firstName} ${item.attendee.lastName}`
                    : item.booking?.billingName || "—"}
                </span>
                {(item.attendee?.jobTitle ||
                  item.attendee?.company ||
                  item.booking?.billingCompany) && (
                  <span className="text-slate-500">
                    {item.attendee?.jobTitle ? ` · ${item.attendee.jobTitle}` : ""}
                    {item.attendee?.company || item.booking?.billingCompany
                      ? `, ${item.attendee?.company || item.booking?.billingCompany}`
                      : ""}
                  </span>
                )}
              </div>
            )}
            <div className="text-xs text-slate-500 space-x-3">
              {(item.attendee?.workEmail || item.booking?.billingEmail) && (
                <span>{item.attendee?.workEmail || item.booking?.billingEmail}</span>
              )}
              {(item.attendee?.phone || item.booking?.billingPhone) && (
                <span>{item.attendee?.phone || item.booking?.billingPhone}</span>
              )}
            </div>
            {passLabel && <div className="text-xs text-slate-500">{passLabel}</div>}
          </div>
        ) : (
          <>
            {item.booking && (
              <div className="mt-1 text-sm text-slate-700">
                <span className="font-medium">{item.booking.billingName}</span>
                {item.booking.billingCompany && (
                  <span className="text-slate-500"> · {item.booking.billingCompany}</span>
                )}
                <span className="text-slate-500"> · {passLabel}</span>
                <span className="ml-2 font-semibold text-slate-900">
                  £{item.booking.totalAmount.toLocaleString("en-GB", { minimumFractionDigits: 2 })}
                </span>
              </div>
            )}

            {item.attendee && (
              <div className="mt-1 text-sm text-slate-700">
                <span className="font-medium">
                  {item.attendee.firstName} {item.attendee.lastName}
                </span>
                <span className="text-slate-500">
                  {" "}
                  · {item.attendee.jobTitle}, {item.attendee.company}
                </span>
              </div>
            )}
          </>
        )}

        {item.type === "email_failure" && item.data && (
          <div className="mt-1 text-sm text-red-600">
            {String(item.data.emailType || "Email")} to {String(item.data.toEmail || "unknown")}
            {Boolean(item.data.error) && (
              <span className="block text-xs text-red-500 mt-0.5">{String(item.data.error)}</span>
            )}
          </div>
        )}

        {item.type.startsWith("admin_") && (
          <div className="mt-1 space-y-1">
            {item.data?.summary != null && (
              <div className="text-sm text-slate-700">{String(item.data.summary)}</div>
            )}
            {item.actor && (
              <div className="text-xs text-slate-500">
                Actor: <span className="font-mono">{item.actor}</span>
              </div>
            )}
            {item.data?.changes != null && typeof item.data.changes === "object" && (
              <details className="mt-1">
                <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-700">
                  View changes
                </summary>
                <pre className="mt-1 text-xs bg-white border border-slate-200 rounded p-2 overflow-x-auto">
                  {JSON.stringify(item.data.changes, null, 2)}
                </pre>
              </details>
            )}
          </div>
        )}

        {item.booking?.invoiceDueDate && item.booking.status === "invoiced" && (
          <div className="mt-1 text-xs text-slate-500">
            Due:{" "}
            {new Date(item.booking.invoiceDueDate).toLocaleDateString("en-GB", {
              day: "numeric",
              month: "short",
              year: "numeric",
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default function AdminActivity() {
  const [data, setData] = useState<ActivityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (showSpinner = false) => {
    if (showSpinner) setRefreshing(true);
    try {
      const res = await adminFetch("/api/admin/activity");
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(() => load(), 60000);
    return () => clearInterval(interval);
  }, [load]);

  const filterButtons = [
    { key: "all", label: "All Activity" },
    { key: "bookings", label: "Bookings" },
    { key: "invoices", label: "Invoices" },
    { key: "attendees", label: "Attendees" },
    { key: "partial", label: "Partial Checkouts" },
    { key: "alerts", label: "Alerts" },
    { key: "admin", label: "Admin Audit" },
  ];

  const filterMap: Record<string, string[]> = {
    all: Object.keys(EVENT_TYPE_CONFIG),
    bookings: ["new_booking_card", "new_booking_invoice"],
    invoices: ["new_booking_invoice", "invoice_paid", "invoice_overdue"],
    attendees: ["attendee_change", "tbc_filled"],
    partial: ["partial_checkout"],
    alerts: ["invoice_overdue", "email_failure", "admin_login_failure"],
    admin: ADMIN_EVENT_TYPES,
  };

  const filteredFeed = data?.feed.filter((item) => filterMap[filter]?.includes(item.type)) ?? [];

  const stats = data?.stats;

  return (
    <AdminLayout title="Activity">
      <div className="space-y-6">
        {/* Stat Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <Card
            className={`border-2 ${stats?.unpaidInvoices ? "border-amber-400 bg-amber-50" : "border-slate-200"}`}
          >
            <CardContent className="pt-5">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center">
                  <FileText className="w-5 h-5 text-amber-600" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-slate-900">
                    {stats?.unpaidInvoices ?? "—"}
                  </p>
                  <p className="text-xs text-slate-500 font-medium">Unpaid Invoices</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card
            className={`border-2 ${stats?.tbcAttendees ? "border-orange-400 bg-orange-50" : "border-slate-200"}`}
          >
            <CardContent className="pt-5">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-orange-100 flex items-center justify-center">
                  <Users className="w-5 h-5 text-orange-600" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-slate-900">{stats?.tbcAttendees ?? "—"}</p>
                  <p className="text-xs text-slate-500 font-medium">TBC Seats</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card
            className={`border-2 ${stats?.emailFailures ? "border-red-400 bg-red-50" : "border-slate-200"}`}
          >
            <CardContent className="pt-5">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
                  <Mail className="w-5 h-5 text-red-600" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-slate-900">{stats?.emailFailures ?? "—"}</p>
                  <p className="text-xs text-slate-500 font-medium">Email Failures</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-2 border-slate-200">
            <CardContent className="pt-5">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center">
                  <TrendingUp className="w-5 h-5 text-slate-600" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-slate-900">
                    {stats?.totalThisMonth ?? "—"}
                  </p>
                  <p className="text-xs text-slate-500 font-medium">This Month</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card
            className={`border-2 ${stats?.partialCheckouts ? "border-yellow-400 bg-yellow-50" : "border-slate-200"} cursor-pointer`}
            onClick={() => setFilter("partial")}
          >
            <CardContent className="pt-5">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-yellow-100 flex items-center justify-center">
                  <Hourglass className="w-5 h-5 text-yellow-600" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-slate-900">
                    {stats?.partialCheckouts ?? "—"}
                  </p>
                  <p className="text-xs text-slate-500 font-medium">Partial Checkouts</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Unpaid invoices alert panel */}
        {data?.unpaidInvoiceList && data.unpaidInvoiceList.length > 0 && (
          <Card className="border-2 border-amber-300 bg-amber-50">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2 text-amber-800">
                <AlertTriangle className="w-4 h-4" />
                Invoices Awaiting Payment ({data.unpaidInvoiceList.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="divide-y divide-amber-200">
                {data.unpaidInvoiceList.map((b) => {
                  if (!b) return null;
                  const isOverdue = b.invoiceDueDate && new Date(b.invoiceDueDate) < new Date();
                  return (
                    <div
                      key={b.id}
                      className="py-3 flex items-center justify-between gap-4 flex-wrap"
                    >
                      <div>
                        <span className="font-mono text-sm font-semibold text-amber-900">
                          {b.orderReference}
                        </span>
                        <span className="ml-3 text-sm text-slate-700">
                          {b.billingName}
                          {b.billingCompany && ` · ${b.billingCompany}`}
                        </span>
                        <span className="ml-3 font-semibold text-slate-900 text-sm">
                          £{b.totalAmount.toLocaleString("en-GB", { minimumFractionDigits: 2 })}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {b.invoiceDueDate && (
                          <span className="text-xs text-slate-500">
                            Due{" "}
                            {new Date(b.invoiceDueDate).toLocaleDateString("en-GB", {
                              day: "numeric",
                              month: "short",
                            })}
                          </span>
                        )}
                        {isOverdue ? (
                          <Badge variant="destructive">Overdue</Badge>
                        ) : (
                          <Badge variant="outline" className="border-amber-400 text-amber-700">
                            Awaiting
                          </Badge>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Activity Feed */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <CardTitle className="text-base">Activity Feed</CardTitle>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => load(true)}
                disabled={refreshing}
                className="gap-2"
              >
                <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>
            <div className="flex gap-2 flex-wrap mt-2">
              {filterButtons.map((fb) => (
                <button
                  key={fb.key}
                  onClick={() => setFilter(fb.key)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                    filter === fb.key
                      ? "bg-slate-900 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {fb.label}
                </button>
              ))}
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-16 text-slate-400">
                <RefreshCw className="w-6 h-6 animate-spin mr-2" />
                Loading activity…
              </div>
            ) : filteredFeed.length === 0 ? (
              <div className="text-center py-16 text-slate-400">
                <Clock className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p className="text-sm">No activity to show</p>
              </div>
            ) : (
              <div className="space-y-2">
                {filteredFeed.map((item, i) => (
                  <FeedCard key={i} item={item} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AdminLayout>
  );
}
