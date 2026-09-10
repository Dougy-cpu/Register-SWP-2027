import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Image as ImageIcon, RotateCcw, ShieldCheck } from "lucide-react";
import logoUrl from "@assets/swp-summit-logo.png";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { BadgeCameraView } from "@/components/badge-camera-view";
import { LeadAnnotationFields, type LeadAnnotation } from "@/components/lead-annotation-fields";
import { useBadgeCamera } from "@/hooks/use-badge-camera";
import { useBadgePhoto } from "@/hooks/use-badge-photo";
import { isScannerPhone } from "@/lib/scanner-device";
import { findScannerTestBadge, type ScannerTestBadge } from "@/lib/scanner-test-data";
import ScannerTestBadges from "./scanner-test-badges";

type TestScanSource = "camera" | "image";
interface TestScanResult {
  badge: ScannerTestBadge;
  source: TestScanSource;
  repeat: boolean;
}

export default function ScannerTest() {
  return isScannerPhone() ? <PhoneScannerTest /> : <ScannerTestBadges />;
}

function PhoneScannerTest() {
  const imageInputRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<string | null>(null);
  const [result, setResult] = useState<TestScanResult | null>(null);
  const [records, setRecords] = useState<Record<string, LeadAnnotation>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const camera = useBadgeCamera((value) => handleDecoded(value, "camera"));
  const photo = useBadgePhoto((value) => handleDecoded(value, "image"), setError);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = "SWP Summit 2027 | Phone scanner rehearsal";
    return () => {
      document.title = previousTitle;
    };
  }, []);

  function handleDecoded(value: string, source: TestScanSource) {
    if (resultRef.current) return;
    const badge = findScannerTestBadge(value);
    if (!badge) {
      setError("That is not one of the four SWP test badges. Nothing was saved. Try a test badge.");
      return;
    }
    resultRef.current = badge.code;
    camera.stop();
    setError("");
    setNotice("");
    setResult({ badge, source, repeat: Boolean(records[badge.code]) });
    setRecords((current) => ({
      ...current,
      [badge.code]: current[badge.code] ?? { rating: null, note: "" },
    }));
    navigator.vibrate?.(50);
  }

  const startAnother = () => {
    photo.cancel();
    resultRef.current = null;
    setResult(null);
    setError("");
    setNotice("");
    camera.start();
  };
  const reset = () => {
    photo.cancel();
    camera.stop();
    resultRef.current = null;
    setResult(null);
    setRecords({});
    setError("");
    setNotice("Rehearsal cleared. Start the camera to try again.");
  };

  return (
    <div className="min-h-screen bg-slate-950 pb-6 text-white">
      <header className="border-b border-white/10">
        <div className="mx-auto flex max-w-xl items-center gap-3 px-4 py-3">
          <img src={logoUrl} alt="SWP Summit" className="h-10 w-auto rounded bg-white p-1" />
          <div>
            <p className="font-bold">Phone scanner rehearsal</p>
            <p className="text-xs text-slate-400">Fictional people · test data only</p>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-xl space-y-4 px-4 py-4">
        <div className="flex gap-3 rounded-xl border border-blue-400/30 bg-blue-500/10 p-4 text-sm text-blue-100">
          <ShieldCheck className="h-5 w-5 shrink-0" />
          <div>
            <p className="font-semibold text-white">Safe test mode</p>
            <p className="mt-1">
              Scan the test badges displayed on a computer. Ratings and notes stay in this rehearsal
              only and disappear when you reset, reload or close this page. Nothing enters leads,
              reports or exports.
            </p>
          </div>
        </div>
        {error && (
          <div
            role="alert"
            className="rounded-xl border border-rose-400/40 bg-rose-500/15 p-3 text-sm text-rose-100"
          >
            {error}
          </div>
        )}
        {notice && (
          <p role="status" className="text-sm text-blue-100">
            {notice}
          </p>
        )}
        {result ? (
          <Card className="overflow-hidden border-emerald-200 bg-white text-slate-950">
            <div className="space-y-2 bg-emerald-50 p-5">
              <Badge className="border-emerald-200 bg-white text-emerald-800">
                <CheckCircle2 className="mr-1 h-4 w-4" />
                TEST SCAN RECOGNISED
              </Badge>
              <p role="status" className="text-sm font-semibold text-emerald-800">
                {result.repeat
                  ? "Already recognised this rehearsal. Your rating and notes are still here."
                  : "Test badge recognised. Add a rating or note below."}
              </p>
              <h1 className="text-2xl font-extrabold tracking-tight">{result.badge.name}</h1>
              <p className="font-medium text-slate-700">{result.badge.jobTitle}</p>
              <p className="text-slate-600">{result.badge.company}</p>
              <p className="break-all text-sm text-slate-600">{result.badge.workEmail}</p>
              <p className="text-xs text-slate-500">
                {result.source === "camera" ? "Live camera" : "Badge photograph"} · fictional
                attendee
              </p>
            </div>
            <div className="space-y-4 p-5">
              <LeadAnnotationFields
                id="rehearsal"
                value={records[result.badge.code]}
                onChange={(value) =>
                  setRecords((current) => ({ ...current, [result.badge.code]: value }))
                }
              />
              <p role="status" className="text-sm text-emerald-800">
                Saved for this rehearsal only. You can edit your rating and notes.
              </p>
              <Button className="h-14 w-full text-base" onClick={startAnother}>
                <RotateCcw className="h-4 w-4" />
                Scan another test badge
              </Button>
            </div>
          </Card>
        ) : (
          <>
            <BadgeCameraView
              camera={{
                ...camera,
                selectCamera: (selected) => {
                  photo.cancel();
                  setError("");
                  camera.selectCamera(selected);
                },
              }}
              startLabel="Start camera test"
              onStart={startAnother}
            />
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              aria-label="Test badge photo"
              onChange={(event) => {
                void photo.scan(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            <Button
              variant="secondary"
              className="h-12 w-full"
              disabled={photo.busy}
              onClick={() => {
                camera.stop();
                setError("");
                imageInputRef.current?.click();
              }}
            >
              <ImageIcon className="h-4 w-4" />
              {photo.busy ? "Reading photo…" : "Test with a photo"}
            </Button>
            {photo.busy && (
              <Button variant="secondary" className="h-12 w-full" onClick={photo.cancel}>
                Cancel photo
              </Button>
            )}
          </>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/15 pt-3">
          <p className="text-sm text-slate-300">
            {Object.keys(records).length} of 4 recognised this rehearsal
          </p>
          <Button variant="secondary" className="h-12" onClick={reset}>
            Reset rehearsal
          </Button>
        </div>
      </main>
    </div>
  );
}
