# HRAS to SWP Summit Register upgrade handoff

Prepared: 20 August 2026
Source application: HR Analytics Summit Register (`C:\Projects\Register HRAS`)
Target application: SWP Summit Register (`C:\Projects\SWP\Register`)
Canonical HRAS feature commit: `d7409a79be9a2244553eb959c2156699ee2ca42f` (`Add manual registrations and attendee transfers`)
HRAS source branch: `hras-checkout-ux-port`
HRAS live register: `https://register.hranalyticssummit.com`

## 1. Purpose and outcome

This document hands over the complete set of HRAS Register upgrades delivered on 20 August 2026 so that the same capabilities can be added to the SWP Summit Register.

The completed HRAS work provides:

1. Manual entry of delegates who are being invoiced outside the online booking flow.
2. A `transferred` registration status that records a move to another event without refunding or voiding the original payment record.
3. Internal organiser notes on every attendee.
4. More flexible registration search across company, job title and promo code, as well as the existing fields.
5. Clear manual-entry and notes columns in the Excel export.
6. Privacy, audit and workflow safeguards so internal notes are not exposed and manual records do not trigger automated booking side effects.

The HRAS change was committed, pushed, installed in Replit, schema-applied, published and live-verified. The SWP repository was inspected during this handoff: these four new capabilities are not present there yet, so they remain a genuine feature gap.

This must be implemented as a feature port, not a whole-file or whole-commit merge. Preserve all SWP event information, branding, colours, pricing, Stripe logic, checkout behaviour, emails, venue/date content and unrelated local changes.

## 2. Business behaviour delivered in HRAS

### 2.1 Manual direct-invoice delegates

The Registrations admin page now has an **Add delegate** action. It opens an **Add a direct-invoice delegate** dialog.

Required fields:

- First name
- Last name
- Job title
- Company
- Work email

Optional fields:

- Phone
- Dietary/accessibility requirements
- Organiser notes

Admin choices:

- Pass type: `single` or `business`
- Initial status: `invoiced` or `paid`

Created record behaviour:

- Creates exactly one booking and one lead attendee in a single database transaction.
- Uses the application's current pricing calculation for a quantity of one, including current VAT.
- Uses the application's existing order-reference generator; there is no hard-coded HRAS reference in the reusable logic.
- Sets `paymentMethod = invoice` and `manualEntry = true`.
- Sets `currentStep = 4`, creates a management token and records the attendee as non-TBC.
- For `invoiced`, sets the normal 14-day invoice due date.
- For `paid`, sets `paidAt` immediately.
- Maps `single` to `hr_professional` and `business` to `consultant_vendor`.
- Stores the email in lowercase and trims text values.
- Sets GDPR consent to false with no consent timestamp because the delegate did not complete the public consent flow.
- Shows a **Manual** badge in the registration list and **Manual direct invoice** in the expanded record.
- Writes an `admin_attendee_added` audit event.

Deliberate safeguards:

- Does not create a Stripe Checkout Session, PaymentIntent or Stripe invoice.
- Does not send confirmation emails, welcome emails or organiser notifications.
- Does not sync the booking to Google Sheets automatically.
- Is excluded from the **Needs attention** delivery calculation.
- Is excluded from unpaid Stripe invoice/reminder widgets because there is no Stripe invoice to chase.

Operational meaning: the registration records that an invoice is handled directly elsewhere. It is not an accounts-receivable or invoice-generation feature.

### 2.2 Transferred status

`transferred` was added to the booking-status enum, API contract, admin status control, list filter and badge styles.

Behaviour:

- An admin can change a registration to **Transferred**.
- A confirmation dialog states that payment and invoice records will not be changed.
- The destination event is recorded in the relevant attendee's organiser notes.
- Stripe action is deliberately `skipped`.
- Existing Stripe PaymentIntent and invoice identifiers remain on the booking.
- No refund is issued and no invoice is voided.
- The audit trail records the previous and new status.
- Transferred registrations retain a completed-style display date in the registration list.

Important scope decision: status remains booking-level, not attendee-level. On a group booking, setting **Transferred** transfers the whole registration. If SWP needs one person in a group to transfer while the other delegates remain active, that is a separate data-model change and is not included in this port.

Current HRAS reporting semantics also remain intentional: the top-line completed-registration and revenue statistics count `paid` and `invoiced`, not `transferred`. The transferred record remains visible and filterable but no longer counts as attendance/revenue for that event's completed summary. Confirm that SWP should retain this same rule before release.

### 2.3 Organiser notes per attendee

Each attendee now has a nullable internal `notes` field.

Behaviour and controls:

- Notes are editable in the expanded registration's attendee table.
- Notes can be supplied when a manual delegate is created.
- Maximum length is 4,000 characters.
- Values are trimmed; an empty value is stored as null.
- Notes are included in the admin registration detail response.
- Notes are searchable from the Registrations search bar.
- Notes are included in the Excel export as **Attendee Notes**.
- Notes are treated as PII and masked in audit-log before/after payloads.
- Notes are stripped from all public booking and attendee responses.
- A non-admin attendee update cannot alter organiser notes.

Privacy is enforced in both `routes/attendees.ts` and `routes/bookings.ts`, rather than relying only on the UI.

### 2.4 Expanded registration search

Registration search is now:

- Case-insensitive.
- Whitespace-trimmed before matching.
- Able to search attendee first name, last name, work email, company, job title and organiser notes.
- Able to search booking reference and applied promo code.

The admin placeholder now reads:

> Name, email, company, job title, promo code or reference...

The SWP backend already searches company, although its UI does not advertise that. The actual SWP gaps are job title, promo code, organiser notes and trimming blank/padded searches, plus the updated placeholder.

### 2.5 Excel export

Two columns were added:

- **Entry Source**: `Manual direct invoice` or `Online checkout`
- **Attendee Notes**: the internal note for that attendee

Existing status, pass, amount, payment, billing, attendee, GDPR and date columns remain unchanged.

## 3. Data model and schema changes

### `lib/db/src/schema/bookings.ts`

- Added `transferred` to the PostgreSQL `booking_status` enum.
- Added `manualEntry: boolean("manual_entry").notNull().default(false)`.

The non-null default is critical: all existing online bookings become `false` without requiring data backfill.

### `lib/db/src/schema/attendees.ts`

- Added `notes: text("notes")`.

The column is nullable so existing attendees need no backfill.

### `artifacts/api-server/src/lib/schema-check.ts`

- Added `bookings.manual_entry` to expected production columns.
- Added `attendees.notes` to expected production columns.

### Production schema outcome in HRAS

The first publish attempt correctly failed because production did not yet have:

- `bookings.manual_entry`
- `attendees.notes`
- the `transferred` booking enum value

After the schema change was manually reviewed and approved, the republish completed. Production was then confirmed with:

- `manual_entry`: non-null boolean, default false
- `notes`: nullable text
- `transferred`: present in `booking_status`

For SWP, apply and inspect the schema change in the development database first. During production Publish, stop and explicitly confirm that the production schema diff contains only these intended additions before approving it.

## 4. API and OpenAPI changes

`lib/api-spec/openapi.yaml` remains the source of truth.

### New endpoint

`POST /api/admin/registrations`

- Admin-token protected.
- Operation ID: `createManualRegistration`.
- Creates a one-person direct-invoice registration.
- Returns HTTP 201 with `AdminBookingWithAttendees`.
- Returns 400 for invalid input and 401 without admin authentication.

Request schema: `ManualRegistrationBody`

- Required: `firstName`, `lastName`, `jobTitle`, `company`, `workEmail`
- Optional: `phone`, `dietaryAccessibility`, `notes`
- `passType`: `single | business`, default `single`
- `status`: `invoiced | paid`, default `invoiced`
- `notes`: maximum 4,000 characters

### Existing endpoints changed

- `GET /api/admin/registrations`: expanded `search` semantics and description.
- `GET /api/admin/registrations/:id`: returns admin attendee objects containing notes.
- `PATCH /api/admin/registrations/:id/status`: accepts `transferred`.
- `PATCH /api/bookings/:bookingId/attendees/:attendeeId`: accepts notes only for authenticated admin requests.
- Public booking and attendee responses explicitly omit notes.

### Contract types added or changed

- Added `AdminAttendee`.
- Added `AdminBookingWithAttendees`.
- Added `ManualRegistrationBody` and its pass/status enum types.
- Added `manualEntry` to `Booking` and `RegistrationSummary`.
- Added `transferred` to every relevant booking/status enum.
- Added organiser notes to the admin attendee-update contract.

After editing OpenAPI, regenerate artifacts with:

```text
pnpm --filter @workspace/api-spec run codegen
```

Never copy or hand-edit generated files independently of the OpenAPI change.

## 5. Server implementation map

| HRAS file                                              | Responsibility added                                                                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `artifacts/api-server/src/routes/admin.ts`             | Expanded search, manual-create endpoint, transfer status, export columns, manual exclusion from unpaid invoice queries |
| `artifacts/api-server/src/routes/attendees.ts`         | Admin-only note creation/update, public note omission, note audit data                                                 |
| `artifacts/api-server/src/routes/bookings.ts`          | Strips notes from every public booking attendee response                                                               |
| `artifacts/api-server/src/lib/booking-confirmation.ts` | Skips all automatic confirmation side effects for manual entries and excludes them from Needs attention                |
| `artifacts/api-server/src/lib/audit.ts`                | Treats `notes` as PII so audit values are masked                                                                       |
| `artifacts/api-server/src/lib/schema-check.ts`         | Checks the two new database columns at startup                                                                         |
| `artifacts/api-server/src/routes/admin-audit.test.ts`  | Integration coverage for search, manual creation, transfer, privacy and audit masking                                  |

Manual creation deliberately reuses the target application's existing:

- `calculatePricing(passType, 1)`
- `defaultOrderRef(booking.id)`
- VAT configuration
- pass and attendee-type enums
- database transaction and audit infrastructure

Do not copy an HRAS price, reference prefix, invoice label or event setting into SWP.

## 6. Admin UI implementation map

Primary file: `artifacts/checkout/src/pages/admin/registrations.tsx`

Changes made in HRAS:

- Added `transferred` to status options and the status filter.
- Added a cyan transferred badge.
- Added transfer-specific confirmation wording.
- Added manual-entry badges in list and expanded detail views.
- Added the **Add delegate** button and dialog.
- Added required-field validation and server-error display for manual creation.
- Resets filters after creation, refreshes the query and expands the new record.
- Added organiser notes to attendee display and edit state.
- Added a 4,000-character internal-only notes field.
- Updated search placeholder and responsive filter layout.

Supporting compatibility change:

- `artifacts/checkout/src/pages/checkout/index.tsx` supplies `manualEntry: false` when constructing the normal checkout booking shape.

For SWP, reproduce the behaviour using SWP's existing blue design tokens, Figtree typography, pass labels and admin layout. Do not copy HRAS colour choices or event-specific text. The new controls should look native to the current SWP admin screen.

## 7. Generated files in the HRAS commit

These were generated from OpenAPI and should be regenerated in SWP, not copied by hand:

- `lib/api-client-react/src/generated/api.schemas.ts`
- `lib/api-client-react/src/generated/api.ts`
- `lib/api-zod/src/generated/api.ts`
- `lib/api-zod/src/generated/types/adminAttendee.ts`
- `lib/api-zod/src/generated/types/adminBookingWithAttendees.ts`
- `lib/api-zod/src/generated/types/adminRegistrationStatusUpdateBodyStatus.ts`
- `lib/api-zod/src/generated/types/booking.ts`
- `lib/api-zod/src/generated/types/bookingStatus.ts`
- `lib/api-zod/src/generated/types/index.ts`
- `lib/api-zod/src/generated/types/listRegistrationsParams.ts`
- `lib/api-zod/src/generated/types/manualRegistrationBody.ts`
- `lib/api-zod/src/generated/types/manualRegistrationBodyPassType.ts`
- `lib/api-zod/src/generated/types/manualRegistrationBodyStatus.ts`
- `lib/api-zod/src/generated/types/registrationSummary.ts`
- `lib/api-zod/src/generated/types/updateAttendeeBody.ts`
- `lib/api-zod/src/generated/types/updateBookingBodyStatus.ts`

## 8. Tests and validation completed for HRAS

Integration coverage added or extended in `artifacts/api-server/src/routes/admin-audit.test.ts`:

1. Company, job-title and promo-code search is case-insensitive and trims padded input.
2. Manual direct-invoice registration creates the expected booking/attendee and performs no Stripe action.
3. Transfer preserves the Stripe PaymentIntent and returns `stripeAction = skipped`.
4. Notes persist in admin detail, are absent from the public response and are masked in audit data.

Final local validation recorded:

- Formatting passed.
- Lint passed.
- Typecheck passed.
- 12 test files / 93 tests passed.
- API build passed.
- Checkout build passed.

Final Replit validation recorded after preserving the newer Replit-side fixes:

- 13 test files / 107 tests passed.
- Typecheck passed.
- API build passed.
- Checkout build passed.
- Only previously known font, source-map and bundle-size warnings remained.

The different local and Replit test totals are expected: the Replit branch contained additional preserved fixes/tests that were not part of `d7409a7`.

On Windows, the checkout build required temporary native build packages because those platform binaries are intentionally excluded from the repository. No dependency manifest or project configuration was changed to work around that. The Linux/Replit build passed normally.

## 9. HRAS release chronology and evidence

### Source and release identity

- Canonical GitHub repository: `https://github.com/Dougy-cpu/CODEX-Register-HRAS`
- Canonical feature commit: `d7409a79be9a2244553eb959c2156699ee2ca42f`
- Commit time: 20 August 2026 at 15:44:52 BST
- Commit size: 28 files, 1,328 insertions and 102 deletions
- Replit preserved/merged head before publish: `c8b349d3f3a3587d66f6ecdfeff2379cfd79b2bc`
- Active Replit publish marker: `72e5c0f3ec12d6a3c48939e04e379fb0268dc8da` (`Published your App`)
- The release lineage contained `d7409a7`, and the feature-bearing checkout tree was validated before promotion.

### Release sequence used

1. Reviewed local status and preserved unrelated HRAS files.
2. Committed and pushed `d7409a7` to `hras-checkout-ux-port`.
3. Pulled/merged the feature into the newer Replit history instead of overwriting Replit-only fixes.
4. Installed from the lockfile.
5. Regenerated/verified code, ran typecheck/tests and built API plus checkout.
6. Started Publish.
7. First Publish exposed the intended production schema additions as unapproved.
8. The schema diff was manually confirmed.
9. Republished successfully.
10. Independently checked the live site, health endpoint, protected endpoint behaviour and live JavaScript markers.

### Live acceptance recorded

- `/api/healthz` returned HTTP 200 with `{"status":"ok"}`.
- The root page returned HTTP 200 and title `HR Analytics Summit Checkout`.
- Unauthenticated GET and JSON POST requests to `/api/admin/registrations` returned 401 as expected.
- The live bundle contained:
  - `Add a direct-invoice delegate`
  - `Payment records are not changed when selecting Transferred`
  - `Name, email, company, job title, promo code or reference`
  - `Organiser Notes`

The Replit SSH connector was unavailable due to authentication. Replit Agent was used only after direct access was exhausted; schema promotion itself still required the user's manual approval. For SWP, follow the established preference to use Git, Replit Shell/workflows and Publish controls without Replit Agent.

## 10. Current SWP baseline and feature gap

Inspected during this handoff:

- Repository: `https://github.com/Dougy-cpu/Register-SWP-2027.git`
- Branch: `codex/public-checkout-ui-audit`
- HEAD: `83b6abf0d160c04a4dfe98c4b7d81c8d1570ba6c`

The existing SWP head already includes an earlier HRAS feature-gap port: improved Stripe customer display, separate confirmation/welcome resend controls, Community Social attendee email, attendee-change organiser notification, and regenerated OpenAPI artifacts. Keep those features.

Confirmed gaps at this baseline:

| Capability          | Current SWP state                                     | Required port                                  |
| ------------------- | ----------------------------------------------------- | ---------------------------------------------- |
| Manual delegate     | No `manual_entry` field, endpoint or UI               | Add full direct-invoice flow and safeguards    |
| Transferred status  | Not in database enum, API or UI                       | Add booking-level status with no Stripe action |
| Organiser notes     | No attendee `notes` column or admin control           | Add internal notes with privacy/audit rules    |
| Company search      | Already works in backend but not shown in placeholder | Retain and advertise it                        |
| Job-title search    | Missing                                               | Add                                            |
| Promo-code search   | Missing                                               | Add                                            |
| Search trimming     | Missing                                               | Add                                            |
| Export source/notes | Missing                                               | Add both columns                               |

The SWP working tree was already dirty at the time of inspection. These items are unrelated and must be preserved or reconciled deliberately:

- Modified: `.gitignore`, `README.md`, `package.json`, `pnpm-lock.yaml`
- Deleted locally: five `attached_assets/Screenshot_2026-03-31_*.png` files
- Untracked: `STRIPE_INVOICE_HANDOVER.md`, `audit-config.json`, `scripts/audit-site.mjs`, `scripts/audit-site.test.mjs`

Recheck status immediately before implementation because this list may change. Do not reset, clean or overwrite the SWP working tree.

## 11. SWP implementation sequence

### Phase 0: protect the target

1. Read the current SWP `AGENTS.md` and design guidelines.
2. Record branch, HEAD, remotes and working-tree status.
3. Create a recoverable backup branch before integrating into Replit.
4. Compare corresponding SWP and HRAS files. Do not cherry-pick `d7409a7` wholesale.

### Phase 1: data model

1. Add `transferred` to SWP's `booking_status` enum.
2. Add `bookings.manual_entry`, non-null with default false.
3. Add nullable `attendees.notes`.
4. Add both columns to the startup schema check.
5. Apply and inspect the development schema diff.

### Phase 2: OpenAPI first

1. Add the manual-registration POST operation.
2. Add `ManualRegistrationBody`, `AdminAttendee` and `AdminBookingWithAttendees`.
3. Add `manualEntry` to booking and registration summary schemas.
4. Add `transferred` to all relevant status enums.
5. Add admin-only notes to the attendee update contract.
6. Update the registration-search description.
7. Run the OpenAPI code generator.
8. Review generated changes before touching consuming code.

### Phase 3: server behaviour

1. Add manual creation using SWP's own pricing and order-reference helpers.
2. Add search for job title, promo code and notes, preserving company search.
3. Add transferred to the admin status allow-list and completed display date.
4. Ensure transferred never enters Stripe refund, void or out-of-band payment branches.
5. Exclude manual bookings from confirmation side effects, Needs attention and Stripe unpaid-invoice queries.
6. Add notes to admin attendee formatters and strip them from every public formatter.
7. Add notes to PII masking.
8. Add Entry Source and Attendee Notes to Excel export.

### Phase 4: admin UI

1. Add the manual-delegate dialog using SWP labels and styling.
2. Add manual badges.
3. Add transferred option, badge, filter and confirmation wording.
4. Add attendee notes display/edit controls.
5. Update the search placeholder.
6. Preserve the current SWP responsive layout and all existing admin actions.

### Phase 5: verification

Run at minimum:

```text
pnpm install --frozen-lockfile
pnpm --filter @workspace/api-spec run codegen
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/checkout run build
```

Also test the development schema application with:

```text
pnpm --filter @workspace/db run push
```

Review any schema prompt before approval. Do not use `push-force` as a default.

### Phase 6: Git/Replit release

1. Commit only the intended SWP feature changes plus generated artifacts.
2. Push the implementation branch.
3. In Replit, back up the current release branch/history.
4. Pull/merge while preserving any newer Replit fixes.
5. Confirm the intended commit is an ancestor of the release head.
6. Install with the lockfile, regenerate if necessary, test and build again.
7. Confirm the production schema diff before Publish.
8. Publish only after code, build and schema identities agree.
9. Verify the live site independently; do not treat a green Publish banner as sufficient.

## 12. SWP acceptance checklist

### Manual delegate

- [ ] Admin-only **Add delegate** action is visible.
- [ ] Required fields block incomplete submissions.
- [ ] Email validation works and normalises to lowercase.
- [ ] Exactly one booking and one attendee are created.
- [ ] SWP's current price, discount rules and VAT are used; no HRAS amount is copied.
- [ ] SWP's order-reference format is used.
- [ ] Manual badge appears in list and detail views.
- [ ] There is no Stripe Session, PaymentIntent or invoice ID.
- [ ] No automatic confirmation/welcome/organiser/Sheets side effects run.
- [ ] Manual booking does not appear in Needs attention or Stripe unpaid-invoice widgets.
- [ ] Both `invoiced` and `paid` initial states behave correctly.

### Transferred

- [ ] Status is available in filter and detail control.
- [ ] Confirmation text explains that payment is unchanged.
- [ ] Status update returns `stripeAction = skipped`.
- [ ] Existing payment/invoice IDs remain unchanged.
- [ ] No refund or invoice void call occurs.
- [ ] Audit records the before/after status.
- [ ] Destination event can be saved in attendee notes.
- [ ] Group-booking limitation has been accepted by the product owner.
- [ ] SWP reporting treatment of transferred revenue has been explicitly confirmed.

### Notes and privacy

- [ ] Notes save, edit and clear successfully.
- [ ] Notes enforce the 4,000-character limit.
- [ ] Admin detail includes notes.
- [ ] Public booking/attendee endpoints never return notes.
- [ ] Non-admin updates cannot mutate notes.
- [ ] Audit before/after values are masked.
- [ ] Notes appear in search and Excel export.

### Search and export

- [ ] First name, last name and email still work.
- [ ] Company search works.
- [ ] Job-title search works.
- [ ] Promo-code search works.
- [ ] Booking-reference search works.
- [ ] Notes search works.
- [ ] Matching is case-insensitive.
- [ ] Leading/trailing spaces are ignored.
- [ ] Empty/space-only search does not filter out records.
- [ ] Export shows correct Entry Source and Attendee Notes values.

### Regression and live release

- [ ] Existing SWP card checkout remains unchanged.
- [ ] Existing SWP Stripe invoice checkout remains unchanged.
- [ ] Existing promo codes and group discounts remain unchanged.
- [ ] Existing receipt, email-resend, Community Social and attendee-change features remain intact.
- [ ] SWP branding, colours, event date and venue remain unchanged.
- [ ] Live root and `/api/healthz` return 200.
- [ ] Unauthenticated GET and JSON POST to `/api/admin/registrations` return 401.
- [ ] Live JavaScript contains the new manual, transferred, notes and search markers.
- [ ] Live DOM still shows `SWP Summit 2027`, `Wednesday, 3 March 2027` and `1 Basinghall Avenue, London`.

For an unauthenticated protected POST smoke test, send `Content-Type: application/json` with `{}`. A bodyless request can return 411 before it reaches authentication and is therefore not a valid route-protection check.

## 13. Known limitations and follow-up found during handoff review

### Notes-clear null guard

The published HRAS source has a small edge case in `artifacts/api-server/src/routes/attendees.ts`: the admin PATCH route permits `notes: null`, but its maximum-length validation then reads `notes.length` without first confirming the value is a string. The current HRAS UI sends null when an organiser clears the field.

For the SWP port, implement the length check defensively:

```text
if (typeof notes === "string" && notes.length > 4000) { ... }
```

or normalise the value before validation. Add an integration test that saves a note and then clears it with null. This review item was discovered while preparing the handoff; it was not included in the published `d7409a7` commit and should also be scheduled as a small HRAS follow-up.

### Product limitations to retain or consciously change

- Transfer is booking-level, not attendee-level.
- A manual `invoiced` entry is only a register record; the actual invoice is created and tracked outside this feature.
- Manual entries deliberately do not prove GDPR consent.
- Transferred bookings are excluded from current completed/revenue stats.
- Search continues to use the existing in-memory filtering approach after loading bookings and attendees; it is suitable for the current register scale but is not a full-text search design.

## 14. Definition of done for SWP

The SWP upgrade is complete only when all of the following are true:

1. The feature-gap implementation is committed without overwriting SWP-specific or unrelated changes.
2. OpenAPI and generated clients agree.
3. Database schema changes are present in development and production.
4. All automated checks and both application builds pass.
5. Manual, transferred, notes, search and export acceptance checks pass.
6. Existing checkout, payment, pricing, promo, email and receipt flows regress cleanly.
7. The published release contains the intended commit and feature markers.
8. The live site still identifies itself as the SWP Summit 2027 register with the correct date, venue, branding and pricing.
