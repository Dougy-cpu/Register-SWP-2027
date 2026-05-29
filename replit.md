# Workspace

## Overview

pnpm workspace monorepo using TypeScript. This is the **SWP Summit** conference registration checkout system (summit: Wednesday, 3 March 2027, 1 Basinghall Avenue, London).

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle for API, Vite for frontend)

## Structure

```text
artifacts-monorepo/
├── artifacts/
│   ├── api-server/         # Express API server (port 8080 in dev)
│   └── checkout/           # React + Vite frontend (port from $PORT)
├── lib/
│   ├── api-spec/           # OpenAPI spec (openapi.yaml) + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks (run codegen to regenerate)
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
├── pnpm-workspace.yaml
├── tsconfig.base.json      # Shared TS options
├── tsconfig.json           # Root TS project references
└── package.json
```

## Applications

### API Server (`artifacts/api-server`)

- Express 5 REST API, port 8080 in development
- Routes: `/api/bookings`, `/api/attendees`, `/api/pricing`, `/api/promo-codes`, `/api/discount-tiers`, `/api/stripe`, `/api/freeagent`, `/api/email`, `/api/admin`
- Libs: `src/lib/pricing.ts` (VAT + group discount calc), `src/lib/email.ts` (nodemailer + PDF), `src/lib/pdf.ts` (PDFKit receipt), `src/lib/seed.ts` (seed data)
- Auto-seeds: welcome email template + discount tiers on first start

### Checkout Frontend (`artifacts/checkout`)

- React + Vite + Tailwind + shadcn/ui
- Brand: Clarkson font headings, Figtree body; primary `#004eb9`, secondary `#266cc7`, bg `#f0f6ff`
- Inputs: 0px border-radius (square); Buttons: 300px radius (pill)
- Multi-step checkout: Step1 (Your Details) → Step2 (Pass Selection) → Step3 (Additional Attendees) → Step4 (Payment) → Confirmation
- Admin panel: `/admin` (password-protected), sub-pages: registrations, promo-codes, discount-tiers, emails

## Pass Pricing (excl. VAT)

| Pass              | Price | Was    | Save | Seats |
| ----------------- | ----- | ------ | ---- | ----- |
| Single (HR)       | £199  | £429   | £230 | 1     |
| Team (HR)         | £499  | £1,200 | £701 | 3     |
| Business (Vendor) | £599  | £999   | £400 | 1     |

VAT: 20% always applied, shown as line breakdown.

## Database Schema

Tables: `bookings`, `attendees`, `promo_codes`, `discount_tiers`, `email_templates`, `email_logs`

- `bookings`: sessionToken, passType, attendeeType, quantity, promoCode, pricing fields, currentStep, status, orderRef, leadEmail, stripeSessionId, stripePaymentIntentId, stripeInvoiceId, stripeInvoicePdfUrl, stripeInvoicePaymentUrl, freeagentInvoiceId, freeagentInvoiceUrl, freeagentPaymentUrl
- `attendees`: bookingId, isLead, firstName, lastName, jobTitle, company, workEmail, phone, dietaryRequirements, accessibilityNeeds, linkedinUrl, gdprConsent

## Required Environment Variables

Set these in the Replit Secrets panel:

| Variable                  | Purpose                                                                                                                                                     | Required For        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `STRIPE_SECRET_KEY`       | Stripe card payments                                                                                                                                        | Stripe checkout     |
| `STRIPE_WEBHOOK_SECRET`   | Stripe webhook signature verification                                                                                                                       | Stripe webhooks     |
| `SMTP_HOST`               | Email sending                                                                                                                                               | Email notifications |
| `SMTP_PORT`               | Email sending (default: 587)                                                                                                                                | Email notifications |
| `SMTP_USER`               | Email SMTP username                                                                                                                                         | Email notifications |
| `SMTP_PASS`               | Email SMTP password                                                                                                                                         | Email notifications |
| `FROM_EMAIL`              | Sender email address                                                                                                                                        | Email notifications |
| `FREEAGENT_CLIENT_ID`     | FreeAgent OAuth (legacy, unused)                                                                                                                            | —                   |
| `FREEAGENT_CLIENT_SECRET` | FreeAgent OAuth (legacy, unused)                                                                                                                            | —                   |
| `FREEAGENT_REFRESH_TOKEN` | FreeAgent OAuth (legacy, unused)                                                                                                                            | —                   |
| `ADMIN_PASSWORD`          | Admin panel password (REQUIRED, must not be a common weak value)                                                                                            | Admin panel         |
| `ADMIN_TOKEN_SECRET`      | 32+ char random secret used to sign admin session tokens (optional — ephemeral key generated at startup if absent, meaning sessions don't survive restarts) | Admin panel         |

## Admin Panel

- URL: `/admin`
- Password: set via `ADMIN_PASSWORD` (a small set of weak values like `admin`, `admin123`, `password`, `123456`, `secret` are blocked at startup and the panel returns 503 until a stronger password is set)
- Auth: signed token of the form `<sigHex>.<expMs>` stored in localStorage as `admin_token`, passed as `x-admin-token` header. Signature is HMAC-SHA256 keyed by a server-side secret (NOT the password) — a stolen token cannot be used to brute-force `ADMIN_PASSWORD` offline. Token TTL: 30 days, expiry enforced server-side.
- Login endpoint: `POST /api/admin/login` is rate-limited to 5 attempts per 15 minutes per IP (always on); successful and failed attempts are written to the audit log with the source IP.
- Audit log: every admin mutation (login success/failure, booking status/edit/delete, promo CRUD, discount tiers, pass inventory/config, notification email CRUD, event settings, email template edit/test/resend, invoice reminder, hear-about-us add/delete/move, attendee admin add/edit) is recorded in `activity_log` with `actor`, `summary`, `before`/`after` diff, and `meta`. Visible in `/admin/activity` under the "Admin Audit" filter.
- Features: registrations list (with Stripe invoice links, due date, overdue badges, Send Reminder button), promo code management, discount tier config, email logs & template editor, activity feed with admin audit trail

## Invoice Payment Flow

Invoice payments use **Stripe Invoicing** (not FreeAgent):

- `POST /api/stripe/create-invoice` — creates Stripe customer (deduped by email), creates invoice with 20% UK VAT, 14 day payment terms, finalizes and sends; stores `stripeInvoiceId`, `stripeInvoicePdfUrl`, `stripeInvoicePaymentUrl`, `invoiceDueDate`
- `POST /api/admin/bookings/:id/send-invoice-reminder` — sends branded reminder email to billing contact with Stripe PDF attached, banking details, overdue flag if past due
- Email confirmation attaches the real Stripe invoice PDF (downloaded from `stripeInvoicePdfUrl`)
- Fallback chain: Stripe PDF → custom pdfkit receipt
- Invoice footer: "Sort code: 04-06-05 | Account: 16963209 | IBAN: GB65CLRB04060516963209 | VAT No: 336124621"
- VAT tax rate: 20% exclusive, cached per process (reuses existing Stripe tax rate if found)
- Overdue detection: admin registrations table shows "Overdue" badge and red styling when `invoiceDueDate` < today and status is `invoiced`

## Order Reference Format

`SWP27-{6541 + bookingId}` — generated on payment/invoice completion

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` with `composite: true`. When adding new schema tables or API routes:

1. Add to `lib/db/src/schema/index.ts`
2. Run `cd lib/db && pnpm exec tsc --build` to rebuild declarations
3. Run codegen: `pnpm --filter @workspace/api-spec run codegen` to regenerate hooks
4. Run `cd lib/api-client-react && pnpm exec tsc --build` to rebuild hook declarations

## API Codegen

Modify `lib/api-spec/openapi.yaml` then run:

```bash
pnpm --filter @workspace/api-spec run codegen
cd lib/api-client-react && pnpm exec tsc --build
```
