# Replit Import Instructions

Use this folder as a complete project update package.

## Before uploading

1. Confirm you have a backup of the current working Replit project.
   - A GitHub backup is fine.
   - If unsure, download the current Replit project as a zip first.
2. Do not upload `node_modules`, `.git`, `.local`, `.config`, `.agents`, or `*.tsbuildinfo`.
   - They are intentionally excluded from this package.
3. Treat `.replit` as sensitive.
   - This package includes `.replit` because the current task is to restore deleted Replit environment values.
   - Do not share this package publicly.
   - Do not commit `.replit` to GitHub.

## What to upload

Drag and drop the full contents of this `codex updates` folder into the root of the working Replit project.

That means upload these root items together:

- `artifacts`
- `attached_assets`
- `lib`
- `mockups`
- `scripts`
- `.env.example`
- `.gitignore`
- `.npmrc`
- `.prettierignore`
- `.prettierrc`
- `.replit`
- `.replitignore`
- `eslint.config.mjs`
- `package.json`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`
- `README.md`
- `replit.md`
- `tsconfig.base.json`
- `tsconfig.json`
- `vitest.config.ts`
- `REPLIT_IMPORT_INSTRUCTIONS.md`

When Replit asks whether to overwrite existing files, choose overwrite.

## Restoring deleted secrets

If secrets were deleted from the working Replit project, this update package includes `.replit` at the package root.

Upload `.replit` to the root of the affected Replit project if you want to restore the previous file-based Replit environment config.

A backup copy also exists outside the update package:

```text
C:\Users\dougl\OneDrive\Documents\New project 2\RESTORE_REPLIT_SECRETS_ONLY\.replit
```

These files contain the previously available Replit `[userenv.shared]` values. Do not share them publicly and do not commit them to GitHub.

Restore by either:

1. Uploading `.replit` to the root of the affected Replit project.
2. Or manually copying the values from its `[userenv.shared]` section back into Replit's Secrets/Environment panel.

After restoring, restart the workflows.

## Important README fixes included

These fixes from the README handoff section are already included:

- `artifacts/api-server/package.json` uses direct `node` commands for `dev`.
- `artifacts/checkout/vite.config.ts` includes the workspace root in `server.fs.allow`.
- `artifacts/checkout/src/pages/checkout/Step1Lead.tsx` preserves caught errors with `{ cause: error }`.
- `scripts/push-branch.sh` supports `--allow-dirty`.
- `README.md` includes Fix 007 for Replit environment reset recovery.

## If Replit says pnpm is missing

If any workflow shows this:

```bash
bash: pnpm: command not found
```

Do not edit project files. Reinstall the Node.js 24 module through Replit's package/module system first. That restores Node and pnpm together.

After Node/pnpm are restored, run this from the workspace root:

```bash
pnpm install
```

This restores `node_modules`, including workspace symlinks such as `@workspace/api-client-react`.

## After uploading

In the Replit shell, run:

```bash
pnpm install
pnpm run typecheck
pnpm run lint
pnpm run format
pnpm run test
```

Then restart the Replit workflows.

## Smoke test

Before using the working booking page publicly, test:

1. Step 1 saves lead details and continues to Step 2.
2. Save and return works on Step 1.
3. Step 2 saves pass selection and continues to Step 3.
4. Step 3 saves attendees and continues to Step 4.
5. Step 4 invoice layout shows the redesigned billing sections.
6. Step 4 card selection still redirects to Stripe.
7. Step 4 invoice selection only creates the invoice when the final button is pressed.
8. Save and return on Step 4 saves progress but does not create an invoice or Stripe payment.

## Local previews included

- `mockups/step2-actions-preview.html` shows the cleaned-up Step 2 action footer.
- `mockups/step4-payment-redesign.html` shows the redesigned Step 4 invoice/payment layout.
