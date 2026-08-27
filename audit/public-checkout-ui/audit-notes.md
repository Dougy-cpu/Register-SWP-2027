# SWP Summit 2027 Public Checkout UI Audit

Audit date: 6 June 2026

Evidence source: local React checkout using a local-only mock API

Design source: `DESIGN_GUIDELINES.md`

## Before Implementation

### 01. Step 1 - Your details (desktop)

Screenshot: `before/01-step1-desktop.png`

Health: Needs polish.

- Strengths: Clear heading, short form, good two-column field layout, and visible event branding.
- UX issues: The header progress is easy to miss; the two large white panels feel flat; the primary CTA does not use the defined premium button treatment; the audience choice and form lack the richer hierarchy already present on Step 4.
- Accessibility risks: Progress is conveyed mostly through a thin visual bar, and the selected audience card relies heavily on border colour.
- Recommendation: Introduce a labelled four-step progress indicator, use the shared premium card treatment, add explicit selected-state copy/icon treatment, and standardise the CTA.

### 02. Step 2 - HR pass selection (desktop)

Screenshot: `before/02-step2-hr-desktop.png`

Health: Strong core interaction, visually dense.

- Strengths: Pricing, inventory, included benefits, quantity, discounts, VAT, and savings are all visible before continuing.
- UX issues: Three summary cards repeat information immediately below; the discount column contains several competing highlights; the lower order summary feels visually disconnected; the "How did you hear" field still uses an orange animated border that conflicts with the SWP brand.
- Accessibility risks: The animated border can distract users with cognitive or vestibular sensitivity; several light grey labels and fine borders need contrast verification.
- Recommendation: Keep the pricing logic intact, reduce repeated summary chrome, replace the orange animation with a static blue focus treatment, and unify the pass card and lower summary with the Step 4 card system.

### 03. Step 2 - Three-ticket group state (desktop)

Screenshot: `before/03-step2-group-desktop.png`

Health: Clear selection, crowded emphasis.

- Strengths: The selected shortcut, quantity, and total update immediately, and the group-use case is easy to understand.
- UX issues: The selected shortcut uses a yellow outline that introduces another accent colour; "Most Popular" appears in several places; the next-discount message competes with the current selection.
- Accessibility risks: Selection is clearer than in Step 1 because a checkmark is present, but the hierarchy still depends on multiple small badges and fine colour changes.
- Recommendation: Use one blue selected treatment, keep one "Most popular" signal, and visually subordinate future discount guidance.

### 04. Step 3 - Three attendees (desktop)

Screenshot: `before/04-step3-attendees-desktop.png`

Health: Functional and understandable, too long and flat.

- Strengths: TBC support is prominent, progress is quantified, and attendee accordions reduce the initial form load.
- UX issues: The status summary and accordion cards use the same flat white treatment; the open attendee form is very tall; all three final actions have equal visual width despite different importance.
- Accessibility risks: Accordion status is mostly textual and the closed attendee rows have limited visual differentiation; keyboard focus must be verified for accordion and action controls.
- Recommendation: Use stronger attendee status badges, premium card grouping, compact metadata, and a consistent primary/secondary action hierarchy while preserving the vertical action stack required by the existing responsive guardrail.

### 05. Step 4 - Card payment (desktop)

Screenshot: `before/05-step4-card-desktop.png`

Health: Strong.

- Strengths: Clear payment choice, sticky order summary, trustworthy copy, visible VAT, and strong next-step guidance.
- UX issues: The top three summary cards repeat the order summary, but the overall hierarchy is substantially stronger than Steps 1-3.
- Accessibility risks: Selected state includes a radio, border, background, and text label, which is robust; focus visibility still needs keyboard verification.
- Recommendation: Use this screen's card, selected-state, summary, and CTA language as the reference for the earlier steps.

### 06. Step 4 - Invoice payment (desktop)

Screenshot: `before/06-step4-invoice-desktop.png`

Health: Trustworthy but excessively long.

- Strengths: Procurement guidance is unusually clear, billing fields are grouped logically, linked values are explained, and the invoice CTA states the consequence.
- UX issues: Invoice guidance is repeated across the intro panel, five process cards, expandable details, sidebar prompt, and six next-step items. The full page is difficult to scan and pushes essential address fields far below the payment decision.
- Accessibility risks: The long reading order increases cognitive load; small linked badges can wrap awkwardly; the sticky sidebar may occupy too much space at intermediate widths.
- Recommendation: Keep the core procurement reassurance but collapse it into three concise steps, move optional detail behind the existing disclosure, and remove repeated sidebar explanation.

### 07. Step 1 - Your details (mobile)

Screenshot: `before/07-step1-mobile.png`

Health: Usable, missing orientation.

- Strengths: Fields stack cleanly, controls remain large enough to tap, and the primary action appears before the save-and-return action.
- UX issues: The step label is hidden entirely, leaving only an unexplained thin blue bar; the long page has no persistent indication of where the user is in checkout; panel borders dominate the narrow viewport.
- Accessibility risks: The visual progress bar has no visible mobile text equivalent, and the long consent text creates a dense tap target.
- Recommendation: Show a compact labelled stepper on mobile, reduce panel padding and border weight, and preserve clear full-width actions.

### 08. Step 2 - Business Pass (mobile)

Screenshot: `before/08-step2-business-mobile.png`

Health: Information complete, poor mobile scanability.

- Strengths: Business-only benefits, inventory, VAT, and pricing remain available on mobile.
- UX issues: The page is extremely long; the three summary cards consume the first screen; the sticky header intersects the full-page capture while scrolling; the pass card has too many nested borders and accent treatments; the action order changes from desktop.
- Accessibility risks: Small discount and inventory badges wrap tightly; dense content raises zoom and reflow risk; the sticky header can obscure content during scrolling.
- Recommendation: Replace the three-card summary with one compact booking strip, simplify pass-card decoration, ensure sticky header clearance, and keep action order consistent.

### 09. Step 4 - Invoice payment (mobile)

Screenshot: `before/09-step4-invoice-mobile.png`

Health: Clear controls, excessive vertical load.

- Strengths: Payment choices stack well and the selected invoice route remains unmistakable.
- UX issues: The invoice option itself is copy-heavy, followed immediately by another long procurement explanation; full-page capture also revealed sticky-header duplication during long-page scrolling.
- Accessibility risks: Essential billing fields require extensive scrolling; the long selected card and repeated explanatory content increase cognitive load.
- Recommendation: Shorten payment-option copy, reduce invoice guidance to three steps, and verify the sticky header does not obscure or duplicate content in long mobile pages.

## After Implementation

Overall health: Strong. The checkout now uses one coherent SWP blue card, progress, field, and CTA system without changing pricing, payment, promo, booking, or attendee rules.

### Implemented improvements

- Added a labelled, semantic four-step progress indicator on desktop and mobile. Completed steps use checkmarks, the current step uses `aria-current="step"`, and confirmation hides the progress control.
- Standardised Steps 1-4 around shared premium cards, 16px radii, restrained blue shadows, compact metric strips, and consistent primary CTAs.
- Replaced the remaining orange animated treatment with a static SWP blue treatment and added reduced-motion safeguards.
- Simplified the Step 2 summary into one strip, unified HR and Business Pass cards, removed yellow emphasis, and retained all price, VAT, inventory, promo, and discount behaviour.
- Added accessible names to quantity decrease and increase controls.
- Strengthened Step 3 hierarchy with a compact status card, premium attendee accordions, clearer information treatment, and the existing mobile-safe vertical action order.
- Shortened card and invoice choice copy and reduced repeated invoice guidance from five/six items to three concise procurement steps.
- Preserved validation behavior and verified required invoice address errors.
- Fixed a confirmation-page crash for group bookings containing TBC attendees. TBC seats now render a safe `TBC` avatar and `Attendee N (TBC)` label.

### After evidence

1. `after/01-step4-card-desktop.png` - Card payment, desktop.
2. `after/02-step4-invoice-desktop.png` - Invoice payment, desktop.
3. `after/03-step3-attendees-desktop.png` - Single attendee, desktop.
4. `after/04-step2-business-desktop.png` - Business Pass, desktop.
5. `after/05-step1-desktop.png` - Lead details, desktop.
6. `after/06-step1-mobile.png` - Lead details and mobile progress.
7. `after/07-step2-business-mobile.png` - Business Pass and compact metric strip, mobile.
8. `after/08-step3-attendees-mobile.png` - Attendee step, mobile.
9. `after/09-step4-card-mobile.png` - Card payment, mobile.
10. `after/10-step4-invoice-mobile.png` - Invoice payment, mobile.
11. `after/11-step2-group-desktop.png` - Two-pass group pricing state.
12. `after/12-step3-group-tbc-desktop.png` - Group booking with additional attendee marked TBC.
13. `after/13-confirmation-invoice-desktop.png` - Completed invoice confirmation with a TBC attendee.

### Scenario results

- HR Professional and Vendor / Consultant visual states were reviewed.
- Single and group quantity states update pricing and discount presentation correctly.
- Card and invoice routes remain distinct and clear.
- Invoice form validation identifies missing address, town/city, and postcode fields.
- TBC attendees advance successfully and render safely on confirmation.
- Mobile layouts reflow without horizontal overflow at 390px.
- The in-app browser's full-page capture can duplicate sticky headers on long pages, so final after evidence uses viewport captures for long states.

### Residual notes

- The invoice form is necessarily long on mobile. Optional guidance remains behind the existing disclosure, but the required billing address cannot be shortened without changing procurement requirements.
- The local audit server in this folder is a development-only fixture and does not call Stripe, email, Google Sheets, or production APIs.
