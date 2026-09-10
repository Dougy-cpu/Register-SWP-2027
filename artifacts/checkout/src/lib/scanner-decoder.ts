import { createWorker } from "qr-scanner/qr-scanner-worker.min.js";

// A static import puts the fallback decoder into the initial application bundle.
// The first photo/camera scan must not need a lazy network download, including
// the first page load before a new service worker can control the page.
export function prepareScannerDecoder() {
  if (typeof Worker === "undefined") return;
  const worker = createWorker();
  worker.terminate();
}
