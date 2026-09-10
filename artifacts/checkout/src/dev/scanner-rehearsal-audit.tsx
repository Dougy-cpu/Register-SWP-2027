// Development entry only, excluded from the production entry graph. The fake
// camera produces actual MediaStream frames so the real decoder, video geometry,
// stream cleanup and React transitions are exercised together in a browser.
import { createRoot } from "react-dom/client";
import { SCANNER_TEST_BADGES, SCANNER_TEST_LINK_MATRIX } from "@/lib/scanner-test-data";
import { REHEARSAL_STORAGE_KEY } from "@/lib/scanner-rehearsal";
import "../index.css";

if (!import.meta.env.DEV || !["localhost", "127.0.0.1"].includes(location.hostname))
  throw new Error("This integration audit is local development only.");
const output = document.querySelector<HTMLPreElement>("#audit-output")!;
const write = (text: string) => {
  output.textContent += `${text}\n`;
};
const check = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
  write(`PASS ${message}`);
};
const effects: string[] = [];
window.fetch = (input) => {
  effects.push(`fetch ${String(input)}`);
  return Promise.reject(new Error("Unexpected network request in rehearsal"));
};
for (const method of ["setItem", "removeItem"] as const) {
  const original = Storage.prototype[method];
  Storage.prototype[method] = function (key: string, value?: string) {
    if (this === localStorage && key === REHEARSAL_STORAGE_KEY)
      return original.call(this, key, value!);
    effects.push(`storage ${method}`);
    throw new Error("Unexpected browser storage write");
  };
}
Storage.prototype.clear = () => {
  effects.push("storage clear");
  throw new Error("Rehearsal must not clear other browser data");
};
indexedDB.open = () => {
  effects.push("IndexedDB open");
  throw new Error("Unexpected IndexedDB access");
};
indexedDB.deleteDatabase = () => {
  effects.push("IndexedDB delete");
  throw new Error("Unexpected IndexedDB access");
};
XMLHttpRequest.prototype.send = () => {
  effects.push("XHR send");
  throw new Error("Unexpected network request");
};
navigator.sendBeacon = () => {
  effects.push("beacon");
  return false;
};
Object.defineProperty(navigator, "userAgent", {
  configurable: true,
  value:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
});
history.replaceState(null, "", "/scanner-test");
const canvas = document.createElement("canvas");
canvas.width = 1280;
canvas.height = 960;
const ctx = canvas.getContext("2d")!;
let matrix: readonly string[] | null = null;
let qrSize = 290;
const streams: MediaStream[] = [];
let failure = false;
function frame() {
  ctx.fillStyle = "#e4e4e4";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (matrix) {
    const cell = Math.floor(qrSize / (matrix.length + 8)),
      side = cell * (matrix.length + 8);
    const x = Math.floor((canvas.width - side) / 2),
      y = Math.floor((canvas.height - side) / 2);
    ctx.fillStyle = "white";
    ctx.fillRect(x, y, side, side);
    ctx.fillStyle = "black";
    matrix.forEach((row, yy) =>
      [...row].forEach((bit, xx) => {
        if (bit === "1") ctx.fillRect(x + (xx + 4) * cell, y + (yy + 4) * cell, cell, cell);
      }),
    );
  }
}
frame();
document.getElementById("show-sample")!.addEventListener("click", () => {
  matrix = SCANNER_TEST_BADGES[0].matrix;
  qrSize = 290;
  frame();
});
document.getElementById("clear-sample")!.addEventListener("click", () => {
  matrix = null;
  frame();
});
const frameTimer = setInterval(frame, 50);
Object.defineProperty(navigator, "mediaDevices", {
  configurable: true,
  value: {
    getUserMedia: async () => {
      if (failure) throw new DOMException("Camera permission denied", "NotAllowedError");
      const stream = canvas.captureStream(20);
      streams.push(stream);
      return stream;
    },
    enumerateDevices: async () => [
      { kind: "videoinput", deviceId: "audit-rear", label: "Simulated rear camera" },
    ],
  },
});
window.addEventListener("pagehide", (event) => {
  if (event.isTrusted) clearInterval(frameTimer);
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
});
const { default: App } = await import("../App");
const rootElement = document.getElementById("root")!;
let root = createRoot(rootElement);
root.render(<App />);
const waitFor = async (predicate: () => unknown, label: string, timeout = 15_000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
const button = (name: string) =>
  [...rootElement.querySelectorAll("button")].find((el) => el.textContent?.trim() === name);
const click = async (name: string) => {
  await waitFor(() => button(name) && !button(name)!.disabled, name);
  button(name)!.click();
};
const see = (text: string) => rootElement.textContent?.includes(text);
const inputNote = (value: string) => {
  const input = rootElement.querySelector("textarea")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
document.getElementById("run-audit")!.addEventListener(
  "click",
  () =>
    void (async () => {
      const trigger = document.querySelector<HTMLButtonElement>("#run-audit")!;
      trigger.disabled = true;
      output.textContent = "";
      try {
        await click("Reset rehearsal");
        await click("Start scanning");
        await waitFor(() => see("Camera ready"), "first camera frame");
        const firstVideo = rootElement.querySelector("video")!;
        check(
          firstVideo.videoWidth > 0 &&
            firstVideo.getBoundingClientRect().width > 1 &&
            getComputedStyle(firstVideo).display !== "none",
          "visible, non-zero camera video with real frames",
        );
        matrix = SCANNER_TEST_BADGES[0].matrix;
        await waitFor(() => see("Alex Morgan"), "decode first badge");
        for (const badge of SCANNER_TEST_BADGES.slice(1)) {
          matrix = badge.matrix;
          await waitFor(() => see(badge.name), `decode ${badge.name}`);
          check(true, `real QR decoder recognises ${badge.code}`);
        }
        check(
          firstVideo === rootElement.querySelector("video") && see("Camera ready"),
          "four badges scanned continuously without restarting the camera",
        );
        matrix = null;
        await click("Leads");
        await waitFor(() => see("Your practice leads"), "lead list");
        check(
          streams.every((s) => s.getTracks().every((t) => t.readyState === "ended")),
          "opening Leads releases the camera",
        );
        rootElement.querySelector<HTMLButtonElement>('[aria-label="Edit Alex Morgan"]')!.click();
        await click("4");
        inputNote("Rehearsal note, saved in this browser");
        await waitFor(
          () => rootElement.querySelector("textarea")?.value.includes("Rehearsal note"),
          "later note edit",
        );
        check(see("Notes save automatically"), "notes and rating can be added later from Leads");
        await click("Scan");
        await click("Start scanning");
        await waitFor(() => see("Camera ready"), "camera restart");
        const nextVideo = rootElement.querySelector("video")!;
        check(
          firstVideo !== nextVideo && nextVideo.videoWidth > 0,
          "returning to Scan starts a new visible video",
        );
        matrix = SCANNER_TEST_BADGES[0].matrix;
        await waitFor(() => see("Already added"), "duplicate badge");
        matrix = null;
        await click("Add note");
        await waitFor(() => rootElement.querySelector("textarea"), "quick notes");
        check(
          rootElement.querySelector("textarea")?.value ===
            "Rehearsal note, saved in this browser" && see("4 of 4 practice badges saved"),
          "repeat scan restores notes without a duplicate lead",
        );
        check(
          rootElement
            .querySelector('[aria-label="Rate 4 out of 5"]')
            ?.getAttribute("aria-pressed") === "true",
          "repeat scan restores rating",
        );
        inputNote("Edited rehearsal note");
        matrix = null;
        await click("Start scanning");
        await waitFor(() => see("Camera ready"), "after note edit");
        matrix = SCANNER_TEST_LINK_MATRIX;
        await waitFor(() => see("Nothing was saved"), "reject QR containing a URL");
        check(see("Camera ready"), "invalid URL QR rejected while camera stays active");
        matrix = null;
        window.dispatchEvent(new PageTransitionEvent("pagehide"));
        await waitFor(() => !!button("Resume camera"), "background pause");
        check(
          streams.every((s) => s.getTracks().every((t) => t.readyState === "ended")),
          "background pause releases every camera track",
        );
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
        await click("Resume camera");
        await waitFor(() => see("Camera ready"), "resume");
        await click("Stop camera");
        failure = true;
        await click("Start scanning");
        await waitFor(() => !!button("Retry camera"), "permission recovery");
        check(
          see("Camera permission"),
          "permission denial has actionable recovery even when the decoder masks the underlying error",
        );
        failure = false;
        await click("Retry camera");
        await waitFor(() => see("Camera ready"), "permission retry");
        const currentStream = streams.at(-1)!;
        currentStream.getVideoTracks()[0].stop();
        await waitFor(() => !!button("Retry camera"), "stalled track recovery");
        check(true, "stopped stream cannot remain a permanent black camera");
        await click("Reset rehearsal");
        await waitFor(() => see("0 of 4 practice badges saved"), "reset render");
        check(see("0 of 4 practice badges saved"), "reset clears isolated practice storage");
        await click("Start scanning");
        await waitFor(() => see("Camera ready"), "distance camera");
        qrSize = 145;
        matrix = SCANNER_TEST_BADGES[0].matrix;
        await waitFor(() => see("Alex Morgan"), "small QR frame");
        check(
          true,
          "compact QR decodes at 145 pixels across in a 1280-pixel frame (synthetic distance check)",
        );
        matrix = null;
        await click("Add note");
        await waitFor(() => rootElement.querySelector("textarea"), "note before reopen");
        inputNote("Keep this note for the break");
        await waitFor(
          () => rootElement.querySelector("textarea")?.value === "Keep this note for the break",
          "save before reopen",
        );
        root.unmount();
        root = createRoot(rootElement);
        root.render(<App />);
        await waitFor(() => see("1 of 4 practice badges saved"), "reopened rehearsal");
        await click("Leads");
        await waitFor(
          () => rootElement.querySelector('[aria-label="Edit Alex Morgan"]'),
          "reopened lead",
        );
        rootElement.querySelector<HTMLButtonElement>('[aria-label="Edit Alex Morgan"]')!.click();
        await waitFor(
          () => rootElement.querySelector("textarea")?.value === "Keep this note for the break",
          "reopened notes",
        );
        check(true, "reopening retains practice leads and notes for the break");
        await click("Scan");
        await waitFor(() => rootElement.querySelector('input[type="file"]'), "photo controls");
        matrix = SCANNER_TEST_BADGES[3].matrix;
        qrSize = 290;
        frame();
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (value) => (value ? resolve(value) : reject(new Error("Photo fixture failed"))),
            "image/png",
          ),
        );
        matrix = null;
        const transfer = new DataTransfer();
        transfer.items.add(new File([blob], "test-badge.png", { type: "image/png" }));
        const photoInput = rootElement.querySelector<HTMLInputElement>('input[type="file"]')!;
        photoInput.files = transfer.files;
        photoInput.dispatchEvent(new Event("change", { bubbles: true }));
        await waitFor(() => see("Sofia Chen"), "decode badge photograph");
        check(true, "real photo decoder recognises a badge without any upload");
        await click("Reset rehearsal");
        await waitFor(() => see("0 of 4 practice badges saved"), "photo reset");
        check(
          effects.length === 0,
          `no network, lead API or real-scanner storage operations (${effects.length})`,
        );
        check(
          streams.every((s) => s.getTracks().every((t) => t.readyState === "ended")),
          "all retired camera tracks ended",
        );
        write(
          "BROWSER REHEARSAL PASSED. Physical phones and installed PWAs still require rehearsal.",
        );
      } catch (error) {
        write(`FAIL ${String(error)}`);
        console.error(error);
      }
    })(),
);
