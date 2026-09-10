import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { initialiseScannerUpdates } from "./lib/scanner-updates";
import { registerSW } from "virtual:pwa-register";

if (/^\/sponsor(?:\/|$)/.test(window.location.pathname)) {
  initialiseScannerUpdates(registerSW);
}

createRoot(document.getElementById("root")!).render(<App />);
