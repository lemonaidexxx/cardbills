# Apps Script retirement

With `DATA_BACKEND=supabase`, Cloudflare handles authentication, request routing, financial validation, classification, balances, imports, reports, and persistence through the Supabase database. Google Sheets is used only by manual and scheduled backup operations. A Google outage never switches financial reads or writes back to Apps Script.

The Cloudflare scheduled trigger checks daily backup eligibility. Its dedicated service account requests only the Sheets scope. No Apps Script deployment or trigger is required for that backup.

After the private import, live cutover, and initial backup have all been verified, the owner can retire these items in the Apps Script project:

- Its web-app deployments serving the legacy application bridge.
- Its time-driven synchronization and backup triggers (confirmed stopped during migration).
- Its bound-sheet custom menu and editor entry points, if they are no longer needed.
- The Apps Script project itself, after preserving its source and configuration privately if desired.

Keep the Google Sheet, its existing Calendar events, the dedicated backup service account, and Cloudflare's scheduled trigger. Cloudflare's `APPS_SCRIPT_URL` and `BRIDGE_SECRET` become unused in Supabase mode; remove them only after the rollback window is closed. After new Supabase writes, export and reconcile the latest database state before any return to Sheets.

Do not delete the repository's `.gs` source modules just because the deployed Apps Script project is retired. The build currently compiles their financial rules into the isolated Cloudflare domain module. This reuses validated calculations without calling the Apps Script service.
