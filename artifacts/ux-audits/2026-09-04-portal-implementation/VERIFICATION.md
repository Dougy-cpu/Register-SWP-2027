# Sponsor portal usability implementation

Local implementation in `C:/Projects/SWP/Register-sponsor-workspace`, based on `13a471f` on `codex/reliability-first-lead-scanner`. Replit Free Mode independently confirmed the matching branch, commit and clean tracked Replit worktree. No Replit code changes, production writes, deployment, migration, scheduled-job execution or emails were performed.

## Delivered

- Four persistent sections: Home, Team & passes, Sessions, Event details. Home actions open the corresponding form or speaking slot.
- Compact per-slot session cards; one session editor at a time with speaker details, photos and slides together.
- Submit saves currently typed session text first. Revision checks prevent stale edits from overwriting a newer revision. Local session drafts survive section changes, slot changes and refresh, and clear on successful sign-out.
- Presenter updates preserve their database IDs and file relationships. Removing a presenter with active files is blocked.
- Staff form starts with five core fields, with optional preferences collapsed. Registration and replacement require explicit confirmation; existing transactional email and commercial rules remain unchanged.
- Explicit team-list confirmation works without filling the allocation. Social confirmation requires answers for all active staff and supports nobody attending. Both confirmations reopen after roster changes.
- Sponsor-scoped onsite contact creation/update, reusing a primary contact without losing primary status or duplicating their email.
- Actual files, per-session states and document acknowledgements determine preparation status. Items awaiting the event team do not generate sponsor deadline warnings.
- Files are uploaded in context. Additional material can be added without replacing the first file. Session feedback is beside the submit/save controls.

## Automated checks

- Full suite: 23 test files, 167 tests passed, including 26 new portal/component and PostgreSQL persistence tests.
- Repository lint passed.
- Workspace typecheck and full production build passed with the mockup package's required build-only PORT and BASE_PATH values supplied.
- Existing build warnings remain: source maps, unresolved Clarkson font references, large bundle, older Browserslist data.
- Whole-repository formatting check reports pre-existing formatting issues in unrelated files; only files changed for this task were formatted. No broad formatting rewrite was made.
- `git diff --check` passed.

The PostgreSQL tests use an isolated in-memory PGlite database and the existing sponsor migration. They verify stable headshot relationships, cross-sponsor ownership rejection, contact reuse, idempotent partial-allocation confirmation and reopening confirmations. Frontend tests block live network calls.

## Browser verification

The actual frontend runs at `http://127.0.0.1:4174/sponsor` with a local in-memory API and fictional sample data. No backend service, email integration, storage bucket or production database is connected. The preview deliberately does not store uploads; upload validation and relationship handling are exercised in isolated automated tests.

Desktop and 390-pixel phone layouts were inspected. The phone viewport had 375 usable content pixels after its scrollbar; document width matched the viewport with no horizontal overflow, and the navigation measured 52 pixels high. A session draft was edited, left, reopened with the typed text intact and submitted directly. Multiple speaking slots remain separate. The main-contact shortcut and the no-one-attending Social flow were also completed against sample data. Browser error/warning logs were empty. Final screenshots are saved alongside this note.

Run the sample preview with `node artifacts/checkout/preview-sponsor-portal.mjs`. Stop/restart resets its fictional records.

## Release boundary

Changes remain local and uncommitted. No schema migration or new dependency is required. Before a production release, use an approved Replit preview rollout to verify authenticated API requests, actual App Storage uploads and the email-interception workflow against the deployment environment. The local sample preview is a UX review environment, not evidence of a live release.
