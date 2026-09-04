# SWP Summit 2027 lead scanner rollout

## Badge production contract

The badge artwork contains exactly:

1. Attendee name
2. Company
3. QR code

The QR payload is the exact 12-character uppercase hexadecimal value from the `QR Value` column in the badge-production workbook. Do not print that value as text on the badge. The value is only an attendee reference and contains no personal information.

In the QR converter, use:

- black modules on a white background
- high error correction
- a four-module quiet zone
- a printed QR size of at least 25 mm square
- no logo, colour, gradient or decorative overlay inside the QR

Download the ZIP from **Admin > Lead Scanner > Export badge data**. It contains:

- `swp-2027-badge-data.xlsx`, with Name, Company and QR Value
- an `Emergency lead capture` worksheet to print for the fallback kit
- `manifest.json`, including the workbook hash and production requirements
- `README.txt`
- a separate scanner-test value that must never be issued as an attendee badge

## What is saved

The scanner reveals only the attendee's name, job title, company and work email. Phone, dietary, accessibility, billing, payment, booking and agenda data are not placed in the scanner pack. The offline pack does not contain a readable list of badge QR values or a master decryption key. Each random QR value locates and unlocks only its matching encrypted attendee record.

The app first writes every real scan to IndexedDB on the phone. Only after that transaction finishes does it show **Lead saved on this phone**. Sync uses client-generated event IDs, so a retry cannot create the same scan twice. Local records are removed only after the server explicitly accepts or identifies them as duplicates. Rejected records remain in a recovery store for organiser review.

## Release prerequisites

Do not publish the feature or run the production migration until all of the following are true:

- A verified production PostgreSQL restore point exists.
- Its reference has been recorded for `PRODUCTION_BACKUP_REFERENCE` during the approved migration run.
- `BADGE_QR_SECRET` is configured as a new random value of at least 32 characters. It must not reuse `SPONSOR_TOKEN_SECRET` or `ADMIN_TOKEN_SECRET`.
- The exact source revision intended for publication is present in Replit.
- The generated OpenAPI clients, dependency lockfile, production build and full tests match that revision.
- The organiser has configured the correct event end time. Scanning fails closed if it is missing.
- The provisional lead-sharing wording and lawful-basis treatment have completed privacy review.

After separate approval, the versioned migration command is:

```text
NODE_ENV=production PRODUCTION_BACKUP_REFERENCE=<verified-reference> pnpm --filter @workspace/db migrate:lead-scanner
```

The command is repeat-safe and refuses a production run without the backup reference.

## Phone readiness check

Each sponsor operator opens the sponsor's existing private link, selects **Scan badge**, enters their own name and activates that phone. Before event day, every phone must show all six checks complete:

- current attendee pack
- offline storage
- offline save test
- camera permission
- real scanner-test QR
- server sync test

The admin page must show the phone as **Ready**, not **Not tested** or **Out of date**. Re-run this check after changing an attendee, replacing a badge QR or updating the event end time.

## Physical rehearsal

Use synthetic staging attendees and production-style printed and laminated badges. Do not use production email addresses or send real emails.

Required evidence:

- 100 consecutive scans produce 100 correct identities, zero false matches and normal-light recognition within two seconds.
- Recent and older iPhones in Safari, Android Chrome and Samsung Internet pass.
- Low light, glare, laminate, angled badges, damaged print and torch use pass.
- Camera-denied photograph capture and the organiser-only manual QR value path pass.
- A scan saved offline remains after closing and reopening the browser, then syncs exactly once after reconnection.
- Multiple retries during simulated API and database failure produce no lost or duplicate scan events.
- Rotated badges, revoked devices, expired sponsor sessions and cross-sponsor access are rejected.
- 500 attendees, 50 sponsors and 150 authenticated devices sharing one public IP do not trigger the general IP rate limit.
- CSV and Excel exports contain only the correct sponsor's synchronised leads and include ratings, notes, scan times, scanner names and duplicate-scan counts.

## Replit Free Mode verification prompt

Use this only after the approved source revision has been imported into Replit. It is deliberately read-only:

```text
Use Free Mode and inspect only. Do not edit files, change secrets, access or display secret values, mutate the database, restart workflows, migrate or publish. First report the exact Git HEAD and whether the worktree is clean. Verify that this exact revision contains the SWP 2027 lead-scanner migration, startup schema checks, BADGE_QR_SECRET validation, pinned self-hosted scanner dependencies, sponsor-scoped service worker, authenticated per-device rate limiting and badge export contract of Name, Company and QR only with no printed reference. Run the generated-client check, typecheck, lint, all tests and the production build. Report pass/fail evidence and any warnings. Confirm whether the production database still needs migration and whether BADGE_QR_SECRET exists and meets the minimum length using booleans only. Do not reveal values and do not make any change.
```

## Event-day fallback kit

Keep organiser-owned tested spare phones, charged power banks and printed emergency capture sheets at registration. A camera fault must move immediately to Photograph; a damaged sponsor phone must move to a spare device; a complete device failure must move to the paper sheet for organiser entry after the event.

Freeze scanner code 72 hours before doors open. Do not activate a waiting service-worker update on event day unless the organiser has explicitly approved and tested that exact release.
