# Sponsor workspace and scanner reliability implementation

Date: 4 September 2026. Local source: `codex/reliability-first-lead-scanner` in the isolated sponsor workspace. Includes the preparation redesign checkpoint `f502410`.

## Implemented

- Organiser navigation: Home, Team & passes, Sessions, Event details. Home links directly to incomplete work and separates tasks waiting for the event team. Explicit team/social completion does not require using every staff place. Onsite contacts are editable.
- Separate speaking-slot pages with contextual photos/slides, stable presenter records and retained file links. Drafts save quietly to the server with a device fallback. Submit saves and validates the visible content in one transaction. Editing approved content creates a draft; only explicit submission requests another review. Review and export protect against simultaneous edits.
- Restricted individual event-staff links: Scan and Leads without sponsor management access. Organisers can renew an existing device without changing its identity. Explicit revocation cannot be bypassed by automatic recovery.
- Cached scanner startup with background reconnect, bounded requests, brief confirmations, continuous camera readiness and deliberate-rescan feedback. Newly issued badges receive an online lookup; an offline unknown badge is retained as “Saved for checking”, not falsely confirmed.
- Sponsor/device-scoped pending scans, notes, cache and recovery. Existing IndexedDB queues retain their IDs and owners. Disconnect never deletes pending work. Old-tab upgrade blocking has a clear recovery message.
- Leads combine confirmed, pending and unresolved records immediately. Notes/ratings stay in Leads, save automatically and survive navigation. Server acknowledgement and confirmed cache update together. Older note acknowledgements cannot erase newer edits. Confirmed-only exports remain available with unresolved scans outstanding.
- Pass request history, pending state and admin approval/decline. Approval updates allocations and the VIP cap together, once only. Admin attention links to content reviews, requests, overdue work, storage and email problems.
- The post-merge script now installs dependencies only. API startup only checks the schema; it no longer invokes legacy schema creation, seeding or rebranding routines. No new dependencies or database migrations were added.

## Automated verification

- Formatting of changed application, contract and test sources: passed. Historical unrelated formatting debt was not rewritten.
- Lint: passed.
- Unit/component/integration suite: **27 files, 182 tests passed** (including two regression guards against implicit startup/post-merge database changes).
- Typecheck and full production build: passed.
- Existing non-blocking build warnings remain: Clarkson font references, UI sourcemap warnings, bundle size and an older Browserslist database.
- Tests include actual HTTP routes and an isolated migrated PGlite database for authentication/CSRF, same-device recovery, revoked/foreign devices, scanner-only access, synchronization idempotency, deferred notes, quiet session drafts, presenter preservation, review validation and pass-request idempotency. These are not a claim of physical-device or multi-connection production load testing.

## Browser verification

All browser writes used isolated local sample previews. Every API call was intercepted; no live database, uploaded file, attendee or email was created.

Ten real IndexedDB checks passed on a fresh local origin:

1. An older open scanner tab returns a recovery instruction rather than hanging.
2. A version-one queue upgrade retains scan IDs and sponsor ownership.
3. Renewing the same device retains every pending scan.
4. A different sponsor cannot read the previous sponsor's queue.
5. An old server acknowledgement cannot delete a newer note.
6. Confirmed cache and queue acknowledgement commit together.
7. Rejected unresolved scans remain recoverable.
8. Retry preserves the original scan ID.
9. Disconnect/reconnect does not delete pending work.
10. Visible queued items have the active sponsor/device scope.

Phone-sized Scan and Leads screens were inspected at 390 × 844. A note survived Leads → Scan → Leads without a Save button. Confirmed export controls stayed available with pending scans. The sample deliberately returns a synchronization error to exercise retained local work; it does not demonstrate successful live synchronization.

Organiser browser checks confirmed separate Quickfire and main-stage slots, session text surviving an immediate navigation change, and explicit submission including newly typed visible content. Screenshots are in this folder.

## Release and testing boundaries

Replit Free Mode verified the starting source and existing database constraints, then fast-forwarded to `15240563b1753272b0d50021163c6ea659d601da`. Frozen install, lint, 180 tests, typecheck and full build passed there. The SDK and configured App Storage bucket were available and reported zero objects. Independent preview checks returned health 200 and protected scanner/admin routes 401.

That preview restart exposed pre-existing `runMigrations()` and `seed()` startup calls. Publication was held. A follow-up removes those automatic schema/default-data writes, retaining the read-only schema guard, and adds two regression checks. The legacy routines remain in source for separately approved maintenance, but are no longer imported or called by the server entry point. This follow-up has passed local lint, 182 tests, typecheck and production build; Replit verification must be repeated on its exact commit before publishing.

The release has not yet been published. This document records development verification, not a claim of a live release.

Remaining event-readiness checks: physical iPhone/Android camera, installed PWA/offline reload and poor-signal recovery, a controlled end-to-end sponsor/scanner workflow, large authenticated ZIP download and an App Storage object surviving a deployment restart. Do not use real sponsor email or production changes for those tests without explicit approval.
