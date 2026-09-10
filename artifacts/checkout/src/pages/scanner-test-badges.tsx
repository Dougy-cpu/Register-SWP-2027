import { useEffect } from "react";
import { Printer, ShieldCheck } from "lucide-react";
import logoUrl from "@assets/swp-summit-logo.png";
import { ScannerTestQr } from "@/components/scanner-test-qr";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PhoneScannerLink } from "@/components/phone-scanner-link";
import { SCANNER_TEST_BADGES, SCANNER_TEST_URL } from "@/lib/scanner-test-data";

export default function ScannerTestBadges() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = "SWP Summit 2027 | Lead scanner test badges";
    return () => {
      document.title = previousTitle;
    };
  }, []);

  return (
    <div className="min-h-screen bg-slate-100 text-slate-950 print:bg-white">
      <style>{`@media print { @page { size: A4; margin: 10mm; } }`}</style>
      <header className="border-b border-blue-100 bg-white print:hidden">
        <div className="mx-auto flex max-w-6xl flex-col justify-between gap-4 px-5 py-5 sm:flex-row sm:items-center">
          <div className="flex items-center gap-4">
            <img src={logoUrl} alt="SWP Summit" className="h-12 w-auto" />
            <div>
              <p className="text-xs font-extrabold uppercase tracking-[0.18em] text-primary">
                Device rehearsal
              </p>
              <h1 className="text-2xl font-extrabold tracking-tight">Lead scanner test kit</h1>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => window.print()}>
              <Printer className="h-4 w-4" /> Print badge sheet
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-5 py-6 print:max-w-none print:p-0">
        <Card className="border-blue-200 bg-blue-50 p-5 print:hidden">
          <div className="space-y-5">
            <div>
              <div className="flex items-center gap-2 text-primary">
                <ShieldCheck className="h-5 w-5" />
                <h2 className="font-bold">No attendee or lead data is used</h2>
              </div>
              <p className="mt-2 max-w-3xl text-sm text-slate-700">
                Keep this page open on your computer so your phone can scan the large badges below,
                or print the sheet. Scan several badges, then tap Leads on your phone to add notes
                and ratings later, just as you will on the day. Every identity is fictional.
                Practice leads stay in that browser until you choose Reset rehearsal or clear
                browser data. Nothing is uploaded or included in real leads.
              </p>
            </div>
            <PhoneScannerLink url={SCANNER_TEST_URL} />
          </div>
        </Card>

        <div className="hidden items-center justify-between border-b-2 border-primary pb-3 print:flex">
          <div>
            <p className="text-xs font-extrabold uppercase tracking-[0.18em] text-primary">
              SWP Summit 2027
            </p>
            <h1 className="text-2xl font-extrabold">Lead scanner test badges</h1>
          </div>
          <p className="text-right text-xs font-semibold text-slate-600">
            Fictional data
            <br />
            Practice only · not reported
          </p>
        </div>

        <section className="grid gap-5 sm:grid-cols-2 print:grid-cols-2 print:gap-4">
          {SCANNER_TEST_BADGES.map((badge, index) => (
            <article
              key={badge.code}
              className="break-inside-avoid overflow-hidden rounded-2xl border border-blue-200 bg-white shadow-[0_12px_35px_rgba(0,78,185,0.08)] print:rounded-none print:shadow-none"
            >
              <div className="border-b border-blue-100 bg-blue-50 px-5 py-4">
                <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-primary">
                  Synthetic test badge {index + 1}
                </p>
                <h2 className="mt-2 text-2xl font-extrabold tracking-tight">{badge.name}</h2>
                <p className="mt-1 font-semibold text-slate-700">{badge.jobTitle}</p>
                <p className="text-slate-600">{badge.company}</p>
              </div>
              <div className="grid items-center gap-4 p-5 print:grid-cols-[1fr_auto]">
                <div className="text-sm text-slate-600">
                  <p>Scan with:</p>
                  <p className="mt-1 font-bold text-primary">{SCANNER_TEST_URL}</p>
                  <p className="mt-4 text-xs">
                    Test reference
                    <br />
                    <code className="font-bold text-slate-900">{badge.code}</code>
                  </p>
                </div>
                <ScannerTestQr
                  matrix={badge.matrix}
                  label={`Test badge for ${badge.name}`}
                  className="mx-auto aspect-square h-auto w-full max-w-[360px] print:h-[50mm] print:w-[50mm]"
                />
              </div>
            </article>
          ))}
        </section>

        <p className="text-center text-xs text-slate-500">
          These codes are recognised only by the public test page. They are not attendee badge
          references and cannot create sponsor leads.
        </p>
      </main>
    </div>
  );
}
