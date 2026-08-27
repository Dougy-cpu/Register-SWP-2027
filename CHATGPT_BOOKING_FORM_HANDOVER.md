# ChatGPT Handover: SWP Summit 2027 Booking Form Website

Use this file as the briefing document for a separate ChatGPT instance that is designing the public booking form webpage for SWP Summit 2027.

This is not a generic conference checkout. It is a premium B2B registration and payment journey for senior HR, workforce planning, people analytics, consulting, vendor, and enterprise buyers.

## 1. Project Context

- Repository: `Register-SWP-2027`
- Product: public registration and checkout system for SWP Summit 2027
- Organisation: People Strategy Hub / Dynamic Business Leaders Limited
- Event name: SWP Summit 2027
- Event date: Wednesday, 3 March 2027
- Venue: 1 Basinghall Avenue, London
- Venue postcode: EC2V 5DD
- Public event website: `https://swpsummit.com`
- Registration domain used in shared links: `https://register.swpsummit.com`
- Support/contact email used in the checkout: `douglas@peoplestrategyhub.com`

The app handles:

- Public checkout
- Lead attendee capture
- Pass selection
- Group discounts
- Promo codes
- Attendee details
- TBC attendee slots
- Stripe card payment
- Stripe invoice payment
- VAT invoice details
- PO number capture and later updates
- Confirmation page
- Self-service attendee management
- Self-service billing/PO updates
- Confirmation and invoice emails
- Google Sheets sync for operations
- Admin tools

The design work in this handover is for the customer-facing booking form and the surrounding booking journey, not the admin screens.

## 2. Design Direction

Use the SWP Summit 2027 visual language:

- Premium B2B enterprise
- Sophisticated
- Commercial
- Expensive
- Strategic
- Calm
- Trustworthy
- Conversion-focused
- Editorial enough to feel aligned with a high-value summit, but still direct and easy to complete

Avoid:

- Generic SaaS dashboard styling
- Generic event template styling
- Cartoon illustration
- Heavy decoration inside the checkout
- Cheap urgency patterns
- Overly playful colours
- Orange legacy HR Analytics Summit branding
- Hiding invoice/procurement details in long paragraphs below the form

The booking form should feel like a confident enterprise purchase flow, not a consumer event checkout.

## 3. Brand Tokens

Use these colours consistently:

- Primary brand blue: `#004eb9`
- Lighter accent blue: `#266cc7`
- Soft blue wash: `#f0f6ff`
- Main text: `#000000`
- Muted text: `#4a5568` or `#444444`
- Borders: `#e2e8f0` or `rgba(0, 78, 185, 0.15)`

Typography:

- Font: Figtree with sensible system fallbacks
- Headings: bold, tight, editorial, usually weight 700 or 800
- Body copy: direct, reassuring, readable
- Eyebrows and labels: uppercase, strong weight, wider letter spacing, SWP blue

Buttons:

- Primary CTA: white text on a 135 degree gradient from `#004eb9` to `#266cc7`
- Primary CTA has subtle blue shadow and a gentle hover lift
- Secondary buttons: blue outline or restrained white/blue treatment
- CTAs should be clear and consequence-led, especially on payment and invoice screens

Cards and containers:

- White or soft blue-wash backgrounds
- Faint blue borders
- Blue-tinted shadows
- Large customer-facing cards typically use 16px to 24px radii in the current checkout
- Smaller interactive cards use 8px to 12px radii
- Avoid nested-card overload on mobile

Icons:

- Lightweight line icons in a Lucide style
- Use `currentColor`
- Most brand icons should be SWP blue
- Icons support comprehension; they should not decorate every element

## 4. Current Visual System In The App

The active checkout uses:

- React, Vite, Tailwind, shadcn/ui
- Figtree loaded from Google Fonts
- SWP-specific CSS utility classes:
  - `.swp-card`
  - `.swp-metric-strip`
  - `.swp-option-card`
  - `.swp-grid-bg`
  - `.swp-primary-btn`
  - `.swp-secondary-btn`
- A faint architectural dot-grid background on the checkout shell
- Sticky white header with subtle blue-tinted shadow
- SWP Summit logo in the header
- Progress indicator under the header
- Centered max-width layout for Steps 1 to 3
- Wider two-column layout with sticky order summary for Step 4

Relevant visual audit screenshots already exist:

- `audit/public-checkout-ui/after/05-step1-desktop.png`
- `audit/public-checkout-ui/after/04-step2-business-desktop.png`
- `audit/public-checkout-ui/after/11-step2-group-desktop.png`
- `audit/public-checkout-ui/after/03-step3-attendees-desktop.png`
- `audit/public-checkout-ui/after/12-step3-group-tbc-desktop.png`
- `audit/public-checkout-ui/after/01-step4-card-desktop.png`
- `audit/public-checkout-ui/after/02-step4-invoice-desktop.png`
- `audit/public-checkout-ui/after/13-confirmation-invoice-desktop.png`
- `audit/public-checkout-ui/after/06-step1-mobile.png`
- `audit/public-checkout-ui/after/07-step2-business-mobile.png`
- `audit/public-checkout-ui/after/08-step3-attendees-mobile.png`
- `audit/public-checkout-ui/after/09-step4-card-mobile.png`
- `audit/public-checkout-ui/after/10-step4-invoice-mobile.png`

The audit notes in `audit/public-checkout-ui/audit-notes.md` say the post-redesign state is strong and should be treated as a useful reference, especially the Step 4 card and invoice screens.

## 5. Overall Checkout Structure

The public checkout route is `/`.

The checkout has four visible form steps plus a final confirmation state:

1. Your details
2. Passes
3. Attendees
4. Payment
5. Confirmation

The progress indicator shows only Steps 1 to 4. It hides on confirmation.

Header:

- Sticky at top
- SWP Summit logo on the left
- Event date and London text on desktop
- Progress indicator below the header

Footer:

- `SWP Summit 2027 - Wednesday, 3 March 2027 - 1 Basinghall Avenue, London`

Global behaviours:

- The browser stores a `booking_session` token in localStorage and sessionStorage.
- Returning visitors resume an in-progress booking at its saved `currentStep`.
- If the stored session belongs to a completed paid/invoiced booking and the visitor is not returning from Stripe, the app rotates to a fresh booking session.
- Browser back/forward maps to checkout steps, so the user can move back through steps without leaving immediately.
- Every step has a "Save and return to SWP Summit" action that saves progress, then redirects to `https://swpsummit.com`.
- Primary forward actions should be visually dominant.
- Back and save/return actions should be available but not compete with the primary conversion path.

Important URL parameters:

- `?pass=hr` preselects the employer-side attendee branch on Step 1.
- `?pass=business` preselects the commercial attendee branch on Step 1.
- `?promo=CODE` auto-applies a promo code on Step 2.
- `?session_id=...&step=5` is used after Stripe card payment return.
- `?step=4` is used as the Stripe cancel return route.

## 6. Step 1: Lead Attendee / Buyer Details

Purpose:

- Identify who is registering.
- Determine whether the buyer is an employer-side attendee or a commercial attendee.
- Capture the lead attendee details and GDPR/T&C consent.

Current headline and intro:

- Eyebrow: `Step 1 of 4`
- H1: `Who is attending?`
- Supporting copy: `Please tell us a bit about yourself so we can tailor your experience.`

Audience choice:

- Section heading: `I am registering as a:`
- Radio card 1:
  - Label: `Employer-side attendee`
  - Supporting text: `In-house HR, strategic workforce planning, people analytics, talent, skills, organisation design, transformation and business-facing workforce teams.`
- Radio card 2:
  - Label: `Commercial attendee`
  - Supporting text: `Vendors, consultants, advisory firms, recruiters, technology providers and commercial service providers.`
- Selected cards show a clear selected state and `Selected` badge.

Audience type affects the rest of the checkout:

- Employer-side attendees get the Workforce Pass flow.
- Commercial attendees get the Business Pass flow.
- Commercial users cannot choose Workforce Pass pricing later; the code forces `business`.
- HR users cannot continue with a business pass if a stale booking had one; the code resolves it back to `single`.

Lead detail fields:

- First Name, required
- Last Name, required
- Work Email, required and validated as email
- Emergency contact phone, optional
- Job Title, required
- Company, required

Consent:

- Required checkbox
- Copy says the user understands data processing under GDPR and conference T&Cs.
- Links:
  - GDPR: `https://peoplestrategyhub.com/your-data-gdpr`
  - T&Cs: `https://swpsummit.com/terms-and-conditions`

Actions:

- Primary: `Continue to Passes`
- Secondary: `Save and return to SWP Summit`

Validation and errors:

- Required field errors are inline.
- Invalid email shows `Valid email is required`.
- Missing consent shows `You must agree to the terms and data processing`.
- Session errors can show: `We could not verify this booking session. Please refresh the page and try again.`
- General save failure: `Something went wrong saving your details. Please try again.`

Technical outcome:

- If this is a new session, Step 1 creates a booking and lead attendee via `/api/bookings/start`.
- Booking starts as `partial`.
- Default pass is `single`, quantity 1.
- Completion of Step 1 advances `currentStep` to 2.

Design implications:

- Step 1 needs to feel reassuring and easy, because it starts the commercial commitment.
- The HR/vendor choice is a major branching decision and should be visually clear.
- Keep the consent visible and legible without making the page feel legal-heavy.

## 7. Step 2: Pass Selection

Purpose:

- Confirm the appropriate pass.
- Let the user choose quantity.
- Apply group discounts and promo codes.
- Capture "How did you hear about the event?"
- Show VAT-inclusive order total before proceeding to attendees.

Current headline and intro:

- Eyebrow: `Step 2 of 4`
- H1: `Select your pass`
- Workforce supporting copy: `Choose how many Workforce Passes you need. Group savings are applied automatically where available.`
- Business supporting copy: `Choose how many Business Passes you need. Group savings are applied automatically where available.`
- Reassurance copy: `Super Early Bird is currently the best value time to book. Prices are shown excluding VAT; VAT and the final total are shown before payment or invoice confirmation.`

Top metric strip:

- Booking type:
  - `Employer-side attendee` or `Commercial attendee`
- Selected pass:
  - Quantity and unit label
  - `Workforce Pass` or `Business Pass`
- Current total:
  - Dynamic total including VAT

Pass types:

1. Workforce Pass
   - Internal pass type: `single`
   - For employer-side leaders and practitioners across strategic workforce planning, people analytics, HR, talent, skills, organisation design and transformation.
   - Not valid for vendors, consultants, recruiters, agencies or commercial service providers.
   - Default/fallback current price: GBP 249 ex VAT
   - Default/fallback original price: GBP 429 ex VAT
   - Seeded current price: GBP 249 ex VAT
   - Seeded original price: GBP 429 ex VAT
   - Seeded period name: `Super Early Bird`
   - Quantity range in UI: 1 to 20
   - Has a `3 passes - Most Popular` shortcut

2. Business Pass
   - Internal pass type: `business`
   - For vendors, consultants, advisory firms, recruiters, technology providers and commercial service providers attending as delegates to understand the market, hear the content and build relevant conversations.
   - This is an attendee pass, not a sponsorship package. Speaking, branding, sponsor visibility and VIP invitations are handled separately.
   - Default/fallback current price in pricing engine: GBP 499 ex VAT
   - Default/fallback original price: GBP 999 ex VAT
   - Seeded current price in pass config: GBP 499 ex VAT
   - Seeded original price: GBP 999 ex VAT
   - Seeded period name: `Super Early Bird`
   - Quantity range in UI: 1 to 10
   - Includes separate Business Pass guidance rather than sponsor-style benefits

Important pricing note:

- Pass config in the database can override displayed current/original prices and benefits.
- The designer should not hard-code pricing into the design as if it can never change.
- Prices are shown ex VAT at the pass level.
- The order summary shows VAT separately and total including VAT.

Default shared pass benefits:

- Full summit day
- Main stage keynotes and content forums
- Planning Lab sessions
- PowerPulse and optional Quickfire sessions
- Personalised agenda creator before the event
- Networking breaks, lunch and drinks reception
- Session slides and recordings after the event

Default Business Pass benefits:

- Same shared pass benefits as Workforce Pass.

Default Business Pass guidance:

- This is an attendee pass, not a sponsorship package.
- Speaking, branding, sponsor visibility and VIP invitations are handled separately.

Inventory badges:

- If remaining is null: no badge.
- If remaining is 5 or fewer: urgent badge like `Only X spots left!`
- If remaining is 20 or fewer: `X spots remaining - selling fast`
- Otherwise: `X spots remaining`
- These badges should communicate scarcity but not feel cheap or aggressive.

Group discount defaults:

- Workforce Pass:
  - 4+ passes: 10% off
  - 8+ passes: 15% off
  - 12+ passes: 20% off
- Business Pass:
  - 2+ passes: 10% off
  - 5+ passes: 15% off

Group discount behaviour:

- Applied automatically based on quantity.
- UI shows the active tier as `Current`.
- UI can show an upsell nudge if the next discount tier is within 3 units.
- Example nudge meaning: add N more passes to reach the next group discount.
- If an active group discount exists, show a clear `X% off group discount applied` message.

Promo code behaviour:

- Manual entry field labelled `Promo Code`.
- User can type a code and click `Apply`.
- Codes are uppercased.
- Codes can also be auto-applied from `?promo=CODE`.
- Applied code display says `Code CODE applied`.
- URL-applied code can show an `Applied via link` badge.
- User can remove an applied code.

Promo code types:

- Percentage discount
- Fixed amount discount
- Per-pass discount in customer-facing copy; internal enum name remains `per_ticket`.
- Complimentary code

Promo restrictions:

- Code must be active.
- Code must be within valid date range.
- Code can have max uses.
- Code can be restricted to Workforce Pass or Business Pass.
- Code can require a minimum quantity.
- Code can be once per customer by lead attendee email.
- Percentage codes can have a max discount amount.

Complimentary promo code edge case:

- Complimentary codes are capped by pass count.
- If selected quantity exceeds remaining complimentary passes, the discount does not zero the order.
- The UI shows an amber shortfall prompt:
  - `Only X complimentary pass(es) remain on this code, but you've selected Y.`
  - Options:
    - Reduce to X passes
    - Keep my quantity (remove code)
- Continue is disabled while this shortfall exists.

"How did you hear about the event?" dropdown:

- Appears inside the order/selection summary area.
- Options are admin-managed but default to:
  - LinkedIn
  - Google / Search engine
  - Email newsletter
  - Word of mouth / Colleague
  - Previous attendee
  - Industry publication or press
  - Podcast
  - Social media
  - Other

Order summary:

- Shows quantity times pass label.
- Base subtotal
- Group discount line when present
- Promo code line when present
- Subtotal after discounts
- VAT at 20%
- Total
- Savings message when savings are greater than zero

Actions:

- Back
- Save and return to SWP Summit
- Primary: `Continue to Attendees`

Continue is disabled when:

- Pricing is loading
- Booking is not yet saved
- Complimentary code shortfall exists
- Update is pending

Design implications:

- Step 2 is information-rich. It must feel premium and clear, not busy.
- The design should make the chosen pass, quantity, VAT, discounts, and total obvious.
- Group and promo savings should be positive but not shouty.
- The HR and Business flows need similar structure with distinct audience meaning.
- Mobile scanability is critical; current audit noted Step 2 can become long on mobile.

## 8. Step 3: Attendee Details

Purpose:

- Collect details for every seat in the booking.
- Allow buyers to mark non-lead seats as TBC so they can complete the booking before names are final.

Current headline and intro:

- Eyebrow: `Step 3 of 4`
- H1: `Attendee details`
- Single-pass copy: `Please confirm who this pass is for.`
- Multi-pass copy: `Please confirm who each of the X passes is for.`

Multi-seat TBC guidance:

- Shows an info banner:
  - `Not sure who's attending yet? Mark any additional pass as TBC to complete your booking now and confirm the attendee details later.`

Status summary card:

- Passes: total quantity
- Ready: valid or TBC attendees out of total
- Lead company: company from Step 1

Multi-seat helper actions:

- `Copy company to all`
- `Mark additional passes TBC`

Attendee UI:

- Accordion with one item per attendee.
- Attendee 1 is the lead attendee.
- Later attendees are additional passes.
- Closed accordion rows show:
  - Attendee number
  - Person name, pending details, or TBC status
- Open row shows fields and controls.

Attendee fields:

- First Name, required
- Last Name, required
- Work Email, required and validated as email
- Phone, optional
- Job Title, required
- Company, required
- Dietary requirements or accessibility needs, optional textarea
- GDPR/T&C consent, required unless the attendee is TBC

Lead attendee behaviour:

- Attendee 1 can show a chip/control: `This pass is for me`.
- Lead values are pre-filled from Step 1.
- Editing any non-consent field can unset the "for me" flag.

Additional attendee TBC behaviour:

- Additional attendees can be marked `Not confirmed yet (TBC)`.
- When TBC is on, personal fields are cleared and hidden.
- TBC row shows an amber message:
  - `This pass is marked as TBC`
  - `You can confirm this attendee's details later.`
- TBC rows count as ready for continuing.

Validation:

- Non-TBC attendees must satisfy all required fields and consent.
- The first invalid attendee accordion opens when Continue is clicked.
- TBC rows skip validation.

Autosave:

- Step 3 autosaves eligible rows after about 1.5 seconds.
- Autosave runs when a row is TBC or has at least first name and work email.
- If autosave fails, an amber banner appears:
  - `We couldn't save your last change`
  - It explains automatic retry and offers `retry now`.
- Retry backoff is approximately 2s, 6s, then 18s.
- Continue is disabled while autosave is saving or in error.

Actions:

- Back
- Save and return to SWP Summit
- Primary: `Continue to Payment`

Primary button states:

- `Saving...`
- `Saving changes...`
- `Save failed - retrying`
- `Continue to Payment`

Design implications:

- This step can become long for group bookings.
- The design should make progress through attendee rows obvious.
- TBC should feel like a legitimate procurement/team-booking feature, not an error.
- Keep final actions stacked vertically on checkout pages; previous audit fixed button overlap by avoiding responsive button grids.

## 9. Step 4: Payment

Purpose:

- Let the buyer choose card or invoice.
- Collect invoice billing details when needed.
- Confirm the booking by payment, invoice issue, or free confirmation.

Non-free headline and intro:

- Eyebrow: `Step 4 of 4`
- H1: `Final checkout`
- Supporting copy: `Choose how to pay, confirm invoice details if required, and finish your SWP Summit registration.`

Top metric strip:

- Booking: quantity and pass summary
- Payment choice: Card or Invoice
- Total due: total including VAT

Payment choices:

1. Pay by card now
   - Icon: credit card
   - Copy: `Pay securely through Stripe and confirm your booking immediately.`
   - Result: user is redirected to Stripe Checkout.

2. Pay by invoice
   - Icon: file text
   - Copy: `Receive a VAT invoice with supplier details, bank information and a secure payment link for your finance team.`
   - Result: user completes billing form, confirms registration, and Stripe invoice is issued and emailed.

Selected payment method:

- Has radio, border, background, and `Selected` badge.
- Should be impossible to miss.

Card payment flow:

- User chooses card.
- Primary CTA: `Proceed to secure card payment`
- Backend creates a Stripe Checkout Session.
- Booking status becomes `pending_payment`.
- User pays in Stripe.
- On return, page shows `Confirming your payment...`
- Browser polls every 2 seconds for up to 60 seconds.
- Browser also calls `/api/stripe/confirm-card-payment` with booking ID and Stripe session ID.
- If confirmed, booking moves to Step 5 confirmation.
- If polling times out, user sees:
  - `Payment confirmation is taking longer than expected.`
  - Message that if payment completed, registration will be confirmed shortly and email will arrive.

Invoice payment flow:

- User chooses invoice.
- Invoice form appears.
- Primary CTA: `Confirm registration and email invoice`
- This confirms the registration immediately and emails the invoice immediately to the billing contact.
- PO and billing details can still be updated before payment using the secure link in the invoice email.
- Invoice can be paid by bank transfer or through a Stripe payment link.

Invoice procurement guidance:

- Main panel eyebrow: `How invoice payment works`
- Heading: `Built for procurement and finance teams`
- Key explanation: invoice is best for procurement or finance-led bookings; card is available if ready to pay now.
- Guidance says invoice email includes:
  - Supplier details
  - Bank information
  - Payment instructions
  - Secure Stripe payment link
- Three process steps:
  - Confirm and issue: registration confirmed when the invoice is issued and emailed.
  - Finance-ready details: supplier details, bank information, payment instructions and secure Stripe payment link included.
  - Pay or update later: pay by bank transfer or Stripe, and add a PO through the secure billing link before payment.
- Optional admin-editable invoice help can appear behind `View full details`.

Invoice form sections:

1. Billing contact
   - Billing contact name, required
   - Company name, required
   - Invoice email address, required and validated as email
   - Purchaser contact number, required
   - These fields can be linked to the lead attendee.
   - Linked fields show `Same as lead attendee`.
   - If changed, they can show `Use lead attendee` to relink.

2. Billing address
   - Address line 1, required
   - Address line 2, optional
   - Town / City, required
   - Region / County, optional
   - Postcode, required
   - Country, required, defaults to United Kingdom

3. Invoice references
   - VAT number, optional
   - PO number, optional
   - PO number max length: 30 characters
   - If PO entered, helper says it will appear on the invoice when registration is confirmed.
   - If no PO entered, helper says the user can confirm now and add PO later using secure invoice email link. The invoice is automatically reissued with PO included.

Step 4 sidebar:

- Sticky on desktop.
- Order summary:
  - Pass type
  - Quantity
  - Subtotal
  - Group discount
  - Promo code
  - VAT at 20%
  - Total
- Action card:
  - Primary CTA
  - `Back to attendees`
  - Save and return button
- What happens next card:
  - Card selected:
    - You are taken to Stripe to pay securely.
    - Your booking is confirmed after successful payment.
    - A confirmation email is sent to the lead attendee.
  - Invoice selected:
    - Registration is confirmed and the invoice is emailed immediately.
    - Supplier details, bank information and payment instructions are included.
    - Pay by bank transfer or Stripe, and update PO or billing details securely.

Payment errors:

- Render as red bordered block.
- Heading: `Payment error`
- Includes actual error.
- Fallback support copy:
  - If this continues, email `douglas@peoplestrategyhub.com` to complete registration.

Abandonment notification:

- If a user reaches Step 4 and leaves without paying/confirming, a best-effort incomplete-ping may be sent.
- It is gated by at least 10 seconds on Step 4 for browser unload.
- There is also a 20-minute fallback timer.
- This is operational logic; the public UI does not need to expose it.

Design implications:

- Step 4 is the strongest current reference for the checkout visual system.
- Invoice is a key purchase route, not a secondary oddity.
- Procurement reassurance must be visible before the form, but repeated long copy should be avoided.
- The CTA should make the consequence clear: card redirects to Stripe; invoice confirms and emails an invoice.

## 10. Free Booking / Complimentary Flow

If pricing total is GBP 0 because a promo code covers the full cost:

- Step 4 becomes a free confirmation screen.
- H1: `Confirm Registration`
- Copy: `Your promo code covers the full cost - no payment needed.`
- Green success panel:
  - `Your promo code has been applied`
  - `This booking is completely free. Click the button below to confirm your place at the summit.`
- Actions:
  - Back
  - Primary: `Confirm Registration`
  - Save and return to SWP Summit
- Sidebar order summary shows total GBP 0.00.

Design implications:

- This should still feel premium and official.
- Avoid making it feel like a coupon/discount gimmick.
- Confirmation still creates a real booking and sends post-confirmation communications.

## 11. Confirmation Page

Purpose:

- Confirm successful registration.
- Provide order reference, event details, attendee summary, invoice status if relevant, and self-service links.

Main success content:

- Large circular check icon in SWP blue wash
- H1: `You are registered!`
- Copy: `We cannot wait to see you at the SWP Summit.`

Core confirmation card:

- Order Reference
  - Shows generated reference or `PENDING`
  - Format is `SWP27-{6541 + bookingId}`
- Event Details
  - Wednesday, 3 March 2027
  - 1 Basinghall Avenue, London
- Registration
  - Quantity times pass label
  - Total amount
- Attendees
  - Name and email for each attendee
  - TBC rows display `Attendee N (TBC)` and initials `TBC`

Invoice-specific confirmation:

- Shows an `Invoice issued` section.
- Includes invoice badge status.
- Explains:
  - Registration is confirmed.
  - Invoice has been emailed to billing contact.
  - Invoice email includes supplier details, bank information, payment instructions and a secure Stripe payment link.
  - Finance team can pay by bank transfer or secure Stripe payment link.
  - PO can be added later through secure billing link; invoice is reissued with PO included.
  - Check junk/spam if email does not arrive.
- If PO exists, show PO number.
- Buttons may include:
  - `Pay invoice online`
  - `Add PO number or update billing`

Management link section:

- If `managementToken` exists, show:
  - Heading: `Need to update attendee details?`
  - Copy: user can add or update attendee names and contact info at any time, including TBC slots.
  - Link: `Manage attendees`

Footer confirmation copy:

- Confirmation email has been sent to lead attendee.
- Check junk/spam if not received.
- Primary final button: `Return to Website`, which goes to `https://swpsummit.com`.

Design implications:

- The confirmation page should feel complete, calm, and official.
- Invoice buyers need extra reassurance that registration is confirmed even before invoice payment.
- Self-service links should be useful but not dominate the success message.

## 12. Post-Booking Self-Service Pages

These pages are linked from confirmation and emails. They are not the main booking form, but the booking form design should anticipate them.

### Manage Attendees

Route:

- `/manage/:token`

Purpose:

- Allow customers to update attendee details after booking, especially TBC slots.

Page content:

- Header with SWP logo
- H1: `Manage Attendees`
- Booking metadata:
  - Order reference
  - Event date
  - Venue
  - Pass quantity
  - Invoice badge if invoice booking
- If attendee changes are locked, show red/locked notice:
  - `Attendee changes are closed`
  - Default support message asks the user to email `douglas@peoplestrategyhub.com`
- If TBC details remain, show amber notice:
  - `X attendee detail(s) still needed`
  - User can return any time using confirmation email link.
- If all details complete, show green notice:
  - `All attendee details are complete`

Attendee cards:

- Each attendee can be expanded.
- TBC cards show `Details Needed`.
- Non-TBC cards show attendee name and email.
- Locked cards show locked state.
- Editable fields match Step 3:
  - First name
  - Last name
  - Job title
  - Company
  - Work email
  - Phone
  - Dietary / Accessibility Requirements
  - GDPR consent
- Save button: `Save Attendee Details`

### Edit Billing / PO

Route:

- `/manage/:token/billing`

Purpose:

- Let invoice customers update billing details and PO number before the invoice is paid.
- Saving reissues the invoice with updated details and emails it to billing contact.

Page content:

- Eyebrow: `Secure invoice update`
- H1: `Update billing and PO details`
- Copy says updated billing details or PO can be added; after saving, invoice is reissued.
- Shows invoice actions if booking is invoiced or paid.
- If card booking, shows `Not an invoice booking`.
- If locked, shows `Booking edits are currently locked`.
- If paid, edits are unavailable/limited.

Fields:

- PO number, optional, max 30 characters
- Billing contact name
- Company
- Invoice email
- Billing phone
- Address line 1
- Address line 2
- Town / city
- Region / county
- Postcode
- Country
- VAT number, optional

Actions:

- `Save and re-issue invoice`
- `Discard changes`
- `View current invoice` when URL exists

Success states:

- Saved and invoice reissued, with note to check junk/spam.
- Saved but invoice could not be reissued, contact support.
- Invoice just marked as paid, no changes applied.

## 13. Payment And Booking Statuses

Booking statuses:

- `partial`: started checkout, not completed
- `pending_payment`: card checkout session created, awaiting payment
- `paid`: completed and paid, including free/complimentary confirmation
- `invoiced`: invoice issued, not yet paid
- `cancelled`
- `refunded`
- `disputed`

Payment methods:

- `card`
- `invoice`

Important status meaning for UX:

- Invoice bookings are confirmed immediately when invoice is issued, even though payment can happen later.
- Card bookings are confirmed only after Stripe payment succeeds.
- Free bookings are confirmed by the free confirmation action.
- Invoice bookings can later become `paid` when Stripe invoice payment succeeds.

## 14. Pricing Rules The Design Must Respect

Do not redesign in a way that implies different pricing behaviour.

Rules:

- VAT is always 20% UK VAT.
- Pass prices are shown ex VAT.
- VAT is shown as a separate line item in summaries.
- Total is VAT-inclusive.
- Group discount applies before promo code.
- Promo code applies to the post-group-discount subtotal.
- Discounts and promo codes can both apply.
- Monetary calculations use integer pence internally; avoid copy that implies approximate prices.
- Complimentary code only creates a free order when all selected seats are covered.
- A fixed or per-pass promo cannot produce a negative receipt; totals clamp at zero.
- Discount tiers and pass config are admin-editable.

Order summary should always make the buyer understand:

- What they selected
- How many seats/passes
- Base subtotal
- Savings/discounts
- VAT
- Final total

## 15. Emails And Operational Side Effects

The designer does not need to design emails here, but the checkout copy should reflect them accurately.

After successful confirmation, the system can send:

- Confirmation email to lead attendee
- Welcome email to each attendee
- Invoice email to billing contact for invoice flow
- Organiser notification
- Google Sheets sync

Side-effect delivery is tracked individually in the admin system.

Design-copy implications:

- It is correct to say confirmation email is sent to the lead attendee.
- It is correct to say invoice email is sent immediately to billing contact when invoice is selected.
- It is correct to say invoice email includes supplier/bank/payment information.
- It is correct to tell users to check junk/spam if email does not arrive within a few minutes.

## 16. Mobile And Accessibility Notes

Mobile:

- Steps 2, 3, and invoice Step 4 can become long.
- Keep orientation visible with progress and concise section headings.
- Avoid deep nesting and repeated explanatory blocks.
- CTAs should remain full-width and clear.
- The existing system uses stacked bottom actions on checkout steps to avoid button overlap.

Accessibility:

- Progress uses semantic nav and `aria-current="step"`.
- Selection should never rely on colour alone; use label, radio/checkmark, border, and background.
- Quantity controls have accessible names for increase/decrease.
- Error messages are inline and should sit close to fields.
- Do not use animation heavily inside forms.
- Respect reduced motion.
- Ensure invoice and promo help copy remains readable on small screens.

## 17. Recommended Page Design Priorities

For a new design or redesign, prioritise:

1. Trust and conversion
   - Premium branded shell
   - Clear step sequence
   - Strong, explicit CTAs
   - Calm payment and invoice reassurance

2. Procurement clarity
   - Invoice is a first-class route
   - PO can be supplied now or later
   - Billing details can be updated before payment
   - Invoice email includes finance-ready details

3. Group booking ease
   - Quantity selection is obvious
   - Group discounts are automatic and visible
   - TBC attendees are allowed for additional seats
   - Self-service attendee updates are available after booking

4. Price transparency
   - Show ex VAT pass price
   - Show VAT separately
   - Show total including VAT
   - Show applied group/promo savings without gimmicks

5. Mobile completion
   - Keep steps scannable
   - Do not bury required fields after repeated copy
   - Preserve full-width actions
   - Avoid sticky elements that obscure content

## 18. Do Not Change These Business Rules In A Design

Do not propose a design that requires changing:

- Database schema
- Stripe logic
- Invoice logic
- VAT logic
- Promo code logic
- Group discount logic
- Booking status logic
- Attendee logic
- Pricing calculations
- Generated API client files
- Generated Zod files

Design should be UI-only unless explicitly asked otherwise.

## 19. Suggested Information Architecture For A Booking Page

A good booking form webpage should probably preserve this high-level structure:

- Sticky branded header
  - Logo
  - Event date/location
  - Progress
- Main step content
  - Step eyebrow
  - Strong H1
  - Short reassurance copy
  - Form/cards for the current decision
  - Inline status, validation, and pricing feedback
- Order/booking summary where relevant
  - Step 2 summary near quantity and promo
  - Step 4 sticky summary on desktop
- Action area
  - Primary continue/confirm action
  - Back where appropriate
  - Save and return
- Footer with event details

Avoid turning the booking form into a marketing landing page. The first screen should be the actual booking experience.

## 20. Key Source Files For Reference

Design source of truth:

- `DESIGN_GUIDELINES.md`
- `AGENTS.md`

Checkout shell and progress:

- `artifacts/checkout/src/pages/checkout/index.tsx`
- `artifacts/checkout/src/components/layout/CheckoutLayout.tsx`
- `artifacts/checkout/src/components/checkout/CheckoutProgress.tsx`
- `artifacts/checkout/src/components/checkout/SaveAndReturnButton.tsx`

Checkout steps:

- `artifacts/checkout/src/pages/checkout/Step1Lead.tsx`
- `artifacts/checkout/src/pages/checkout/Step2Passes.tsx`
- `artifacts/checkout/src/pages/checkout/Step3Attendees.tsx`
- `artifacts/checkout/src/pages/checkout/Step4Payment.tsx`
- `artifacts/checkout/src/pages/checkout/Confirmation.tsx`
- `artifacts/checkout/src/pages/checkout/CompShortfallPrompt.tsx`

Styling:

- `artifacts/checkout/src/tokens.css`
- `artifacts/checkout/src/index.css`

Business logic references:

- `artifacts/api-server/src/lib/pricing.ts`
- `artifacts/api-server/src/routes/pricing.ts`
- `artifacts/api-server/src/routes/bookings.ts`
- `artifacts/api-server/src/routes/stripe.ts`
- `artifacts/api-server/src/routes/promo-codes.ts`
- `artifacts/api-server/src/routes/hear-about-us.ts`
- `artifacts/api-server/src/lib/seed.ts`

Database schema:

- `lib/db/src/schema/bookings.ts`
- `lib/db/src/schema/attendees.ts`
- `lib/db/src/schema/pass-config.ts`
- `lib/db/src/schema/pass-inventory.ts`
- `lib/db/src/schema/discount-tiers.ts`
- `lib/db/src/schema/promo-codes.ts`
- `lib/db/src/schema/event-settings.ts`

Post-booking management:

- `artifacts/checkout/src/pages/manage/ManageAttendees.tsx`
- `artifacts/checkout/src/pages/manage/EditBilling.tsx`

Visual audit:

- `audit/public-checkout-ui/audit-notes.md`
- `audit/public-checkout-ui/after/`

## 21. Quick Design Brief For Regular ChatGPT

Design a premium, calm, conversion-focused public booking form for SWP Summit 2027. The user journey is a four-step checkout: lead details, pass quantity/pricing, attendee details, and payment by card or invoice, followed by confirmation. The design must support Employer-side attendee and Commercial attendee audience branches, Workforce Pass and Business Pass pricing, automatic group discounts, promo codes including complimentary codes, VAT at 20%, TBC attendee details, save-and-return, Stripe card payment, invoice procurement flow, PO number now or later, and post-booking management links.

The page should look like a high-value B2B enterprise summit checkout aligned with SWP Summit branding. Use SWP blue `#004eb9`, accent blue `#266cc7`, soft blue wash `#f0f6ff`, black text, muted grey text, Figtree typography, restrained blue shadows, and clear card hierarchy. The design should communicate trust, clarity, and commercial value without becoming decorative or generic.

Do not alter pricing, VAT, promo, invoice, Stripe, booking status, or attendee rules. Design the webpage around the existing process and make the customer experience clearer, more premium, and easier to complete on desktop and mobile.
