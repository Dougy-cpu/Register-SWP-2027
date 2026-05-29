# AGENTS.md

## Project Context

This repository is `Register-SWP-2027`, the registration and checkout system for SWP Summit 2027 by People Strategy Hub.

Event details:

- Event: SWP Summit 2027
- Date: Wednesday, 3 March 2027
- Venue: 1 Basinghall Avenue, London

The app handles public checkout, attendee management, admin tools, Stripe card payments, Stripe invoice payments, email delivery, and Google Sheets sync.

Public checkout should feel premium, calm, trustworthy, and conversion-focused. Admin screens should feel clean, structured, and efficient.

## Design Direction

Use the SWP Summit 2027 visual language for all customer-facing design work:

- Premium B2B enterprise
- Sophisticated, commercial, expensive, and strategic
- Aligned with the SWP Summit website
- Not a generic SaaS dashboard or generic conference template

Use [DESIGN_GUIDELINES.md](./DESIGN_GUIDELINES.md) as the design source of truth before changing screen layouts, styling, components, or public copy.

## Brand Tokens

Use these SWP colours consistently:

- Primary brand blue: `#004eb9`
- Lighter accent blue: `#266cc7`
- Soft blue wash: `#f0f6ff`
- Main text: `#000000`
- Muted text: `#4a5568` or `#444444`
- Borders: `#e2e8f0` or `rgba(0, 78, 185, 0.15)`

Use Figtree with sensible system fallbacks.

Remove HR Analytics Summit orange `#E74F3E` and `rgba(231,79,62,...)` unless explicitly required for a historical reference.

## Engineering Guardrails

Do not change database schema unless the task explicitly asks for it.

Do not change Stripe, invoice, VAT, promo code, group discount, booking status, or attendee logic unless explicitly asked.

Do not edit generated API client files or generated Zod files by hand. Use OpenAPI as the source of truth for API contract changes, then regenerate.

Keep all monetary calculations and pricing behaviour unchanged unless explicitly requested.

Prefer UI-only changes for design tasks. Improve one screen or flow at a time.

Do not add new dependencies unless there is a clear reason and it is approved.

## Validation

After frontend changes, run:

```bash
pnpm run typecheck
pnpm --filter @workspace/checkout run build
```

For broader app changes, also run relevant lint, tests, and full build commands.

In final summaries, include:

- Changed files
- Visual or behavioural changes
- Checks run
- Any risks or follow-up notes
