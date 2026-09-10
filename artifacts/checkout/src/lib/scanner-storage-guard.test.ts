import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ScannerStorageError,
  STORAGE_TIMEOUT_MS,
  startStorageTransaction,
  storageOperation,
} from "./scanner-storage-guard";
afterEach(() => vi.useRealTimers());
describe("storage failure recovery", () => {
  it("releases a hung operation and closes a late connection without reporting success", async () => {
    vi.useFakeTimers();
    let finish!: (value: string) => void;
    const expired = vi.fn();
    const result = storageOperation(
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
      expired,
    );
    const check = expect(result).rejects.toBeInstanceOf(ScannerStorageError);
    await vi.advanceTimersByTimeAsync(STORAGE_TIMEOUT_MS);
    await check;
    finish("late commit");
    expect(expired).toHaveBeenCalledOnce();
  });
  it("aborts a stalled transaction before releasing its caller", async () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    startStorageTransaction({ done: new Promise(() => undefined), abort });
    await vi.advanceTimersByTimeAsync(STORAGE_TIMEOUT_MS - 100);
    expect(abort).toHaveBeenCalledOnce();
  });
  it("does not abort completed writes or leave their timers running", async () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    startStorageTransaction({ done: Promise.resolve(), abort });
    expect(await storageOperation(Promise.resolve("saved"))).toBe("saved");
    await vi.advanceTimersByTimeAsync(STORAGE_TIMEOUT_MS * 2);
    expect(abort).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
