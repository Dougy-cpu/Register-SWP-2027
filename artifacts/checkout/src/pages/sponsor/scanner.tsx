import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import QrScanner from "qr-scanner";
import {
  ArrowLeft,
  Camera,
  CameraOff,
  Check,
  CheckCircle2,
  CircleHelp,
  CloudOff,
  CloudUpload,
  Download,
  Image as ImageIcon,
  Lightbulb,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  WifiOff,
  X,
} from "lucide-react";
import logoUrl from "@assets/swp-summit-logo.png";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  activateScanner,
  downloadOfflinePack,
  getScannerBootstrap,
  ScannerApiError,
  syncPendingScannerItems,
  updateReadiness,
  recoverScanner,
  importScannerLink,
  lookupScannerBadge,
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
  queueScan,
  rejectedScannerItems,
  saveScannerCredential,
  storeOfflinePack,
  verifyOfflineQueue,
  verifyOfflineStorage,
  cachedScannerBootstrap,
  readScannerValue,
  cachedScannerLeads,
  pendingScannerItems,
  retryRejectedScans,
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
    return "Your saved leads are safe. Tap Reconnect scanner, or ask your sponsor organiser for a renewed scanner link.";
  }
  if (caught instanceof TypeError && /fetch|network/i.test(caught.message)) {
    return "We couldn't connect just now. Check your signal and try again.";
  }
  if (caught instanceof Error && caught.name === "AbortError")
    return "The connection is slow. Saved leads will sync automatically when it improves.";
  if (caught instanceof Error) return caught.message;
  return "Something went wrong. Please try again.";
}

function scannerActivationErrorMessage(caught: unknown): string {
  if (caught instanceof ScannerApiError && caught.status === 401) {
    return "Open this scanner from the Scan badge button in your sponsor workspace.";
  }
  return scannerErrorMessage(caught);
}

function offlinePackIsUsable(pack: StoredOfflinePack | null): boolean {
  return Boolean(
    pack &&
    pack.format === 1 &&
    typeof pack.version === "string" &&
    typeof pack.keyContext === "string" &&
    Array.isArray(pack.records) &&
    (!pack.expiresAt || Date.now() <= new Date(pack.expiresAt).getTime()),
  );
}

export default function SponsorScanner() {
  const [, navigate] = useLocation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const qrScannerRef = useRef<QrScanner | null>(null);
  const processingRef = useRef(false);
  const lastDecodeRef = useRef({ code: "", at: 0 });
  const recentScansRef = useRef(new Map<string, number>());
  const scanToastTimerRef = useRef<number | null>(null);
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
  const [scanConfirmationKey, setScanConfirmationKey] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  const [error, setError] = useState("");
  const [accessError, setAccessError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState("Added to leads");
  const [notice, setNotice] = useState("");
  const [updateWaiting, setUpdateWaiting] = useState(false);
  const [offlineTestStage, setOfflineTestStage] = useState<"none" | "armed" | "observed">("none");

  const refreshCounts = useCallback(async () => {
    const [pending, rejected] = await Promise.all([pendingScannerCount(), rejectedScannerItems()]);
    setPendingCount(pending);
    setRecoveryItems(rejected);
  }, []);

  const refreshBootstrap = useCallback(async () => {
    let state: ScannerBootstrap;
    try {
      state = await getScannerBootstrap();
    } catch (caught) {
      if (!(caught instanceof ScannerApiError) || caught.code !== "access_refresh") throw caught;
      const saved = await getScannerCredential();
      if (!saved) throw caught;
      const renewed = await recoverScanner(saved);
      setCredential(renewed);
      state = await getScannerBootstrap();
    }
    if (!state?.device || !state.scannerWindow) {
      throw new TypeError("Network request failed");
    }
    setBootstrap(state);
    setAccessError(null);
    return state;
  }, []);

  const syncNow = useCallback(
    async (quiet = false) => {
      if (!navigator.onLine) {
        if (!quiet) setNotice("No connection. Your leads remain saved on this phone.");
        await refreshCounts();
        return;
      }
      try {
        const result = await syncPendingScannerItems();
        await refreshCounts();
        if (result.rejected > 0) {
          setError(
            `${result.rejected} lead${result.rejected === 1 ? " needs" : "s need"} organiser help. Nothing has been deleted.`,
          );
        } else if (!quiet) {
          setNotice(
            result.remaining ? "Your saved leads will finish syncing automatically." : "All saved.",
          );
        }
        await refreshBootstrap().catch(() => undefined);
      } catch (caught) {
        if (!quiet) setError(scannerErrorMessage(caught));
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
      const downloadingFor = await getScannerCredential();
      if (!downloadingFor) return;
      const downloaded = await downloadOfflinePack();
      if (
        downloaded?.format !== 1 ||
        typeof downloaded.version !== "string" ||
        typeof downloaded.keyContext !== "string" ||
        !Array.isArray(downloaded.records)
      ) {
        throw new TypeError("Network request failed");
      }
      const stored = await storeOfflinePack(downloaded, downloadingFor);
      setPack(stored);
      const storageOk = await verifyOfflineStorage();
      await updateReadiness({
        packVersion: stored.version,
        storageTested: storageOk,
      });
      await refreshBootstrap();
      setNotice("Scanner ready.");
    } catch (caught) {
      const savedPack = await getOfflinePack().catch(() => null);
      if (offlinePackIsUsable(savedPack)) {
        setPack(savedPack);
        setNotice("Ready to scan. Updates will retry automatically.");
      } else {
        setError(scannerErrorMessage(caught));
      }
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
    if (credential && bootstrap?.device?.outOfDate && navigator.onLine) {
      void downloadAndStorePack();
    }
  }, [bootstrap?.device?.outOfDate, credential, downloadAndStorePack]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let localPack: StoredOfflinePack | null = null;
      try {
        const linkToken = new URLSearchParams(window.location.hash.slice(1)).get("activate");
        if (linkToken) window.history.replaceState(null, "", window.location.pathname);
        const saved = linkToken ? await importScannerLink(linkToken) : await getScannerCredential();
        if (cancelled) return;
        setCredential(saved);
        localPack = await getOfflinePack();
        setPack(localPack);
        if (saved) {
          setBootstrap(await cachedScannerBootstrap());
          setAccessError(await readScannerValue<string>("access-error"));
        }
        await refreshCounts();
        // Local readiness is usable immediately; no network promise holds the screen open.
        if (!cancelled) setInitialising(false);
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
        if (!cancelled) {
          if (offlinePackIsUsable(localPack)) {
            setNotice("Ready to scan. We'll reconnect automatically.");
          } else {
            setError(scannerErrorMessage(caught));
          }
        }
      } finally {
        if (!cancelled) setInitialising(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [downloadAndStorePack, finaliseObservedOfflineTest, refreshBootstrap, refreshCounts, syncNow]);

  useEffect(() => {
    const revoked = (event: Event) => {
      const caught = (event as CustomEvent<ScannerApiError>).detail;
      setAccessError(caught.code ?? "invalid_device");
      qrScannerRef.current?.stop();
      setCameraActive(false);
    };
    window.addEventListener("swp:scanner-access", revoked);
    return () => window.removeEventListener("swp:scanner-access", revoked);
  }, []);

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
      if (scanToastTimerRef.current !== null) {
        window.clearTimeout(scanToastTimerRef.current);
        scanToastTimerRef.current = null;
      }
    },
    [],
  );

  const showScanConfirmation = useCallback((message = "Added to leads") => {
    setConfirmation(message);
    if (scanToastTimerRef.current !== null) window.clearTimeout(scanToastTimerRef.current);
    setScanConfirmationKey((value) => value + 1);
    scanToastTimerRef.current = window.setTimeout(() => {
      setScanConfirmationKey(0);
      scanToastTimerRef.current = null;
    }, 1_200);
  }, []);

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
      setError(scannerActivationErrorMessage(caught));
    } finally {
      setActivating(false);
    }
  };

  const handleDecoded = useCallback(
    async (rawValue: string, source: ScanSource) => {
      if (processingRef.current) return;
      processingRef.current = true;
      setError("");
      try {
        const code = normaliseScannedValue(rawValue);
        if (!code) throw new Error("That QR is not an SWP attendee badge");
        if (accessError)
          throw new Error("Reconnect this scanner before scanning. Your existing leads are safe.");
        const now = Date.now();
        const sameFrame =
          lastDecodeRef.current.code === code && now - lastDecodeRef.current.at < 1_500;
        lastDecodeRef.current = { code, at: now };
        if (sameFrame) return;
        const recentScanAt = recentScansRef.current.get(code);
        if (recentScanAt && now - recentScanAt < 10_000) {
          showScanConfirmation("Already added");
          return;
        }
        for (const [recentCode, scannedAt] of recentScansRef.current) {
          if (now - scannedAt > 60_000) recentScansRef.current.delete(recentCode);
        }
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
          recentScansRef.current.set(code, now);
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
        let attendee = await decryptPackAttendee(code);
        if (!attendee) {
          if (navigator.onLine) {
            try {
              attendee = await lookupScannerBadge(code);
            } catch (caught) {
              if (caught instanceof ScannerApiError && [400, 401, 403, 404].includes(caught.status))
                throw caught;
              // A slow/offline lookup is recoverable; the server will check the original scan later.
            }
          }
        }
        const [pending, confirmed] = await Promise.all([
          pendingScannerItems(),
          cachedScannerLeads(),
        ]);
        const alreadyAdded =
          pending.scans.some((scan) => scan.code === code) ||
          Boolean(attendee && confirmed.some((lead) => lead.attendeeId === attendee.attendeeId));
        if (alreadyAdded) {
          recentScansRef.current.set(code, now);
          showScanConfirmation("Already added");
          return;
        }
        await queueScan({ code, source, attendee });
        recentScansRef.current.set(code, Date.now());
        showScanConfirmation(attendee ? "Added to leads" : "Saved for checking");
        navigator.vibrate?.(50);
        await refreshCounts();
        if (navigator.onLine) void syncNow(true);
      } catch (caught) {
        setError(scannerErrorMessage(caught));
      } finally {
        processingRef.current = false;
      }
    },
    [accessError, bootstrap, refreshBootstrap, refreshCounts, showScanConfirmation, syncNow],
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
      void (async () => {
        await updateReadiness({ cameraTested: true });
        await refreshBootstrap();
      })().catch(() => undefined);
    } catch (caught) {
      setCameraActive(false);
      setError(
        caught instanceof Error && /permission|notallowed/i.test(caught.message)
          ? "Camera access is needed to scan a badge. Allow it when your phone asks, or upload a photo instead."
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
        scan?.attendee?.name ?? "Awaiting badge check",
        scan?.attendee?.company ?? "",
        scan?.attendee?.workEmail ?? "",
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
    if (
      !window.confirm(
        "Disconnect this scanner? Saved work stays on this phone. Open the same person's scanner link to reconnect it.",
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
    recentScansRef.current.clear();
  };

  if (initialising) {
    return (
      <main className="min-h-screen bg-slate-50 grid place-items-center p-6">
        <div className="text-center">
          <RefreshCw className="h-9 w-9 mx-auto text-primary animate-spin" />
          <p className="mt-4 text-muted-foreground">Getting your scanner ready…</p>
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
            <h1 className="text-2xl font-bold mt-2">Start scanning</h1>
            <p className="text-sm text-muted-foreground mt-3">
              Enter your name once. We’ll take care of setup and saving.
            </p>
          </div>
          {error && <ErrorBanner message={error} onClose={() => setError("")} />}
          <Label htmlFor="operator-name">Your name</Label>
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
            <Camera className="h-4 w-4 mr-2" />
            {activating ? "Getting ready…" : "Continue"}
          </Button>
          <Button variant="ghost" className="w-full mt-2" onClick={() => navigate("/sponsor")}>
            <ArrowLeft className="h-4 w-4 mr-2" /> Back to sponsor workspace
          </Button>
        </Card>
      </main>
    );
  }

  const ready = bootstrap?.device?.ready ?? false;
  const rejectedCount = recoveryItems.length;
  const offlineUsable = offlinePackIsUsable(pack);
  const diagnosticsEnabled =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("diagnostics") === "1";

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <header className="sticky top-0 z-30 bg-slate-950/95 backdrop-blur border-b border-white/10">
        <div className="max-w-3xl mx-auto px-4 h-16 flex items-center justify-between gap-3">
          <button
            onClick={() => navigate("/sponsor/leads")}
            className="flex items-center gap-3 text-left"
          >
            <ArrowLeft className="h-5 w-5" />
            <div>
              <p className="font-semibold leading-tight">Scan · Leads</p>
              <p className="text-xs text-slate-400 truncate max-w-44 sm:max-w-none">
                {credential.sponsorCompany} · {credential.operatorName}
              </p>
            </div>
          </button>
          <Button variant="secondary" onClick={() => navigate("/sponsor/leads")}>
            Leads
          </Button>
          {(rejectedCount > 0 || !navigator.onLine) && (
            <div
              className={`rounded-full px-3 py-2 text-xs font-semibold flex items-center gap-2 ${
                rejectedCount
                  ? "bg-rose-500/20 text-rose-200 border border-rose-400/40"
                  : "bg-white/10 text-slate-200 border border-white/15"
              }`}
              aria-live="polite"
            >
              {rejectedCount ? (
                <TriangleAlert className="h-3.5 w-3.5" />
              ) : (
                <WifiOff className="h-3.5 w-3.5" />
              )}
              {rejectedCount ? "Help needed" : "Working offline"}
            </div>
          )}
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-5 space-y-4">
        {accessError && (
          <div role="alert" className="rounded-xl bg-amber-50 text-amber-950 p-4 space-y-3">
            <p>
              Your saved leads are safe.{" "}
              {accessError === "device_revoked"
                ? "Your organiser needs to restore this phone from Team & passes and give you a new scanner link."
                : "Reconnect, or ask your organiser for a renewed scanner link."}
            </p>
            <Button
              variant="secondary"
              onClick={() =>
                void (async () => {
                  if (!credential) return;
                  try {
                    const renewed = await recoverScanner(credential);
                    setCredential(renewed);
                    await refreshBootstrap();
                    setError("");
                    void syncNow(true);
                  } catch (caught) {
                    setError(
                      caught instanceof ScannerApiError && caught.status === 401
                        ? "Ask your sponsor organiser for a renewed scanner link. Open it on this phone; your saved leads will reconnect automatically."
                        : scannerErrorMessage(caught),
                    );
                  }
                })()
              }
            >
              Reconnect scanner
            </Button>
            <Button variant="secondary" onClick={() => navigate("/sponsor/leads")}>
              View saved leads
            </Button>
          </div>
        )}
        {diagnosticsEnabled && updateWaiting && (
          <div className="rounded-xl border border-blue-400/30 bg-blue-500/10 p-3 text-sm text-blue-100">
            An update is ready, but this running event-day scanner will not replace itself. Reload
            only when the organiser tells you to.
          </div>
        )}
        {diagnosticsEnabled && (
          <p className="text-xs text-slate-400">{pendingCount} items waiting to sync</p>
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
            <Button
              size="sm"
              variant="secondary"
              className="mt-3 ml-2"
              onClick={() =>
                void retryRejectedScans()
                  .then(() => syncNow())
                  .catch((caught) => setError(scannerErrorMessage(caught)))
              }
            >
              Check again
            </Button>
          </div>
        )}

        {diagnosticsEnabled && (!ready || bootstrap?.device?.outOfDate) && (
          <ReadinessPanel
            bootstrap={bootstrap}
            pack={pack}
            preparing={preparing}
            onPrepare={() => void downloadAndStorePack()}
            onOfflineTest={() => void runOfflineTest()}
            onSyncTest={() => void runSyncTest()}
          />
        )}

        {diagnosticsEnabled && offlineTestStage === "armed" && (
          <div className="rounded-xl border border-amber-400/40 bg-amber-500/15 p-3 text-sm text-amber-100">
            Offline test waiting: turn off Wi-Fi and mobile data, close and reopen this scanner,
            then reconnect.
          </div>
        )}
        {diagnosticsEnabled && offlineTestStage === "observed" && !navigator.onLine && (
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
                <p
                  role="heading"
                  aria-level={1}
                  className="text-white text-2xl font-bold mt-5 tracking-tight"
                >
                  Scan an attendee
                </p>
                <p className="text-slate-400 text-sm mt-2 max-w-xs">
                  Point this phone at the QR code on their badge. Everything saves automatically,
                  even if the signal drops.
                </p>
                <Button
                  className="mt-6 h-14 px-8 text-base"
                  onClick={() => void startCamera()}
                  disabled={Boolean(accessError) || (!offlineUsable && preparing)}
                >
                  {preparing ? (
                    <RefreshCw className="h-5 w-5 mr-2 animate-spin" />
                  ) : (
                    <Camera className="h-5 w-5 mr-2" />
                  )}
                  {preparing && !offlineUsable ? "Getting ready…" : "Start scanning"}
                </Button>
              </div>
            </div>
          )}
          {cameraActive && (
            <>
              <div className="absolute inset-x-0 top-0 p-4 flex justify-between bg-gradient-to-b from-black/75 to-transparent">
                <div>
                  {!navigator.onLine && (
                    <Badge className="bg-black/60 text-white border border-white/20">
                      <WifiOff className="h-3 w-3 mr-1" />
                      Still working offline
                    </Badge>
                  )}
                </div>
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

        <div>
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
            disabled={Boolean(accessError)}
          >
            <ImageIcon className="h-4 w-4 mr-2" /> Upload photos
          </Button>
        </div>

        <div className="text-center">
          <button
            className="inline-flex items-center gap-2 px-3 py-2 text-sm text-slate-400 hover:text-white"
            onClick={() => setShowHelp((value) => !value)}
            aria-expanded={showHelp}
          >
            <CircleHelp className="h-4 w-4" /> Having trouble?
          </button>
        </div>

        {showHelp && (
          <Card className="p-4 sm:p-5 bg-white text-slate-950 space-y-4">
            <div>
              <h2 className="font-bold">Scanner help</h2>
              <p className="text-sm text-muted-foreground mt-1">
                If a badge will not scan, refresh the scanner and try again.
              </p>
            </div>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => void downloadAndStorePack()}
              disabled={preparing || !navigator.onLine}
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${preparing ? "animate-spin" : ""}`} />
              Refresh scanner
            </Button>

            <div className="pt-1 border-t border-slate-200 flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                If this still does not work, show this screen to the organiser.
              </p>
              <button
                className="shrink-0 text-xs text-slate-500 underline underline-offset-4"
                onClick={() => void forgetPhone()}
              >
                Disconnect phone
              </button>
            </div>
          </Card>
        )}
      </main>

      {scanConfirmationKey > 0 && (
        <div
          key={scanConfirmationKey}
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed inset-x-0 top-20 z-50 flex justify-center px-4"
        >
          <div className="flex items-center gap-2 rounded-full bg-emerald-500 px-5 py-3 text-sm font-bold text-white shadow-[0_12px_36px_rgba(16,185,129,0.35)]">
            <CheckCircle2 className="h-5 w-5" strokeWidth={3} />
            {confirmation}
          </div>
        </div>
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
