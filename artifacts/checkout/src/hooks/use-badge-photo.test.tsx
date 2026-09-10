import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PHOTO_TIMEOUT_MS, useBadgePhoto } from "./use-badge-photo";
const scan = vi.hoisted(() => vi.fn());
vi.mock("qr-scanner", () => ({ default: { scanImage: scan } }));
beforeEach(() => {
  scan.mockReset();
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const photo = new File(["QR"], "badge.png", { type: "image/png" });
it("bounds a stalled photo decode and ignores its late result", async () => {
  let finish!: (value: { data: string }) => void;
  scan.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const decoded = vi.fn(),
    error = vi.fn();
  const { result } = renderHook(() => useBadgePhoto(decoded, error));
  act(() => {
    void result.current.scan(photo);
  });
  expect(result.current.busy).toBe(true);
  await act(() => vi.advanceTimersByTimeAsync(PHOTO_TIMEOUT_MS));
  expect(result.current.busy).toBe(false);
  expect(error).toHaveBeenCalledWith(expect.stringContaining("took too long"));
  await act(async () => finish({ data: "FACADE000001" }));
  expect(decoded).not.toHaveBeenCalled();
});
it("allows successful photo retry after a decode failure", async () => {
  scan.mockRejectedValueOnce("No QR code found").mockResolvedValueOnce({ data: "FACADE000001" });
  const decoded = vi.fn(),
    error = vi.fn();
  const { result } = renderHook(() => useBadgePhoto(decoded, error));
  await act(() => result.current.scan(photo));
  expect(error).toHaveBeenCalledOnce();
  await act(() => result.current.scan(photo));
  expect(decoded).toHaveBeenCalledWith("FACADE000001");
  expect(result.current.busy).toBe(false);
});
it("keeps the photo busy until its decoded badge has finished saving", async () => {
  scan.mockResolvedValue({ data: "FACADE000001" });
  let saved!: () => void;
  const decoded = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        saved = resolve;
      }),
  );
  const error = vi.fn();
  const { result } = renderHook(() => useBadgePhoto(decoded, error));
  await act(async () => {
    void result.current.scan(photo);
  });
  expect(decoded).toHaveBeenCalledOnce();
  expect(result.current.busy).toBe(true);
  // The image watchdog ends when decoding succeeds; persistence is a separate stage.
  await act(() => vi.advanceTimersByTimeAsync(PHOTO_TIMEOUT_MS));
  expect(error).not.toHaveBeenCalled();
  await act(async () => saved());
  expect(result.current.busy).toBe(false);
});
