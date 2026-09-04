import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { registerSW } from "virtual:pwa-register";

if (/^\/sponsor(?:\/|$)/.test(window.location.pathname)) {
  registerSW({
    immediate: true,
    onNeedRefresh() {
      window.dispatchEvent(new CustomEvent("swp:update-ready"));
    },
  });
}

createRoot(document.getElementById("root")!).render(<App />);
