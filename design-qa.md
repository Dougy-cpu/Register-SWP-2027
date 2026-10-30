# Checkout design QA — 30 October 2026

Status: **passed** for the approved Passes and Payment implementation.

## References and rendered evidence

Approved references: `C:/Users/dougl/OneDrive/Documents/ChatGPT/SWP 2027 - Reg/output/checkout-reliability-2026-10-30/Passes-proposed-group-savings.png` and `Payment-proposed.png`.

Rendered production-build captures: `C:/Users/dougl/OneDrive/Documents/ChatGPT/SWP 2027 - Reg/output/checkout-release-2026-10-30/`:

- `Passes-desktop.png` — 1487 × 1058 comparison viewport.
- `Payment-desktop.png` — 1330 × 1181 comparison viewport.
- `Payment-card-desktop.png` — card variant.
- `Passes-mobile-top.png`, `Passes-mobile-offer.png` — 320px viewport.
- `Payment-mobile-top.png` — 390px viewport.
- `Payment-mobile-summary.png` — 320px viewport.

The reference/render pairs were inspected together, followed by an independent visual review. No visual blockers were found. An initial full-page capture was distorted by the capture mechanism; it was excluded in favour of normal viewport captures and DOM measurements.

## Comparison and corrections

- Retained the approved white page, blue primary action, pale-blue booking summary, two-column desktop layout and separate mobile sections.
- Reused the actual SWP and 9,000-byte People Strategy Hub PNG assets. Both loaded successfully. No invented logos or decorative assets.
- Corrected the checkout font to Figtree with local fallbacks. Matched the heading hierarchy, reduced header/section spacing, consolidated totals and made secondary Save actions links.
- Added the compact next-group offer with a quoted VAT-inclusive total and explicit Add action. Full rates and promo entry remain expandable.
- Payment keeps all 12 billing inputs, lead-attendee relinking, live invoice recipient and visible save status. Country stays free text to preserve existing non-UK values. The complete payment deadline, including before-event terms, takes precedence over the shortened mock-up wording.
- Retained semantic form labels, radio controls, visible focus states, recoverable errors and responsive wrapping. Browser zoom is enabled.
- No horizontal overflow at 320px or 390px. The long invoice action wraps safely on a narrow phone. Both logos, quantities, prices and primary actions remain legible.

## Functional boundaries

Browser verification used a local in-memory API fixture with fictional details and no external email/payment delivery. The invoice draft survived Back/Continue, payment-method switching and refresh. The simulated invoice submission reached confirmation. Automated tests cover card, free-registration, failures, races and validation. Real Stripe payments, actual email delivery and physical-device testing were not performed.
