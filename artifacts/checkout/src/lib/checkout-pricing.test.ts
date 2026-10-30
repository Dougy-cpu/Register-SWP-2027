import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PricingBreakdown, PricingRequest } from "@workspace/api-client-react";
import { calculateCheckoutPricing } from "./checkout-pricing";

const api = vi.hoisted(() => ({ calculatePricing: vi.fn() }));
vi.mock("@workspace/api-client-react", () => ({ calculatePricing: api.calculatePricing }));

const request: PricingRequest = { passType: "single", quantity: 1 };
const quote = { passType: "single", quantity: 1, total: 226.8 } as PricingBreakdown;

beforeEach(() => {
  vi.useFakeTimers();
  api.calculatePricing.mockReset().mockResolvedValue(quote);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("calculateCheckoutPricing", () => {
  it("returns the server quote, preserves request options and clears its deadline", async () => {
    const result = await calculateCheckoutPricing(request, {
      headers: { "x-test-request": "checkout" },
    });

    expect(result).toBe(quote);
    expect(api.calculatePricing).toHaveBeenCalledWith(request, {
      headers: { "x-test-request": "checkout" },
      signal: expect.any(AbortSignal),
    });
    const signal = api.calculatePricing.mock.calls[0][1].signal as AbortSignal;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10000);
    expect(signal.aborted).toBe(false);
  });

  it("ends a stalled quote after ten seconds and permits a fresh successful retry", async () => {
    let resolveLate!: (quote: PricingBreakdown) => void;
    api.calculatePricing.mockImplementationOnce(
      () =>
        new Promise<PricingBreakdown>((resolve) => {
          resolveLate = resolve;
        }),
    );
    const success = vi.fn();
    const failure = vi.fn();
    const outcome = calculateCheckoutPricing(request).then(success, failure);
    const signal = api.calculatePricing.mock.calls[0][1].signal as AbortSignal;
    await vi.advanceTimersByTimeAsync(9999);
    expect(failure).not.toHaveBeenCalled();
    expect(signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await outcome;
    expect(failure).toHaveBeenCalledTimes(1);
    expect(failure.mock.calls[0][0].message).toBe(
      "We couldn't update your total. Please try again.",
    );
    expect(signal.aborted).toBe(true);
    expect(await calculateCheckoutPricing(request)).toBe(quote);

    // A late response from an adapter that ignores abort must not revive the old quote.
    resolveLate({ ...quote, total: 0 });
    await Promise.resolve();
    expect(success).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forwards caller cancellation to the request and removes the pending deadline", async () => {
    api.calculatePricing.mockImplementationOnce(
      (_data: PricingRequest, options: RequestInit) =>
        new Promise((_, reject) => {
          options.signal!.addEventListener("abort", () => {
            reject(new DOMException("Request cancelled", "AbortError"));
          });
        }),
    );
    const caller = new AbortController();
    const result = calculateCheckoutPricing(request, { signal: caller.signal });
    const failure = expect(result).rejects.toMatchObject({ name: "AbortError" });
    caller.abort();
    await failure;

    expect((api.calculatePricing.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes an already-cancelled signal to the underlying request", async () => {
    api.calculatePricing.mockImplementationOnce((_data: PricingRequest, options: RequestInit) => {
      expect(options.signal?.aborted).toBe(true);
      return Promise.reject(new DOMException("Request cancelled", "AbortError"));
    });
    const caller = new AbortController();
    caller.abort();

    await expect(
      calculateCheckoutPricing(request, { signal: caller.signal }),
    ).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves a server failure and clears the timeout instead of reporting a later second error", async () => {
    const error = new Error("Pricing unavailable");
    api.calculatePricing.mockRejectedValueOnce(error);

    await expect(calculateCheckoutPricing(request)).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });
});
