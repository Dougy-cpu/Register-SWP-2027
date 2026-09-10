import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, Printer, ShieldCheck, Smartphone } from "lucide-react";
import logoUrl from "@assets/swp-summit-logo.png";
import { ScannerTestQr } from "@/components/scanner-test-qr";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  SCANNER_TEST_BADGES,
  SCANNER_TEST_LINK_MATRIX,
  SCANNER_TEST_PATH,
  SCANNER_TEST_URL,
} from "@/lib/scanner-test-data";

export default function ScannerTestBadges() {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = "SWP Summit 2027 | Lead scanner test badges";
    return () => {
      document.title = previousTitle;
    };
  }, []);

  const copyScannerLink = async () => {
    try {
      await navigator.clipboard.writeText(SCANNER_TEST_URL);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      window.prompt("Copy this scanner test link:", SCANNER_TEST_URL);
    }
  };

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
            <Button asChild>
              <a href={SCANNER_TEST_PATH} target="_blank" rel="noreferrer">
                Open scanner test <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-5 py-6 print:max-w-none print:p-0">
        <Card className="border-blue-200 bg-blue-50 p-5 print:hidden">
          <div className="grid items-center gap-6 md:grid-cols-[1fr_auto]">
            <div>
              <div className="flex items-center gap-2 text-primary">
                <ShieldCheck className="h-5 w-5" />
                <h2 className="font-bold">No attendee or lead data is used</h2>
              </div>
              <p className="mt-2 max-w-3xl text-sm text-slate-700">
                Open the scanner test on each phone or tablet. Keep this badge page visible on a
                second screen, or print it. Every identity below is fictional and every scan stays
                on the test screen only. The QR codes use the same compact 12-character format as
                the real event badges.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <code className="rounded-lg border border-blue-200 bg-white px-3 py-2 text-sm font-bold text-primary">
                  {SCANNER_TEST_URL}
                </code>
                <Button variant="outline" size="sm" onClick={() => void copyScannerLink()}>
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {copied ? "Copied" : "Copy link"}
                </Button>
              </div>
            </div>
            <div className="rounded-2xl border border-blue-200 bg-white p-3 text-center shadow-sm">
              <ScannerTestQr
                matrix={SCANNER_TEST_LINK_MATRIX}
                label="Open the SWP lead scanner device test"
                className="mx-auto h-48 w-48"
              />
              <p className="mt-2 flex items-center justify-center gap-1 text-xs font-semibold text-slate-600">
                <Smartphone className="h-3.5 w-3.5" /> Scan to open on a phone
              </p>
            </div>
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
            Not saved or reported
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
              <div className="grid items-center gap-4 p-5 sm:grid-cols-[1fr_auto] print:grid-cols-[1fr_auto]">
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
                  className="mx-auto h-56 w-56 print:h-[50mm] print:w-[50mm]"
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
