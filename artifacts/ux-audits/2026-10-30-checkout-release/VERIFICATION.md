# Approved checkout release — 30 October 2026

The Passes and Payment designs, including the group-savings prompt, are implemented. This release includes the earlier reliability commit `287463e`. Deployment results will be recorded after Replit verification.

## Behaviour

- Shared SWP/People Strategy Hub header, Figtree typography and responsive progress bar.
- Passes has one summary, clear audience eligibility, quantity controls, expandable group rates and promo entry, and an optional referral field.
- The next-group prompt requests an authoritative quote for the same pass and promo, displays the returned discount and VAT-inclusive total, and changes only quantity when clicked. It respects allocation availability and checkout caps, suppresses zero-value/complimentary offers, rejects stale responses and never blocks checkout if its optional quote fails.
- Payment has two compact methods, a complete invoice form, collapsed admin-provided guidance and one summary/action panel. All billing fields, links to lead-attendee values, draft saving, submission validation and full payment terms are preserved.
- Existing reliability protection remains: bounded quote/payment-return checks, explicit promo removal, ordered draft writes, refresh/navigation recovery, submission locks and atomic refusal of public writes to completed bookings.

## Verification

- **438 tests pass across 59 files**, including 26 Passes and 18 Payment component tests.
- Repository lint, root typecheck and full production build pass. Changed files pass formatting and diff checks.
- The old source-text visual guard required a card around Passes. It was updated for the approved open layout while retaining the common primary-action requirement across all four steps.
- Existing unrelated repository-wide formatting debt and non-blocking build warnings remain unchanged (Clarkson asset references outside this scoped font treatment, source maps, bundle size, Browserslist age).
- Desktop/mobile visual comparison passed. See root `design-qa.md` for references, captures and boundaries.
- Browser fixture: 3 Workforce passes = £578.34 including VAT. The 5-pass offer = £907.20; with a valid stacked 20% public code it becomes £725.76. The current three-pass total remains unchanged until quantity is explicitly changed.
- All 12 invoice inputs survived Back/Continue and refresh. Mobile widths 320px and 390px had no horizontal overflow. A simulated invoice booking reached confirmation with the separate finance recipient and PO intact.
- No new dependencies or migrations. No production data edits, real bookings, invoices, charges or emails were created by these checks.

## Source and rollout

- Local branch: `codex/checkout-reliability-first` in `C:/Projects/SWP/Register-checkout-reliability`.
- Replit Free Mode verified a clean baseline at `9a761a4ee2f182f60020a53ea8f2dfacd7ff4326`, tree `a023ba7e7d39ee56639444801a933b85adf7f436`, matching the reviewed Git base.
- Pre-release live homepage: HTTP 200, bundle `/assets/index-DHBrnJaQ.js`; `/api/healthz` returned `status: ok`.
- Replit installation/build and publication are separate from the local results above. Actual email delivery, a real Stripe transaction and physical-phone testing remain outside this verification.
