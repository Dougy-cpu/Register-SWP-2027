export type ScannerConnection = "unknown" | "connected" | "unavailable";
let connection: ScannerConnection = "unknown";
let lastContact = 0;
let failures = 0;
let retryAt = 0;

export function scannerConnection(): ScannerConnection {
  return connection;
}
export function recordScannerContact(ok: boolean) {
  lastContact = Date.now();
  connection = ok ? "connected" : "unavailable";
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
  window.dispatchEvent(new Event("swp:scanner-connection"));
}
export function scannerRetryDue(force = false): boolean {
  return force || Date.now() >= retryAt;
}
export function lastScannerContact() {
  return lastContact;
}
