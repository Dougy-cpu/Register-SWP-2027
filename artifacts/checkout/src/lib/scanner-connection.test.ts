import { afterEach, expect, it, vi } from "vitest";
afterEach(() => vi.useRealTimers());
it("starts offline when the browser reopens without a connection", async () => {
  vi.resetModules();
  const hint = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  try {
    const connection = await import("./scanner-connection");
    expect(connection.scannerConnection()).toBe("unavailable");
    hint.mockReturnValue(true);
    window.dispatchEvent(new Event("online"));
    expect(connection.scannerConnection()).toBe("unavailable");
    connection.recordScannerContact(true);
    expect(connection.scannerConnection()).toBe("connected");
  } finally {
    hint.mockRestore();
  }
});

it("backs off failed requests, permits explicit retry and resets after actual server contact", async () => {
  vi.resetModules();
  vi.useFakeTimers();
  const connection = await import("./scanner-connection");
  expect(connection.scannerConnection()).toBe("unknown");
  connection.recordScannerContact(false);
  expect(connection.scannerConnection()).toBe("unavailable");
  expect(connection.isScannerNetworkFailure(new TypeError("Failed to fetch"))).toBe(true);
  expect(connection.isScannerNetworkFailure(new Error("Phone storage is full"))).toBe(false);
  expect(connection.scannerRetryDue()).toBe(false);
  expect(connection.scannerRetryDue(true)).toBe(true);
  await vi.advanceTimersByTimeAsync(3100);
  expect(connection.scannerRetryDue()).toBe(true);
  connection.recordScannerContact(false);
  await vi.advanceTimersByTimeAsync(3100);
  expect(connection.scannerRetryDue()).toBe(false);
  connection.recordScannerContact(true);
  expect(connection.scannerConnection()).toBe("connected");
  expect(connection.scannerRetryDue()).toBe(true);
});
