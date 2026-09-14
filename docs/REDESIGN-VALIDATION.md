# Cardbills redesign and backup-only release

The application uses a light canvas, grouped top navigation, a secondary section bar, and modal record drawers. The bottom transaction save bar retains staged selections across navigation. Authentication, tables, forms, and settings share the same local system-font styling.

Supabase settings expose a separate Sheets-only activation action. It sets daily backups and disables Calendar synchronization without modifying Calendar events. Backup network work runs outside the financial save queue; a short database commit merges only backup metadata into the latest workspace version. Failed backups retain the previous successful timestamp and database version. The combined integration API remains available for compatibility.

Validation on 2026-09-14:

- 75 Node tests passed, including backup-only activation, daily scheduling, disabled Calendar synchronization, and failed-backup metadata isolation.
- Source syntax, RPC allowlists, asset references, and source-package checks passed.
- Wrangler deployment dry run passed with no production changes.
- Synthetic browser checks passed at desktop 1440px, tablet 820px, and mobile 390px: authentication form, section navigation, horizontal table containment, record drawer dismissal and focus return, import dialog, and Supabase backup settings.

Browser checks can run with `node tools/browser-check.mjs PATH_TO_PLAYWRIGHT_PACKAGE_JSON` and an optional `BROWSER_EXECUTABLE`. Screenshots and fixtures remain in the operating system's temporary directory.

Deployment and database activation remain separate operations. A passing source release does not certify that the private import, live cutover, or initial backup has completed. Keep migration snapshots, SQL containing private records, and Google credentials outside this repository. After any new Supabase writes, reconcile a fresh Supabase export before a rollback to Sheets.
