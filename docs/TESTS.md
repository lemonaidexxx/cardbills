# Tests and release verification

## Executed checks

| Check | Result | Environment |
| --- | --- | --- |
| Node test suite | 48 passed, 0 failed | Node.js 22.16.0 |
| Syntax and source checks | Passed | Local source files |
| Offline browser checks | 8 passed | Chromium, 1440x1000 and 390x844, synthetic records |
| Reviewed workbook reconciliation | 22 checks passed | Local workbook and source-data comparison |
| Complete reviewed import simulation | Passed | In-memory Apps Script services |
| Repeat-import check | Passed | Same package and request identities |

The Node suite covers owner authorization, signed backend requests, replay rejection, encryption and tamper detection, same-origin checks, bounded requests, password/MFA transitions, rate limits, token assurance, outage handling, session expiry and logout. It also checks setup repetition, currency precision, date validity, reminder-time normalization, formula protection, package field restrictions and unknown statement balances.

Offline browser checks cover login layout, password visibility, the overview, navigation, import dialogs and empty collections on desktop and mobile. They use synthetic fetch responses in an offline DOM. Live navigation was restricted by the environment; deployed network, cookie and Content Security Policy behavior remain part of live acceptance.

The private import simulation exercised all supplied records and checked statement defaults, historical archived cards, separate ledgers and repeat-safe batches. Private transaction fixtures are kept outside this public source package.

## Run the local suite

```sh
npm run check
npm test
```

The tests use Node's built-in test runner. The backend fixture simulates Google services. These checks are distinct from a live Google authorization or Cloudflare runtime test.

## Optional offline browser checks

The release includes an offline Chromium script and a synthetic fixture generator:

```sh
python -m pip install playwright
python -m playwright install chromium
python tools/browser-check.py
```

Set BROWSER_EXECUTABLE to an installed Chromium path when using a system browser. The script writes screenshots to a temporary folder and uses synthetic records.

## Live acceptance checklist

Run these after installing in your accounts:

1. Inspect the Cloudflare build output. Install dependencies and run a Wrangler dry run if deploying from a local computer. npm dependency retrieval and Wrangler deployment could not be executed in the preparation environment.
2. Confirm SQL installation, table grants and RLS. An anonymous or ordinary authenticated Supabase key should have no access to the application session/attempt tables. The Worker secret key should access only the routes used by the application.
3. Confirm the Google deployment owner, manifest authorization and private Sheet permissions. Test a signed backend request from the deployed Worker.
4. Open a private browser window. Anonymous /api/rpc requests must fail. A password-only session must remain unable to retrieve financial data.
5. Complete TOTP verification. Inspect the cookie flags and check that no Supabase access token appears in browser localStorage, sessionStorage or response JSON.
6. Submit an incorrect OTP and verify rejection. Confirm attempt limits. Submit a cross-origin request and verify rejection.
7. Sign out, then reuse the previous application session cookie in a test request. Confirm that access is rejected.
8. Submit an unsigned backend request and a replayed signed test request. Confirm rejection. Use synthetic test content and keep the signing key private.
9. Import the reviewed package and compare its final receipt with the package control totals. Reopen the identical package and confirm unchanged counts. Test interrupted-import recovery with a separate synthetic test Sheet.
10. Verify names, cards, statement dates, signed amounts and both description fields. Check that archived cards retain historical transactions and that official unknown balances appear as unknown.
11. Test a purchase share, partial personal repayment, refund credit and reversal. Test a separate bank payment and statement allocation. Verify allocation limits and independent totals.
12. Test a selected person's report preview and export. Inspect the exported fields and record selection before sharing.
13. Use a future synthetic statement to test Calendar access, create, repeated synchronization, changed due date, partial settlement and full settlement. Verify event IDs and reminders in the actual calendar.
14. Test desktop and mobile navigation, keyboard focus, modal focus, slow requests and errors under the deployed security headers.
15. Inspect actual Worker CPU usage, request counts, Apps Script execution times and provider quotas before enabling routine automation.

Preparation date: 12 September 2026. Live Cloudflare, Supabase and Google account acceptance remains to be completed by the deployment owner.
