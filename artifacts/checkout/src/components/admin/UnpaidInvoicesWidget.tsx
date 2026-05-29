import { useState } from "react";
import {
  useGetUnpaidInvoicesSummary,
  useListUnpaidInvoices,
  useBulkRemindUnpaidInvoices,
  useSendInvoiceReminder,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, ArrowUpDown, Clock, Send } from "lucide-react";

type Bucket = "0-7" | "8-14" | "15+";
type SortKey = "daysOutstanding" | "totalAmount" | "lastReminder" | "orderReference";
type SortOrder = "asc" | "desc";

const BUCKET_META: Record<
  Bucket,
  { label: string; description: string; tone: string; icon: typeof Clock }
> = {
  "0-7": {
    label: "0–7 days",
    description: "Recently issued",
    tone: "border-l-green-500",
    icon: Clock,
  },
  "8-14": {
    label: "8–14 days",
    description: "Due soon",
    tone: "border-l-amber-500",
    icon: Clock,
  },
  "15+": {
    label: "15+ days",
    description: "Overdue",
    tone: "border-l-red-500",
    icon: AlertTriangle,
  },
};

const PAGE_SIZE = 25;

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export default function UnpaidInvoicesWidget() {
  const [openBucket, setOpenBucket] = useState<Bucket | null>(null);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const {
    data: summary,
    isLoading: summaryLoading,
    isError: summaryError,
    error: summaryErr,
    refetch: refetchSummary,
  } = useGetUnpaidInvoicesSummary({
    query: { queryKey: ["unpaidInvoicesSummary"] },
  });

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["unpaidInvoicesSummary"] });
    queryClient.invalidateQueries({ queryKey: ["unpaidInvoicesList"] });
  };

  const sendReminder = useSendInvoiceReminder({
    mutation: {
      onSuccess: () => {
        toast({ title: "Reminder sent" });
        invalidateAll();
      },
      onError: (err: unknown) => {
        toast({
          title: "Failed to send reminder",
          description: err instanceof Error ? err.message : "Unknown error",
          variant: "destructive",
        });
      },
    },
  });

  const bulkRemind = useBulkRemindUnpaidInvoices({
    mutation: {
      onSuccess: (data: { sent: number; attempted: number; failed: number }) => {
        toast({
          title: `Sent ${data.sent} of ${data.attempted} reminders`,
          description: data.failed > 0 ? `${data.failed} failed — check server logs` : undefined,
          variant: data.failed > 0 ? "destructive" : "default",
        });
        invalidateAll();
        setConfirmBulk(false);
      },
      onError: (err: unknown) => {
        toast({
          title: "Bulk send failed",
          description: err instanceof Error ? err.message : "Unknown error",
          variant: "destructive",
        });
      },
    },
  });

  if (summaryError) {
    return (
      <Card className="p-6 border-border rounded-sm shadow-sm border-l-4 border-l-red-500">
        <p className="font-bold text-sm">Failed to load unpaid invoices</p>
        <p className="text-xs text-muted-foreground mt-1">
          {summaryErr instanceof Error ? summaryErr.message : "Unknown error"}
        </p>
        <Button size="sm" variant="outline" className="mt-3" onClick={() => refetchSummary()}>
          Retry
        </Button>
      </Card>
    );
  }

  if (summaryLoading || !summary) {
    return (
      <Card className="p-6 border-border rounded-sm shadow-sm">
        <p className="text-muted-foreground text-sm">Loading unpaid invoices…</p>
      </Card>
    );
  }

  return (
    <>
      <div className="space-y-4">
        <div className="flex items-end justify-between">
          <div>
            <h3 className="text-xl font-bold">Unpaid Invoices</h3>
            <p className="text-xs text-muted-foreground mt-1">
              {summary.totalUnpaid} unpaid •{" "}
              <span className="font-medium">£{summary.totalOutstanding.toLocaleString()}</span>{" "}
              outstanding
            </p>
            <p
              className="text-[11px] text-muted-foreground/80 mt-0.5"
              title="Buckets are based on days since the booking was created (≈ invoice issue date)."
            >
              Bucketed by days since invoice issued
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {(Object.keys(BUCKET_META) as Bucket[]).map((bucket) => {
            const meta = BUCKET_META[bucket];
            const data = summary.buckets[bucket];
            const Icon = meta.icon;
            return (
              <Card
                key={bucket}
                className={`p-5 border-l-4 rounded-sm shadow-sm cursor-pointer hover:shadow-md transition ${meta.tone}`}
                onClick={() => setOpenBucket(bucket)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") setOpenBucket(bucket);
                }}
              >
                <div className="flex justify-between items-start">
                  <div>
                    <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1">
                      {meta.label}
                    </p>
                    <h4 className="text-3xl font-bold">{data.count}</h4>
                  </div>
                  <Icon className="w-5 h-5 text-muted-foreground" />
                </div>
                <p className="text-xs text-muted-foreground mt-3">
                  {meta.description} • £{data.totalAmount.toLocaleString()}
                </p>
              </Card>
            );
          })}
        </div>
      </div>

      <Dialog open={openBucket !== null} onOpenChange={(o) => !o && setOpenBucket(null)}>
        <DialogContent className="max-w-5xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>
              Unpaid invoices — {openBucket ? BUCKET_META[openBucket].label : ""}
            </DialogTitle>
            <DialogDescription>
              {openBucket === "15+"
                ? "These bookings are overdue. You can send a reminder to all of them at once."
                : "Click 'Send reminder' to email an individual customer."}
            </DialogDescription>
          </DialogHeader>

          {openBucket === "15+" && summary.buckets["15+"].count > 0 && (
            <div className="flex justify-end pb-2">
              <Button
                variant="default"
                size="sm"
                onClick={() => setConfirmBulk(true)}
                disabled={bulkRemind.isPending}
              >
                <Send className="w-4 h-4 mr-2" />
                Send reminder to all {summary.buckets["15+"].count}
              </Button>
            </div>
          )}

          <div className="overflow-auto flex-1">
            {openBucket && (
              <UnpaidInvoicesTable
                bucket={openBucket}
                onSendReminder={(bookingId) => sendReminder.mutate({ bookingId })}
                sendingId={sendReminder.isPending ? sendReminder.variables?.bookingId : undefined}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmBulk} onOpenChange={setConfirmBulk}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send reminders to all 15+ day overdue bookings?</AlertDialogTitle>
            <AlertDialogDescription>
              This will email {summary.buckets["15+"].count} billing contact
              {summary.buckets["15+"].count === 1 ? "" : "s"}. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkRemind.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                bulkRemind.mutate({ data: { bucket: "15+" } });
              }}
              disabled={bulkRemind.isPending}
            >
              {bulkRemind.isPending ? "Sending…" : "Send reminders"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function SortableTh({
  label,
  field,
  active,
  order,
  onSort,
  align = "left",
}: {
  label: string;
  field: SortKey;
  active: SortKey;
  order: SortOrder;
  onSort: (f: SortKey) => void;
  align?: "left" | "right";
}) {
  const isActive = active === field;
  return (
    <th
      className={`px-4 py-3 select-none cursor-pointer hover:text-foreground ${
        align === "right" ? "text-right" : ""
      }`}
      onClick={() => onSort(field)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <ArrowUpDown
          className={`w-3 h-3 ${isActive ? "text-foreground" : "text-muted-foreground/40"}`}
        />
        {isActive && <span className="text-[10px]">{order === "asc" ? "↑" : "↓"}</span>}
      </span>
    </th>
  );
}

function UnpaidInvoicesTable({
  bucket,
  onSendReminder,
  sendingId,
}: {
  bucket: Bucket;
  onSendReminder: (bookingId: number) => void;
  sendingId: number | undefined;
}) {
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortKey>("daysOutstanding");
  const [order, setOrder] = useState<SortOrder>("desc");

  const { data, isLoading, isError, error, refetch } = useListUnpaidInvoices(
    { bucket, page, limit: PAGE_SIZE, sort, order },
    { query: { queryKey: ["unpaidInvoicesList", bucket, page, sort, order] } },
  );

  const handleSort = (field: SortKey) => {
    if (field === sort) {
      setOrder(order === "asc" ? "desc" : "asc");
    } else {
      setSort(field);
      setOrder("desc");
    }
    setPage(1);
  };

  if (isError) {
    return (
      <div className="py-6 text-center">
        <p className="text-sm font-bold text-red-700">Failed to load invoices</p>
        <p className="text-xs text-muted-foreground mt-1">
          {error instanceof Error ? error.message : "Unknown error"}
        </p>
        <Button size="sm" variant="outline" className="mt-3" onClick={() => refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  if (isLoading || !data) {
    return <p className="text-muted-foreground text-sm py-4">Loading…</p>;
  }

  if (data.rows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm py-8 text-center">
        No unpaid invoices in this bucket.
      </p>
    );
  }

  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));

  return (
    <div className="space-y-3">
      <table className="w-full text-sm text-left">
        <thead className="bg-muted text-muted-foreground uppercase text-xs font-bold">
          <tr>
            <SortableTh
              label="Ref"
              field="orderReference"
              active={sort}
              order={order}
              onSort={handleSort}
            />
            <th className="px-4 py-3">Lead</th>
            <th className="px-4 py-3">Email</th>
            <SortableTh
              label="Total"
              field="totalAmount"
              active={sort}
              order={order}
              onSort={handleSort}
              align="right"
            />
            <SortableTh
              label="Days"
              field="daysOutstanding"
              active={sort}
              order={order}
              onSort={handleSort}
              align="right"
            />
            <SortableTh
              label="Last Reminder"
              field="lastReminder"
              active={sort}
              order={order}
              onSort={handleSort}
            />
            <th className="px-4 py-3"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border bg-white">
          {data.rows.map((row) => (
            <tr key={row.id} className="hover:bg-muted/50">
              <td className="px-4 py-3 font-mono text-xs">{row.orderReference || "—"}</td>
              <td className="px-4 py-3">{row.leadName || "—"}</td>
              <td className="px-4 py-3 text-xs text-muted-foreground">{row.billingEmail || "—"}</td>
              <td className="px-4 py-3 text-right font-medium">
                £{row.totalAmount.toLocaleString()}
              </td>
              <td className="px-4 py-3 text-right">{row.daysOutstanding}</td>
              <td className="px-4 py-3 text-xs text-muted-foreground">
                {fmtDate(row.lastInvoiceReminderSentAt)}
              </td>
              <td className="px-4 py-3 text-right">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onSendReminder(row.id)}
                  disabled={sendingId === row.id}
                >
                  {sendingId === row.id ? "Sending…" : "Send reminder"}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
        <span>
          Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, data.total)} of{" "}
          {data.total}
        </span>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
          >
            Previous
          </Button>
          <span>
            Page {page} of {totalPages}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
