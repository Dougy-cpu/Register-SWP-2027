import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { registerSW } from "virtual:pwa-register";

const storage = vi.hoisted(() => ({ unsettled: vi.fn() }));
vi.mock("./scanner-storage", () => ({ scannerHasUnsettledWork: storage.unsettled }));
let options: Parameters<typeof registerSW>[0];
const reload = vi.fn();
const activate = vi.fn();
const register: typeof registerSW = (value) => {
  options = value;
  return activate;
};

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  storage.unsettled.mockReset().mockResolvedValue(false);
  reload.mockReset();
  activate.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("window", { dispatchEvent: vi.fn(), location: { reload } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("does not reload a running scanner when another tab installs an update", async () => {
  const updates = await import("./scanner-updates");
  updates.initialiseScannerUpdates(register);
  options?.onNeedReload?.();
  expect(reload).not.toHaveBeenCalled();
  expect(updates.scannerUpdateState().waiting).toBe(true);
});

it("keeps the current release while any saved queue still needs attention", async () => {
  storage.unsettled.mockResolvedValue(true);
  const updates = await import("./scanner-updates");
  updates.initialiseScannerUpdates(register);
  options?.onNeedRefresh?.();
  await expect(updates.applyScannerUpdate()).rejects.toThrow("still waiting");
  expect(activate).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});

it("reloads only the scanner that explicitly accepted a safe update", async () => {
  const updates = await import("./scanner-updates");
  updates.initialiseScannerUpdates(register);
  options?.onNeedRefresh?.();
  activate.mockImplementation(async () => {
    options?.onNeedReload?.();
  });
  await updates.applyScannerUpdate();
  expect(activate).toHaveBeenCalledWith(true);
  expect(reload).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("releases a stalled update and never reloads later without a new request", async () => {
  const updates = await import("./scanner-updates");
  updates.initialiseScannerUpdates(register);
  options?.onNeedRefresh?.();
  const attempt = expect(updates.applyScannerUpdate()).rejects.toThrow("has not finished");
  await vi.advanceTimersByTimeAsync(12000);
  await attempt;
  options?.onNeedReload?.();
  expect(reload).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
