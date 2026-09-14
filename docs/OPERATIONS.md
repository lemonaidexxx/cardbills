# Operations

## Routine work

Use Transactions for tags, notes, activity classification and assigning shares. Cards and Accounts manages names, account grouping, primary/supplementary relationships and archives. Statements records official bills and due dates. Bank Payments and Payment Allocations track payments to the bank. Money Owed, People and Repayments track personal collections. Review identifies missing fields, unknown activity types, suspected duplicates and validation problems.

Before sharing a collections report, preview the selected person and fields. Exported reports are snapshots generated from the selected records. The private workspace keeps its own authentication boundary.

## Settings

| Setting | Fresh default | Purpose |
| --- | --- | --- |
| Timezone | Asia/Manila | Local financial dates and reminders |
| DefaultCurrency | PHP | New-record currency |
| ReminderTime | 09:00 | Local reminder time |
| CalendarId | empty | Selected target calendar |
| SyncEnabled | false | Calendar synchronization control |
| ReminderMinutes | 1440,0 | Reminders one day before and at event time |
| ShowAmounts | false | Calendar title/detail amount preference |
| IncludeHistorical | false | Creation of historical events |
| BackupEnabled | false | Scheduled financial backup control |
| BackupDays | 7 | Backup interval when enabled |

Change normal settings in Settings and Integration. ReminderTime accepts supported clock strings and spreadsheet time values and normalizes them to HH:mm.

## Backups and updates

Before replacing an installed release, create a private backup and record the active Apps Script deployment version and Cloudflare version. Pause automation while changing backend code. Replace the contents of the matching source files, run the schema migration under the Google owner account, verify record counts and relationships, and update the existing Apps Script deployment to a new version. Keep its deployment URL stable when possible. Deploy the matching Cloudflare release and restore automation after checks pass.

`setup` and `migrateSchema` preserve existing tables with the expected columns. They stop on incompatible schema changes. Ordinary UI updates use the existing records and source identities.

For rollback, pause synchronization, restore the previous Apps Script and Worker versions, and inspect the Sheet before restoring financial data. Calendar events are external records: verify their state separately. This v4 release changes validation and gateway behavior; restoring an older code release requires a compatible schema/validation plan. Prefer a previous v4 snapshot once the application is installed.

## Recovery

A journal operation marked pending may represent a partly completed write. Open Settings and Integration and resume that operation. Refresh the data before repeating an action. For reviewed imports, select the identical original package again after recovery; the operation IDs make completed batches repeat-safe.

A package conflict means the existing record differs from the package or its source identity has already been imported under another record. Inspect the specific account, card, statement or source row. Preserve established records instead of creating a second independent history.

## Authentication recovery

Use the Supabase administrative account to reset the application user's password when necessary. For a lost authenticator, first secure the owner account, revoke current application sessions, and remove the lost factor through Supabase's supported administrative MFA controls. Enable owner enrollment briefly, register the replacement authenticator, then disable enrollment again.

Revoking application sessions is an explicit administrative operation in Supabase SQL Editor:

```sql
delete from public.cardbills_sessions;
```

Rotate SESSION_KEY to invalidate decryptability of existing stored sessions. Rotate BRIDGE_SECRET in both Apps Script and Cloudflare together. Rotate a compromised Supabase secret key through the Supabase dashboard and update the Worker runtime secret. Keep the password manager's copies current.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Complete the application settings | Check every runtime name in DEPLOYMENT.md and save a new deployment |
| Check the configured service addresses | Use exact HTTPS origins, the hosted Supabase project URL and the Apps Script /exec URL |
| Sign-in rejected | Check the configured username, Supabase account password, confirmed email and owner UUID |
| Authenticator enrollment unavailable | Enable ALLOW_ENROLLMENT only for the deliberate setup; check existing verified factors |
| OTP rejected | Check the authenticator entry and device time; wait for the next code after attempt limits |
| Service unavailable | Check Supabase project status, quota use and network/provider availability |
| Backend connection needs review | Compare bridge secrets and owner UUIDs; check the deployment's Google owner and access setting |
| Calendar is undefined | Confirm Calendar Advanced Service in the manifest and service registration |
| Calendar authorization error | Authorize the manifest scopes and verify access under the personal deployment owner |
| Calendar inaccessible | Select the intended existing calendar and verify its permissions before migration |
| Invalid reminder time | Enter a supported time such as 09:00 and use settings repair |
| Invalid due date | Correct the statement's ISO date and rerun the synchronization preview |
| Duplicate automation triggers | Stop automation and install it once under the owner account |
| Schema version/order error | Restore the expected headers, then run migrateSchema under the owner account |
| Code changed but behavior did not | Update the existing Apps Script deployment to the new version; confirm the Worker deployment |
| Import timeout or recovery warning | Refresh, inspect pending operations, resume recovery, and reopen the same package |
| Spending chart empty | Classify imported transaction types; use transaction rows and import receipts for source activity |
| Statement remainder unknown | Enter official statement balances and confirmed payment allocations |
| Worker CPU limit | Inspect real metrics and request size; reduce batch size and unnecessary calls before changing plans |

Disabling the synchronization engine stops new synchronization work. Existing Calendar events retain their last configured reminders until updated through the statement controls and a successful synchronization.
