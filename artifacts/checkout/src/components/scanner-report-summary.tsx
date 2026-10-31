export interface ScannerReport {
  asOf: string;
  companies: {
    sponsorId: number;
    sponsorCompany: string;
    scans: number;
    people: number;
    reps: { id: string; name: string; scans: number }[];
  }[];
}
export function ScannerReportSummary({ report }: { report: ScannerReport }) {
  return (
    <section aria-label="Confirmed scanner totals" className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Confirmed as of{" "}
        {new Date(report.asOf).toLocaleString("en-GB", { timeZone: "Europe/London" })} (London).
        Offline work appears after it backs up.
      </p>
      {report.companies.map((c) => (
        <div key={c.sponsorId} className="rounded-xl border bg-white p-4">
          <h3 className="font-bold">{c.sponsorCompany}</h3>
          <p className="mt-2">
            <strong>{c.scans}</strong> confirmed rep scans · <strong>{c.people}</strong> unique
            people
          </p>
          <details className="mt-2">
            <summary className="min-h-11 cursor-pointer py-2">By representative</summary>
            {c.reps.map((r) => (
              <p className="flex justify-between gap-4 py-1" key={r.id}>
                <span>{r.name}</span>
                <strong>{r.scans}</strong>
              </p>
            ))}
          </details>
        </div>
      ))}
    </section>
  );
}
