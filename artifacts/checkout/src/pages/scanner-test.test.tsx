import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ScannerTest from "./scanner-test";
import { StrictMode } from "react";

import { cameraMock, installCameraMock, latestCamera } from "@/test/badge-camera-mock";
vi.mock("qr-scanner", async () => ({
  default: (await import("@/test/badge-camera-mock")).MockQrScanner,
}));
beforeEach(installCameraMock);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("remounts a visible video and resumes scanning after a successful test scan", async () => {
  const { container } = render(<ScannerTest />);
  fireEvent.click(screen.getByRole("button", { name: "Start camera test" }));
  await waitFor(() => expect(cameraMock.start).toHaveBeenCalledTimes(1));
  await screen.findByText("Camera ready");
  const firstVideo = container.querySelector("video");
  act(() => latestCamera().decode({ data: "FACADE000001" }));
  expect(screen.getByText("Alex Morgan")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Rate 4 out of 5" }));
  fireEvent.change(screen.getByLabelText("Notes"), {
    target: { value: "Follow up after the event" },
  });
  expect(screen.getByText(/Saved for this rehearsal only/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Scan another test badge" }));
  await waitFor(() => expect(cameraMock.start).toHaveBeenCalledTimes(2));
  await screen.findByText("Camera ready");
  expect(container.querySelector("video")).not.toBe(firstVideo);
  act(() => latestCamera().decode({ data: "FACADE000002" }));
  expect(screen.getByText("Priya Shah")).toBeTruthy();
});

it("survives StrictMode mount replay and rapid repeated user actions", async () => {
  const { unmount } = render(
    <StrictMode>
      <ScannerTest />
    </StrictMode>,
  );
  const start = screen.getByRole("button", { name: "Start camera test" });
  fireEvent.click(start);
  fireEvent.click(start);
  await screen.findByText("Camera ready");
  expect(cameraMock.start).toHaveBeenCalledTimes(1);
  act(() => latestCamera().decode({ data: "FACADE000001" }));
  const another = screen.getByRole("button", { name: "Scan another test badge" });
  fireEvent.click(another);
  fireEvent.click(another);
  await screen.findByText("Camera ready");
  expect(cameraMock.start).toHaveBeenCalledTimes(2);
  unmount();
  expect(cameraMock.instances.every((item) => item.track.readyState === "ended")).toBe(true);
});

it("keeps duplicate ratings, edits, notes and resets in memory without side effects", async () => {
  const network = vi.fn(() => {
    throw new Error("No test data may leave this page");
  });
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(network);
  const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(network);
  const clear = vi.spyOn(Storage.prototype, "clear").mockImplementation(network);
  vi.stubGlobal("fetch", network);
  vi.stubGlobal("indexedDB", { open: network, deleteDatabase: network });
  const xhr = vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(network);
  const { unmount } = render(<ScannerTest />);
  const scan = async (code: string) => {
    fireEvent.click(
      screen.getByRole("button", { name: /Start camera test|Scan another test badge/ }),
    );
    await screen.findByText("Camera ready");
    act(() => latestCamera().decode({ data: code }));
  };
  await scan("FACADE000001");
  fireEvent.click(screen.getByRole("button", { name: "Rate 3 out of 5" }));
  fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Only in memory" } });
  await scan("FACADE000002");
  await scan("FACADE000001");
  expect(screen.getByText(/Already recognised this rehearsal/)).toBeTruthy();
  expect((screen.getByLabelText("Notes") as HTMLTextAreaElement).value).toBe("Only in memory");
  expect(screen.getByRole("button", { name: "Rate 3 out of 5" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "Rate 3 out of 5" }));
  fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Edited" } });
  expect(screen.getByText("2 of 4 recognised this rehearsal")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Reset rehearsal" }));
  expect(screen.getByText("0 of 4 recognised this rehearsal")).toBeTruthy();
  await scan("FACADE000001");
  expect((screen.getByLabelText("Notes") as HTMLTextAreaElement).value).toBe("");
  unmount();
  render(<ScannerTest />);
  expect(screen.getByText("0 of 4 recognised this rehearsal")).toBeTruthy();
  act(() => {
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("offline"));
  });
  expect(network).not.toHaveBeenCalled();
  for (const spy of [write, remove, clear, xhr]) expect(spy).not.toHaveBeenCalled();
});

it("rejects invalid, partial, URL and unknown payloads while continuing to scan", async () => {
  render(<ScannerTest />);
  fireEvent.click(screen.getByRole("button", { name: "Start camera test" }));
  await screen.findByText("Camera ready");
  for (const data of [
    "FACADE00001",
    "FACADE00000G",
    "https://example.com/FACADE000001",
    "ABCDEF123456",
    "",
    "FACADE 000001",
  ]) {
    act(() => latestCamera().decode({ data }));
    expect(screen.getByRole("alert").textContent).toContain("Nothing was saved");
    expect(screen.getByText("Camera ready")).toBeTruthy();
  }
  act(() => latestCamera().decode({ data: " facade000004 " }));
  expect(screen.getByText("1 of 4 recognised this rehearsal")).toBeTruthy();
});

it("cancels stale photo results on reset, camera restart and unmount", async () => {
  let finish!: (value: { data: string }) => void;
  cameraMock.photo.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { unmount } = render(<ScannerTest />);
  const file = new File(["photo"], "badge.png", { type: "image/png" });
  fireEvent.change(screen.getByLabelText("Test badge photo"), { target: { files: [file] } });
  expect(screen.getByRole("button", { name: "Reading photo…" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Reset rehearsal" }));
  await act(async () => finish({ data: "FACADE000001" }));
  expect(screen.queryByText("Alex Morgan")).toBeNull();
  fireEvent.change(screen.getByLabelText("Test badge photo"), { target: { files: [file] } });
  fireEvent.click(screen.getByRole("button", { name: "Start camera test" }));
  await screen.findByText("Camera ready");
  await act(async () => finish({ data: "FACADE000002" }));
  expect(screen.queryByText("Priya Shah")).toBeNull();
  fireEvent.change(screen.getByLabelText("Test badge photo"), { target: { files: [file] } });
  unmount();
  await act(async () => finish({ data: "FACADE000001" }));
  expect(cameraMock.instances.every((item) => item.destroyed)).toBe(true);
});

it("shows the desktop badge handoff with copyable URL and no camera controls", async () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0",
  );
  const copy = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
  const { container } = render(<ScannerTest />);
  expect(screen.getByText("Lead scanner test kit")).toBeTruthy();
  expect(screen.getByText("Copy this link and paste it into your phone browser.")).toBeTruthy();
  expect(container.querySelector("video")).toBeNull();
  expect(screen.queryByRole("button", { name: /Start camera|Start scanning|Email me/ })).toBeNull();
  expect(screen.queryByRole("link", { name: /Open scanner test|Open test device/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  await screen.findByText("Link copied. Paste it into your phone browser.");
  expect(copy).toHaveBeenCalledWith("https://register.swpsummit.com/scanner-test");
  expect(screen.getAllByRole("img", { name: /Test badge for/ })).toHaveLength(4);
  expect(cameraMock.start).not.toHaveBeenCalled();
});
