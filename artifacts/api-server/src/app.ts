import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import pinoHttp from "pino-http";
import router from "./routes";
import { getOptionalEnv, isProductionEnv } from "./lib/env";
import { logger } from "./lib/logger";
import { adminLoginThrottle } from "./middleware/admin-login-throttle";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app: Express = express();

const isProduction = isProductionEnv();
app.disable("x-powered-by");

// Trust the first proxy hop so that express-rate-limit reads the real client
// IP from X-Forwarded-For rather than the proxy address. On Replit autoscale,
// requests pass through exactly one reverse-proxy layer.
if (isProduction) {
  app.set("trust proxy", 1);
}

// ---------------------------------------------------------------------------
// Security headers (Helmet)
// ---------------------------------------------------------------------------
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://js.stripe.com", "'unsafe-inline'"],
        frameSrc: ["'self'", "https://js.stripe.com"],
        connectSrc: ["'self'", "https://api.stripe.com", "https://js.stripe.com"],
        imgSrc: ["'self'", "data:", "https://q.stripe.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: isProduction ? [] : null,
      },
    },
    hsts: isProduction
      ? {
          maxAge: 63072000, // 2 years
          includeSubDomains: true,
          preload: true,
        }
      : false,
    frameguard: { action: "deny" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    crossOriginEmbedderPolicy: false,
  }),
);

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
const PRODUCTION_ORIGIN = "https://register.swpsummit.com";

function productionOrigin(): string {
  const raw = getOptionalEnv("APP_BASE_URL") ?? PRODUCTION_ORIGIN;
  try {
    return new URL(raw).origin;
  } catch {
    return PRODUCTION_ORIGIN;
  }
}

const corsOptions: cors.CorsOptions = isProduction
  ? {
      origin: productionOrigin(),
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "x-admin-token",
        "x-booking-session",
        "x-sponsor-csrf",
        "stripe-signature",
      ],
    }
  : {
      origin: true,
      credentials: true,
    };

app.use(cors(corsOptions));

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        const pathname = req.url?.split("?")[0] ?? "";
        return {
          id: req.id,
          method: req.method,
          url: pathname.startsWith("/api/sponsor/access/")
            ? "/api/sponsor/access/[redacted]"
            : pathname,
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// ---------------------------------------------------------------------------
// Rate limiting (API routes only)
// ---------------------------------------------------------------------------
const generalApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
  skip: (_req) => !isProduction,
});

const bookingCreationLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many booking requests, please try again later." },
  skip: (_req) => !isProduction,
});

const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many payment requests, please try again later." },
  skip: (_req) => !isProduction,
});

// Failure-aware throttle for /api/admin/login. The first few wrong passwords
// are free, then each subsequent failure escalates the cool-off (1m → 5m →
// 15m → 60m). A *successful* login wipes the counter for that IP, so a
// legitimate admin who fat-fingered their password a couple of times is not
// punished. Implemented in middleware/admin-login-throttle.ts.

// Apply general API limiter to all /api routes except the Stripe webhook,
// which can burst when Stripe retries events on our behalf.
app.use("/api", (req, res, next) => {
  if (req.path === "/stripe/webhook") return next();
  return generalApiLimiter(req, res, next);
});

// Tighter limits on mutation/creation endpoints only — reads and updates
// on /api/bookings/* are not restricted beyond the general limiter.
app.post("/api/admin/login", adminLoginThrottle);
app.post("/api/bookings", bookingCreationLimiter);
app.post("/api/stripe/create-checkout-session", paymentLimiter);
app.post("/api/stripe/create-invoice", paymentLimiter);
app.post("/api/stripe/confirm-card-payment", paymentLimiter);

// ---------------------------------------------------------------------------
// Body parsing — must come before route handlers
// Stripe webhook needs raw body; all others get JSON
// ---------------------------------------------------------------------------
app.use("/api/stripe/webhook", express.raw({ type: "application/json" }));

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
app.use("/api", router);

// ---------------------------------------------------------------------------
// Static frontend (production only)
// In production, the Express server serves the pre-built Vite output so the
// whole app lives on one origin — both at register.swpsummit.com.
// ---------------------------------------------------------------------------
if (isProduction) {
  // Path from compiled dist/ to the checkout frontend build
  const frontendDist = path.resolve(__dirname, "../../checkout/dist/public");

  if (fs.existsSync(frontendDist)) {
    app.use(express.static(frontendDist, { index: false }));

    // SPA fallback — serve index.html for any non-API, non-asset route so
    // client-side routing (wouter) works on hard refresh / direct navigation.
    // Express 5 requires named wildcard parameter syntax (not bare *).
    app.get(/(.*)/, (req, res, next) => {
      if (req.path.startsWith("/api")) {
        next();
        return;
      }
      const indexPath = path.join(frontendDist, "index.html");
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        next();
      }
    });
  } else {
    logger.warn(
      { frontendDist },
      "Frontend dist not found — static serving skipped. Run pnpm build first.",
    );
  }
}

export default app;
