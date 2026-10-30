# Approved booking and welcome emails

The 30 October 2026 design uses the SWP Summit and People Strategy Hub logos in the header, the PSH footer, a compact booking summary, a clear next action, and a complete plain-text alternative. Booking, tax, payment, attendee and delivery-trigger logic is unchanged.

## Release boundary

This release is prepared for publication; it does not activate itself against existing saved templates. Publication and the two production template updates require Douglas's action-time approval. Do not send or resend any emails to validate it.

1. Verify the reviewed commit, install with the lockfile, and build. The source tree used for development matched Replit HEAD `5ab1fdeaf3291cf85b2e6c3d519326cacb03e7f9` and receipt commit `9530a964c1a2af73891318fb6c0935492586b7be` (`7a2237a79ca883632719eae689306eed9c7ea1e0`).
2. Publish the new code first and verify health. Existing templates still render through their existing path at this stage. Do not install new template bodies while old code is serving.
3. In an authorised environment connected to the **production** database, run `pnpm --filter @workspace/api-server email-template-upgrade` for the read-only comparison. Do not assume the development workspace's `DATABASE_URL` is production.
4. With publication/template-update approval, run the same command with `--apply --backup /private/persistent/path/email-templates-before-redesign.json`. Keep the backup outside Git and download a copy. The command checks the exact two reviewed bodies and subjects, saves both original rows, and updates both transactionally. Concurrent or unreviewed edits abort the update. It is safe to repeat after success. No schema change or message delivery occurs.
5. Read back the two records and use the authenticated admin preview, including its phone view. Verify all three displayed logos, payment/invoice variants, live placeholders and plain-text content. Keep preview links inactive. Never use Test Send for this verification.

Rollback order: restore the two backed-up template bodies and subjects first, verifying there have been no subsequent admin edits; then roll back code if necessary. Other templates are untouched. The seed path only supplies the approved defaults when records are absent.

## Implementation and checks

- `src/assets/email/`: editable template bodies, email-safe frame and the original 9,000-byte PSH PNG. SWP reuses the 18,635-byte receipt asset. Both display at 84 × 84. One PSH MIME part is reused for header and footer.
- `src/lib/approved-email-design.ts`: escaped booking data, conditional copy, presentation tables, image parts, browser preview and text rendering. The optional upgrade command is separate from startup and scheduled jobs.
- Existing custom templates retain their legacy renderer. Admin previews and test composition use the same approved renderer when the layout marker is present. Source editing protects the layout from the basic visual editor's lossy HTML conversion.
- Tests intercept delivery: exact MIME image bytes, receipts preserved, no PDFs in individual welcomes, discounts, invoice deadlines/PO/payment/billing help, complimentary/staff wording, missing PDFs, TBC privacy, safe interpolation, custom templates, resends, reissues, and admin editing.
- Local rendering: confirmation 19,041 HTML bytes; welcome 18,358; invoice example 22,413. PNG payload 27,635 bytes. Desktop and 390px phone checks showed three loaded 84px logos and no horizontal overflow. This is not an assertion of a live Gmail/Outlook delivery test.
- Full build uses `PORT=5000 BASE_PATH=/`. Existing checkout font/source-map/chunk warnings remain. Repository-wide formatting reports 329 pre-existing files; changed files pass formatting. Do not bulk-format unrelated files.

No dependency, schema, payment calculation, SMTP credential, sender identity or sending schedule changes are included.
