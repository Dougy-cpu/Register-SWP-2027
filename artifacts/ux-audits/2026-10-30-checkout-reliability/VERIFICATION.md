# Checkout reliability — 30 October 2026

Status: implemented and verified in an isolated local worktree. Not published. The Passes and Payment redesigns are image mock-ups awaiting Douglas's approval; their layouts have not been applied to the app.

## Source and boundaries

- Branch: `codex/checkout-reliability-first`, worktree `C:/Projects/SWP/Register-checkout-reliability`.
- Base Git commit: `033d89bd9861e6db2d41fba1d6c66bb8a14e22f2`.
- Replit Free Mode independently confirmed a clean workspace at `9a761a4ee2f182f60020a53ea8f2dfacd7ff4326`, with the same source tree `a023ba7e7d39ee56639444801a933b85adf7f436` as the Git base.
- The earlier checkout and production were preserved. No Power Mode, production data changes, real bookings, Stripe sessions, invoices, charges or emails were created.
- No new dependencies or database migrations.

## Implemented behaviour

1. Group-saving prompts use the current pass price. Pricing results belong to the exact pass, quantity and promo selection; stale results cannot replace a newer total. Failed or stalled quotes offer Retry and cannot be used to proceed.
2. Promo removal sends an explicit null and removes the linked code from the address. Linked and typed codes share a cancellable validation flow. Checkout waits while a linked code is being checked; late responses cannot replace a newer choice.
3. Invoice method, billing address and PO details save as drafts. Writes are ordered, a booking/session-bound tab cache protects unsaved edits, and navigation flushes pending saves. Cache updates and cancellation of stale booking refreshes protect remounts. Failed saves remain visible and retryable.
4. Public checkout writes cannot alter completed/cancelled bookings, including payment confirmation racing an autosave. Partial and pending-payment bookings remain editable for the existing Stripe cancellation/return flow. Admin and management-token billing keep their existing behaviour. Draft writes suppress inherited admin credentials, preventing accidental invoice reissue.
5. A delayed card-payment return has a bounded status check, a Check payment status action and a support route. Checking never creates another checkout or charge.
6. Attendee validation opens and focuses the first missing field. Inputs and controls have accessible names and associations. New steps reset focus/scroll, respect reduced motion and preserve the correct browser history through refresh.
7. The invoice layout no longer forces horizontal scrolling on narrow screens. Payment controls lock during submission. Complimentary Back failures are visible and retryable. The contact-number label accurately describes the purchaser's own number.

## Changed implementation files

- `artifacts/checkout/src/pages/checkout/Step1Lead.tsx`
- `artifacts/checkout/src/pages/checkout/Step2Passes.tsx`
- `artifacts/checkout/src/pages/checkout/Step3Attendees.tsx`
- `artifacts/checkout/src/pages/checkout/Step4Payment.tsx`
- `artifacts/checkout/src/pages/checkout/index.tsx`
- `artifacts/checkout/src/lib/checkout-payment-draft.ts`
- `artifacts/checkout/src/lib/checkout-pricing.ts`
- `artifacts/api-server/src/routes/bookings.ts`
- `lib/api-spec/openapi.yaml`, followed by regenerated React client and Zod output.
- Seven new regression test files beside the affected code.

## Validation

- Full suite: **415 tests pass across 59 files**, including 67 new regression tests.
- Root typecheck, repository ESLint and full production build pass. The full build needs the existing mockup package's `PORT=5173` and `BASE_PATH=/` environment values.
- The final history correction also passed checkout typecheck and a fresh checkout production build.
- Formatting passes for every changed file; `git diff --check` passes. The repository-wide formatting check still reports 338 unrelated existing files. Those were left untouched.
- Existing non-blocking build warnings remain for Clarkson font references, source maps, bundle size and Browserslist data.
- Server guard tests use local HTTP requests and real PostgreSQL predicates through PGlite, including concurrent completion, terminal status refusal, pending-payment compatibility, admin updates and management-token billing.
- Independent agents reviewed promo races, draft ordering, remount recovery, quote timeouts, navigation and server editability.

## Browser checks

The production frontend build ran against an isolated in-memory fixture API with no production API fallback and no email/payment delivery. All names and contact details were fictional.

- Current £189 Workforce price produces the correct £85.05 saving for three passes. Removing a promo returns the three-pass total to £578.34 including VAT.
- Submitting incomplete group attendees opens attendee 2 and focuses its first missing field. Additional TBC places still reach Payment.
- Invoice address, email, phone and PO survive the explicit Back/Continue journey and full refresh.
- After the final history fix, refresh on Payment followed by browser Back reaches Attendees. An immediate PO edit survives Back and Forward before the debounce completes.
- At a 390px viewport the document is 375px wide; at 320px it is 305px wide (normal scrollbar allowance), with no horizontal document overflow.
- Evidence: `C:/Users/dougl/OneDrive/Documents/ChatGPT/SWP 2027 - Reg/output/checkout-reliability-2026-10-30/`.

## Release and design approval

This work is local and has not been pushed, pulled into Replit or published. Real Stripe end-to-end payment, actual email delivery and physical-device testing have not been run in this task.

The two matching mock-ups retain SWP styling, add People Strategy Hub branding, consolidate pass pricing into one summary, and bring invoice fields higher on the page while retaining the required billing information. Approval is required before implementing those design changes. Production publication remains a separate approval step.
