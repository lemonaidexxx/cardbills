# Architecture and security

## Request path

```text
Browser
  -> Cloudflare Worker
     -> Supabase Auth and restricted session storage
     -> Supabase financial storage

Cloudflare scheduled/manual backup
  -> private Google Sheet (one-way backup only)
```

This describes the target production architecture with `DATA_BACKEND=supabase`; activation follows verified import and cutover. The vanilla-JavaScript dashboard is retained, and the build compiles the existing financial rules into Cloudflare. Normal loading, retrieval, calculations, and saves do not call Apps Script or Google Sheets. Schema version 4 adds the UNKNOWN card relationship option while preserving the existing table columns.

## Authentication

The login username maps on the Worker to one configured Supabase email account. The Worker sends the password to Supabase's password endpoint. It checks the authenticated user through the Auth server, verifies the configured owner UUID and confirmed email, and creates a short-lived restricted application session.

The MFA flow obtains a challenge and verifies the authenticator code with Supabase. Financial requests require AAL2 and an enrolled verified TOTP factor. Each authenticated request verifies the token through Supabase again. A provider outage blocks private requests until verification is available.

The browser receives a random opaque session cookie. Its attributes are Secure, HttpOnly, SameSite=Strict and Path=/. The cookie uses the __Host- prefix. Supabase stores the SHA-256 hash of the cookie identifier, the owner UUID, an encrypted access token and an expiry time. AES-GCM binds the encrypted token to its session identifier. The Worker stores the encryption key in a runtime secret.

MFA rotates the session identifier and deletes the pre-authentication session. Logout removes the current application session. Application sessions are capped at 30 minutes; restricted sessions at five minutes. Expired sessions are cleaned during rate-limit operations.

## Access controls

The financial API uses an explicit operation allowlist in Cloudflare. State-changing requests require an exact matching Origin and JSON content. Browser responses set a restrictive Content Security Policy, frame protection, MIME sniffing protection, no-referrer, HSTS and no-store caching.

Rate limits use atomic database operations. Password attempts have both a per-IP limit and an owner-wide limit. MFA and enrollment have owner-wide and per-IP limits. Database table permissions and RLS restrict the session and attempt tables to the server role.

Supabase financial access requires the configured owner and verified MFA. Client grants and row-level security restrict access; financial writes go through the protected Worker and database commit functions. The legacy signed Apps Script bridge is retained only for the separately configured Sheets backend and is unused in Supabase mode. Google failures never trigger a fallback to that bridge.

## Financial storage

Supabase holds all live financial entities and their relationships, labels/settings, import history, audit history, recovery journal, and record baselines. Currency values use integer minor units; PHP has two decimal places. Explicit entity IDs survive sorting and renaming. Operations use a journal with repeat-safe request IDs, source identities, validation and recovery records. Cloudflare serializes financial changes, and database commits enforce workspace version checks.

Original and cleaned descriptions are separate fields. User-controlled text is rendered through textContent. Backups write literal Sheet values and preserve unrelated tabs. Only masked card information is part of the operational model. Sheet edits do not update the live database.

Imported signed activity, official statement balances, bank payments and personal receivables are separate measures. Blank official balances remain unknown. Unclassified activity is visible for review. Personal repayment records and bank-payment records have separate allocation rules.

## Data placement

| Destination | Contents |
| --- | --- |
| Supabase | Financial tables, labels/settings, import history, audit history, recovery journal and record baselines |
| Google Sheet | Backup data storage only: daily one-way copies from Supabase, with manual backup available |
| Supabase Auth | Application user, password verification state and authenticator state |
| Supabase public tables with restricted grants | Encrypted application sessions and hashed attempt counters |
| Cloudflare | Application runtime, financial rules, request handling and scheduled backups |
| Cloudflare secrets | Supabase server credentials, owner configuration, session key and dedicated Sheets backup credentials |
| GitHub | Source code, schema installation, tests and documentation |

## Administration

Keep enrollment enabled only during initial setup or a deliberate recovery. Protect your Google, GitHub, Cloudflare and Supabase administrator accounts with their own MFA. Limit database administration and backup-Sheet access to trusted administrators. Sheet access permits reading or altering backup copies, so keep it restricted even though it does not change live records.

Daily backups use `BackupEnabled=true`, `BackupDays=1`, and `SyncEnabled=false`. Calendar synchronization is disabled. Backup failures are reported separately and do not block normal financial retrieval or saves. Retire the external Apps Script deployments and triggers only after the cutover and initial backup are verified; see [Apps Script retirement](APPS-SCRIPT-RETIREMENT.md).

Use the current Supabase publishable and secret keys. The secret key is sent only from the Worker in the apikey header. User-token Authorization headers are used for Auth requests. API-key background: https://supabase.com/docs/guides/getting-started/api-keys

The static-asset configuration uses explicit HTML file handling. Worker routing controls the authenticated /app path and serves app.html through the asset binding.
