import pino from "pino";
import { getLogLevel, isProductionEnv } from "./env";

const isProduction = isProductionEnv();

export const logger = pino({
  level: getLogLevel(),
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "req.headers.x-admin-token",
    "req.headers.x-booking-session",
    "res.headers['set-cookie']",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
