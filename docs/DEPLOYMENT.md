# Deployment

Complete these sections in order. Use a private folder for financial imports and a separate folder for this source project. Configuration secrets belong in Cloudflare and Apps Script settings.

## 1. Add the source to GitHub

1. Extract the source ZIP on your computer.
2. Open the GitHub repository you selected for Cardbills.
3. Choose **Add file > Upload files**.
4. Upload the contents of the extracted source folder, preserving its folders. `package.json` and `wrangler.json` belong at the repository root. Include `.gitignore` and `.dev.vars.example`.
5. Commit the source files. Keep the reviewed import JSON, workbooks and audit CSVs in your separate private folder.

For a local Git workflow, clone the repository, copy the source into that working tree, inspect the changes, and commit them. The existing license is retained.

## 2. Create the Supabase project

1. Sign into Supabase and create a **Free** project dedicated to this application.
2. Save its database password in your password manager. Choose a nearby available region.
3. Open **SQL Editor**, create a query, paste `supabase/setup.sql`, and run it.
4. Confirm that `cardbills_sessions` and `cardbills_attempts` exist and have Row Level Security enabled. The SQL grants their access to the server role.
5. Open **Authentication > Users** and create your owner user with an email address and a strong password. Confirm the user's email during creation or through the available confirmation flow.
6. Copy that user's UUID. This is the application **OWNER_USER_ID**, distinct from the project reference and your Supabase dashboard account.
7. In Authentication configuration, disable **Allow new users to sign up** and anonymous sign-ins. Keep email/password authentication enabled for the existing owner account.
8. Keep TOTP enrollment and verification enabled in the MFA settings.
9. Open **Settings > API Keys**. Copy the **publishable key** (`sb_publishable_...`) and a **secret key** (`sb_secret_...`). Record the project URL, such as `https://PROJECT-REFERENCE.supabase.co`.

The Worker uses the current publishable/secret key pair. Supabase manages your login password and authenticator secret. The application uses the user UUID as its owner allowlist. [1][2][3]

## 3. Generate two application secrets

Install a current supported Node.js release if it is not already available. Open a terminal in the extracted source folder and run:

```sh
node tools/generate-secrets.mjs
```

Save the generated **SESSION_KEY** and **BRIDGE_SECRET** in your password manager. Each is a separate random 64-character hexadecimal value. Paste the same BRIDGE_SECRET into Apps Script and Cloudflare in the following sections. Keep SESSION_KEY in Cloudflare only.

## 4. Install the Google backend

1. Sign into the personal Google account that owns your destination Sheet. Verify the avatar in Google Sheets and in Apps Script.
2. Open the destination Sheet and choose **Extensions > Apps Script**.
3. Replace the default `Code.gs` contents with `apps-script/Code.gs`.
4. Add a Script file named **Gateway** and paste `apps-script/Gateway.gs`.
5. Add HTML files named **Index**, **Styles** and **Client**, and paste the corresponding files from `apps-script/`.
6. Open **Project Settings**, enable **Show appsscript.json manifest file in editor**, and replace that manifest with the supplied `appsscript.json`.
7. In **Project Settings > Script Properties**, add these values:

| Property | Value |
| --- | --- |
| `SPREADSHEET_ID` | The ID between `/d/` and `/edit` in the destination Sheet URL |
| `OWNER_EMAIL` | The personal Google email that owns and deploys this script |
| `OWNER_USER_ID` | The Supabase application user's UUID from section 2 |
| `BRIDGE_SECRET` | The generated bridge secret from section 3 |

8. Save the project. Select the **setup** function and click **Run**.
9. Review Google's authorization request and authorize this project under the personal owner account. Only continue through an unverified-app warning after checking that it refers to this script project and the permissions you intend to grant.
10. Return to the Sheet. Confirm that the `CC_` application tabs exist. The fresh setup configures PHP and the Asia/Manila timezone.

The manifest registers the Calendar Advanced Service. For an Apps Script default Cloud project, adding the service enables its API. With a separately attached standard Cloud project, enable Google Calendar API in that project as well. [4]

Google permissions in this release cover spreadsheet access, Calendar access, installable triggers, the Sheet menu/dialog interface and the owner's email identity.

## 5. Deploy Apps Script

1. Choose **Deploy > New deployment** in Apps Script.
2. Select **Web app**.
3. Set **Execute as: Me**, using the personal account from section 4.
4. Set **Who has access: Anyone** so the Cloudflare server can submit requests.
5. Deploy and copy the resulting URL ending in **`/exec`**.
6. Keep the Google Sheet's own sharing setting **Restricted**.

The web endpoint authenticates signed server requests before accessing records. Each request carries an owner ID, a short-lived timestamp and a one-use nonce. The BRIDGE_SECRET is stored server-side. A browser opening the endpoint receives a service identifier; the financial API requires a valid signed request. The Sheet permission and the web endpoint access setting are separate controls. [5]

## 6. Deploy Cloudflare

1. Sign into your Cloudflare account.
2. Open **Workers & Pages > Create application**.
3. Choose **Import a repository > Get started** and connect GitHub.
4. Grant repository access to your Cardbills repository and select it.
5. Set the Worker name to **cardbills**, matching `wrangler.json`.
6. Use the repository root as the project root.
7. Set the build command to **`npm run check && npm test`**. Cloudflare's normal dependency installation reads `package.json`; if automatic installation is disabled in your build configuration, use `npm install && npm run check && npm test` instead.
8. Set the deploy command to **`npx wrangler deploy`**.
9. Select **Save and Deploy**. Record the exact `https://cardbills.YOUR-SUBDOMAIN.workers.dev` origin assigned to the Worker.

The first deployment can be uploaded before its application settings exist. Requests to the application then ask you to complete those settings. Cloudflare connects subsequent repository pushes to builds and deployments. [6]

## 7. Enter Cloudflare runtime settings

Open **Workers & Pages > cardbills > Settings > Variables and Secrets**. Add the values below as runtime settings. Use **Secret** for private values. Using Secret for every value except ALLOW_ENROLLMENT is a simple consistent setup.

| Name | Value |
| --- | --- |
| `APP_ORIGIN` | Exact Worker origin from section 6, starting with `https://`, with no trailing slash or path |
| `SUPABASE_URL` | Your Supabase project URL, with no trailing slash |
| `SUPABASE_PUBLISHABLE_KEY` | Publishable key beginning `sb_publishable_` |
| `SUPABASE_SECRET_KEY` | Server secret key beginning `sb_secret_` |
| `OWNER_USER_ID` | The owner application user's UUID |
| `OWNER_EMAIL` | The email of that Supabase application user |
| `OWNER_USERNAME` | The username you choose for the Cardbills login form |
| `SESSION_KEY` | Generated session-encryption key |
| `BRIDGE_SECRET` | Exactly the same bridge secret as in Apps Script |
| `APPS_SCRIPT_URL` | The Apps Script deployment URL ending `/exec` |
| `ALLOW_ENROLLMENT` | `true` for the initial owner enrollment |

Save and deploy the changed settings. Use runtime secrets rather than frontend build variables. The authentication password is entered into the login form; Supabase stores and verifies it. [7]

The two OWNER_EMAIL settings have different responsibilities: Apps Script uses the Google deployment owner; Cloudflare uses the Supabase application login email. Using your personal email for both is convenient, but their identities are verified separately.

Set the Supabase Authentication Site URL to the same application origin for consistency. This application's direct password/TOTP flow uses its own same-origin endpoints.

## 8. Enroll the authenticator

1. Open the Worker URL.
2. Enter your configured OWNER_USERNAME and the password of the Supabase application user.
3. Choose **Set up authenticator**.
4. Scan the QR code in your authenticator, or enter the displayed setup key.
5. Enter the six-digit code and open the workspace.
6. Return to Cloudflare and change **ALLOW_ENROLLMENT** to **false**. Save and deploy.
7. Sign out and sign in again. Confirm that your password is followed by an authenticator challenge.

The dashboard's financial API requires the allowlisted owner, a server-verified Supabase token, AAL2, and a currently verified TOTP factor. Password-only sessions remain restricted. [2]

The application session lasts up to 30 minutes, bounded by the authentication token expiry. An incomplete login lasts up to five minutes. Sign in again after expiry.

## 9. Import the reviewed financial package

1. Keep the `*.cardbills.json` file in your private folder.
2. In the signed-in dashboard, open **Transactions > Import reviewed package**.
3. Select the reviewed package. Read the transaction count and signed totals in the preview.
4. Choose the import action. Keep the page open while it processes the batch sequence.
5. Wait for the verified transaction receipt.
6. Check the transaction count, card relationships, archived cards and statement dates in the dashboard and Sheet.
7. Keep the same original package for a repeat-safe retry. Its record IDs and operation IDs identify work already completed.

An interrupted request may already have written its batch. Refresh first. When the backend reports a pending operation, open **Settings and Integration**, resume that operation, and then reopen the same package. The importer preserves source keys and refuses conflicting existing records.

Imported transaction activity is classified independently from the source balancing check. Choose activity types for purchases, fees, refunds, rebates, bank payments and other entries. Spending charts use classified entries. Enter official balances and minimum-payment amounts from the actual statements.

## 10. Configure Calendar reminders

1. Open **Settings and Integration**.
2. Test Calendar access and select the intended calendar.
3. Verify the timezone and reminder time.
4. Open a statement you want to track and confirm its due date and official amounts.
5. Turn on that statement's Calendar reminders.
6. Preview synchronization, confirm the intended event, then run synchronization.
7. Confirm the resulting event in Google Calendar.
8. Enable synchronization and install automation after the test succeeds.

The fresh settings leave automatic synchronization off. Historical reminders are skipped by default. One statement corresponds to one reminder event. Payment allocations determine settlement behavior.

## 11. Complete live verification

Use the checklist in [Tests](TESTS.md). In particular, verify anonymous access rejection, password-only rejection, TOTP login, logout, the first import receipt, repeat-safe retries and a test Calendar event.

Review Cloudflare's request count and CPU metrics under ordinary use. The Free plan currently allows 100,000 Worker requests daily and 10 milliseconds CPU per invocation. This release sends every website request through the Worker. Supabase Free projects currently pause after a week of inactivity. Resume a paused project in Supabase before signing in again. Provider quotas and live timings determine whether the free tiers meet your usage. [8][9][10]

## Official references

[1] https://supabase.com/docs/guides/getting-started/api-keys

[2] https://supabase.com/docs/guides/auth/auth-mfa/totp

[3] https://supabase.com/docs/guides/auth/general-configuration

[4] https://developers.google.com/apps-script/guides/services/advanced

[5] https://developers.google.com/apps-script/guides/web

[6] https://developers.cloudflare.com/workers/ci-cd/builds/

[7] https://developers.cloudflare.com/workers/configuration/secrets/

[8] https://developers.cloudflare.com/workers/platform/pricing/

[9] https://developers.cloudflare.com/workers/platform/limits/

[10] https://supabase.com/pricing

Documentation checked 12 September 2026. Dashboard labels may vary slightly between account interfaces.
