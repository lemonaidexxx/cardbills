# BillBills performance verification

The release uses Supabase for live financial storage after verified cutover. Sheets is a one-way backup destination; neither Sheets nor Apps Script participates in normal database reads or saves.

## Changes

- Independent browser reads run concurrently (maximum four). Writes remain ordered, form a barrier for subsequent reads, and retain idempotent operation IDs.
- Every cached server response requires a fresh owner/MFA-protected workspace version check. Results are invalidated by commits, external version changes, and the workspace's local calendar day. The cache is memory-only and bounded to 64 results.
- Lists are filtered, sorted, and paginated on the server with the existing financial domain rules. Each response has at most 40 rows. This release does not introduce a second SQL implementation of derived balances or filters.
- Bootstrap no longer sends the full browsing snapshot, and the old browser fetch interceptor is no longer loaded. Existing lookup projections remain for relationship selectors.
- Date formatters are reused. Existing records remain visible while a list request completes; obsolete responses cannot replace a newer view. No new timeouts or loading indicators were added.

## Measurements and checks

Five local samples using the private migration snapshot reduced bootstrap JSON from 1,138,478 to 210,312 bytes (81.5%). Removed browsing-snapshot construction took 73–148 ms, median 112 ms. These are payload and local CPU measurements, not production network timings.

The test suite covers read concurrency, duplicate-read sharing, write ordering, obsolete requests, authorization on cache hits, database-version invalidation, backup failure isolation, and financial idempotency. Source checks and desktop/tablet/mobile synthetic browser verification pass.

Live deployment, authenticated persistence, and network timings are verified separately during cutover. No financial records or credentials are included in this report or repository.
