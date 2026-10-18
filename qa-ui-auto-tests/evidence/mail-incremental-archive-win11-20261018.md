# Incremental mail archive — Windows 11 verification

Verified locally on 2026-10-18 with isolated `com.taomni.app.qa` and disposable loopback IMAP/SMTP accounts. The installed production app and personal mailbox were not modified.

Final build: Rust debug profile with the production React frontend, Node 22.23.3 / pnpm 10.34.7, Rust 1.96.0. Source fingerprint: `887eccdbbd98e9a0c3ff27af855564d4b3ac24fa602c61fd2092ef7358254539`. QA executable SHA-256: `8d6d9da2babbda6aaf40988c7d9e1398f7338d1b450d0f99379319237091d04f`. Build log: `qa-ui-auto-report/_local/mail-batch-native-build-node22-final.log`.

## Problem and behavior

The archive previously indexed an entire folder before downloading its first complete original. A mailbox with tens of thousands of historical messages could therefore show zero saved originals and an empty Local archive while header synchronization was progressing normally. The earlier two-message fixture did not distinguish this behavior.

The archive now alternates a header page of 100 messages with at most 100 missing originals. It drains remaining cached originals after history completes, preserves include/exclude rules and UID validity checks, and attempts unavailable content only once per scan so another scan can retry it. Complete originals become readable as each one is published.

The panel reports current-folder Headers separately from Saved this scan and Current message byte progress. It decodes IMAP folder names, suppresses stale message percentages during header synchronization, and omits IMAP header progress for POP3. Pausing and reopening the mail tab preserve the current scan's folder and counters. Saved this scan is a scan counter, not the lifetime archive size.

## Verification

- Frontend: 29 focused Vitest tests passed for MailArchivePanel, MailStorageSettings and mailFolders, using Node 22.23.3 / pnpm 10.34.7.
- Rust: all 8 `mail::archive::tests::` tests passed. New loopback tests prove the first full-MIME FETCH precedes subsequent history pages, a complete cached index drains across multiple MIME batches, and unavailable content is attempted once per scan. Log: `qa-ui-auto-report/_local/mail-batch-rust-tests-final.log`.
- Python: all 3 storage-oracle/fixture tests passed. The oracle rejects missing/corrupt originals and already-complete history. SQLite connections are explicitly closed to avoid Windows file-lock failures during cleanup.
- Browser: TC-MAIL-STORAGE-01 and TC-MAIL-STORAGE-04 passed, zero failures/skips, against the Node 22 / pnpm 10 Vite server. Report: `qa-ui-auto-report/mail-batch-browser-node22/run-20261018-093835-088737500/summary.json`.
- Native: TC-MAIL-STORAGE-02, 03, 04 and 05 passed, zero failures/skips. Report: `D:/qa-taomni-mail/run-20261018-094254-035296300/summary.json`. This covers complete MIME persistence, migration/backup/cleanup, unavailable-content retry, readable folder selection, and incremental publication/pause/resume.
- TypeScript and Vite production compilation pass as part of the QA build. Changed Rust file formatting and `git diff --check` pass. F-MAIL-23 QA audit and CI registration pass; worktree development contract reports no warnings/errors. Final case checkpoint references were checked against the executable steps.

TC-MAIL-STORAGE-05 uses 350 MIME messages with attachments and controlled protocol latency. A read-only SQLite/gzip oracle requires complete originals with matching fixture SHA-256 and size while the header index is still incomplete. The case then pauses, reads an early saved original and its attachment, reopens the mail tab, resumes, checks all 350 originals and attachments, verifies pagination of 200 + 150, and rescans without duplicate storage.

The final native observation recorded 200/350 cached headers, `sync_complete=0`, and two complete originals with verified hashes. The paused screenshot shows `Headers: 100/350` (the archive worker's last header snapshot) and `Saved this scan: 3/200`; the independent header lane had already advanced the shared index beyond that snapshot. Local archive displayed the early originals and opened the selected message body with `batch.bin`. After resume and again after rescan, the oracle found 350 headers, 350 original mappings, 350 objects, and matching original/attachment hashes. Screenshots `TC-MAIL-STORAGE-05/mail-incremental-paused-progress.png` and `mail-incremental-readable-original.png` in the native report were visually inspected.

Both final summaries report stable input identities. All six case/mode observations were accepted as current by `load_observations`; receipt signatures, summary hashes, source/runner/case fingerprints, configuration and native QA build identity match. Local identity-check output is retained in `qa-ui-auto-report/_local/mail-batch-final-identities.json`.

## Recovered failures and scope

- Initial Rust compilation rejected SQLite COUNT deserialization into usize; the query now reads u32 and converts explicitly. The corrected Rust suite passes.
- The first native incremental case exposed a real status bug: persisted pause returned a fresh zero-valued status instead of the stopped job's counters. The status command now retains that snapshot. Failure report: `D:/qa-taomni-mail/run-20261018-092755-340637600/summary.json`.
- The next run proved the pause fix but exposed an incorrect test assumption: independent header synchronization continues while original storage is paused. The case retains its decisive live incomplete-history observation and no longer requires the independent index to remain incomplete after pausing. Failure report: `D:/qa-taomni-mail/run-20261018-093606-566618700/summary.json`.
- One browser attempt failed with a destroyed execution context while checking the test mail control. Its trace is retained under `qa-ui-auto-report/mail-batch-browser-final/run-20261018-092617-935298400`; unchanged-source retry and the final Node 22 run both passed. No assertion was weakened to hide this failure.
- Initial runs used the host's Node 24 / pnpm 12 defaults. Final frontend/browser validation and the final native build use repository-required Node 22 / pnpm 10 without replacing global tools.
- Native reports use the short `D:/qa-taomni-mail` root to avoid Windows path-length limits and EdgeDriver 155.0.4283.60 to match WebView2. The receipt helper emits Git-discovery warnings outside the checkout; summary/receipt and source/build identities are checked explicitly.
- Full-repository rustfmt has unrelated baseline differences; only the changed Rust file is verified here. No unrelated files were reformatted.
- This is Windows 11 functional evidence using a 350-message controlled fixture. Linux/macOS, external provider interoperability, application restart restoration of in-memory counters, and performance on the user's 33,933-message mailbox are not claimed.
