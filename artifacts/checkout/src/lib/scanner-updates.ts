import type { registerSW } from "virtual:pwa-register";
import { SCANNER_RELEASE } from "./scanner-release";
import { scannerHasUnsettledWork } from "./scanner-storage";

let registration: ServiceWorkerRegistration | undefined;
let update: ReturnType<typeof registerSW> | undefined;
let approved = false;
let waiting = false;
let latest: string | null = null;
let checked = false;
let offlineReady = false;
let updateCompleted: (() => void) | undefined;
const changed = () => window.dispatchEvent(new Event("swp:scanner-update"));

export function scannerUpdateState() {
  return { running: SCANNER_RELEASE, latest, checked, waiting, offlineReady };
}
export function initialiseScannerUpdates(register: typeof registerSW) {
  update = register({
    immediate: true,
    onRegisteredSW(_url, value) {
      registration = value;
    },
    onOfflineReady() {
      offlineReady = true;
      changed();
    },
    onNeedRefresh() {
      waiting = true;
      changed();
      window.dispatchEvent(new CustomEvent("swp:update-ready"));
    },
    // Another tab accepting an update must not reload an active scanner or note.
    onNeedReload() {
      if (approved) {
        updateCompleted?.();
        window.location.reload();
      } else {
        waiting = true;
        changed();
      }
    },
  });
}
export async function checkScannerUpdate() {
  try {
    const response = await fetch(`/scanner-version.json?t=${Date.now()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return;
    const value = await response.json();
    if (typeof value.version !== "string" || !/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(value.version))
      return;
    latest = value.version;
    checked = true;
    if (registration) await registration.update();
    if (registration?.waiting) waiting = true;
    if ("caches" in window) {
      const script = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
      offlineReady = Boolean(
        script &&
        (await caches.match(script.src, { ignoreSearch: true })) &&
        (await caches.match(new URL("/index.html", location.origin), { ignoreSearch: true })),
      );
    }
    changed();
  } catch {
    /* Offline scanning does not wait for a release check. */
  }
}
export async function applyScannerUpdate() {
  if (await scannerHasUnsettledWork())
    throw new Error(
      "Saved scans or notes are still waiting. Reconnect and let them back up before updating.",
    );
  if (!waiting || !update) {
    await checkScannerUpdate();
    throw new Error("Keep this page open while the update downloads, then try again.");
  }
  approved = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const activated = new Promise<void>((resolve, reject) => {
    updateCompleted = resolve;
    timer = setTimeout(
      () =>
        reject(
          new Error(
            "The update has not finished. Keep this page open and try again when connected.",
          ),
        ),
      12000,
    );
  });
  try {
    await Promise.all([update(true), activated]);
  } catch (error) {
    approved = false;
    throw error;
  } finally {
    clearTimeout(timer);
    updateCompleted = undefined;
  }
}
