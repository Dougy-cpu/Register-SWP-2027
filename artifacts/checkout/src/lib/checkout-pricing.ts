import { calculatePricing, type PricingRequest } from "@workspace/api-client-react";

// A stalled connection must lead to a visible retry, not a permanently disabled checkout.
export async function calculateCheckoutPricing(data: PricingRequest, options: RequestInit = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("We couldn't update your total. Please try again."));
    }, 10000);
  });
  try {
    return await Promise.race([
      calculatePricing(data, { ...options, signal: controller.signal }),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
