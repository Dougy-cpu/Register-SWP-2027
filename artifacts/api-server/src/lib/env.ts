export function getOptionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

export function getRequiredEnv(name: string): string {
  const value = getOptionalEnv(name);
  if (!value) {
    throw new Error(`${name} environment variable is required but was not provided.`);
  }
  return value;
}

export function getEnvInt(name: string, fallback: number): number {
  const raw = getOptionalEnv(name);
  if (!raw) return fallback;

  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production";
}

export function getLogLevel(): string {
  return getOptionalEnv("LOG_LEVEL") ?? "info";
}

export function getStripeSecretKey(): string | undefined {
  return getOptionalEnv("STRIPE_SECRET_KEY");
}

export function getAdminPasswordEnv(): string | undefined {
  return getOptionalEnv("ADMIN_PASSWORD");
}

export function getAdminTokenSecretEnv(): string | undefined {
  return getOptionalEnv("ADMIN_TOKEN_SECRET");
}

export function getPort(): number {
  const raw = getRequiredEnv("PORT");
  const port = Number(raw);

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PORT value: "${raw}"`);
  }

  return port;
}
