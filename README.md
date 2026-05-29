# Register-SWP-2027

**SWP Summit 2027 — Conference Registration & Checkout System**

A full-stack, production-grade event registration platform built for the **SWP Summit 2027** (Wednesday, 3 March 2027, 1 Basinghall Avenue, London). Handles the complete attendee journey from initial pass selection through Stripe card payment or invoice checkout, attendee management, email delivery, and a comprehensive admin back-office.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture & Monorepo Structure](#2-architecture--monorepo-structure)
3. [Technology Stack](#3-technology-stack)
4. [Workspace Packages](#4-workspace-packages)
5. [Database Schema](#5-database-schema)
6. [API Reference](#6-api-reference)
7. [Frontend Application](#7-frontend-application)
8. [Admin Panel](#8-admin-panel)
9. [Pricing Engine](#9-pricing-engine)
10. [Payment Flows](#10-payment-flows)
11. [Email System](#11-email-system)
12. [Google Sheets Integration](#12-google-sheets-integration)
13. [Calendar / iCal Support](#13-calendar--ical-support)
14. [Environment Variables & Secrets](#14-environment-variables--secrets)
15. [Running the Project](#15-running-the-project)
16. [Development Workflows](#16-development-workflows)
17. [Codegen & Type Safety](#17-codegen--type-safety)
18. [GitHub Sync](#18-github-sync)
19. [Security Notes](#19-security-notes)
20. [Brand & Design Tokens](#20-brand--design-tokens)
21. [Order Reference Format](#21-order-reference-format)
22. [Key Business Rules](#22-key-business-rules)

---

## 1. Project Overview

This system manages the entire registration lifecycle for the SWP Summit:

- **Public checkout** — multi-step form collecting lead/attendee details, pass selection, promo code application, and payment (card or invoice)
- **Self-service management** — token-gated attendee management and billing edit pages (no login required)
- **Admin back-office** — full registrations dashboard, promo code CRUD, discount tier management, pass configuration, email template editor, audit log, and invoice tooling
- **Automated communications** — confirmation emails with PDF VAT receipt, welcome emails per attendee, organiser notification emails, and invoice reminder emails
- **Stripe integration** — Checkout Sessions for card payments, Stripe Invoicing for invoice/bank-transfer payments, webhook-driven status updates
- **Google Sheets sync** — one-row-per-attendee live export to a Google Sheet for operational use

---

## 2. Architecture & Monorepo Structure

This is a **pnpm workspace monorepo**. All packages share a single `node_modules` at the root and use TypeScript composite project references for fast incremental builds.

```
workspace/
├── artifacts/
│   ├── api-server/          # Express 5 REST API (port 8080 in dev, $PORT in prod)
│   └── checkout/            # React + Vite frontend (port from $PORT)
├── lib/
│   ├── api-spec/            # Single source of truth: openapi.yaml + Orval codegen config
│   ├── api-client-react/    # Generated React Query hooks (never edit by hand)
│   ├── api-zod/             # Generated Zod v4 schemas from OpenAPI spec
│   └── db/                  # Drizzle ORM schema, migrations, and DB connection
├── scripts/
│   ├── sync-to-github.sh    # Pushes workspace to Register-SWP-2027 on GitHub
│   └── post-merge.sh        # Post-merge setup (runs after task-agent merges)
├── pnpm-workspace.yaml
├── tsconfig.base.json       # Shared TypeScript compiler options
├── tsconfig.json            # Root project references
├── eslint.config.mjs
├── vitest.config.ts
└── package.json
```

### Key Design Decisions

- **OpenAPI-first**: The API contract lives in `lib/api-spec/openapi.yaml`. Frontend hooks and Zod schemas are generated from it — never hand-written.
- **Integer-pence arithmetic**: All monetary calculations internally use integer pence (× 100) to eliminate floating-point drift. Pounds appear only at the API boundary.
- **Atomic confirmation**: Booking status flip, promo counter increment, and all side effects (email, Sheets sync) run inside a single DB transaction, preventing split-brain on crash.
- **Per-side-effect delivery flags**: Each post-confirmation action (`confirmationEmailSent`, `welcomeEmailsSent`, `organiserNotified`, `sheetsSynced`) has its own boolean column. Failed deliveries are visible in the admin panel and can be individually retried.

---

## 3. Technology Stack

| Layer             | Technology                             |
| ----------------- | -------------------------------------- |
| **Monorepo**      | pnpm workspaces                        |
| **Language**      | TypeScript 5.9 (strict, composite)     |
| **Node.js**       | 24                                     |
| **API Framework** | Express 5                              |
| **Database**      | PostgreSQL + Drizzle ORM               |
| **Validation**    | Zod v4 (`zod/v4`), `drizzle-zod`       |
| **API Contract**  | OpenAPI 3.1 (Orval codegen)            |
| **Frontend**      | React, Vite, Tailwind CSS, shadcn/ui   |
| **Routing (FE)**  | Wouter                                 |
| **Data Fetching** | TanStack React Query v5                |
| **Payments**      | Stripe (Checkout Sessions + Invoicing) |
| **Email**         | Nodemailer (SMTP) + PDFKit (receipts)  |
| **PDF**           | PDFKit                                 |
| **Google Sheets** | `googleapis` (service account)         |
| **Logging**       | Pino                                   |
| **Build (API)**   | esbuild (CJS bundle)                   |
| **Build (FE)**    | Vite                                   |
| **Testing**       | Vitest                                 |
| **Linting**       | ESLint 10 + typescript-eslint          |
| **Formatting**    | Prettier                               |

---

## 4. Workspace Packages

### `artifacts/api-server`

Express 5 REST API. Handles all business logic, DB access, Stripe calls, email sending, and Sheets sync.

- **Entry**: `src/index.ts`
- **Port**: `8080` in development, `$PORT` in production
- **Routes module**: `src/routes/index.ts` — mounts all sub-routers
- **Lib modules**:
  - `src/lib/pricing.ts` — VAT + group discount + promo code calculation engine
  - `src/lib/invoice.ts` — Stripe invoice create/reissue/void/refresh logic
  - `src/lib/email.ts` — Nodemailer transport + template rendering + PDF attachment
  - `src/lib/pdf.ts` — PDFKit VAT receipt generator (fallback when no Stripe PDF)
  - `src/lib/booking-confirmation.ts` — orchestrates all post-payment side effects
  - `src/lib/google-sheets.ts` — Google Sheets append/upsert for attendee rows
  - `src/lib/audit.ts` — writes to `activity_log` for every admin mutation
  - `src/lib/seed.ts` — idempotent seed: email templates, discount tiers, pass config
  - `src/lib/logger.ts` — Pino logger instance
  - `src/lib/order-reference.ts` — `SWP27-{6541 + bookingId}` format
  - `src/lib/ics.ts` — RFC-5545 iCalendar file generation
  - `src/lib/schema-check.ts` — startup DB schema validation
  - `src/lib/invoice-status.ts` — stale-cache poll of Stripe invoice status
- **Middleware**:
  - `src/middleware/admin-auth.ts` — HMAC-SHA256 token verification
  - `src/middleware/admin-login-throttle.ts` — rate-limit 5 attempts / 15 min / IP

### `artifacts/checkout`

React + Vite SPA, served from `$PORT`. Uses generated React Query hooks from `@workspace/api-client-react`.

- **Entry**: `src/main.tsx`
- **Router**: Wouter, base path from `import.meta.env.BASE_URL`
- **State**: TanStack React Query (server state), local React state (form steps)

### `lib/api-spec`

Single OpenAPI 3.1 YAML (`openapi.yaml`) that is the authoritative API contract. Orval config (`orval.config.ts`) drives code generation into `lib/api-client-react` and `lib/api-zod`.

### `lib/api-client-react`

Auto-generated React Query v5 hooks for every API operation. **Never edit these files manually** — regenerate with `pnpm --filter @workspace/api-spec run codegen`.

### `lib/api-zod`

Auto-generated Zod v4 schemas matching every OpenAPI component schema. Used for request/response validation both server- and client-side.

### `lib/db`

Drizzle ORM schema definitions and the database connection singleton. Exports all table objects and insert/select types.

---

## 5. Database Schema

All tables use PostgreSQL via Drizzle ORM. The connection string is read from `DATABASE_URL`.

### `bookings`

Core registration record. One row per checkout session.

| Column                            | Type          | Notes                                                                                 |
| --------------------------------- | ------------- | ------------------------------------------------------------------------------------- |
| `id`                              | serial PK     |                                                                                       |
| `session_token`                   | text UNIQUE   | Browser session identifier                                                            |
| `status`                          | enum          | `partial`, `pending_payment`, `paid`, `invoiced`, `cancelled`, `refunded`, `disputed` |
| `pass_type`                       | enum          | `single`, `business`                                                                  |
| `attendee_type`                   | enum          | `hr_professional`, `consultant_vendor`                                                |
| `quantity`                        | integer       | Number of passes                                                                      |
| `promo_code`                      | text          | Applied promo code (uppercase)                                                        |
| `promo_discount_amount`           | numeric(10,2) |                                                                                       |
| `group_discount_amount`           | numeric(10,2) |                                                                                       |
| `subtotal_amount`                 | numeric(10,2) | After discounts, excl. VAT                                                            |
| `vat_amount`                      | numeric(10,2) | 20% UK VAT                                                                            |
| `total_amount`                    | numeric(10,2) | Including VAT                                                                         |
| `payment_method`                  | enum          | `card`, `invoice`                                                                     |
| `stripe_session_id`               | text UNIQUE   | Stripe Checkout Session ID                                                            |
| `stripe_payment_intent_id`        | text          |                                                                                       |
| `stripe_invoice_id`               | text          |                                                                                       |
| `stripe_invoice_pdf_url`          | text          |                                                                                       |
| `stripe_invoice_payment_url`      | text          |                                                                                       |
| `stripe_invoice_status`           | text          | Cached from Stripe                                                                    |
| `stripe_invoice_status_synced_at` | timestamptz   | Cache freshness marker                                                                |
| `order_reference`                 | text UNIQUE   | `SWP27-{6541+id}`                                                                     |
| `current_step`                    | integer       | Step 1–4 (checkout progress)                                                          |
| `billing_*`                       | text          | Full billing address fields                                                           |
| `po_number`                       | text          | Purchase order number                                                                 |
| `invoice_due_date`                | timestamptz   | 14 days from invoice creation                                                         |
| `paid_at`                         | timestamptz   |                                                                                       |
| `management_token`                | text UNIQUE   | Token for self-service URL                                                            |
| `hear_about_us`                   | text          | How registrant heard about the event                                                  |
| `confirmation_email_sent`         | boolean       | Per-side-effect delivery flag                                                         |
| `welcome_emails_sent`             | boolean       | Per-side-effect delivery flag                                                         |
| `organiser_notified`              | boolean       | Per-side-effect delivery flag                                                         |
| `sheets_synced`                   | boolean       | Per-side-effect delivery flag                                                         |
| `partial_notification_sent`       | boolean       | Abandoned checkout flag                                                               |
| `created_at` / `updated_at`       | timestamptz   |                                                                                       |

**Indexes**: `stripe_session_id` (unique), `stripe_payment_intent_id`, `stripe_invoice_id`, `order_reference` (unique), `promo_code`

### `attendees`

One row per person attending. Linked to `bookings` by `booking_id`.

| Column                     | Type        | Notes                    |
| -------------------------- | ----------- | ------------------------ |
| `id`                       | serial PK   |                          |
| `booking_id`               | integer FK  | References `bookings.id` |
| `is_lead`                  | boolean     | Lead/primary contact     |
| `first_name` / `last_name` | text        |                          |
| `job_title` / `company`    | text        |                          |
| `work_email`               | text        |                          |
| `phone`                    | text        |                          |
| `dietary_requirements`     | text        |                          |
| `accessibility_needs`      | text        |                          |
| `linkedin_url`             | text        |                          |
| `gdpr_consent`             | boolean     |                          |
| `gdpr_consent_at`          | timestamptz |                          |

### `promo_codes`

| Column                       | Type          | Notes                                                |
| ---------------------------- | ------------- | ---------------------------------------------------- |
| `id`                         | serial PK     |                                                      |
| `code`                       | text UNIQUE   | Always stored uppercase                              |
| `discount_type`              | enum          | `percentage`, `fixed`, `per_ticket`, `complimentary` |
| `discount_value`             | numeric(10,2) | Percentage or £ amount                               |
| `max_discount_amount`        | numeric(10,2) | Cap for percentage codes                             |
| `max_uses`                   | integer       | Null = unlimited                                     |
| `used_count`                 | integer       | Atomically incremented                               |
| `is_active`                  | boolean       |                                                      |
| `valid_from` / `valid_until` | timestamptz   | Date-range gating                                    |
| `description`                | text          | Internal label                                       |

### `discount_tiers`

Group discount tiers per pass type (e.g. 4+ Single passes → 10% off).

| Column             | Type                                |
| ------------------ | ----------------------------------- |
| `id`               | serial PK                           |
| `pass_type`        | enum (`single`, `team`, `business`) |
| `min_quantity`     | integer                             |
| `discount_percent` | numeric(5,2)                        |
| `label`            | text                                |

**Default tiers** (seeded on first start):

- Single: 4+ → 10%, 8+ → 15%, 12+ → 20%
- Business: 2+ → 10%, 5+ → 15%

### `email_templates`

Editable email templates for `confirmation` and `welcome` types. HTML body with `{{placeholder}}` variables. Seeded with defaults on first start.

### `email_logs`

Record of every email sent: `booking_id`, `type`, `recipient`, `subject`, `status`, `error`, `sent_at`.

### `notification_emails`

Admin-configurable list of email addresses that receive organiser notifications on each new booking.

### `pass_inventory`

Per-pass-type stock control: `pass_type`, `total_capacity`, `sold_count`, `reserved_count`, `is_sold_out_override`.

### `pass_config`

Admin-editable pass pricing, period name, and benefit lists. Overrides the hard-coded defaults in `pricing.ts` when present.

### `event_settings`

Key-value store for event configuration: event date/time, venue, social event details, and the Google Sheets spreadsheet ID.

### `activity_log`

Full audit trail. Every admin mutation writes a row: `actor`, `action`, `summary`, `entity_type`, `entity_id`, `before` (JSON diff), `after` (JSON diff), `meta`, `created_at`.

### `hear_about_us`

Admin-managed ordered list of "How did you hear about us?" options displayed on the checkout Step 1 form.

---

## 6. API Reference

All routes are prefixed `/api`. The full contract is in `lib/api-spec/openapi.yaml`.

### Health

| Method | Path           | Description                               |
| ------ | -------------- | ----------------------------------------- |
| `GET`  | `/api/healthz` | Health check — returns `{ status: "ok" }` |

### Bookings

| Method  | Path                          | Description                               |
| ------- | ----------------------------- | ----------------------------------------- |
| `POST`  | `/api/bookings`               | Create or upsert booking by session token |
| `GET`   | `/api/bookings/:sessionToken` | Get booking by session token              |
| `PATCH` | `/api/bookings/:id`           | Update booking fields                     |

### Attendees

| Method  | Path                        | Description                      |
| ------- | --------------------------- | -------------------------------- |
| `POST`  | `/api/attendees`            | Create attendee(s) for a booking |
| `GET`   | `/api/attendees/:bookingId` | List attendees for a booking     |
| `PATCH` | `/api/attendees/:id`        | Update a single attendee         |

### Pricing

| Method | Path                          | Description                                                    |
| ------ | ----------------------------- | -------------------------------------------------------------- |
| `GET`  | `/api/pricing`                | Calculate pricing (passType, quantity, promoCode query params) |
| `POST` | `/api/pricing/validate-promo` | Validate a promo code                                          |

### Promo Codes (public validate)

| Method | Path                        | Description               |
| ------ | --------------------------- | ------------------------- |
| `POST` | `/api/promo-codes/validate` | Validate code eligibility |

### Stripe

| Method | Path                                  | Description                                      |
| ------ | ------------------------------------- | ------------------------------------------------ |
| `POST` | `/api/stripe/create-checkout-session` | Create Stripe Checkout Session (card payment)    |
| `POST` | `/api/stripe/create-invoice`          | Create and send Stripe Invoice (invoice payment) |
| `POST` | `/api/stripe/webhook`                 | Stripe webhook handler (raw body required)       |
| `GET`  | `/api/stripe/session-status`          | Poll checkout session status                     |

### Email

| Method  | Path                              | Description              |
| ------- | --------------------------------- | ------------------------ |
| `GET`   | `/api/email/templates`            | List all email templates |
| `GET`   | `/api/email/templates/:type`      | Get a single template    |
| `PATCH` | `/api/email/templates/:type`      | Update template (admin)  |
| `POST`  | `/api/email/templates/:type/test` | Send test email          |
| `GET`   | `/api/email/logs`                 | List email send logs     |

### Admin (all require `x-admin-token` header)

| Method   | Path                                            | Description                                                    |
| -------- | ----------------------------------------------- | -------------------------------------------------------------- |
| `POST`   | `/api/admin/login`                              | Authenticate with `ADMIN_PASSWORD` — rate-limited              |
| `GET`    | `/api/admin/stats`                              | Dashboard summary stats                                        |
| `GET`    | `/api/admin/registrations`                      | Paginated registrations list (filter by status, search, promo) |
| `GET`    | `/api/admin/registrations/export`               | CSV export of all registrations                                |
| `GET`    | `/api/admin/registrations/:id`                  | Get single registration detail                                 |
| `POST`   | `/api/admin/registrations/:id/redeliver`        | Retry failed post-confirmation side effects                    |
| `PATCH`  | `/api/admin/registrations/:id/status`           | Update booking status                                          |
| `DELETE` | `/api/admin/registrations`                      | Bulk-delete bookings                                           |
| `GET`    | `/api/admin/promo-codes`                        | List all promo codes                                           |
| `POST`   | `/api/admin/promo-codes`                        | Create promo code                                              |
| `PATCH`  | `/api/admin/promo-codes/:id`                    | Update promo code                                              |
| `DELETE` | `/api/admin/promo-codes/:id`                    | Delete promo code                                              |
| `PUT`    | `/api/admin/discount-tiers`                     | Replace all discount tiers for a pass type                     |
| `GET`    | `/api/admin/passes/inventory`                   | Get pass inventory                                             |
| `PUT`    | `/api/admin/passes/inventory/:passType`         | Update pass inventory                                          |
| `GET`    | `/api/admin/passes/config`                      | Get pass pricing config                                        |
| `PUT`    | `/api/admin/passes/config/:passType`            | Update pass pricing and benefits                               |
| `GET`    | `/api/admin/notification-emails`                | List organiser notification recipients                         |
| `POST`   | `/api/admin/notification-emails`                | Add notification recipient                                     |
| `PATCH`  | `/api/admin/notification-emails/:id`            | Update recipient                                               |
| `DELETE` | `/api/admin/notification-emails/:id`            | Remove recipient                                               |
| `GET`    | `/api/admin/activity`                           | Audit log (filterable by type, actor, date)                    |
| `GET`    | `/api/admin/unpaid-invoices`                    | List open/overdue invoices                                     |
| `GET`    | `/api/admin/unpaid-invoices/summary`            | Count and total of unpaid invoices                             |
| `POST`   | `/api/admin/unpaid-invoices/bulk-remind`        | Send invoice reminder emails in bulk                           |
| `POST`   | `/api/admin/bookings/:id/send-invoice-reminder` | Send reminder for a single invoice                             |

### Calendar

| Method | Path                       | Description                                      |
| ------ | -------------------------- | ------------------------------------------------ |
| `GET`  | `/api/calendar/main.ics`   | iCalendar file for the main summit (public)      |
| `GET`  | `/api/calendar/social.ics` | iCalendar file for the pre-event social (public) |

### Hear About Us

| Method   | Path                         | Description             |
| -------- | ---------------------------- | ----------------------- |
| `GET`    | `/api/hear-about-us`         | List active options     |
| `POST`   | `/api/hear-about-us`         | Add option (admin)      |
| `DELETE` | `/api/hear-about-us/:id`     | Remove option (admin)   |
| `PATCH`  | `/api/hear-about-us/reorder` | Reorder options (admin) |

### Manage (self-service, token-gated)

| Method  | Path                               | Description                                 |
| ------- | ---------------------------------- | ------------------------------------------- |
| `GET`   | `/api/manage/:token`               | Get booking + attendees by management token |
| `PATCH` | `/api/manage/:token/attendees/:id` | Update an attendee via management token     |
| `GET`   | `/api/manage/:token/billing`       | Get billing details                         |
| `PATCH` | `/api/manage/:token/billing`       | Update billing details                      |

---

## 7. Frontend Application

The checkout frontend is a React SPA served at the root path `/`.

### Routes

| Path                     | Component            | Description                           |
| ------------------------ | -------------------- | ------------------------------------- |
| `/`                      | `CheckoutFlow`       | Main multi-step checkout              |
| `/admin/login`           | `AdminLogin`         | Admin password entry                  |
| `/admin`                 | `AdminDashboard`     | Stats overview                        |
| `/admin/registrations`   | `AdminRegistrations` | Registrations list + management       |
| `/admin/promo-codes`     | `AdminPromoCodes`    | Promo code CRUD                       |
| `/admin/discount-tiers`  | `AdminDiscountTiers` | Group discount configuration          |
| `/admin/emails`          | `AdminEmails`        | Email logs + template editor          |
| `/admin/notifications`   | `AdminNotifications` | Organiser notification recipients     |
| `/admin/passes`          | `AdminPasses`        | Pass pricing, benefits, and inventory |
| `/admin/settings`        | `AdminSettings`      | Event settings (date, venue, social)  |
| `/admin/activity`        | `AdminActivity`      | Audit trail                           |
| `/manage/:token`         | `ManageAttendees`    | Self-service attendee editing         |
| `/manage/:token/billing` | `EditBilling`        | Self-service billing address edit     |

### Checkout Flow Steps

The checkout is a four-step linear form, resumable by session token (stored in `localStorage`):

1. **Step 1 — Your Details**: Lead attendee name, email, phone, job title, company, how they heard about the event. GDPR consent.
2. **Step 2 — Pass Selection**: Choose pass type (Single HR / Business Vendor), quantity, attendee type, apply promo code. Live pricing with VAT breakdown.
3. **Step 3 — Additional Attendees**: Fill in details for all non-lead seats (name, email, job title, company, dietary, accessibility, LinkedIn). Placeholder seats allowed — attendees can update via the management link later.
4. **Step 4 — Payment**: Choose card or invoice. Card → Stripe Checkout redirect. Invoice → billing details form (address, PO number, VAT number), then Stripe Invoice created and emailed.

After payment/invoice: **Confirmation page** showing order reference, attendee summary, pricing breakdown, and management link.

### Component Structure

```
src/
├── pages/
│   ├── checkout/
│   │   ├── index.tsx               # Step orchestrator
│   │   ├── Step1Lead.tsx
│   │   ├── Step2Passes.tsx
│   │   ├── Step3Attendees.tsx
│   │   ├── Step4Payment.tsx
│   │   ├── Confirmation.tsx
│   │   └── CompShortfallPrompt.tsx # UI for complimentary code seat cap
│   ├── admin/
│   │   ├── dashboard.tsx
│   │   ├── login.tsx
│   │   ├── registrations.tsx
│   │   ├── promo-codes.tsx
│   │   ├── discount-tiers.tsx
│   │   ├── emails.tsx
│   │   ├── notifications.tsx
│   │   ├── passes.tsx
│   │   ├── settings.tsx
│   │   └── activity.tsx
│   └── manage/
│       ├── ManageAttendees.tsx
│       └── EditBilling.tsx
├── components/
│   ├── ui/                         # shadcn/ui primitives
│   ├── layout/                     # Page shell, nav
│   ├── admin/                      # Admin-specific shared components
│   └── InvoiceBadge.tsx
├── hooks/
│   ├── use-mobile.tsx
│   └── use-toast.ts
├── lib/                            # Shared utilities
├── tokens.css                      # Design token CSS variables
└── index.css                       # Tailwind base + global styles
```

---

## 8. Admin Panel

Access at `/admin`. Protected by password + HMAC-signed token.

### Authentication

- Login via `POST /api/admin/login` with `{ password }` body
- Rate-limited: **5 attempts per 15 minutes per IP** (always on — cannot be disabled)
- On success: returns a token `<sigHex>.<expMs>` stored in `localStorage` as `admin_token`
- Token passed as `x-admin-token` request header on every subsequent admin API call
- Token TTL: **30 days**, enforced server-side
- Signature: HMAC-SHA256 keyed by `ADMIN_TOKEN_SECRET` (not the password) — a stolen token cannot be used to brute-force `ADMIN_PASSWORD` offline
- Startup guard: if `ADMIN_PASSWORD` matches a known weak value (`admin`, `admin123`, `password`, `123456`, `secret`, etc.), the server logs a warning and the admin panel returns `503` until a stronger password is set

### Admin Pages

| Page           | URL                     | Features                                                                                                                       |
| -------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Dashboard      | `/admin`                | Total bookings, revenue, attendees, recent activity                                                                            |
| Registrations  | `/admin/registrations`  | Search, filter by status, Stripe invoice links, overdue badges, Send Reminder, redeliver side effects, CSV export, bulk delete |
| Promo Codes    | `/admin/promo-codes`    | Create/edit/delete codes, usage tracking, date gating                                                                          |
| Discount Tiers | `/admin/discount-tiers` | Configure group discount thresholds per pass type                                                                              |
| Emails         | `/admin/emails`         | View send log, edit confirmation/welcome templates, send test emails                                                           |
| Notifications  | `/admin/notifications`  | Add/remove organiser notification email addresses                                                                              |
| Passes         | `/admin/passes`         | Edit prices, original prices, benefits list, inventory (capacity/sold/reserved, sold-out override)                             |
| Settings       | `/admin/settings`       | Event date/time, venue, pre-event social config, Google Sheets spreadsheet ID                                                  |
| Activity       | `/admin/activity`       | Full audit log with before/after diffs, filterable by type and actor                                                           |

### Audit Log

Every admin action writes to `activity_log`:

- Login success / failure (with source IP)
- Booking status changes, edits, deletes
- Promo code CRUD
- Discount tier changes
- Pass inventory / config changes
- Email template edits, test sends, resends
- Invoice reminder sends
- Notification email CRUD
- Event settings changes
- Hear-about-us add/delete/reorder
- Attendee admin edits

---

## 9. Pricing Engine

File: `artifacts/api-server/src/lib/pricing.ts`

All monetary values are computed in **integer pence** internally. Pounds appear only at the API boundary (`penceToPounds` / `poundsToPence` helpers).

### Pass Prices (defaults — overridable via admin pass config)

| Pass     | Type                | Price (excl. VAT) | Was    | Seats per unit |
| -------- | ------------------- | ----------------- | ------ | -------------- |
| Single   | HR Professional     | £199              | £429   | 1              |
| Team     | HR Professional     | £499              | £1,200 | 3              |
| Business | Consultant / Vendor | £599              | £999   | 1              |

> **Note**: The Team pass is a fixed-price bundle — 1 unit covers 3 seats.

### Calculation Order

1. **Base subtotal** = `pricePerUnit × billingUnits` (pence)
2. **Group discount** = largest matching tier percent × base subtotal (integer division, single `Math.round`)
3. **Promo discount** applied to `baseSubtotal − groupDiscount`:
   - `percentage`: `(afterGroup × pct) / 100`, capped by `max_discount_amount` if set
   - `per_ticket`: `perTicketAmount × quantity`, capped at afterGroup
   - `complimentary`: 100% off if `remainingSeats >= quantity`, else no discount (UI prompts user to reduce quantity)
   - `fixed`: flat amount, capped at afterGroup
4. **Subtotal after discounts** = `max(0, baseSubtotal − groupDiscount − promoDiscount)` (never negative)
5. **VAT** = `subtotalAfterDiscounts × 2000 / 10000` (20%, integer pence, single `Math.round`)
6. **Total** = `subtotalAfterDiscounts + vat`

### Promo Code Atomic Increment

`incrementPromoUsage()` uses a conditional `UPDATE … WHERE usedCount + inc <= maxUses` so concurrent confirmations cannot oversubscribe a capped code. For `complimentary` codes the counter increments by the booking quantity (tracks seats), for all other types by 1 (tracks bookings).

---

## 10. Payment Flows

### Card Payment (Stripe Checkout)

1. Frontend calls `POST /api/stripe/create-checkout-session` with `bookingId`
2. Server creates a Stripe Checkout Session, returns `{ url }`
3. Frontend redirects to Stripe-hosted payment page
4. On success: Stripe sends `checkout.session.completed` webhook
5. Webhook handler (`POST /api/stripe/webhook`) looks up booking by `stripe_session_id`, runs atomic confirmation inside a DB transaction:
   - Increments promo usage (if applicable)
   - Flips `status → paid`, sets `order_reference`, `paid_at`
   - Triggers post-confirmation side effects (email, Sheets, organiser notification)
6. Frontend polls `GET /api/stripe/session-status` and redirects to Confirmation page

### Invoice Payment (Stripe Invoicing)

1. Frontend collects billing details on Step 4, calls `POST /api/stripe/create-invoice`
2. Server runs `reissueBookingInvoice()`:
   - Finds or creates Stripe Customer (deduped by email), syncs billing address
   - Gets or creates UK VAT 20% tax rate in Stripe (cached per process)
   - Creates Stripe Invoice with line items: pass description, group discount (negative), promo discount (negative)
   - Finalizes and sends invoice via Stripe (14-day payment terms)
   - Stores `stripeInvoiceId`, `stripeInvoicePdfUrl`, `stripeInvoicePaymentUrl`, `invoiceDueDate`
   - Flips `status → invoiced`
3. Confirmation email is sent immediately with the real Stripe Invoice PDF attached
4. When customer pays online: Stripe sends `invoice.payment_succeeded` webhook → booking flipped to `paid`
5. Admin can send manual reminders from the Registrations panel (sends branded email with PDF + banking details)

### Invoice Footer (shown on every Stripe invoice)

```
Issued by: Dynamic Business Leaders Limited
Company No. 12252258  |  VAT No. 336124621
Registered Address: 45 Lemsford Village, Welwyn Garden City, Hertfordshire AL8 7TR
Bank: Tide (ClearBank)  |  Sort Code: 04-06-05  |  Account: 16963209
IBAN (GBP): GB65CLRB04060516963209  |  SWIFT: CLRBGB22
IBAN (EUR): GB45TCCL00997990500906  |  BIC: TCCLGB31
```

### Stale Invoice Status Sync

`refreshStripeInvoiceStatusIfStale()` is called on every booking read. If the cached `stripe_invoice_status_synced_at` is older than 5 minutes and the booking isn't already `paid`/`cancelled`, it fetches the live status from Stripe and persists it. `refreshStripeInvoiceUrls()` always fetches fresh (used on download/resend paths).

---

## 11. Email System

File: `artifacts/api-server/src/lib/email.ts`

Emails are sent via Nodemailer using SMTP credentials from environment variables.

### Email Types

| Type                       | Trigger                      | Recipients                             | Attachment                                    |
| -------------------------- | ---------------------------- | -------------------------------------- | --------------------------------------------- |
| **Confirmation**           | On booking payment/invoice   | Lead attendee (or billing contact)     | Stripe Invoice PDF (fallback: PDFKit receipt) |
| **Welcome**                | On booking payment/invoice   | Every individual attendee              | None                                          |
| **Organiser notification** | On new paid/invoiced booking | All addresses in `notification_emails` | None                                          |
| **Invoice reminder**       | Admin-triggered or bulk send | Billing contact                        | Stripe Invoice PDF                            |

### Email Template Variables

Templates use `{{placeholder}}` syntax. Available in confirmation/welcome:

| Variable                   | Description                                         |
| -------------------------- | --------------------------------------------------- |
| `{{firstName}}`            | Lead attendee first name                            |
| `{{orderReference}}`       | `SWP27-XXXXX`                                       |
| `{{passLabel}}`            | Human-readable pass name                            |
| `{{quantity}}`             | Number of passes                                    |
| `{{quantityLabel}}`        | "pass" or "passes"                                  |
| `{{attendeesTable}}`       | HTML table of all attendees                         |
| `{{priceSummary}}`         | HTML price breakdown                                |
| `{{poNumberSection}}`      | PO number row (if set)                              |
| `{{eventDate}}`            | From event settings                                 |
| `{{eventVenue}}`           | From event settings                                 |
| `{{eventVenuePostcode}}`   | From event settings                                 |
| `{{eventCalendarLinks}}`   | "Add to Calendar" links block                       |
| `{{socialCalendarLinks}}`  | Pre-event social calendar links (if enabled)        |
| `{{managementLink}}`       | Self-service attendee management URL                |
| `{{invoicePaymentButton}}` | "Pay Invoice Online" button (invoice bookings only) |

### PDF Receipt Fallback

If the Stripe PDF URL is unavailable, `src/lib/pdf.ts` generates a branded PDFKit receipt with full VAT breakdown, order reference, and attendee list.

---

## 12. Google Sheets Integration

File: `artifacts/api-server/src/lib/google-sheets.ts`

Uses a Google service account with `spreadsheets` scope. Configured via three environment variables. The spreadsheet ID is stored in `event_settings` (editable in admin Settings page).

**Sheet structure**: One row per attendee. Booking-level fields are repeated on each row for flat analysis.

**Columns**: Order Reference, Booking Date, Pass Type, Quantity, Attendee Type, Payment Method, Booking Status, Seat Index, Is Lead, First Name, Last Name, Job Title, Company, Work Email, Phone, GDPR Consent, GDPR Consent At, Subtotal (exc VAT), VAT, Total (inc VAT), Promo Code, Group Discount, Promo Discount.

Headers are auto-created on first write if the sheet is empty.

### Required Secrets for Sheets

| Variable                             | Value                                                          |
| ------------------------------------ | -------------------------------------------------------------- |
| `GOOGLE_SHEETS_SPREADSHEET_ID`       | The ID from the Google Sheet URL                               |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL`       | Service account `client_email`                                 |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | Service account `private_key` (with literal `\n` for newlines) |

---

## 13. Calendar / iCal Support

File: `artifacts/api-server/src/lib/ics.ts`

Two public iCalendar endpoints (no auth required):

- `GET /api/calendar/main.ics` — RFC-5545 file for the main summit
- `GET /api/calendar/social.ics` — RFC-5545 file for the pre-event social (returns 404 if social is not enabled or dates not configured)

Event data (start/end times, venue, description) is read from `event_settings`. Both endpoints return `404` with a plain-text body if the required settings are not yet configured.

Calendar links are injected into confirmation and welcome emails via the `{{eventCalendarLinks}}` and `{{socialCalendarLinks}}` template variables.

---

## 14. Environment Variables & Secrets

Set all secrets in the Replit Secrets panel (never in source code or `.env` files committed to git).

### Required for Core Operation

| Variable         | Purpose                                                           |
| ---------------- | ----------------------------------------------------------------- |
| `DATABASE_URL`   | PostgreSQL connection string (auto-provided by Replit PostgreSQL) |
| `ADMIN_PASSWORD` | Admin panel password. Must not be a common weak value.            |

### Required for Stripe Payments

| Variable                | Purpose                                                  |
| ----------------------- | -------------------------------------------------------- |
| `STRIPE_SECRET_KEY`     | Stripe secret key (`sk_live_…` or `sk_test_…`)           |
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret from Stripe Dashboard (`whsec_…`) |

### Required for Email

| Variable     | Purpose                        | Default |
| ------------ | ------------------------------ | ------- |
| `SMTP_HOST`  | SMTP server hostname           | —       |
| `SMTP_PORT`  | SMTP port                      | `587`   |
| `SMTP_USER`  | SMTP username                  | —       |
| `SMTP_PASS`  | SMTP password                  | —       |
| `FROM_EMAIL` | Sender address shown in emails | —       |

### Required for Google Sheets (optional feature)

| Variable                             | Purpose                     |
| ------------------------------------ | --------------------------- |
| `GOOGLE_SHEETS_SPREADSHEET_ID`       | Target Google Sheet ID      |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL`       | Service account email       |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | Service account private key |

### Optional / Recommended

| Variable             | Purpose                                                                                                                                                | Default        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| `ADMIN_TOKEN_SECRET` | 32+ char random secret for signing admin session tokens. If absent, an ephemeral key is generated at startup — sessions won't survive server restarts. | auto-generated |
| `GITHUB_TOKEN`       | GitHub PAT (repo scope) used by the auto-sync script                                                                                                   | —              |

### Legacy / Unused

| Variable                  | Notes                                                              |
| ------------------------- | ------------------------------------------------------------------ |
| `FREEAGENT_CLIENT_ID`     | FreeAgent OAuth — replaced by Stripe Invoicing, kept for reference |
| `FREEAGENT_CLIENT_SECRET` | As above                                                           |
| `FREEAGENT_REFRESH_TOKEN` | As above                                                           |

---

## 15. Running the Project

### Prerequisites

- Node.js 24
- pnpm (workspace-aware)
- A PostgreSQL database (Replit provides one automatically)

### First-time Setup

```bash
# Install all dependencies
pnpm install

# Run database migrations (Drizzle)
pnpm --filter @workspace/db run migrate

# Seed initial data (email templates, discount tiers, pass config)
# This happens automatically on first API server startup
```

### Development

The project uses Replit Workflows to run services. In development, three processes run concurrently:

| Service           | Port    | Command                                        |
| ----------------- | ------- | ---------------------------------------------- |
| API Server        | 8080    | `pnpm --filter @workspace/api-server run dev`  |
| Checkout Frontend | `$PORT` | `pnpm --filter @workspace/checkout run dev`    |
| GitHub Sync       | —       | `bash scripts/sync-to-github.sh` (every 5 min) |

### Production / Deployment

```bash
# Build everything
pnpm run build

# Start the API server (reads PORT from environment)
pnpm --filter @workspace/api-server run start

# Frontend is served as static files from Vite build output
```

---

## 16. Development Workflows

Configured as Replit Workflows (long-running processes managed by the platform):

| Workflow                           | Command                                                          | Purpose                             |
| ---------------------------------- | ---------------------------------------------------------------- | ----------------------------------- |
| `artifacts/api-server: API Server` | `pnpm --filter @workspace/api-server run dev`                    | Express dev server with hot-reload  |
| `artifacts/checkout: web`          | `pnpm --filter @workspace/checkout run dev`                      | Vite dev server                     |
| `Sync to GitHub`                   | `while true; do bash scripts/sync-to-github.sh; sleep 300; done` | Auto-push to GitHub every 5 minutes |

### One-off Commands

```bash
# Type-check everything
pnpm run typecheck

# Lint
pnpm run lint

# Format check
pnpm run format

# Auto-format
pnpm run format:write

# Run tests
pnpm run test
```

---

## 17. Codegen & Type Safety

The project uses a strict **OpenAPI → codegen → TypeScript** pipeline. Never edit the generated files in `lib/api-client-react` or `lib/api-zod` directly.

### Adding a New API Endpoint

1. Add the path/operation to `lib/api-spec/openapi.yaml`
2. Run codegen to regenerate hooks and Zod schemas:
   ```bash
   pnpm --filter @workspace/api-spec run codegen
   cd lib/api-client-react && pnpm exec tsc --build
   ```
3. Implement the route handler in `artifacts/api-server/src/routes/`
4. Use the generated hook in the frontend

### Adding a New DB Table

1. Create the schema file in `lib/db/src/schema/`
2. Export it from `lib/db/src/schema/index.ts`
3. Rebuild DB declarations:
   ```bash
   cd lib/db && pnpm exec tsc --build
   ```
4. Run or write a Drizzle migration

### TypeScript Project References

Every package has `composite: true` in its `tsconfig.json`. Root `tsconfig.json` declares all project references. The build order is: `lib/db` → `lib/api-zod` → `lib/api-client-react` → `artifacts/*`.

---

## 18. GitHub Sync

The GitHub connection uses **manual branches and pull requests** — there is no automatic push to `main`. All syncing is triggered explicitly by running the scripts below.

Authenticates using the `GITHUB_TOKEN` Replit secret (PAT with `repo` scope).

### Push to a branch

```bash
# Auto-named branch (sync/YYYY-MM-DD-HHMMSS)
bash scripts/push-branch.sh

# Custom branch name
bash scripts/push-branch.sh my-feature-branch
```

Pushes the current workspace state to the named branch on GitHub. Never touches `main` directly.

### Open a Pull Request

```bash
BRANCH_NAME="my-feature-branch" bash scripts/create-pr.sh

# With a custom PR title and body
PR_TITLE="My change" PR_BODY="Details here" BRANCH_NAME="my-feature-branch" bash scripts/create-pr.sh
```

Creates a PR from the branch to `main` via the GitHub API. Prints the PR URL on success.

### Typical workflow

1. Make changes in Replit
2. `bash scripts/push-branch.sh my-branch-name`
3. `BRANCH_NAME="my-branch-name" bash scripts/create-pr.sh`
4. Review and merge the PR on GitHub

---

## 19. Security Notes

### Admin Authentication

- Passwords: startup-time blocklist of common weak values; server returns `503` until changed
- Rate limiting: 5 login attempts per 15 minutes per IP (always active)
- Token signature: HMAC-SHA256 keyed by `ADMIN_TOKEN_SECRET`, not the password — a leaked token cannot be used to recover the password offline
- Token TTL: 30 days, enforced server-side on every request
- Audit log: every login attempt (success + failure) is recorded with source IP

### Stripe Webhook

- Raw body required — Express `json()` middleware is bypassed for `/api/stripe/webhook`
- Signature verified with `stripe.webhooks.constructEvent()` using `STRIPE_WEBHOOK_SECRET`
- Idempotency: webhook handler checks `booking.status` before applying changes

### Financial Integrity

- All monetary arithmetic uses integer pence to eliminate floating-point drift
- Promo counter increment is a conditional `UPDATE` (not `SELECT` then `UPDATE`) to prevent race conditions
- Booking confirmation is fully transactional: status flip + promo increment commit or roll back together

### GDPR

- `gdpr_consent` + `gdpr_consent_at` stored per attendee
- Email addresses used only for event communications and optional Google Sheets export
- Management token is a cryptographically random UUID giving attendees access to their own data only

---

## 20. Brand & Design Tokens

Defined in `artifacts/checkout/src/tokens.css`.

| Token                | Value                 |
| -------------------- | --------------------- |
| Primary colour       | `#004eb9` (red)       |
| Secondary colour     | `#266cc7` (orange)    |
| Background           | `#f0f6ff` (off-white) |
| Heading font         | Clarkson              |
| Body font            | Figtree               |
| Input border-radius  | `6px` (`rounded-md`)  |
| Button border-radius | `6px` (`rounded-md`)  |

shadcn/ui components are used throughout the admin panel and checkout. Tailwind utility classes follow the token values.

---

## 21. Order Reference Format

```
SWP27-{6541 + bookingId}
```

Examples: first booking → `SWP27-6542`, second → `SWP27-6543`, etc.

The offset `6541` ensures all references are 4+ digits and avoids `SWP27-1` looking like a test booking. Generated at payment/invoice completion and stored as a unique index on `bookings.order_reference`.

---

## 22. Key Business Rules

- **VAT**: Always 20% UK VAT, always shown as a separate line item. Never included in the displayed pass prices (all prices quoted ex-VAT).
- **Team pass**: Fixed bundle price (£499 for 3 seats). Additional bundles priced per unit, not per seat.
- **Complimentary promo codes**: If `quantity > remainingSeats`, the discount does not apply and the UI shows a `CompShortfallPrompt` asking the user to reduce quantity or remove the code.
- **Promo + group discounts**: Both can apply simultaneously. Group discount is calculated first on the base subtotal; promo is applied to the post-group-discount amount.
- **Invoice due date**: 14 calendar days from invoice creation.
- **Overdue detection**: Admin Registrations table shows "Overdue" badge (red) when `invoiceDueDate < today` and `status = invoiced`.
- **Booking resumption**: A returning visitor with an existing `sessionToken` in `localStorage` resumes at their last saved `currentStep`.
- **Placeholder attendees**: Buyers can leave non-lead seats with minimal details and share the management link with colleagues to fill their own information.
- **Billing edits**: Available via `/manage/:token/billing` — updates billing fields on the booking row. Does not re-issue or modify the Stripe invoice.
- **Invoice re-issue**: When an admin triggers a re-issue, the existing open Stripe invoice is voided/deleted before a new one is created. Already-paid invoices short-circuit with no changes.
- **Partial bookings**: Bookings in `partial` status (incomplete checkout) trigger a `partial_notification_sent` flag after a configurable period. Admin can see and manage these.
- **Side-effect retries**: Each post-confirmation side effect has its own boolean flag. The `POST /api/admin/registrations/:id/redeliver` endpoint re-runs only the failed ones.

---

## 23. Known Issues, Fixes & Agent Handoff Log

This section documents build problems encountered during development and how they were resolved. Maintained for continuity between AI agents working on this codebase.

---

### Fix 001 — API Server crash on `dev` start (`uv_cwd` / `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`)

**Date**: 2026-05-07
**Status**: ✅ Resolved

**Symptom**: The `artifacts/api-server: API Server` workflow failed immediately after the esbuild step completed. The error was:

```
Error: ENOENT: no such file or directory, uv_cwd
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL @workspace/api-server@0.0.0 dev
```

**Root cause**: The `dev` script in `artifacts/api-server/package.json` chained pnpm invocations:

```json
"dev": "export NODE_ENV=development && pnpm run build && pnpm run start"
```

When esbuild's `buildAll()` deleted and recreated the `dist/` directory (`await rm(distDir, { recursive: true, force: true })`), pnpm lost its working directory context before spawning the `start` sub-process. This is a known pnpm bug triggered by nested `pnpm run` calls where a child process alters the filesystem mid-run.

**Fix**: Replaced nested pnpm calls with direct Node invocations — bypassing pnpm's CWD tracking entirely:

```json
"dev": "NODE_ENV=development node ./build.mjs && NODE_ENV=development node --enable-source-maps ./dist/index.mjs"
```

File changed: `artifacts/api-server/package.json`

**Watch out for**: If you ever change `dev` back to use `pnpm run build && pnpm run start`, this crash will return. Always use direct `node` calls in the `dev` script for this package.

---

### Fix 002 — TypeScript `TS6053` errors (files exist on disk but TypeScript reports them missing)

**Date**: 2026-05-07
**Status**: ✅ Resolved

**Symptom**: `typecheck` workflow failed with many `error TS6053: File '...' not found` errors for files that visibly existed on disk (confirmed via `ls`). Affected packages: `lib/db`, `lib/api-zod`, `lib/api-client-react`, `artifacts/api-server`, `artifacts/mockup-sandbox`.

**Root cause**: Stale TypeScript incremental build cache files (`.tsbuildinfo`) from before a checkpoint merge were poisoning the composite project build. TypeScript was reading fingerprint data from the old cache and failing to match it against the post-merge file state.

**Fix**:

1. Deleted the three stale cache files:
   - `lib/db/tsconfig.tsbuildinfo`
   - `lib/api-zod/tsconfig.tsbuildinfo`
   - `lib/api-client-react/tsconfig.tsbuildinfo`
2. Rebuilt all lib packages:
   ```bash
   pnpm --filter @workspace/db exec tsc --build
   pnpm --filter @workspace/api-zod exec tsc --build
   pnpm --filter @workspace/api-client-react exec tsc --build
   ```

**Watch out for**: Any time a large merge or checkpoint lands, if typecheck reports TS6053 for files you can see on disk, delete `.tsbuildinfo` files and rebuild libs before investigating further.

---

### Fix 003 — ESLint `preserve-caught-error` in `Step1Lead.tsx`

**Date**: 2026-05-07
**Status**: ✅ Resolved

**Symptom**: `lint` workflow failed with:

```
artifacts/checkout/src/pages/checkout/Step1Lead.tsx
  173:11  error  There is no `cause` attached to the symptom error being thrown  preserve-caught-error
```

**Root cause**: The `handleSaveAndReturn` function added by an AI agent re-threw a caught error without attaching the original as `cause`, discarding the original stack trace:

```typescript
} catch (error) {
  throw new Error(bookingSaveErrorMessage(error));  // original error lost
}
```

**Fix**: Added `{ cause: error }` to preserve the original error chain:

```typescript
} catch (error) {
  throw new Error(bookingSaveErrorMessage(error), { cause: error });
}
```

File changed: `artifacts/checkout/src/pages/checkout/Step1Lead.tsx` line 176.

**Rule**: This ESLint rule (`preserve-caught-error`) is active across the whole workspace. Whenever re-throwing inside a `catch (error)` block, always pass `{ cause: error }` as the second argument to `new Error(...)`.

---

### Fix 004 — Prettier format failures after checkpoint merge

**Date**: 2026-05-07
**Status**: ✅ Resolved

**Symptom**: `format` workflow failed citing `README.md` and `artifacts/checkout/src/pages/admin/registrations.tsx`.

**Root cause**: Files edited during or after the checkpoint merge had trailing whitespace, inconsistent quote style, or other style drift not caught by the merging agent.

**Fix**: Ran `pnpm run format:write` from the workspace root to auto-fix all files. The `format` workflow (`prettier --check .`) is the canonical gate — it must pass before pushing a branch.

**Rule**: Always run `pnpm run format:write` before running `bash scripts/push-branch.sh`. The format workflow will fail the check if any file diverges from Prettier's output.

---

### Fix 005 — Checkout frontend ENOENT on `lib/api-client-react/tsconfig.json`

**Date**: 2026-05-07
**Status**: ✅ Resolved

**Symptom**: The checkout Vite dev server threw a runtime overlay error:

```
[plugin:vite:esbuild] parsing /home/runner/workspace/lib/api-client-react/tsconfig.json failed:
Error: ENOENT: no such file or directory, open '...lib/api-client-react/tsconfig.json'
```

The file existed on disk — `ls lib/api-client-react/` confirmed it. Restarting the workflow did not help.

**Root cause**: Vite's `fs.strict: true` mode restricts file reads to the project `root` and its ancestor up to the workspace root. However, when `fs.deny` patterns are present alongside `strict`, Vite's heuristic for auto-detecting the workspace root can fail to include sibling packages. Vite's esbuild plugin follows TypeScript `references` in `artifacts/checkout/tsconfig.json` → `../../lib/api-client-react/tsconfig.json`. Because `lib/` sits outside the checkout `root` and wasn't in `fs.allow`, Vite silently converted the blocked read into `ENOENT` (deliberate security behaviour — Vite returns ENOENT rather than EACCES to avoid leaking the existence of restricted paths).

**Fix**: Added the workspace root to `fs.allow` in `artifacts/checkout/vite.config.ts`:

```typescript
server: {
  fs: {
    strict: true,
    deny: ["**/.*"],
    allow: [path.resolve(import.meta.dirname, "../..")],  // ← added
  },
},
```

**Watch out for**: If you ever see a Vite ENOENT for a file you can confirm exists on disk, check `fs.strict` + `fs.allow` before anything else. This pattern will recur for any lib package referenced via TypeScript `references` from a deeply-nested artifact.

---

### Fix 006 — Applying external agent zip exports without breaking existing fixes

**Date**: 2026-05-07
**Status**: ✅ Documented

**Symptom**: An external agent (CODEX, running in a separate GitHub environment) exported a `.zip` snapshot of its work. When applied naively, it would have reverted four working fixes already present in the Replit workspace.

**Root cause**: The CODEX agent was working from the pre-fix state of the repository. Its zip captured file versions that pre-date the fixes in Fix 001–005. Because CODEX and Replit are separate environments, the fixes made in Replit were never visible to CODEX before it exported.

**Files that would have been broken if the zip was applied wholesale**:

| File                                                  | Zip version                      | What breaks                               |
| ----------------------------------------------------- | -------------------------------- | ----------------------------------------- |
| `artifacts/api-server/package.json`                   | Nested `pnpm run` dev script     | Server crashes with `uv_cwd` (Fix 001)    |
| `artifacts/checkout/vite.config.ts`                   | No `fs.allow` entry              | Checkout ENOENT on tsconfig (Fix 005)     |
| `artifacts/checkout/src/pages/checkout/Step1Lead.tsx` | `new Error(msg)` without `cause` | ESLint `preserve-caught-error` (Fix 003)  |
| `scripts/push-branch.sh`                              | No `--allow-dirty` flag          | Cannot push when Replit has pending edits |

**Rule for applying future CODEX zip exports**:

1. Extract the zip to `/tmp/` and diff against the workspace: `diff -rq --exclude="*.tsbuildinfo" --exclude="node_modules" --exclude="dist" "/tmp/extract/..." .`
2. Review every differing file before copying. If the diff only removes a fix listed in this section, do **not** apply that file — the workspace version is correct.
3. Only apply files where CODEX has genuinely new content (new features, new routes, new components) that the workspace doesn't have.
4. After applying, run the full check suite (`typecheck`, `lint`, `format`, `test`) before pushing to GitHub.

---

### Fix 007 - Environment reset recovery

**Date**: 2026-05-07
**Status**: Documented

**Symptom**: After a Replit container reset, all workflows failed immediately because `pnpm` was no longer available:

```bash
bash: pnpm: command not found
```

After restoring the runtime, workflows still failed because dependencies were missing:

```bash
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'esbuild' imported from artifacts/api-server/build.mjs
Cannot find module '.../vite/bin/vite.js'
WARN: Local package.json exists, but node_modules missing, did you mean to install?
```

Vite may also report workspace imports as missing, for example:

```bash
[plugin:vite:import-analysis] Failed to resolve import "@workspace/api-client-react"
```

**Root cause**: The Replit container environment reset. The Nix-installed runtime tools (`node`, `pnpm`) were removed from `PATH`, and `node_modules` was no longer present. The project files, lockfile, workspace config, and symlinks were still correct.

**Fix**:

1. Reinstall the Node.js 24 module through Replit's module/package management system. This restores Node 24 and pnpm together.
2. Run `pnpm install` from the workspace root to restore `node_modules` and workspace package symlinks.

**Rule**: Do not fix this by editing `package.json`, `pnpm-workspace.yaml`, Vite config, or workspace package imports. This is an environment recovery issue, not a code issue.

---

### Agent Handoff Notes

When picking up work on this codebase, run these checks first:

```bash
# 1. Confirm all services are healthy
pnpm run typecheck   # must exit 0
pnpm run lint        # must exit 0
pnpm run format      # must exit 0
pnpm run test        # must exit 0

# 2. If typecheck reports TS6053 for files that exist on disk:
rm -f lib/db/tsconfig.tsbuildinfo lib/api-zod/tsconfig.tsbuildinfo lib/api-client-react/tsconfig.tsbuildinfo
pnpm --filter @workspace/db exec tsc --build
pnpm --filter @workspace/api-zod exec tsc --build
pnpm --filter @workspace/api-client-react exec tsc --build

# 3. Before pushing to GitHub:
pnpm run format:write
bash scripts/push-branch.sh your-branch-name
BRANCH_NAME="your-branch-name" bash scripts/create-pr.sh
```

**Hard rules for AI agents**:

- Never use `pnpm run X && pnpm run Y` in `package.json` scripts inside `artifacts/api-server` — use direct `node` calls instead (see Fix 001)
- Always pass `{ cause: error }` when re-throwing inside `catch` blocks (see Fix 003)
- Run `pnpm run format:write` before any branch push (see Fix 004)
- Never edit files in `lib/api-client-react/src/generated/` or `lib/api-zod/src/` — these are auto-generated from `lib/api-spec/openapi.yaml`; run `pnpm --filter @workspace/api-spec run codegen` to regenerate
- Never apply a CODEX zip export without diffing first — see Fix 006 for the procedure

---

Additional environment reset rule: if Replit says `pnpm: command not found` or dependencies such as `esbuild`/`vite` are missing after a reset, recover the runtime and run `pnpm install`; do not edit project config (see Fix 007).

---

### Fix 008 — Environment hardening, centralized Stripe client, and graceful shutdown

**Date**: 2026-05-07
**Status**: ✅ Resolved

**Changes applied**:

- **Env helpers** (`artifacts/api-server/src/lib/env.ts`): Added a typed `getEnv(key)` helper that throws at startup for any missing required variable, replacing scattered `process.env.X!` casts throughout the codebase.
- **Centralized Stripe client** (`artifacts/api-server/src/lib/stripe.ts`): Extracted a single `stripe` singleton from `lib/stripe.ts`, removing duplicated `new Stripe(...)` calls across route files.
- **Graceful shutdown** (`artifacts/api-server/src/index.ts`): Added `SIGTERM`/`SIGINT` handlers that drain the HTTP server and close the DB pool before exiting, preventing dropped requests during container restarts.
- **Log redaction**: Added PII field paths (`email`, `billing_email`, `work_email`, `first_name`, `last_name`) to Pino's `redact` list so they are masked in production log output.
- **DB pool tuning**: Set `max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000` on the PostgreSQL pool for better connection lifecycle management.
- **Admin UI updates** (`artifacts/checkout/src/pages/admin/registrations.tsx`): Minor UI consistency fixes in the registrations table.
- **Scripts**: Updated `scripts/post-merge.sh` to rebuild all lib packages after a task-agent merge.
- **Typecheck fixes**: Resolved residual TypeScript composite project reference errors introduced by the agent merge.

**Files changed**: `artifacts/api-server/src/lib/env.ts` (new), `artifacts/api-server/src/lib/stripe.ts` (new), `artifacts/api-server/src/index.ts`, `artifacts/api-server/src/routes/admin.ts`, `artifacts/api-server/src/lib/email.ts`, `artifacts/checkout/src/pages/admin/registrations.tsx`, `scripts/post-merge.sh`.

---

### Fix 009 — Promo-code auto-apply links switched to custom domain

**Date**: 2026-05-07
**Status**: ✅ Resolved

**Symptom**: The admin promo-codes page generated auto-apply share links using the Replit `.replit.dev` preview domain. These links would break if the Replit environment was recycled or the project was republished.

**Fix**: Updated `artifacts/checkout/src/pages/admin/promo-codes.tsx` to construct the auto-apply URL using the production custom domain instead of the Replit preview URL:

```typescript
// Before
const url = `${window.location.origin}/?promo=${code}`;

// After
const url = `https://register.swpsummit.com/?promo=${code}`;
```

**Rule**: Any URL that is shared externally (emails, admin copy-to-clipboard helpers, QR codes) must use `https://register.swpsummit.com` as the base, never `window.location.origin` or a `.replit.dev` domain. The main website redirect target remains `https://swpsummit.com`.

---

### Fix 010 — Checkout button layout overlap on Step 3 and Step 4

**Date**: 2026-05-07
**Status**: ✅ Resolved

**Symptom**: On the attendees step (Step 3) and the payment step (Step 4), the action-bar buttons at the bottom of the page were overlapping or clipping on smaller viewports and inside the Replit preview iframe. Specifically:

- Step 3: Back / Save and return / Continue to Payment were rendered in a 3-column grid that collapsed incorrectly and caused text overflow.
- Step 4: The Save and return button was narrower than the other two buttons in the action card and its label was being clipped by the icon.

**Fix**:

1. `artifacts/checkout/src/pages/checkout/Step3Attendees.tsx` — Changed the bottom action container from `grid gap-3 sm:grid-cols-3` back to `flex flex-col gap-3` so all three buttons stack vertically at full width on every viewport.
2. `artifacts/checkout/src/pages/checkout/Step4Payment.tsx` — Changed the action container from a responsive grid back to `flex flex-col gap-3`; removed `md:w-auto` overrides so all three buttons (Complete / Back to attendees / Save and return) are consistently full-width.
3. `artifacts/checkout/src/components/checkout/SaveAndReturnButton.tsx` — Wrapped the button label text in `<span className="min-w-0 flex-1 text-center">` so it flows correctly inside a flex button without clipping the `ArrowUpRight` icon; added `sm:px-6 sm:text-base` responsive padding to match the other buttons at wider breakpoints.

**Files changed**: `artifacts/checkout/src/pages/checkout/Step3Attendees.tsx`, `artifacts/checkout/src/pages/checkout/Step4Payment.tsx`, `artifacts/checkout/src/components/checkout/SaveAndReturnButton.tsx`.

**Rule**: Keep action-bar buttons in a `flex flex-col gap-3` stack. Avoid responsive grid layouts for button groups on checkout pages — the varying label lengths and the SaveAndReturnButton wrapper div make grid columns unreliable.

---

_Built and maintained on Replit. Synced to GitHub (`Dougy-cpu/Register-SWP-2027`) via manual branch + PR workflow._
