import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import ScannerTest from "./scanner-test";
import { StrictMode } from "react";
import { REHEARSAL_STORAGE_KEY, readRehearsal } from "@/lib/scanner-rehearsal";
import { cameraMock, installCameraMock, latestCamera } from "@/test/badge-camera-mock";

vi.mock("qr-scanner", async () => ({
  default: (await import("@/test/badge-camera-mock")).MockQrScanner,
}));
beforeEach(() => {
  installCameraMock();
  localStorage.removeItem(REHEARSAL_STORAGE_KEY);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.removeItem(REHEARSAL_STORAGE_KEY);
  localStorage.removeItem("test-real-scanner-sentinel");
});
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const decode = (data: string) => act(() => latestCamera().decode({ data }));
const start = async () => {
  click("Start scanning");
  await screen.findByText("Camera ready");
};
const edit = (name: string) => click(`Edit ${name}`);

it("scans continuously, opens searchable leads for later notes, then restarts a visible camera", async () => {
  const { container } = render(<ScannerTest />);
  await start();
  const firstVideo = container.querySelector("video");
  decode("FACADE000001");
  decode("FACADE000002");
  expect(cameraMock.start).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Camera ready")).toBeTruthy();
  expect(screen.queryByLabelText("Notes")).toBeNull();
  expect(screen.getByText("2 of 4 practice badges saved")).toBeTruthy();
  const retired = latestCamera();
  click("Leads");
  expect(retired.track.readyState).toBe("ended");
  expect(container.querySelector("video")).toBeNull();
  act(() => retired.decode({ data: "FACADE000003" }));
  expect(screen.queryByText("Daniel Okafor")).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Search practice leads" }), {
    target: { value: " northstar " },
  });
  expect(screen.queryByRole("button", { name: "Edit Priya Shah" })).toBeNull();
  edit("Alex Morgan");
  click("Rate 4 out of 5");
  fireEvent.change(screen.getByLabelText("Notes"), {
    target: { value: "Follow up after the event" },
  });
  expect(readRehearsal().find((lead) => lead.code === "FACADE000001")?.note).toBe(
    "Follow up after the event",
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Search practice leads" }), {
    target: { value: "nobody" },
  });
  expect(screen.getByText("No practice leads match that search.")).toBeTruthy();
  click("Scan");
  await start();
  expect(container.querySelector("video")).not.toBe(firstVideo);
  decode("FACADE000003");
  expect(screen.getByText("3 of 4 practice badges saved")).toBeTruthy();
});

it("survives StrictMode replay and rapid repeated starts without leaking streams", async () => {
  const { unmount } = render(
    <StrictMode>
      <ScannerTest />
    </StrictMode>,
  );
  const button = screen.getByRole("button", { name: "Start scanning" });
  fireEvent.click(button);
  fireEvent.click(button);
  await screen.findByText("Camera ready");
  expect(cameraMock.start).toHaveBeenCalledTimes(1);
  decode("FACADE000001");
  decode("FACADE000002");
  click("Leads");
  click("Scan");
  await start();
  expect(cameraMock.start).toHaveBeenCalledTimes(2);
  unmount();
  expect(cameraMock.instances.every((item) => item.track.readyState === "ended")).toBe(true);
});

it("retains notes and ratings across repeat scans and reopening, using only isolated practice storage", async () => {
  localStorage.setItem("test-real-scanner-sentinel", "untouched");
  const forbidden = vi.fn(() => {
    throw new Error("Practice data must stay isolated");
  });
  const nativeSet = Storage.prototype.setItem;
  const nativeRemove = Storage.prototype.removeItem;
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key,
    value,
  ) {
    if (key !== REHEARSAL_STORAGE_KEY) return forbidden();
    return nativeSet.call(this, key, value);
  });
  const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (
    this: Storage,
    key,
  ) {
    if (key !== REHEARSAL_STORAGE_KEY) return forbidden();
    return nativeRemove.call(this, key);
  });
  vi.spyOn(Storage.prototype, "clear").mockImplementation(forbidden);
  vi.stubGlobal("fetch", forbidden);
  vi.stubGlobal("indexedDB", { open: forbidden, deleteDatabase: forbidden });
  vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(forbidden);
  const { unmount } = render(<ScannerTest />);
  await start();
  decode("FACADE000001");
  decode("FACADE000002");
  click("Leads");
  edit("Alex Morgan");
  click("Rate 3 out of 5");
  fireEvent.change(screen.getByLabelText("Notes"), {
    target: { value: "Return during the break" },
  });
  click("Scan");
  await start();
  decode("FACADE000001");
  expect(screen.getByText("Already added")).toBeTruthy();
  click("Add note");
  expect((screen.getByLabelText("Notes") as HTMLTextAreaElement).value).toBe(
    "Return during the break",
  );
  expect(screen.getByRole("button", { name: "Rate 3 out of 5" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  click("Rate 3 out of 5");
  fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Edited in the break" } });
  unmount();
  render(<ScannerTest />);
  expect(screen.getByText("2 of 4 practice badges saved")).toBeTruthy();
  click("Leads");
  edit("Alex Morgan");
  expect((screen.getByLabelText("Notes") as HTMLTextAreaElement).value).toBe("Edited in the break");
  expect(screen.getByRole("button", { name: "Rate 3 out of 5" }).getAttribute("aria-pressed")).toBe(
    "false",
  );
  act(() => {
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("offline"));
  });
  click("Reset rehearsal");
  expect(screen.getByText("0 of 4 practice badges saved")).toBeTruthy();
  expect(readRehearsal()).toEqual([]);
  expect(localStorage.getItem("test-real-scanner-sentinel")).toBe("untouched");
  expect(write).toHaveBeenCalled();
  expect(remove).toHaveBeenCalledWith(REHEARSAL_STORAGE_KEY);
  expect(forbidden).not.toHaveBeenCalled();
});

it("does not confirm failed saves and preserves edited notes for a successful retry", async () => {
  render(<ScannerTest />);
  await start();
  const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Full", "QuotaExceededError");
  });
  decode("FACADE000001");
  expect(screen.queryByText("Saved for practice")).toBeNull();
  expect(screen.getByText("0 of 4 practice badges saved")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("Practice saving is unavailable");
  save.mockRestore();
  decode("FACADE000001");
  click("Leads");
  edit("Alex Morgan");
  const failNotes = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Do not lose this note" } });
  expect(readRehearsal()[0].note).toBe("");
  expect((screen.getByLabelText("Notes") as HTMLTextAreaElement).value).toBe(
    "Do not lose this note",
  );
  const leave = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(leave);
  expect(leave.defaultPrevented).toBe(true);
  failNotes.mockRestore();
  click("Try saving again");
  expect(readRehearsal()[0].note).toBe("Do not lose this note");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("does not overwrite unreadable practice data until reset, and retains leads if reset fails", async () => {
  localStorage.setItem(REHEARSAL_STORAGE_KEY, "malformed");
  render(<ScannerTest />);
  expect(screen.getByRole("alert").textContent).toContain("could not be opened");
  expect(
    (screen.getByRole("button", { name: "Start scanning" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(localStorage.getItem(REHEARSAL_STORAGE_KEY)).toBe("malformed");
  click("Reset rehearsal");
  await start();
  decode("FACADE000001");
  const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("Unavailable");
  });
  click("Reset rehearsal");
  expect(screen.getByRole("alert").textContent).toContain("could not be cleared");
  expect(screen.getByText("1 of 4 practice badges saved")).toBeTruthy();
  remove.mockRestore();
  click("Reset rehearsal");
  expect(screen.getByText("0 of 4 practice badges saved")).toBeTruthy();
});

it("rejects invalid, partial, URL and unknown payloads while continuing to scan", async () => {
  render(<ScannerTest />);
  await start();
  for (const data of [
    "FACADE00001",
    "FACADE00000G",
    "https://example.com/FACADE000001",
    "ABCDEF123456",
    "",
    "FACADE 000001",
  ]) {
    decode(data);
    expect(screen.getByRole("alert").textContent).toContain("Nothing was saved");
    expect(screen.getByText("Camera ready")).toBeTruthy();
  }
  decode(" facade000004 ");
  expect(screen.getByText("1 of 4 practice badges saved")).toBeTruthy();
});

it("cancels late photo results on navigation, reset, camera restart and unmount", async () => {
  let finish!: (value: { data: string }) => void;
  cameraMock.photo.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { unmount } = render(<ScannerTest />);
  const file = new File(["photo"], "badge.png", { type: "image/png" });
  const photo = () =>
    fireEvent.change(screen.getByLabelText("Test badge photo"), { target: { files: [file] } });
  photo();
  click("Leads");
  await act(async () => finish({ data: "FACADE000001" }));
  expect(screen.queryByText("Alex Morgan")).toBeNull();
  click("Scan");
  photo();
  click("Reset rehearsal");
  await act(async () => finish({ data: "FACADE000001" }));
  expect(readRehearsal()).toEqual([]);
  photo();
  await start();
  await act(async () => finish({ data: "FACADE000002" }));
  expect(screen.queryByText("Priya Shah")).toBeNull();
  photo();
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
  expect(screen.getByText(/Scan several badges, then tap Leads/)).toBeTruthy();
  expect(container.querySelector("video")).toBeNull();
  expect(screen.queryByRole("button", { name: /Start camera|Start scanning|Email me/ })).toBeNull();
  click("Copy link");
  await screen.findByText("Link copied. Paste it into your phone browser.");
  expect(copy).toHaveBeenCalledWith("https://register.swpsummit.com/scanner-test");
  expect(screen.getAllByRole("img", { name: /Test badge for/ })).toHaveLength(4);
  expect(cameraMock.start).not.toHaveBeenCalled();
});
