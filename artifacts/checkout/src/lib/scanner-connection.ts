export type ScannerConnection = "unknown" | "connected" | "unavailable";
let connection: ScannerConnection =
  typeof navigator !== "undefined" && navigator.onLine === false ? "unavailable" : "unknown";
let lastContact = 0;
let failures = 0;
let retryAt = 0;

export function scannerConnection(): ScannerConnection {
  return connection;
}
export function isScannerNetworkFailure(error: unknown) {
  return (
    connection === "unavailable" &&
    error instanceof Error &&
    (error.name === "AbortError" ||
      (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)))
  );
}
function setConnection(next: ScannerConnection) {
  if (connection === next) return;
  connection = next;
  window.dispatchEvent(new Event("swp:scanner-connection"));
}

// Keep outages across scanner screens. Only contact with the server clears the notice.
if (typeof window !== "undefined") {
  window.addEventListener("offline", () => setConnection("unavailable"));
}

export function subscribeScannerConnection(listener: () => void) {
  window.addEventListener("swp:scanner-connection", listener);
  return () => window.removeEventListener("swp:scanner-connection", listener);
}

export function recordScannerContact(ok: boolean) {
  lastContact = Date.now();
  if (ok) {
    failures = 0;
    retryAt = 0;
  } else {
    failures++;
    retryAt =
      Date.now() +
      Math.min(60_000, 2000 * 2 ** Math.min(failures - 1, 5)) +
      Math.floor(Math.random() * 1000);
  }
  setConnection(ok ? "connected" : "unavailable");
}
export function scannerRetryDue(force = false): boolean {
  return force || Date.now() >= retryAt;
}
export function lastScannerContact() {
  return lastContact;
}
