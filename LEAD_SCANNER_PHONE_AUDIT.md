# SWP Summit 2027: phone scanner reliability audit

Audit date: 10 September 2026. Event: Wednesday, 3 March 2027, 1 Basinghall Avenue, London.

## Release status

The fixes are local, on `codex/mobile-scanner-lifecycle`, based on the requested commit `1a3c9fd449f3aa0e9fc405a10bd29bfce2866cfa`. This audit covers the shared camera lifecycle, public rehearsal, real scan capture, offline storage and sync, notes, duplicate handling, access recovery, and existing PWA update policy. No push, deployment, migration, secret change, dependency addition or email sending is included.

Automated and local browser checks provide substantial evidence, but they do not establish that every physical camera or installed PWA will behave correctly. The device matrix below is a release requirement. No physical iPhone, Android handset, installed mobile PWA, venue connection or production sponsor account was exercised in this audit.

## Confirmed faults and corrections

| Fault reproduced or identified                                                                                                                                                        | Correction and evidence                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| After a successful public test scan, the result screen unmounted the video. The next-scan handler returned on its missing video ref before clearing the result.                       | A regression failed with one scanner start instead of two. Starting now requests a fresh session and waits for React to mount a visible video within a fixed deadline.                                                                                                                                   |
| `qr-scanner` 1.4.2 owns the video passed to its constructor and has delayed stop cleanup. Reusing that video across an old and new instance risks stopping the new stream.            | Each attempt owns a fresh, keyed video. Cancellation invalidates callbacks first, then destroys the decoder, removes its overlay and stops owned tracks. Deferred permission and delayed-stop tests pass.                                                                                                |
| A resolved start promise did not prove that usable camera frames existed. Missing refs, hidden views, permission delays and stopped pictures could leave a blank camera indefinitely. | A 12-second startup deadline includes layout and frame readiness. Active status requires live, enabled, unmuted tracks and usable video dimensions/readiness. Ended/error events fail immediately; stalled or unhealthy pictures fail within eight seconds while the page is running. Retry is explicit. |
| Backgrounding and orientation changes had no clear recovery policy.                                                                                                                   | Hiding the page or leaving it releases the camera and shows Resume camera. Intrinsic video dimension changes request refocusing. No automatic restart loop. The phone role is independent of viewport width, so rotation does not replace the rehearsal or its notes.                                    |
| The decoder masks several permission/device/busy failures as the string “Camera not found.”                                                                                           | Recovery copy covers permission settings, another app holding the camera, alternative cameras and badge photos. It does not misdiagnose every such failure as absent hardware. Verified with the actual decoder in Chromium.                                                                             |
| An in-flight real badge lookup could queue a scan after the operator stopped the camera.                                                                                              | The added regression failed before the fix. Capture generation and camera-session checks now run after asynchronous work and before queuing. Lookup, pack decryption and queue ownership remain pinned to the credential that began the scan.                                                            |
| Photo controls could become available before capture finished; cancellation was not reachable in the active scanner view.                                                             | The shared photo reader stays busy through the caller's save operation. Its ten-second image-decoding watchdog ends when decoding succeeds. Cancellation invalidates pending capture before a later lookup can queue it. Regression tests cover both behaviours.                                         |
| A failed readiness update after the organiser's test QR intentionally stopped the camera could be hidden by the stale-session guard.                                                  | Intentional test completion is distinguished from operator cancellation. Readiness failure is visible and retryable without creating a lead.                                                                                                                                                             |
| Offline feedback depended on some other state change; a previous success notice could overlap a later storage failure.                                                                | Connectivity events update the banner immediately. A new capture clears old confirmation, and storage failure clears success feedback and permits a retry.                                                                                                                                               |
| Five rating targets were tight on small phones.                                                                                                                                       | The shared rating fields retain 44-pixel minimum width and 48-pixel height, with narrower spacing at small widths. Notes use 16-pixel text and preserve the existing 4,000-character limit.                                                                                                              |

Stopping or cancelling prevents a lookup that has not yet reached the queue from adding a lead. An IndexedDB transaction already started must finish atomically; its durable record is retained even if the operator then stops or leaves. Success feedback is only shown after local persistence, and never from a retired camera session.

## Phone and desktop journeys

- A desktop opening `/scanner-test` receives the test-badge display. It has the full selectable `https://register.swpsummit.com/scanner-test` URL, a prominent Copy link button and “Copy this link and paste it into your phone browser.” There is no desktop scanner-start or test-device CTA.
- Four fictional, simple 21-module QR codes remain available with four-module quiet zones. Screen codes are up to 360 pixels wide; print codes are 50 mm. They need physical distance and print-quality checks, not just successful decoding at a desk.
- iPhone and Android Mobile user agents receive the phone rehearsal. Desktop and tablet user agents receive handoff content. This is a product-role guard, not authentication. Request Desktop Website and unusual embedded browsers should be checked in the device rehearsal; supported instructions should direct people to Safari or Chrome in normal mobile mode.
- A rehearsal scan shows the fictional person, a rating and notes, a clear rehearsal-only saved status, and Scan another test badge. Repeating a badge restores its existing note/rating without adding a duplicate. Reset, reload, close or unmount discards the rehearsal's React memory.
- The public rehearsal has no lead API, browser-storage or persistence imports. Browser checks trap fetch, XHR, beacons, IndexedDB and Storage writes and detect zero such operations. Photo decoding happens in the browser. Its synthetic records never enter real leads, reporting or exports.
- The real scanner keeps continuous scanning, local persistence, existing duplicate handling, queued/rejected recovery and the Leads page. Real rating and note persistence stays in its existing caller; only the field presentation is shared with rehearsal.

## Storage, sync and PWA audit

The existing encrypted attendee pack, owner-scoped IndexedDB, persist-before-confirmation contract, idempotent scan IDs, rejected-item retention and annotation acknowledgement checks remain in place. Native Chromium IndexedDB checks exercised a blocked database upgrade, legacy-data preservation, device credential renewal, sponsor isolation, stale note acknowledgements, atomic queue acknowledgement, rejected-item retry, simulated disconnect/reconnect and ownership changes during capture.

A mocked sync transport then failed a request, retained the original queued scan ID, recovered on retry and acknowledged it. The browser was actually reloaded and separately verified the scanner credential, unsynced scan, latest rating/note and confirmed lead cache. This proves native local persistence and the mocked transport contract, not a production server round trip.

Residual storage limits: browser/OS storage eviction, private browsing and a browser-level IndexedDB stall are not eliminated by this change. The existing storage layer has no general transaction watchdog; an unresolved write must not be reported as saved or retried concurrently with a new ID. The new camera and photo-decoding deadlines do not certify bounded storage writes. Test storage failure and device reopening during the physical rehearsal, and preserve the phone if a save remains unresolved. Reliable event operation also requires the prepared spare device and end-of-day reconciliation described below.

The PWA still uses sponsor-scoped static caching and an explicit update prompt. It does not cache API responses, force a waiting worker to activate, or reload a running scanner. The QR decoder worker is included in the production precache. Foreground online/visibility events and a 15-second interval trigger retries; there is no promise of background sync while a phone app is closed. Sponsor pages must be prepared online before an offline cold open. The public rehearsal is not a separately installed offline PWA.

Replit Free Mode supplied a read-only review of the matching base checkout, runtime and logs. It confirmed the public video-ref failure and absence of explicit camera background handling; it did not edit, pull, push or deploy. Its console showed a separate workflow port-8080 collision; the managed API was running. This observation is not evidence of a scanner camera failure, nor verification of the locally changed build in Replit. Power Mode and Max Mode were not used.

## Validation record

| Check                                         | Result                                                                                                                                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile`              | Passed. On Windows, Git's `bin` directory was added to the process PATH so the existing `sh` preinstall could run. Lockfile unchanged.                                                                                                                 |
| `pnpm run lint`                               | Passed.                                                                                                                                                                                                                                                |
| `pnpm run typecheck`                          | Passed across the workspace.                                                                                                                                                                                                                           |
| Focused scanner tests                         | 77 tests across 11 files passed, including API/server scanner tests.                                                                                                                                                                                   |
| `pnpm run test`                               | 277 tests across 40 files passed.                                                                                                                                                                                                                      |
| `pnpm --filter @workspace/checkout run build` | Passed with `PORT=5000`, `BASE_PATH=/`.                                                                                                                                                                                                                |
| `pnpm run build`                              | Passed with the same environment. Includes all workspace builds and type checks.                                                                                                                                                                       |
| Real decoder browser rehearsal                | 18 assertions passed using actual `qr-scanner` and a real canvas media stream. Four badges, repeat notes/rating, invalid URL, pause/resume, denied permission, stopped tracks, compact QR, local photo decode and no persistence/network side effects. |
| Native IndexedDB browser audit                | 16 assertions passed before reload and four after an actual reload. Sync responses were mocked.                                                                                                                                                        |
| Responsive visual review                      | Phone result controls inspected at 320 × 568, 390 × 844 and landscape 844 × 390; desktop handoff also inspected. No page horizontal overflow.                                                                                                          |
| Production artifact review                    | Development audit entry points excluded; QR worker present in the static precache.                                                                                                                                                                     |

Non-fatal build warnings concern existing Clarkson font URLs, source-map reporting in UI components, bundle size and an older Browserslist dataset. The application uses Figtree for the scanner. No dependency update was made to suppress these warnings. A pre-existing Windows-only crawler test compared CRLF static files to LF strings; the two assertions now normalise line endings without changing crawler content or policy.

### Re-run the local browser evidence

Run the checkout development server on localhost, then open:

1. `/scanner-rehearsal.audit.html`: select Run browser rehearsal. The runner uses the actual QR decoder with a synthetic camera and traps all data writes/network calls. It replaces the displayed address with `/scanner-test`; reopen the audit HTML explicitly to start a new run.
2. `/scanner-storage.audit.html`: use a fresh localhost origin for all 16 checks, then select Run storage and sync audit. Reload the browser and select Verify saved state after reload. It uses synthetic data in this local origin and mocks all sync requests. Reusing an already-upgraded audit database skips the two legacy-upgrade checks.

Both runners require development mode and a localhost origin. They are separate development entry points and are excluded from the production application bundle. Do not run storage tests against a production origin or a browser profile containing real scanner data.

## Physical device acceptance matrix

All rows are **not yet run**. Record the actual model, OS, browser version, installed/not-installed state, tested commit, tester, date and result. Use an approved HTTPS build and the badge stock/printer intended for the event.

| Device class                    | Browser              | Installed PWA | Required coverage                                                        |
| ------------------------------- | -------------------- | ------------- | ------------------------------------------------------------------------ |
| Current iPhone                  | Safari               | No            | Every camera, rehearsal, real capture and interruption check below       |
| Current iPhone                  | Safari-installed app | Yes           | All checks, especially permission, lock/resume and offline cold open     |
| Older supported iPhone          | Safari               | No and Yes    | All checks; small screen, keyboard, memory and longer scan session       |
| Current Android phone           | Chrome               | No            | All checks; lens selection, focus and torch                              |
| Current Android phone           | Chrome-installed app | Yes           | All checks; offline reopen and update handling                           |
| Older/lower-power Android phone | Chrome               | No and Yes    | All checks; sustained performance, low light and stalled-stream recovery |

### Checks for each device

1. **Handoff and permissions:** copy the full link on a computer; open it in the phone browser. Check initial permission allow, deny, change permission in Settings, retry and a camera held by another app. Fail if any startup remains blank or indefinitely busy; it must become ready or show an actionable error within 12 seconds while the page is active.
2. **Optics:** scan all four test badges from the screen and printed sheet. Measure 25, 50, 75 and 100 cm in normal light, dim light and glare. Record the farthest consistently usable distance; no particular physical distance is certified by this audit. Check rear/front and each available rear lens, portrait/landscape, and torch on/off. Include a damaged/creased badge and the badge-photo fallback.
3. **Repeated use and notes:** perform at least ten successive scans, including immediate and later repeats. Set, change and clear ratings; type and edit notes, open the keyboard and rotate. Verify repeats preserve notes and count once. Verify Reset and reload clear rehearsal data. Check recovery from an unrelated QR and a URL QR.
4. **Interruptions:** rapidly tap start/stop, switch cameras, switch apps for 30 seconds and lock for 60 seconds. Return and explicitly Resume camera. No retired stream may resume, no stale badge may appear and the phone camera indicator must turn off after Stop or leaving the page. Scan after opening and cancelling the photo picker.
5. **Real lead path:** with an approved test sponsor and synthetic attendee badges, complete the six readiness checks. Scan online, confirm exactly one lead, add rating/notes, revisit Leads and scan again. Confirm genuine saved versus queued versus rejected feedback. Attempt a slow lookup and stop/cancel before it completes; no new capture should be queued from that lookup.
6. **Network loss and reopening:** prepare the current attendee pack online, then enable airplane mode. Scan known and unknown badges, edit notes, close/reopen the installed app and confirm saved records. Reconnect with the app foregrounded; verify original IDs, no duplicates, exact notes/rating and an empty pending queue only after server acknowledgement. Test deferred and rejected recovery plus a renewed device link. Never clear storage to fix a phone holding unsynced leads.
7. **PWA release handling:** prepare the production assets, verify an offline cold open, then test a controlled update between two approved builds. The update must not reload active scanning or discard queued work. Reopen intentionally and confirm the expected version and retained leads.
8. **Sustained session:** run 50–100 scans over at least 15 minutes on the older phones. Include duplicate scans, low battery and a warm device. Record time to readiness, recognition time and any failures. Check camera indicators after stopping. Do not substitute desktop simulated frames for this check.

Release acceptance: every device/mode row passes, no unresolved lost/duplicate/cross-sponsor records, no permanent black screen, the approved deployed commit is known, and the organiser verifies final counts against server leads/export. Review any failure before expanding access.

### Event-day operating preparation

Prepare each named operator's phone online before doors open, complete all six real scanner readiness checks, and rehearse on printed badges. Keep a charged, prepared spare phone and charging leads. Confirm the venue's Wi-Fi/mobile coverage and the offline process. Assign an organiser to check rejected/pending items and reconcile counts at the end of the day. Keep phones open while final sync completes; preserve any unresolved queue and use the existing organiser recovery export. Do not clear a phone, revoke it or replace its browser profile while it contains unsynced work.

## Proposed next change: “Email me the test link”

No button, sending endpoint or email has been added. The current authenticated sponsor session (`artifacts/api-server/src/middleware/sponsor-auth.ts`) identifies a sponsor with `sponsorId`, `accessVersion` and `csrfToken`; it does not identify the individual viewing the page. The scanner's operator name is not a verified email identity. The existing welcome-email code may email primary contacts or an attendee's `workEmail`, neither of which establishes who “me” is.

The next scoped implementation should first establish a verified contact identity in the authenticated session. The exact recipient source must then be `sponsorContactsTable.email`, selected by both the verified `contactId` and the session's `sponsorId`, with a valid active sponsor session. Do not take an arbitrary recipient from the request, infer the recipient from the first primary contact, or treat possession of the public test link as permission to send mail.

Proposed flow:

- In the authenticated sponsor workspace, show **Email me the test link** and the verified recipient address. Keep desktop QR badges and Copy link usable independently.
- Use a CSRF-protected `POST /api/sponsor/scanner/test-link` with a fixed template and fixed public test URL. Reuse the existing mail transport/logging only after recipient validation.
- Add persistent limits shared across app instances: initially one request per minute and three per hour per verified contact, ten per day per sponsor, plus an IP backstop. Use an idempotency key/dedupe window, `429` with `Retry-After`, and disable repeated clicks while a request is pending. Confirm these proposed limits before rollout.
- Keep the feature off until its separate approval and verification. Return success only when the mail service accepts the message; surface a failure with Copy link available. Audit attempts without recording scanner tokens. The message includes only the public test URL, no activation credential or attendee data.

Proposed email subject: **Your SWP Summit scanner test link**

Proposed body:

> Hi {verified first name},
>
> Open this link in Safari or Chrome on your phone to try the SWP Summit scanner:
>
> https://register.swpsummit.com/scanner-test
>
> Keep the test badges open on your computer for your phone to scan. You can practise adding ratings and notes; everything in the rehearsal is fictional and disappears when you reset or close it.
>
> This is a practice link. Use your personal scanner link for real leads on the day.

Next-change tests: unauthenticated access rejected; CSRF checked; wrong/cross-sponsor contact rejected; changed contact email revalidated; disabled feature sends nothing; repeated clicks/idempotency and multi-instance rate limits; mail-service failure produces no false success; exact recipient/template/link; mobile/desktop roles preserved; public rehearsal still performs zero lead or storage writes. Use mocked mail delivery until explicitly approved for a controlled test. Douglas sends any correspondence himself.

## Changed source areas

- Camera ownership and rendering: `src/lib/badge-camera.ts`, `src/hooks/use-badge-camera.ts`, `src/components/badge-camera-view.tsx`.
- Photo fallback and capture cancellation: `src/hooks/use-badge-photo.ts`, `src/pages/sponsor/scanner.tsx`.
- Phone-only role, desktop handoff and rehearsal: `src/lib/scanner-device.ts`, `src/components/phone-scanner-link.tsx`, `src/pages/scanner-test.tsx`, `src/pages/scanner-test-badges.tsx`.
- Shared rating/notes presentation: `src/components/lead-annotation-fields.tsx`, `src/pages/sponsor/leads.tsx`.
- Original-credential capture ownership: `src/lib/scanner-api.ts`, `src/lib/scanner-storage.ts`.
- Regression coverage: camera, device-role, photo, public rehearsal, live scanner and PWA tests, the scanner contract assertion, and `src/test/badge-camera-mock.ts`.
- Repeatable local browser evidence: `scanner-rehearsal.audit.html`, `scanner-storage.audit.html`, `src/dev/scanner-rehearsal-audit.tsx`, `src/dev/scanner-storage-check.ts`.
- Windows test portability: `src/crawler-responses.test.ts`.

Source paths in this section are relative to `artifacts/checkout/`. This document is the audit and physical-rehearsal handoff. Payment calculations, booking behaviour, event data and database schema are unchanged.
