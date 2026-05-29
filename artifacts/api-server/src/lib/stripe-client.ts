import Stripe from "stripe";
import { getStripeSecretKey } from "./env";

let cachedKey: string | null = null;
let cachedStripe: Stripe | null = null;

export function getStripe(): Stripe | null {
  const key = getStripeSecretKey();
  if (!key) {
    cachedKey = null;
    cachedStripe = null;
    return null;
  }

  if (cachedStripe && cachedKey === key) {
    return cachedStripe;
  }

  cachedKey = key;
  cachedStripe = new Stripe(key, {
    maxNetworkRetries: 2,
    timeout: 10_000,
    appInfo: {
      name: "hras-checkout",
      version: "1.0.0",
    },
  });

  return cachedStripe;
}
