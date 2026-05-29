import { useGetAdminStats } from "@workspace/api-client-react";
import AdminLayout from "@/components/layout/AdminLayout";
import { Card } from "@/components/ui/card";
import { Users, CreditCard, Receipt, TrendingUp, Clock } from "lucide-react";
import UnpaidInvoicesWidget from "@/components/admin/UnpaidInvoicesWidget";

type RegRow = {
  id: number;
  orderReference?: string | null;
  leadName?: string | null;
  leadEmail?: string | null;
  leadPhone?: string | null;
  leadJobTitle?: string | null;
  leadCompany?: string | null;
  passType: string;
  quantity: number;
  totalAmount: number;
  status: string;
  billingName?: string | null;
  billingEmail?: string | null;
  billingPhone?: string | null;
  billingCompany?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "paid"
      ? "bg-green-100 text-green-800"
      : status === "invoiced"
        ? "bg-blue-100 text-blue-800"
        : "bg-yellow-100 text-yellow-800";
  return (
    <span className={`px-2 py-1 rounded-full text-xs font-bold uppercase ${cls}`}>{status}</span>
  );
}

function CompletedTable({ rows }: { rows: RegRow[] }) {
  return (
    <Card className="overflow-hidden border-border rounded-sm shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left">
          <thead className="bg-muted text-muted-foreground uppercase text-xs font-bold">
            <tr>
              <th className="px-6 py-4">Ref</th>
              <th className="px-6 py-4">Lead Attendee</th>
              <th className="px-6 py-4">Pass</th>
              <th className="px-6 py-4">Total</th>
              <th className="px-6 py-4">Status</th>
              <th className="px-6 py-4">Date</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border bg-white">
            {rows.map((reg) => (
              <tr key={reg.id} className="hover:bg-muted/50 transition-colors">
                <td className="px-6 py-4 font-mono font-medium">{reg.orderReference || "-"}</td>
                <td className="px-6 py-4">
                  <p className="font-bold">{reg.leadName || reg.billingName || "Unknown"}</p>
                  <p className="text-xs text-muted-foreground">
                    {reg.leadCompany || reg.billingCompany}
                  </p>
                </td>
                <td className="px-6 py-4">
                  <span className="capitalize">{reg.passType}</span>
                  <span className="text-muted-foreground ml-1">(x{reg.quantity})</span>
                </td>
                <td className="px-6 py-4 font-medium">
                  {"\u00a3"}
                  {Number(reg.totalAmount).toLocaleString()}
                </td>
                <td className="px-6 py-4">
                  <StatusBadge status={reg.status} />
                </td>
                <td className="px-6 py-4 text-xs text-muted-foreground whitespace-nowrap">
                  {fmtDate(reg.createdAt)}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-6 py-8 text-center text-muted-foreground">
                  No completed registrations yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function PartialsTable({ rows }: { rows: RegRow[] }) {
  return (
    <Card className="overflow-hidden border-border rounded-sm shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left">
          <thead className="bg-yellow-50 text-yellow-900 uppercase text-xs font-bold">
            <tr>
              <th className="px-6 py-4">Name</th>
              <th className="px-6 py-4">Job Title</th>
              <th className="px-6 py-4">Company</th>
              <th className="px-6 py-4">Contact</th>
              <th className="px-6 py-4">Pass</th>
              <th className="px-6 py-4">Last Seen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border bg-white">
            {rows.map((reg) => {
              const name = reg.leadName || reg.billingName || "-";
              const jobTitle = reg.leadJobTitle || "-";
              const company = reg.leadCompany || reg.billingCompany || "-";
              const email = reg.leadEmail || reg.billingEmail || null;
              const phone = reg.leadPhone || reg.billingPhone || null;
              return (
                <tr key={reg.id} className="hover:bg-yellow-50/50 transition-colors">
                  <td className="px-6 py-4 font-bold">{name}</td>
                  <td className="px-6 py-4 text-muted-foreground">{jobTitle}</td>
                  <td className="px-6 py-4">{company}</td>
                  <td className="px-6 py-4">
                    {email && <p className="text-xs">{email}</p>}
                    {phone && <p className="text-xs text-muted-foreground">{phone}</p>}
                    {!email && !phone && <span className="text-muted-foreground">-</span>}
                  </td>
                  <td className="px-6 py-4">
                    <span className="capitalize">{reg.passType || "-"}</span>
                    {reg.quantity > 0 && (
                      <span className="text-muted-foreground ml-1">(x{reg.quantity})</span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-xs text-muted-foreground whitespace-nowrap">
                    {fmtDate(reg.updatedAt)}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-6 py-8 text-center text-muted-foreground">
                  No partial checkouts at the moment.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export default function AdminDashboard() {
  const { data: stats, isLoading } = useGetAdminStats({
    query: {
      queryKey: ["adminStats"],
    },
  });

  if (isLoading || !stats) {
    return (
      <AdminLayout title="Dashboard">
        <div className="flex justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      </AdminLayout>
    );
  }

  const recentPartials = (stats as unknown as { recentPartials?: RegRow[] }).recentPartials ?? [];

  return (
    <AdminLayout title="Dashboard">
      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        <Card className="p-5 border-l-4 border-l-primary rounded-sm shadow-sm col-span-2 lg:col-span-1">
          <div className="flex justify-between items-start">
            <div>
              <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1">
                Total Revenue
              </p>
              <h2 className="text-3xl font-bold">
                {"\u00a3"}
                {stats.totalRevenue.toLocaleString()}
              </h2>
            </div>
            <div className="p-2 bg-primary/10 rounded-full">
              <TrendingUp className="w-5 h-5 text-primary" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            + {"\u00a3"}
            {stats.totalVat.toLocaleString()} VAT
          </p>
        </Card>

        <Card className="p-5 border-l-4 border-l-secondary rounded-sm shadow-sm">
          <div className="flex justify-between items-start">
            <div>
              <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1">
                Completed
              </p>
              <h2 className="text-3xl font-bold">{stats.completedRegistrations}</h2>
            </div>
            <div className="p-2 bg-secondary/10 rounded-full">
              <Users className="w-5 h-5 text-secondary" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-3">paid or invoiced</p>
        </Card>

        <Card className="p-5 border-l-4 border-l-yellow-400 rounded-sm shadow-sm">
          <div className="flex justify-between items-start">
            <div>
              <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1">
                Partial
              </p>
              <h2 className="text-3xl font-bold">{stats.partialRegistrations}</h2>
            </div>
            <div className="p-2 bg-yellow-100 rounded-full">
              <Clock className="w-5 h-5 text-yellow-600" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-3">incomplete checkouts</p>
        </Card>

        <Card className="p-5 border-l-4 border-l-accent rounded-sm shadow-sm">
          <div className="flex justify-between items-start">
            <div>
              <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1">
                Card Payments
              </p>
              <h2 className="text-3xl font-bold">{stats.paymentMethodCounts.card}</h2>
            </div>
            <div className="p-2 bg-accent/20 rounded-full">
              <CreditCard className="w-5 h-5 text-accent-foreground" />
            </div>
          </div>
        </Card>

        <Card className="p-5 border-l-4 border-l-blue-500 rounded-sm shadow-sm">
          <div className="flex justify-between items-start">
            <div>
              <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1">
                Invoices
              </p>
              <h2 className="text-3xl font-bold">{stats.paymentMethodCounts.invoice}</h2>
            </div>
            <div className="p-2 bg-blue-500/10 rounded-full">
              <Receipt className="w-5 h-5 text-blue-500" />
            </div>
          </div>
        </Card>
      </div>

      <div className="mb-8">
        <UnpaidInvoicesWidget />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-8">
          {/* Completed registrations */}
          <div>
            <h3 className="text-xl font-bold mb-4">Recent Completed Registrations</h3>
            <CompletedTable rows={stats.recentRegistrations as RegRow[]} />
          </div>

          {/* Partial checkouts */}
          <div>
            <div className="flex items-center gap-3 mb-4">
              <h3 className="text-xl font-bold">Partial Checkouts</h3>
              {recentPartials.length > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-800 text-xs font-bold">
                  {recentPartials.length}
                </span>
              )}
            </div>
            <PartialsTable rows={recentPartials} />
          </div>
        </div>

        <div>
          <h3 className="text-xl font-bold mb-4">Pass Breakdown</h3>
          <Card className="p-6 border-border rounded-sm shadow-sm bg-white">
            <div className="space-y-6">
              <div>
                <div className="flex justify-between mb-2">
                  <span className="font-bold">HR Professional Pass</span>
                  <span className="font-medium">{stats.passCounts.single}</span>
                </div>
                <div className="w-full bg-muted h-2 rounded-full overflow-hidden">
                  <div
                    className="bg-primary h-full"
                    style={{
                      width: `${(stats.passCounts.single / Math.max(1, stats.completedRegistrations)) * 100}%`,
                    }}
                  ></div>
                </div>
              </div>
              <div>
                <div className="flex justify-between mb-2">
                  <span className="font-bold">Business Pass</span>
                  <span className="font-medium">{stats.passCounts.business}</span>
                </div>
                <div className="w-full bg-muted h-2 rounded-full overflow-hidden">
                  <div
                    className="bg-slate-800 h-full"
                    style={{
                      width: `${(stats.passCounts.business / Math.max(1, stats.completedRegistrations)) * 100}%`,
                    }}
                  ></div>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </AdminLayout>
  );
}
