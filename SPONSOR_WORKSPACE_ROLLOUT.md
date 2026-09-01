# SWP Summit 2027 Sponsor Workspace rollout

This release adds sponsor records, private sponsor workspaces, sponsor promo allocations, staff registrations, session submissions, file management through Replit App Storage, logistics acknowledgements, internal notifications and the daily deadline check.

It is deliberately safe to merge before launch:

- startup checks for the new database shape and stops with a clear error if the approved migration has not been applied;
- creating or confirming a sponsor never sends the sponsor welcome email;
- the deadline job is built but is not scheduled by this change;
- App Storage objects are only served through authenticated API routes;
- no Google Drive or Dropbox file mirror is used.

## Required Replit setup

1. Provision App Storage for the `Register-SWP-2027` Repl before starting preview verification. The app uses the official `@replit/object-storage` JavaScript SDK.
2. Add a dedicated `SPONSOR_TOKEN_SECRET` of at least 32 random characters. Do not reuse the admin password.
3. Keep `SPONSOR_STORAGE_ADAPTER` empty in Replit so the App Storage adapter is selected. `memory` is only for automated or local tests.
4. In preview, set a unique `SPONSOR_STORAGE_PREFIX`, for example `preview/sponsor-workspace-20260901`. Production should use either no prefix or an agreed permanent production prefix.
5. Use intercepted/test SMTP details in preview. Do not use a real sponsor email address for a test sponsor.

App Storage object keys are deterministic and filename-independent:

```text
{SPONSOR_STORAGE_PREFIX}/sponsors/{sponsorId}/{assetId}/{version}
```

The original filename, MIME type, checksum, category, relationship and version are stored in PostgreSQL.

## Database migration approval gate

The additive migration is:

```text
lib/db/migrations/20260901_001_sponsor_workspace.sql
```

Before production migration:

1. Create and verify a production database backup.
2. Record its reference.
3. Obtain explicit action-time approval to migrate production.
4. Run the versioned migration separately from deployment, supplying the backup reference:

```text
pnpm --filter @workspace/db run migrate:sponsors
```

The migration runner refuses a production run unless `PRODUCTION_BACKUP_REFERENCE` is present. It is idempotent and records `20260901_001_sponsor_workspace` in `schema_migrations`.

Do not use `drizzle-kit push --force` for this production change.

## Preview verification

Use a dedicated test sponsor and intercepted email inbox.

1. Apply the migration to the preview database.
2. Create a draft sponsor with a primary contact, explicit pass allocations and deliverables.
3. Confirm the sponsor. Verify the VIP and public codes are created, but no welcome email is sent.
4. Review the live welcome preview, change sponsor data and confirm that a stale preview cannot be sent. Do not send to a real sponsor.
5. Exchange the private link and confirm the token disappears from the visible URL.
6. Rotate access and verify the previous link and active session are revoked.
7. Register, edit/replace and cancel sponsor staff. Confirm the staff place is restored after cancellation, the attendee is included in the Session Scheduler export, and it is excluded from paid Business-pass revenue.
8. Test the private VIP code on Workforce and Business passes, the sponsor-specific maximum per booking, allocation exhaustion, cancellation release and deliberate restoration.
9. Test the public 20% code with a Workforce group booking and confirm the group discount is applied first.
10. Add multiple session entitlements, submit content, request changes, approve and export. Edit approved/exported content and verify the prior export becomes outdated.
11. Upload every allowed file type and test invalid MIME, signature, macro-enabled Office, executable and over-size files.
12. Replace a required logistics document and verify its previous acknowledgement no longer completes the task.
13. Test individual download, selected ZIP, complete sponsor ZIP and the all-sponsor backup batches. Confirm `manifest.csv` contains the current relationships and statuses.
14. Deliberately remove one test object through the App Storage console, run Verify storage, and confirm the file becomes `missing` and appears in Needs attention before a ZIP begins. Also force one test upload failure and confirm the persistent storage-error task remains visible until a later upload succeeds.
15. Restart the preview deployment. Confirm uploaded files still preview/download and a complete sponsor ZIP still succeeds.
16. Check that passive workspace views and downloads are logged without notification email, while material changes create immediate internal notifications.

## Deadline scheduled deployment

The built command is:

```text
pnpm --filter @workspace/api-server run deadline-job
```

After explicit approval, create a separate Replit Scheduled Deployment for a daily 08:00 Europe/London run. Confirm the schedule remains at 08:00 when the UK changes between GMT and BST. The job is idempotent for each London calendar day, marks required due items overdue, records activity and sends internal deadline notifications. Sponsor reminder emails remain manual.

## Final release gate

Before production publication, require explicit approval for each of these actions:

- production database migration;
- production deployment/publication;
- enabling the deadline schedule;
- sending the first real sponsor welcome email.

Immediately after deployment, verify health/schema checks, admin sponsor pages, a protected sponsor route, an authenticated test file download and one complete sponsor ZIP. Do not treat build or deployment success alone as proof that App Storage persisted correctly.

## Developer verification

Run from the repository root:

```text
pnpm --filter @workspace/api-spec run codegen
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run build
```

The migration tests use an isolated in-memory PGlite database. They apply the migration to both a fresh application baseline and an upgraded database with existing registrations, verify the backfill and constraints, and apply the migration twice to prove idempotency. They do not connect to a local, preview or production PostgreSQL database.

Verification completed for this branch on 1 September 2026:

- OpenAPI client and Zod schema generation passed;
- ESLint and TypeScript checks passed;
- 127 automated tests across 18 files passed, including the fresh and upgraded migration scenarios;
- changed source files passed Prettier and `git diff --check`;
- the full production build passed. Its existing non-blocking warnings remain: source-map lookup messages, runtime-hosted font references and the large checkout bundle warning.

The repository-wide `pnpm run format` command still reports unrelated pre-existing formatting drift outside this change. Do not bulk-format those files as part of the sponsor release.
