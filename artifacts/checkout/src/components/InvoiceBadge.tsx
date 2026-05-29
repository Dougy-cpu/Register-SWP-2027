import { CheckCircle2, AlertTriangle, FileText, Clock, Ban } from "lucide-react";

export type InvoiceBadgeStatus = "paid" | "voided" | "overdue" | "sent" | "pending";

const STYLES: Record<
  InvoiceBadgeStatus,
  { cls: string; label: string; Icon: typeof CheckCircle2 }
> = {
  paid: {
    cls: "bg-green-100 text-green-800 border-green-300",
    label: "Paid",
    Icon: CheckCircle2,
  },
  voided: {
    cls: "bg-slate-100 text-slate-700 border-slate-300",
    label: "Voided",
    Icon: Ban,
  },
  overdue: {
    cls: "bg-red-100 text-red-800 border-red-300",
    label: "Overdue",
    Icon: AlertTriangle,
  },
  sent: {
    cls: "bg-blue-100 text-blue-800 border-blue-300",
    label: "Sent",
    Icon: FileText,
  },
  pending: {
    cls: "bg-yellow-100 text-yellow-800 border-yellow-300",
    label: "Pending",
    Icon: Clock,
  },
};

export function InvoiceBadge({
  status,
  size = "md",
}: {
  status: InvoiceBadgeStatus | string | null | undefined;
  size?: "sm" | "md";
}) {
  const key = (status ?? "pending") as InvoiceBadgeStatus;
  const style = STYLES[key] ?? STYLES.pending;
  const sizeCls = size === "sm" ? "px-1.5 py-0.5 text-[10px] gap-1" : "px-2 py-0.5 text-xs gap-1.5";
  const iconCls = size === "sm" ? "w-3 h-3" : "w-3.5 h-3.5";
  return (
    <span
      className={`inline-flex items-center font-bold uppercase tracking-wider border rounded ${sizeCls} ${style.cls}`}
    >
      <style.Icon className={iconCls} />
      {style.label}
    </span>
  );
}
