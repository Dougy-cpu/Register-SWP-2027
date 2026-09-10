import { useCallback, useEffect, useRef, useState } from "react";
import QrScanner from "qr-scanner";
import {
  Camera,
  CameraOff,
  CheckCircle2,
  ExternalLink,
  Image as ImageIcon,
  Lightbulb,
  RotateCcw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import logoUrl from "@assets/swp-summit-logo.png";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { BADGE_SCANNER_OPTIONS } from "@/lib/scanner-camera";
import {
  findScannerTestBadge,
  SCANNER_TEST_BADGES_PATH,
  type ScannerTestBadge,
} from "@/lib/scanner-test-data";

type TestScanSource = "camera" | "image";

interface TestScanResult {
  badge: ScannerTestBadge;
  source: TestScanSource;
}

function scannerErrorMessage(caught: unknown): string {
  if (caught instanceof Error && /permission|notallowed/i.test(caught.message)) {
    return "Camera access is needed for this test. Allow it when your phone asks, or upload a photo instead.";
  }
  if (caught instanceof Error && caught.message) return caught.message;
  return "The scanner could not start on this device.";
}

export default function ScannerTest() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const qrScannerRef = useRef<QrScanner | null>(null);
  const handleDecodedRef = useRef<(value: string, source: TestScanSource) => void>(() => undefined);
  const lastDecodeRef = useRef({ value: "", at: 0 });
  const [cameraActive, setCameraActive] = useState(false);
  const [flashAvailable, setFlashAvailable] = useState(false);
  const [flashOn, setFlashOn] = useState(false);
  const [result, setResult] = useState<TestScanResult | null>(null);
  const [scannedCodes, setScannedCodes] = useState<string[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const previousTitle = document.title;
    document.title = "SWP Summit 2027 | Lead scanner device test";
    return () => {
      document.title = previousTitle;
    };
  }, []);

  const stopCamera = useCallback(() => {
    qrScannerRef.current?.stop();
    setCameraActive(false);
    setFlashOn(false);
  }, []);

  const handleDecoded = useCallback(
    (rawValue: string, source: TestScanSource) => {
      const now = Date.now();
      const normalised = rawValue.trim().toUpperCase();
      if (lastDecodeRef.current.value === normalised && now - lastDecodeRef.current.at < 1_500) {
        return;
      }
      lastDecodeRef.current = { value: normalised, at: now };
      const badge = findScannerTestBadge(normalised);
      if (!badge) {
        setError("That is not one of the SWP test badges. Nothing was saved.");
        return;
      }
      stopCamera();
      setError("");
      setResult({ badge, source });
      setScannedCodes((current) =>
        current.includes(badge.code) ? current : [...current, badge.code],
      );
      navigator.vibrate?.(50);
    },
    [stopCamera],
  );

  useEffect(() => {
    handleDecodedRef.current = handleDecoded;
  }, [handleDecoded]);

  useEffect(
    () => () => {
      qrScannerRef.current?.destroy();
      qrScannerRef.current = null;
    },
    [],
  );

  const startCamera = useCallback(async () => {
    if (!videoRef.current) return;
    setError("");
    setResult(null);
    try {
      if (!qrScannerRef.current) {
        qrScannerRef.current = new QrScanner(
          videoRef.current,
          (scan) => handleDecodedRef.current(scan.data, "camera"),
          BADGE_SCANNER_OPTIONS,
        );
      }
      await qrScannerRef.current.start();
      setCameraActive(true);
      setFlashAvailable(await qrScannerRef.current.hasFlash());
    } catch (caught) {
      setCameraActive(false);
      setError(scannerErrorMessage(caught));
    }
  }, []);

  const toggleFlash = async () => {
    if (!qrScannerRef.current) return;
    try {
      await qrScannerRef.current.toggleFlash();
      setFlashOn(await qrScannerRef.current.isFlashOn());
    } catch {
      setError("The torch is not available on this device.");
    }
  };

  const scanImage = async (file?: File) => {
    if (!file) return;
    setError("");
    try {
      const scan = await QrScanner.scanImage(file, {
        returnDetailedScanResult: true,
        alsoTryWithoutScanRegion: true,
      });
      handleDecoded(scan.data, "image");
    } catch {
      setError("No readable SWP test QR code was found in that photograph.");
    } finally {
      if (imageInputRef.current) imageInputRef.current.value = "";
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <header className="border-b border-white/10 bg-slate-950/95">
        <div className="mx-auto flex min-h-16 max-w-3xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-3">
            <img src={logoUrl} alt="SWP Summit" className="h-10 w-auto rounded bg-white p-1" />
            <div>
              <p className="font-bold leading-tight">Lead scanner device test</p>
              <p className="text-xs text-slate-400">Synthetic records only</p>
            </div>
          </div>
          <Button variant="secondary" asChild>
            <a href={SCANNER_TEST_BADGES_PATH} target="_blank" rel="noreferrer">
              Test QR codes <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-4 px-4 py-5">
        <div className="rounded-xl border border-blue-400/30 bg-blue-500/10 p-4 text-sm text-blue-100">
          <div className="flex gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <p className="font-semibold text-white">Safe test mode</p>
              <p className="mt-1 text-blue-100/90">
                This page contains four hardcoded fictional people. It does not connect to attendee
                data, save leads or add anything to reports and exports.
              </p>
            </div>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="flex gap-2 rounded-xl border border-rose-400/40 bg-rose-500/15 p-3 text-sm text-rose-100"
          >
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {result ? (
          <Card className="overflow-hidden border-emerald-200 bg-white text-slate-950">
            <div className="bg-emerald-50 p-5 sm:p-6">
              <div className="flex items-start gap-4">
                <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-emerald-600 text-white">
                  <CheckCircle2 className="h-7 w-7" strokeWidth={2.5} />
                </div>
                <div>
                  <Badge className="border-emerald-200 bg-white text-emerald-800">
                    TEST SCAN RECOGNISED
                  </Badge>
                  <h1 className="mt-3 text-2xl font-extrabold tracking-tight">
                    {result.badge.name}
                  </h1>
                  <p className="mt-1 font-medium text-slate-700">{result.badge.jobTitle}</p>
                  <p className="text-slate-600">{result.badge.company}</p>
                </div>
              </div>
            </div>
            <div className="space-y-4 p-5 sm:p-6">
              <div className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm sm:grid-cols-2">
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
                    Work email
                  </p>
                  <p className="mt-1 break-all font-medium">{result.badge.workEmail}</p>
                </div>
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
                    Method
                  </p>
                  <p className="mt-1 font-medium">
                    {result.source === "camera" ? "Live camera" : "Uploaded photograph"}
                  </p>
                </div>
              </div>
              <p className="text-sm text-slate-600">
                Pass confirmed on this device. This test result exists only on this screen and has
                not been saved.
              </p>
              <Button className="h-12 w-full sm:w-auto" onClick={() => void startCamera()}>
                <RotateCcw className="h-4 w-4" /> Scan another test badge
              </Button>
            </div>
          </Card>
        ) : (
          <section className="relative min-h-[52vh] overflow-hidden rounded-2xl border border-white/15 bg-black">
            <video
              ref={videoRef}
              className={`absolute inset-0 h-full w-full object-cover ${cameraActive ? "block" : "hidden"}`}
              muted
              playsInline
            />
            {!cameraActive && (
              <div className="absolute inset-0 grid place-items-center bg-gradient-to-b from-slate-900 to-black p-8 text-center">
                <div>
                  <div className="mx-auto grid h-20 w-20 place-items-center rounded-full border border-blue-400/30 bg-blue-500/15">
                    <Camera className="h-9 w-9 text-blue-300" />
                  </div>
                  <p
                    role="heading"
                    aria-level={1}
                    className="mt-5 text-2xl font-bold tracking-tight text-white"
                  >
                    Test this device
                  </p>
                  <p className="mx-auto mt-2 max-w-sm text-sm text-slate-400">
                    Display a test QR code on another screen or print the badge sheet, then point
                    this device at it.
                  </p>
                  <Button className="mt-6 h-14 px-8 text-base" onClick={() => void startCamera()}>
                    <Camera className="h-5 w-5" /> Start camera test
                  </Button>
                </div>
              </div>
            )}
            {cameraActive && (
              <>
                <div className="absolute inset-x-0 top-0 z-10 flex justify-end gap-2 bg-gradient-to-b from-black/75 to-transparent p-4">
                  {flashAvailable && (
                    <Button
                      size="icon"
                      variant="secondary"
                      onClick={() => void toggleFlash()}
                      aria-label="Toggle torch"
                    >
                      <Lightbulb
                        className={`h-5 w-5 ${flashOn ? "fill-amber-300 text-amber-500" : ""}`}
                      />
                    </Button>
                  )}
                  <Button
                    size="icon"
                    variant="secondary"
                    onClick={stopCamera}
                    aria-label="Stop camera"
                  >
                    <CameraOff className="h-5 w-5" />
                  </Button>
                </div>
                <div className="pointer-events-none absolute inset-0 grid place-items-center">
                  <div className="aspect-square w-[72%] max-w-sm rounded-3xl border-[3px] border-white shadow-[0_0_0_999px_rgba(0,0,0,0.24)]" />
                </div>
                <p className="absolute inset-x-0 bottom-5 text-center text-sm font-medium text-white drop-shadow">
                  Hold steady over a test QR
                </p>
              </>
            )}
          </section>
        )}

        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(event) => void scanImage(event.target.files?.[0])}
          />
          <Button
            variant="secondary"
            className="h-12 w-full"
            onClick={() => imageInputRef.current?.click()}
          >
            <ImageIcon className="h-4 w-4" /> Test with a photo
          </Button>
          <div className="flex min-h-12 items-center justify-center rounded-lg border border-white/15 px-4 py-3 text-sm text-slate-300">
            {scannedCodes.length} of 4 recognised this session
          </div>
        </div>
      </main>
    </div>
  );
}
