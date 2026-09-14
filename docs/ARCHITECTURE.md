# Architecture and security

## Request path

```text
Browser
  -> Cloudflare Worker
     -> Supabase Auth and restricted session storage
     -> signed HTTPS request
        -> Google Apps Script
           -> private Google Sheet
           -> Google Calendar
```

The original Apps Script financial services and vanilla-JavaScript dashboard are retained. A Cloudflare gateway replaces the browser's Apps Script RPC transport. Schema version 4 adds the UNKNOWN card relationship option while preserving the existing table columns.

## Authentication

The login username maps on the Worker to one configured Supabase email account. The Worker sends the password to Supabase's password endpoint. It checks the authenticated user through the Auth server, verifies the configured owner UUID and confirmed email, and creates a short-lived restricted application session.

The MFA flow obtains a challenge and verifies the authenticator code with Supabase. Financial requests require AAL2 and an enrolled verified TOTP factor. Each authenticated request verifies the token through Supabase again. A provider outage blocks private requests until verification is available.

The browser receives a random opaque session cookie. Its attributes are Secure, HttpOnly, SameSite=Strict and Path=/. The cookie uses the __Host- prefix. Supabase stores the SHA-256 hash of the cookie identifier, the owner UUID, an encrypted access token and an expiry time. AES-GCM binds the encrypted token to its session identifier. The Worker stores the encryption key in a runtime secret.

MFA rotates the session identifier and deletes the pre-authentication session. Logout removes the current application session. Application sessions are capped at 30 minutes; restricted sessions at five minutes. Expired sessions are cleaned during rate-limit operations.

## Access controls

The financial API uses an explicit operation allowlist at both Cloudflare and Apps Script. State-changing requests require an exact matching Origin and JSON content. Browser responses set a restrictive Content Security Policy, frame protection, MIME sniffing protection, no-referrer, HSTS and no-store caching.

Rate limits use atomic database operations. Password attempts have both a per-IP limit and an owner-wide limit. MFA and enrollment have owner-wide and per-IP limits. Database table permissions and RLS restrict the session and attempt tables to the server role.

Cloudflare signs backend requests with HMAC-SHA256. Apps Script validates the signature, timestamp, one-use nonce, configured owner UUID and effective Google deployment owner. Nonces are stored under a script lock for replay detection. The Apps Script public functions also check the Google owner for direct administrative use. The deployment owner's Google account and Sheet editors are privileged administrators with direct access to the financial store.

## Financial storage

Google Sheets holds the financial entities and their relationships. Currency values use integer minor units; PHP has two decimal places. Explicit entity IDs survive sorting and renaming. Operations use a journal with repeat-safe request IDs, source identities, validation and recovery records. Sheet locks serialize script operations; row-level checks detect conflicting manual edits.

Original and cleaned descriptions are separate fields. Technical identifiers are protected with warning-only Sheet protections. User-controlled text is rendered through textContent and written with formula protection. Only masked card information is part of the operational model.

Imported signed activity, official statement balances, bank payments and personal receivables are separate measures. Blank official balances remain unknown. Unclassified activity is visible for review. Personal repayment records and bank-payment records have separate allocation rules.

## Data placement

| Destination | Contents |
| --- | --- |
| Google Sheet | Financial tables, labels/settings, import history, audit history, recovery journal and record baselines |
| Apps Script properties | Sheet configuration, owner identities, bridge secret, nonce/trigger metadata |
| Supabase Auth | Application user, password verification state and authenticator state |
| Supabase public tables with restricted grants | Encrypted application sessions and hashed attempt counters |
| Cloudflare secrets | Supabase server credentials, owner configuration, session key and bridge secret |
| GitHub | Source code, schema installation, tests and documentation |

## Administration

Keep enrollment enabled only during initial setup or a deliberate recovery. Protect your Google, GitHub, Cloudflare and Supabase administrator accounts with their own MFA. Anyone with edit access to the Apps Script project can inspect its properties; anyone with direct Sheet edit access can change financial records. Limit both groups to trusted administrators.

Use the current Supabase publishable and secret keys. The secret key is sent only from the Worker in the apikey header. User-token Authorization headers are used for Auth requests. API-key background: https://supabase.com/docs/guides/getting-started/api-keys

The static-asset configuration uses explicit HTML file handling. Worker routing controls the authenticated /app path and serves app.html through the asset binding.
