import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import QrScanner from "qr-scanner";
import {
  ArrowLeft,
  Camera,
  CameraOff,
  Check,
  CheckCircle2,
  CloudOff,
  CloudUpload,
  Download,
  Image as ImageIcon,
  Keyboard,
  Lightbulb,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  TriangleAlert,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import logoUrl from "@assets/swp-summit-logo.png";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  activateScanner,
  downloadOfflinePack,
  getScannerBootstrap,
  ScannerApiError,
  syncPendingScannerItems,
  updateReadiness,
} from "@/lib/scanner-api";
import {
  armOfflineReloadTest,
  clearScannerCredential,
  clearOfflineReloadTest,
  decryptPackAttendee,
  getOfflinePack,
  getScannerCredential,
  normaliseScannedValue,
  observeOfflineReloadTest,
  pendingScannerCount,
  queueAnnotation,
  queueScan,
  rejectedScannerItems,
  saveScannerCredential,
  storeOfflinePack,
  verifyOfflineQueue,
  verifyOfflineStorage,
} from "@/lib/scanner-storage";
import type {
  PendingAnnotation,
  PendingScan,
  RejectedSyncItem,
  ScanSource,
  ScannerBootstrap,
  ScannerCredential,
  StoredOfflinePack,
} from "@/types/lead-scanner";

function recoveryCsvCell(value: unknown): string {
  const raw = String(value ?? "");
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

function scannerErrorMessage(caught: unknown): string {
  if (caught instanceof ScannerApiError && caught.status === 401) {
    return "This phone is no longer authorised. Open the sponsor link again to activate it.";
  }
  if (caught instanceof Error) return caught.message;
  return "The scanner could not complete that action";
}

export default function SponsorScanner() {
  const [, navigate] = useLocation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const qrScannerRef = useRef<QrScanner | null>(null);
  const processingRef = useRef(false);
  const leadSheetOpenRef = useRef(false);
  const resumeCameraAfterLeadRef = useRef(false);
  const lastDecodeRef = useRef({ code: "", at: 0 });
  const downloadingPackRef = useRef(false);
  const handleDecodedRef = useRef<(rawValue: string, source: ScanSource) => Promise<void>>(
    async () => undefined,
  );
  const [credential, setCredential] = useState<ScannerCredential | null>(null);
  const [operatorName, setOperatorName] = useState("");
  const [bootstrap, setBootstrap] = useState<ScannerBootstrap | null>(null);
  const [pack, setPack] = useState<StoredOfflinePack | null>(null);
  const [initialising, setInitialising] = useState(true);
  const [activating, setActivating] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [flashAvailable, setFlashAvailable] = useState(false);
  const [flashOn, setFlashOn] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [recoveryItems, setRecoveryItems] = useState<RejectedSyncItem[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [latestScan, setLatestScan] = useState<PendingScan | null>(null);
  const [rating, setRating] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [manualCode, setManualCode] = useState("");
  const [showManual, setShowManual] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [updateWaiting, setUpdateWaiting] = useState(false);
  const [offlineTestStage, setOfflineTestStage] = useState<"none" | "armed" | "observed">("none");

  const refreshCounts = useCallback(async () => {
    const [pending, rejected] = await Promise.all([pendingScannerCount(), rejectedScannerItems()]);
    setPendingCount(pending);
    setRecoveryItems(rejected);
  }, []);

  const refreshBootstrap = useCallback(async () => {
    const state = await getScannerBootstrap();
    setBootstrap(state);
    return state;
  }, []);

  const syncNow = useCallback(
    async (quiet = false) => {
      if (!navigator.onLine) {
        if (!quiet) setNotice("No connection. Your leads remain saved on this phone.");
        await refreshCounts();
        return;
      }
      setSyncing(true);
      try {
        const result = await syncPendingScannerItems();
        await refreshCounts();
        if (result.rejected > 0) {
          setError(
            `${result.rejected} saved item${result.rejected === 1 ? " was" : "s were"} rejected by the server. Ask the organiser to review this phone.`,
          );
        } else if (!quiet) {
          setNotice(
            result.remaining
              ? `${result.remaining} items still waiting to sync`
              : "All leads synced",
          );
        }
        await refreshBootstrap().catch(() => undefined);
      } catch (caught) {
        if (!quiet) setError(scannerErrorMessage(caught));
      } finally {
        setSyncing(false);
      }
    },
    [refreshBootstrap, refreshCounts],
  );

  const downloadAndStorePack = useCallback(async () => {
    if (downloadingPackRef.current) return;
    downloadingPackRef.current = true;
    setPreparing(true);
    setError("");
    try {
      const downloaded = await downloadOfflinePack();
      const stored = await storeOfflinePack(downloaded);
      setPack(stored);
      const storageOk = await verifyOfflineStorage();
      await updateReadiness({
        packVersion: stored.version,
        storageTested: storageOk,
      });
      await refreshBootstrap();
      setNotice(`${stored.records.length} badge records prepared for offline scanning`);
    } catch (caught) {
      setError(scannerErrorMessage(caught));
    } finally {
      downloadingPackRef.current = false;
      setPreparing(false);
    }
  }, [refreshBootstrap]);

  const finaliseObservedOfflineTest = useCallback(async () => {
    const stage = await observeOfflineReloadTest(!navigator.onLine);
    setOfflineTestStage(stage);
    if (stage !== "observed" || !navigator.onLine) return false;
    await updateReadiness({ storageTested: true, offlineTested: true });
    await clearOfflineReloadTest();
    setOfflineTestStage("none");
    setNotice("Offline close and reopen test passed");
    return true;
  }, []);

  useEffect(() => {
    if (credential && bootstrap?.device.outOfDate && navigator.onLine) {
      void downloadAndStorePack();
    }
  }, [bootstrap?.device.outOfDate, credential, downloadAndStorePack]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const saved = await getScannerCredential();
        if (cancelled) return;
        setCredential(saved);
        setPack(await getOfflinePack());
        await refreshCounts();
        const offlineStage = await observeOfflineReloadTest(!navigator.onLine);
        setOfflineTestStage(offlineStage);
        if (offlineStage === "observed" && !navigator.onLine) {
          setNotice("This page reopened offline. Reconnect this phone to complete the check.");
        }
        if (saved && navigator.onLine) {
          await finaliseObservedOfflineTest();
          const state = await refreshBootstrap();
          const localPack = await getOfflinePack();
          if (!localPack || localPack.version !== state.device.currentPackVersion) {
            await downloadAndStorePack();
          }
          await syncNow(true);
        }
      } catch (caught) {
        if (!cancelled) setError(scannerErrorMessage(caught));
      } finally {
        if (!cancelled) setInitialising(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [downloadAndStorePack, finaliseObservedOfflineTest, refreshBootstrap, refreshCounts, syncNow]);

  useEffect(() => {
    const handleOnline = () => {
      void (async () => {
        await finaliseObservedOfflineTest().catch(() => undefined);
        await syncNow(true);
      })();
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible" && navigator.onLine) void syncNow(true);
    };
    const handleUpdate = () => setUpdateWaiting(true);
    window.addEventListener("online", handleOnline);
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("swp:update-ready", handleUpdate);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine) void syncNow(true);
    }, 15_000);
    return () => {
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("swp:update-ready", handleUpdate);
      window.clearInterval(interval);
    };
  }, [finaliseObservedOfflineTest, syncNow]);

  useEffect(
    () => () => {
      qrScannerRef.current?.destroy();
      qrScannerRef.current = null;
    },
    [],
  );

  const activate = async () => {
    if (operatorName.trim().length < 2) return;
    setActivating(true);
    setError("");
    try {
      const created = await activateScanner(operatorName.trim());
      await saveScannerCredential(created);
      setCredential(created);
      await refreshBootstrap();
      await downloadAndStorePack();
    } catch (caught) {
      setError(scannerErrorMessage(caught));
    } finally {
      setActivating(false);
    }
  };

  const handleDecoded = useCallback(
    async (rawValue: string, source: ScanSource) => {
      if (processingRef.current || leadSheetOpenRef.current) return;
      processingRef.current = true;
      setError("");
      try {
        const code = normaliseScannedValue(rawValue);
        if (!code) throw new Error("That QR is not an SWP attendee badge");
        const now = Date.now();
        if (lastDecodeRef.current.code === code && now - lastDecodeRef.current.at < 1_500) return;
        lastDecodeRef.current = { code, at: now };
        if (bootstrap && code === bootstrap.testQrValue) {
          if (source === "camera") {
            qrScannerRef.current?.stop();
            setCameraActive(false);
            setFlashOn(false);
          }
          await updateReadiness({
            qrTested: true,
            ...(source === "camera" ? { cameraTested: true } : {}),
          });
          setNotice("Test badge recognised. QR scanning is ready.");
          await refreshBootstrap();
          return;
        }
        if (bootstrap && !bootstrap.scannerWindow.scanningOpen) {
          throw new Error(
            bootstrap.scannerWindow.scanClosesAt
              ? "Lead scanning is closed for this event"
              : "The organiser must configure the event end time before scanning can begin",
          );
        }
        const attendee = await decryptPackAttendee(code);
        if (!attendee) {
          throw new Error(
            "This badge is not in the current approved attendee pack. Connect and update the pack, then try again.",
          );
        }
        const queued = await queueScan({ code, source, attendee });
        leadSheetOpenRef.current = true;
        if (source === "camera") {
          resumeCameraAfterLeadRef.current = true;
          qrScannerRef.current?.stop();
          setCameraActive(false);
          setFlashOn(false);
        }
        setLatestScan(queued);
        setRating(null);
        setNote("");
        navigator.vibrate?.(80);
        await refreshCounts();
        if (navigator.onLine) void syncNow(true);
      } catch (caught) {
        setError(scannerErrorMessage(caught));
      } finally {
        processingRef.current = false;
      }
    },
    [bootstrap, refreshBootstrap, refreshCounts, syncNow],
  );

  useEffect(() => {
    handleDecodedRef.current = handleDecoded;
  }, [handleDecoded]);

  const startCamera = useCallback(async () => {
    if (!videoRef.current) return;
    setError("");
    try {
      if (!qrScannerRef.current) {
        qrScannerRef.current = new QrScanner(
          videoRef.current,
          (result) => void handleDecodedRef.current(result.data, "camera"),
          {
            preferredCamera: "environment",
            highlightScanRegion: true,
            highlightCodeOutline: true,
            maxScansPerSecond: 10,
            returnDetailedScanResult: true,
          },
        );
      }
      await qrScannerRef.current.start();
      setCameraActive(true);
      setFlashAvailable(await qrScannerRef.current.hasFlash());
      await updateReadiness({ cameraTested: true });
      await refreshBootstrap();
    } catch (caught) {
      setCameraActive(false);
      setError(
        caught instanceof Error && /permission|notallowed/i.test(caught.message)
          ? "Camera permission was denied. Allow camera access in your browser settings, or use Photograph instead."
          : scannerErrorMessage(caught),
      );
    }
  }, [refreshBootstrap]);

  const stopCamera = () => {
    qrScannerRef.current?.stop();
    setCameraActive(false);
    setFlashOn(false);
  };

  const toggleFlash = async () => {
    if (!qrScannerRef.current) return;
    try {
      await qrScannerRef.current.toggleFlash();
      setFlashOn(await qrScannerRef.current.isFlashOn());
    } catch {
      setError("The torch is not available on this phone");
    }
  };

  const scanImage = async (file?: File) => {
    if (!file) return;
    setError("");
    try {
      const result = await QrScanner.scanImage(file, {
        returnDetailedScanResult: true,
        alsoTryWithoutScanRegion: true,
      });
      await handleDecoded(result.data, "image");
    } catch {
      setError("No readable attendee QR was found in that photograph");
    } finally {
      if (imageInputRef.current) imageInputRef.current.value = "";
    }
  };

  const runOfflineTest = async () => {
    try {
      const [storageOk, queueOk] = await Promise.all([
        verifyOfflineStorage(),
        verifyOfflineQueue(),
      ]);
      if (!storageOk || !queueOk) throw new Error("This browser could not retain the offline test");
      await armOfflineReloadTest();
      setOfflineTestStage("armed");
      await updateReadiness({ storageTested: true, offlineTested: false });
      await refreshBootstrap();
      setNotice(
        "Offline test armed. Turn off Wi-Fi and mobile data, close and reopen this scanner, then reconnect.",
      );
    } catch (caught) {
      setError(scannerErrorMessage(caught));
    }
  };

  const runSyncTest = async () => {
    if (!navigator.onLine) {
      setError("Reconnect this phone before completing the sync test");
      return;
    }
    try {
      if (!bootstrap) throw new Error("Prepare this scanner before running the sync test");
      await queueScan({
        code: bootstrap.testQrValue,
        source: "manual",
        attendee: {
          attendeeId: -1,
          name: "Scanner readiness test",
          firstName: "Scanner",
          lastName: "Test",
          jobTitle: "",
          company: "SWP Summit 2027",
          workEmail: "test@invalid.example",
        },
      });
      await refreshCounts();
      const result = await syncPendingScannerItems();
      await refreshCounts();
      const state = await refreshBootstrap();
      if (!state.device.syncTested || result.remaining > 0) {
        throw new Error("The queued sync test did not receive a complete server acknowledgement");
      }
      setNotice("Queued record and server acknowledgement test passed");
    } catch (caught) {
      setError(scannerErrorMessage(caught));
    }
  };

  const finishLead = async () => {
    if (!latestScan) return;
    try {
      await queueAnnotation({ scanId: latestScan.id, rating, note });
      const shouldResumeCamera = resumeCameraAfterLeadRef.current;
      resumeCameraAfterLeadRef.current = false;
      leadSheetOpenRef.current = false;
      setLatestScan(null);
      setRating(null);
      setNote("");
      await refreshCounts();
      if (navigator.onLine) void syncNow(true);
      if (shouldResumeCamera) await startCamera();
    } catch (caught) {
      setError(scannerErrorMessage(caught));
    }
  };

  const downloadRecovery = () => {
    const headings = [
      "Type",
      "Scanner operator",
      "Event ID",
      "Attendee",
      "Company",
      "Work email",
      "Captured or created",
      "Rating",
      "Note",
      "Reason",
      "QR value",
    ];
    const rows = recoveryItems.map((item) => {
      const scan = item.kind === "scan" ? (item.payload as PendingScan) : null;
      const annotation = item.kind === "annotation" ? (item.payload as PendingAnnotation) : null;
      return [
        item.kind,
        credential?.operatorName ?? "",
        scan?.id ?? annotation?.scanId ?? "",
        scan?.attendee.name ?? "",
        scan?.attendee.company ?? "",
        scan?.attendee.workEmail ?? "",
        scan?.capturedAt ?? annotation?.createdAt ?? "",
        annotation?.rating ?? "",
        annotation?.note ?? "",
        item.reason,
        scan?.code ?? "",
      ];
    });
    const csv = [headings, ...rows].map((row) => row.map(recoveryCsvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}\r\n`], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `swp-scanner-recovery-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const forgetPhone = async () => {
    if (pendingCount > 0) {
      setError("Sync the saved items on this phone before removing it.");
      return;
    }
    if (
      recoveryItems.length > 0 &&
      !window.confirm(
        "This phone still holds rejected items for organiser recovery. Removing it now permanently deletes them. Continue only after downloading the recovery file.",
      )
    )
      return;
    if (
      !window.confirm(
        "Remove this scanner identity and all downloaded attendee data from this phone?",
      )
    )
      return;
    stopCamera();
    await clearScannerCredential();
    setCredential(null);
    setBootstrap(null);
    setPack(null);
    setPendingCount(0);
    setRecoveryItems([]);
    setLatestScan(null);
    leadSheetOpenRef.current = false;
    resumeCameraAfterLeadRef.current = false;
  };

  if (initialising) {
    return (
      <main className="min-h-screen bg-slate-50 grid place-items-center p-6">
        <div className="text-center">
          <RefreshCw className="h-9 w-9 mx-auto text-primary animate-spin" />
          <p className="mt-4 text-muted-foreground">Preparing scanner…</p>
        </div>
      </main>
    );
  }

  if (!credential) {
    return (
      <main className="min-h-screen bg-slate-50 grid place-items-center p-4 swp-grid-bg">
        <Card className="w-full max-w-md p-7 sm:p-9 swp-card">
          <img src={logoUrl} alt="SWP Summit" className="h-16 w-auto mx-auto mb-6" />
          <div className="text-center mb-7">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-primary">
              Sponsor lead scanner
            </p>
            <h1 className="text-2xl font-bold mt-2">Who is using this phone?</h1>
            <p className="text-sm text-muted-foreground mt-3">
              Enter your name so every scan and note is correctly attributed.
            </p>
          </div>
          {error && <ErrorBanner message={error} onClose={() => setError("")} />}
          <Label htmlFor="operator-name">Scanner operator</Label>
          <Input
            id="operator-name"
            value={operatorName}
            onChange={(event) => setOperatorName(event.target.value)}
            placeholder="Your full name"
            autoComplete="name"
            className="mt-2 h-12"
          />
          <Button
            className="w-full mt-5 h-12"
            onClick={() => void activate()}
            disabled={activating || operatorName.trim().length < 2}
          >
            <Smartphone className="h-4 w-4 mr-2" />
            {activating ? "Activating…" : "Activate this phone"}
          </Button>
          <Button variant="ghost" className="w-full mt-2" onClick={() => navigate("/sponsor")}>
            <ArrowLeft className="h-4 w-4 mr-2" /> Back to sponsor workspace
          </Button>
        </Card>
      </main>
    );
  }

  const ready = bootstrap?.device.ready ?? false;
  const rejectedCount = recoveryItems.length;
  const offlineUsable = Boolean(
    pack && (!pack.expiresAt || Date.now() <= new Date(pack.expiresAt).getTime()),
  );

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <header className="sticky top-0 z-30 bg-slate-950/95 backdrop-blur border-b border-white/10">
        <div className="max-w-3xl mx-auto px-4 h-16 flex items-center justify-between gap-3">
          <button
            onClick={() => navigate("/sponsor")}
            className="flex items-center gap-3 text-left"
          >
            <ArrowLeft className="h-5 w-5" />
            <div>
              <p className="font-semibold leading-tight">Scan badge</p>
              <p className="text-xs text-slate-400 truncate max-w-44 sm:max-w-none">
                {credential.sponsorCompany} · {credential.operatorName}
              </p>
            </div>
          </button>
          <button
            onClick={() => void syncNow()}
            className={`rounded-full px-3 py-2 text-xs font-semibold flex items-center gap-2 ${
              rejectedCount
                ? "bg-rose-500/20 text-rose-200 border border-rose-400/40"
                : pendingCount
                  ? "bg-amber-400 text-slate-950"
                  : "bg-emerald-500/15 text-emerald-300 border border-emerald-400/30"
            }`}
          >
            {rejectedCount ? (
              <TriangleAlert className="h-3.5 w-3.5" />
            ) : navigator.onLine ? (
              syncing ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <CloudUpload className="h-3.5 w-3.5" />
              )
            ) : (
              <CloudOff className="h-3.5 w-3.5" />
            )}
            {rejectedCount
              ? `${rejectedCount} need review`
              : pendingCount
                ? `${pendingCount} waiting to sync`
                : "All leads synced"}
          </button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-5 space-y-4">
        {updateWaiting && (
          <div className="rounded-xl border border-blue-400/30 bg-blue-500/10 p-3 text-sm text-blue-100">
            An update is ready, but this running event-day scanner will not replace itself. Reload
            only when the organiser tells you to.
          </div>
        )}
        {notice && (
          <div className="rounded-xl bg-emerald-500/15 border border-emerald-400/30 p-3 text-sm text-emerald-100 flex gap-2">
            <Check className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{notice}</span>
            <button className="ml-auto" onClick={() => setNotice("")} aria-label="Dismiss">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        {error && <DarkErrorBanner message={error} onClose={() => setError("")} />}
        {rejectedCount > 0 && (
          <div className="rounded-xl bg-rose-500/15 border border-rose-400/40 p-3 text-sm text-rose-100">
            <div className="flex gap-2">
              <TriangleAlert className="h-4 w-4 mt-0.5 shrink-0" />
              <span>
                {rejectedCount} item{rejectedCount === 1 ? " needs" : "s need"} organiser review on
                this phone. They have not been discarded.
              </span>
            </div>
            <Button size="sm" variant="secondary" className="mt-3" onClick={downloadRecovery}>
              <Download className="h-4 w-4 mr-2" /> Download recovery file
            </Button>
          </div>
        )}

        {(!ready || bootstrap?.device.outOfDate) && (
          <ReadinessPanel
            bootstrap={bootstrap}
            pack={pack}
            preparing={preparing}
            onPrepare={() => void downloadAndStorePack()}
            onOfflineTest={() => void runOfflineTest()}
            onSyncTest={() => void runSyncTest()}
          />
        )}

        {offlineTestStage === "armed" && (
          <div className="rounded-xl border border-amber-400/40 bg-amber-500/15 p-3 text-sm text-amber-100">
            Offline test waiting: turn off Wi-Fi and mobile data, close and reopen this scanner,
            then reconnect.
          </div>
        )}
        {offlineTestStage === "observed" && !navigator.onLine && (
          <div className="rounded-xl border border-emerald-400/40 bg-emerald-500/15 p-3 text-sm text-emerald-100">
            Offline reopen confirmed. Reconnect now to record the successful check.
          </div>
        )}

        <section className="relative overflow-hidden rounded-2xl bg-black border border-white/15 min-h-[52vh]">
          <video
            ref={videoRef}
            className={`absolute inset-0 w-full h-full object-cover ${cameraActive ? "block" : "hidden"}`}
            muted
            playsInline
          />
          {!cameraActive && (
            <div className="absolute inset-0 grid place-items-center text-center p-8 bg-gradient-to-b from-slate-900 to-black">
              <div>
                <div className="h-20 w-20 mx-auto rounded-full bg-blue-500/15 border border-blue-400/30 grid place-items-center">
                  <Camera className="h-9 w-9 text-blue-300" />
                </div>
                <h2 className="text-white text-xl font-bold mt-5">Ready to scan</h2>
                <p className="text-slate-400 text-sm mt-2 max-w-xs">
                  Hold the badge QR inside the frame. The attendee reference contains no personal
                  information.
                </p>
                <Button
                  className="mt-6 h-12 px-7"
                  onClick={() => void startCamera()}
                  disabled={!offlineUsable}
                >
                  <Camera className="h-4 w-4 mr-2" /> Start camera
                </Button>
                {!offlineUsable && (
                  <p className="text-amber-300 text-xs mt-3">Download the attendee pack first.</p>
                )}
              </div>
            </div>
          )}
          {cameraActive && (
            <>
              <div className="absolute inset-x-0 top-0 p-4 flex justify-between bg-gradient-to-b from-black/75 to-transparent">
                <Badge className="bg-black/60 text-white border border-white/20">
                  {navigator.onLine ? (
                    <Wifi className="h-3 w-3 mr-1" />
                  ) : (
                    <WifiOff className="h-3 w-3 mr-1" />
                  )}
                  {navigator.onLine ? "Online" : "Offline ready"}
                </Badge>
                <div className="flex gap-2">
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
              </div>
              <div className="pointer-events-none absolute inset-0 grid place-items-center">
                <div className="w-[72%] max-w-sm aspect-square rounded-3xl border-[3px] border-white shadow-[0_0_0_999px_rgba(0,0,0,0.24)]" />
              </div>
              <p className="absolute inset-x-0 bottom-5 text-center text-sm font-medium text-white drop-shadow">
                Hold steady over the QR
              </p>
            </>
          )}
        </section>

        <div className="grid grid-cols-2 gap-3">
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
            className="h-12"
            onClick={() => imageInputRef.current?.click()}
            disabled={!offlineUsable}
          >
            <ImageIcon className="h-4 w-4 mr-2" /> Photograph
          </Button>
          <Button
            variant="secondary"
            className="h-12"
            onClick={() => setShowManual((value) => !value)}
            disabled={!offlineUsable}
          >
            <Keyboard className="h-4 w-4 mr-2" /> Enter QR value
          </Button>
        </div>

        {showManual && (
          <Card className="p-4 bg-white text-slate-950">
            <Label htmlFor="manual-code">12-character QR value</Label>
            <div className="flex gap-2 mt-2">
              <Input
                id="manual-code"
                value={manualCode}
                onChange={(event) => setManualCode(event.target.value.toUpperCase().slice(0, 12))}
                className="font-mono uppercase tracking-widest"
                autoCapitalize="characters"
                autoCorrect="off"
              />
              <Button
                onClick={() => {
                  void handleDecoded(manualCode, "manual");
                  setManualCode("");
                }}
                disabled={!normaliseScannedValue(manualCode)}
              >
                Add
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              This value is not printed on attendee badges. Use only with an authorised scanner or
              organiser source.
            </p>
          </Card>
        )}

        <div className="flex items-center justify-between text-xs text-slate-400 px-1">
          <span>Pack: {pack ? `${pack.records.length} attendees` : "not downloaded"}</span>
          <button className="underline underline-offset-4" onClick={() => void forgetPhone()}>
            Remove this phone
          </button>
        </div>
      </main>

      {latestScan && (
        <LeadCapturedSheet
          scan={latestScan}
          rating={rating}
          note={note}
          onRating={setRating}
          onNote={setNote}
          onFinish={() => void finishLead()}
        />
      )}
    </div>
  );
}

function ReadinessPanel({
  bootstrap,
  pack,
  preparing,
  onPrepare,
  onOfflineTest,
  onSyncTest,
}: {
  bootstrap: ScannerBootstrap | null;
  pack: StoredOfflinePack | null;
  preparing: boolean;
  onPrepare: () => void;
  onOfflineTest: () => void;
  onSyncTest: () => void;
}) {
  const device = bootstrap?.device;
  const checks = [
    {
      label: "Current attendee pack",
      pass: Boolean(pack && pack.version === device?.currentPackVersion),
    },
    { label: "Offline storage", pass: device?.storageTested ?? false },
    { label: "Offline close and reopen", pass: device?.offlineTested ?? false },
    { label: "Camera permission", pass: device?.cameraTested ?? false },
    { label: "Real test QR", pass: device?.qrTested ?? false },
    { label: "Reconnect and sync", pass: device?.syncTested ?? false },
  ];
  return (
    <Card className="p-5 bg-white text-slate-950 border-blue-200">
      <div className="flex items-start gap-3">
        <div className="h-10 w-10 rounded-xl bg-blue-50 grid place-items-center shrink-0">
          <ShieldCheck className="h-5 w-5 text-primary" />
        </div>
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-bold">Scanner ready check</h2>
            {device?.outOfDate && (
              <Badge className="bg-amber-100 text-amber-900">Out of date</Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Complete all six checks on this phone before event day.
          </p>
        </div>
      </div>
      <div className="grid sm:grid-cols-2 gap-2 mt-4">
        {checks.map((check) => (
          <div
            key={check.label}
            className="rounded-lg border px-3 py-2 flex items-center gap-2 text-sm"
          >
            {check.pass ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            ) : (
              <span className="h-4 w-4 rounded-full border-2 border-slate-300" />
            )}
            {check.label}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2 mt-4">
        <Button size="sm" onClick={onPrepare} disabled={preparing || !navigator.onLine}>
          <RefreshCw className={`h-4 w-4 mr-2 ${preparing ? "animate-spin" : ""}`} />
          {preparing ? "Preparing…" : "Download current pack"}
        </Button>
        <Button size="sm" variant="outline" onClick={onOfflineTest}>
          <CloudOff className="h-4 w-4 mr-2" /> Test offline save
        </Button>
        <Button size="sm" variant="outline" onClick={onSyncTest} disabled={!navigator.onLine}>
          <CloudUpload className="h-4 w-4 mr-2" /> Test sync
        </Button>
      </div>
      <p className="text-xs text-muted-foreground mt-3">
        To complete the QR check, start the camera and scan the separate Scanner test QR supplied in
        the organiser's Lead Scanner admin page.
      </p>
    </Card>
  );
}

function LeadCapturedSheet({
  scan,
  rating,
  note,
  onRating,
  onNote,
  onFinish,
}: {
  scan: PendingScan;
  rating: number | null;
  note: string;
  onRating: (rating: number | null) => void;
  onNote: (note: string) => void;
  onFinish: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm grid items-end sm:items-center sm:justify-center">
      <Card className="rounded-t-3xl sm:rounded-3xl border-0 w-full sm:max-w-lg p-6 sm:p-8 text-slate-950">
        <div className="h-14 w-14 rounded-full bg-emerald-100 grid place-items-center">
          <Check className="h-7 w-7 text-emerald-700" strokeWidth={3} />
        </div>
        <p className="text-xs uppercase tracking-[0.14em] font-bold text-emerald-700 mt-5">
          Lead saved on this phone
        </p>
        <h2 className="text-3xl font-bold mt-1">{scan.attendee.name}</h2>
        <p className="text-lg text-slate-600 mt-1">{scan.attendee.jobTitle}</p>
        <p className="text-slate-500">{scan.attendee.company}</p>

        <div className="mt-6">
          <Label>Rating (optional)</Label>
          <div className="grid grid-cols-5 gap-2 mt-2">
            {[1, 2, 3, 4, 5].map((value) => (
              <button
                key={value}
                className={`h-12 rounded-xl border-2 font-bold text-lg transition-colors ${
                  rating === value
                    ? "bg-primary border-primary text-white"
                    : "border-slate-200 hover:border-blue-300"
                }`}
                onClick={() => onRating(rating === value ? null : value)}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-5">
          <Label htmlFor="lead-note">Note (optional)</Label>
          <Textarea
            id="lead-note"
            value={note}
            onChange={(event) => onNote(event.target.value.slice(0, 4000))}
            rows={3}
            placeholder="What did you discuss?"
            className="mt-2"
          />
        </div>
        <Button className="w-full h-12 mt-6 text-base" onClick={onFinish}>
          {rating || note.trim() ? "Save and scan next" : "Scan next"}
        </Button>
      </Card>
    </div>
  );
}

function ErrorBanner({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="rounded-lg bg-rose-50 border border-rose-200 p-3 text-sm text-rose-800 flex gap-2 mb-4">
      <TriangleAlert className="h-4 w-4 mt-0.5 shrink-0" />
      <span>{message}</span>
      <button className="ml-auto" onClick={onClose} aria-label="Dismiss">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function DarkErrorBanner({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="rounded-xl bg-rose-500/15 border border-rose-400/40 p-3 text-sm text-rose-100 flex gap-2">
      <TriangleAlert className="h-4 w-4 mt-0.5 shrink-0" />
      <span>{message}</span>
      <button className="ml-auto" onClick={onClose} aria-label="Dismiss">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
