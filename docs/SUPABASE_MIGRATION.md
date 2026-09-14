# Supabase financial backend

Release: `supabase-20260913-1`.

GitHub supplies application code. Cloudflare hosts the existing authenticated website and a private Durable Object that executes financial operations. Supabase PostgreSQL stores the ledger. Google Sheets is a one-way backup destination. Google Calendar synchronization uses the Google APIs directly.

## Installation and cutover

1. Save current changes, close other application tabs, and stop the previous Apps Script scheduled and spreadsheet-edit automation. Retain the Sheet and the existing deployment as a rollback snapshot. The source snapshot used for import must represent the final Sheet state.
2. In the intended Supabase project's SQL Editor, run the private `01_Install_And_Import.sql` supplied with the migration kit. It installs `bb_workspaces`, `bb_records`, `bb_mutations`, their access controls, and the current exported records. The import resolves the existing confirmed user by email. It refuses an already populated destination, checks the payload digest, compares record counts and signed transaction totals, checks record references, and sets the workspace to `READY` after verification. The schema installation and financial import are separate transactions. Existing `cardbills_*` authentication and `billsbills_*` staging objects are retained.
3. Verify `READY` and the returned entity counts. Keep the import file private; it contains financial records. Further Sheet changes after the exported snapshot need a fresh export before cutover.
4. Confirm the new Cloudflare build succeeded. Add a runtime Text variable `DATA_BACKEND` with value `supabase`, then Deploy. The existing owner settings, Supabase keys, session key, login, and authenticator enrollment stay in place. An unset value or `sheets` continues using the original backend; failed database requests in Supabase mode do not fall back to Sheets.
5. Sign in and open Settings and Integration. Confirm `Supabase` and `supabase-20260913-1` in Database and backups. Check account/card nicknames, transaction counts, classifications, statement balances and totals. Save a classification, refresh, and confirm persistence. Test a payment only with an actual confirmed payment amount and date.
6. After successful cutover, archive the Apps Script web-app deployment. Keep its source and pre-migration Sheet copy for recovery. Routine application changes now deploy from GitHub without editing Apps Script files.

## Google Calendar and Sheet backups

The existing Google permissions belong to Apps Script and do not transfer to Cloudflare. This integration uses a dedicated Google service account.

1. In Google Cloud, select a project and enable Google Sheets API and Google Calendar API. Create a service account for BillsBills and a JSON key. Cloud project administrator permissions are not needed on that service account for shared Sheet/calendar access.
2. Share the backup Sheet with the service account's `client_email` as Editor. Share the intended Google Calendar with the same address and allow changes to events. Keep these shares restricted; public sharing is unnecessary.
3. In Cloudflare runtime secrets, create `GOOGLE_SERVICE_ACCOUNT_JSON` containing the JSON key, then Deploy. Store the key privately outside GitHub.
4. Confirm old Apps Script automation has stopped. In BillsBills, choose Settings and Integration > Enable Calendar and Sheet backups. The existing configured calendar is used; when blank, the application owner's email is selected. This enables historical synchronization for current open statements, saved backup preferences, and the Cloudflare scheduled job. Then choose Synchronize all statements to complete initial linking. Create private backup writes the current database copy to the existing Sheet.
5. Inspect the selected calendar, last backup, and synchronization results. Existing exact statement markers are adopted and event IDs retained. Historical notifications are silent. Confirmed settled statements keep events with future reminders disabled. Synchronization runs in bounded batches every 15 minutes when enabled; backup frequency follows BackupDays.

Until Google credentials and permissions are configured, the existing Sheet is the preserved pre-migration backup, and existing Calendar events remain in Google. New automatic copies and event updates are not active.

## Storage and security

The existing password, MFA, owner check, same-origin checks, secure session cookie and rate limits remain in the Worker. Financial reads use the user JWT and owner plus `aal2` Row Level Security. Client database writes are denied. The private engine validates financial relationships and submits a server-only commit that checks the current app session, workspace version, original row values and request identity. Related changes and audit entries commit in one PostgreSQL transaction. A conflicting write fails rather than overwriting a newer version. Retrying an unchanged operation ID returns its prior result.

The private Durable Object serializes writes and gives the reused validation engine a suitable CPU budget. No financial records are written to its durable storage. Ledger snapshots and caches are in memory only. SQL records preserve original IDs, minor-unit amounts, row metadata and technical links. Backup writes use literal typed values, not evaluated spreadsheet formulas.

## Responsiveness

An authenticated bootstrap fetches a ledger snapshot. For two minutes, supported filtering, sorting and pagination run in browser memory. Explicit refresh reloads the authoritative data. Dropdown edits remain local until the shared bottom Save changes action. Successful classification saves update the displayed and cached rows without another bootstrap. Other writes invalidate the browser snapshot. Database reads omit completed operation payloads, baseline snapshots and full audit history unless the requested operation needs them. Login/session verification still uses Supabase and remains part of live request latency.

## Independent backups and rollback

Use Download database backup for a private JSON copy. Preserve separate dated backups rather than relying only on the rolling Sheet copy. After new database writes, do not switch back to an older Sheet; export and reconcile the latest database state first. Leaving the old backend configured is a pre-cutover rollback option, not a two-way synchronization system.

## Development and verification

Run `npm test` and `npm run check`. Wrangler also invokes `node tools/build.mjs` before deploying. The build statically scopes the versioned financial modules per request and emits the runtime; it uses no dynamic evaluation. The original Apps Script files are retained solely for rollback. Public source contains no imported financial records. Generate a private install/import file with `node tools/prepare-import.mjs PRIVATE_SNAPSHOT.json PRIVATE_INSTALL.sql` after validating a fresh snapshot.

Local unit tests and browser checks use synthetic data and mocked services. The migration kit's source-data validation reads the exported Sheet locally. Live SQL installation, RLS behavior, Cloudflare CPU/latency, payment persistence and Google synchronization must be verified after owner-side activation. Do not equate mocked tests or a successful build with completed live migration.
