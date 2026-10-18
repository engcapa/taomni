# Readable mail folder selection — Windows 11 verification

Verified on 2026-10-18 on Windows 11 Pro with WebView2 / EdgeDriver 155.0.4283.60.
Native application: isolated `com.taomni.app.qa`, debug Rust build with the production frontend.
Build/source fingerprint: `8297d06dfba5de3908f475541e1ccbcd4a73f7cc7ad9677855283beee9588318`.
All mail accounts, IMAP/SMTP services and storage directories were disposable test fixtures.

## Behavior

- Manual full folder paths accept readable Chinese names or existing IMAP server keys in include and exclude modes, including before the first sync.
- Only INBOX is case-insensitive; a leaf name does not match a different parent path.
- Cached checkboxes recognize readable selections. Mixed readable/encoded entries appear once; unchecking removes both forms.
- Readable selections persist across save/reopen. Exclusion keeps existing originals but prevents storing newly arrived messages.
- Raw-name editing remains available behind the advanced disclosure. Other storage cases now open it before typing.

## Executed evidence

| Check | Result | Retained local evidence |
| --- | --- | --- |
| TC-MAIL-STORAGE-04 browser, final case | Passed, no skips | `qa-ui-auto-report/mail-readable-browser/run-20261018-085855-891732200/summary.json` |
| TC-MAIL-STORAGE-01 browser retained storage workflow | Passed, no skips | `qa-ui-auto-report/mail-readable-browser/run-20261018-084726-727269700/summary.json` |
| TC-MAIL-STORAGE-04 native, final case | Passed, no skips | `D:/qa-taomni-mail/run-20261018-085854-951448400/summary.json` |
| TC-MAIL-STORAGE-02 native complete MIME, migration, backup and cleanup | Passed | `D:/qa-taomni-mail/run-20261018-085641-027583700/summary.json` (this run also contains a superseded TC-MAIL-STORAGE-04 selector failure) |
| MailStorageSettings, mailFolders and MailArchivePanel Vitest suites | 26 tests passed | `pnpm exec vitest run src/components/mail/MailStorageSettings.test.tsx src/lib/mailFolders.test.ts src/components/mail/MailArchivePanel.test.tsx` |
| Rust mail storage tests | 7 tests passed | `qa-ui-auto-report/_local/mail-readable-rust-tests.log` |
| QA build including TypeScript and Vite | Passed | `qa-ui-auto-report/_local/mail-readable-native-build-2.log` |
| QA feature audit / development contract / CI case registration | Passed | `qa-ui-auto-report/_local/mail-readable-audit.log`; worktree development contract evaluated with no warnings/errors |
| Changed Rust file rustfmt; git diff whitespace | Passed | `rustfmt --check --edition 2024 src-tauri/src/mail/storage.rs`; `git diff --check` |

Final native and browser summaries report stable source identities and have adjacent runner receipts. The native build identity matches their source fingerprint. Screenshots of settings and exclusion results were visually inspected.

Independent read-only inspection of the final native SQLite database and gzip objects also confirmed:

- `&U,BTFw-`: 2 message headers, only UID 1 stored in full; the newly excluded UID 2 has no full original.
- `Projects/&U,BTFw-`: both messages stored in full.
- Every stored gzip original hashes to the SHA-256 recorded in SQLite.

## Recovered failures and boundaries

- Initial QA build rejected an unsupported Testing Library test option; fixed before the successful build.
- Initial browser run overlapped that test-file edit, so its source-stability gate failed despite passing assertions; rerun on stable input passed.
- Initial native driver was version 153 against WebView2 155. A matching Microsoft-signed driver was downloaded into the local report tools directory; the global driver was not replaced.
- A deep report directory exceeded Python's ordinary Windows path limit in the independent disk oracle. Native runs use the shorter `D:/qa-taomni-mail` report root. Stored application files existed and were checked read-only using the extended path prefix before retrying.
- The new case originally read archive entries before scan completion, then used a browser-only text selector in a native count assertion. It now waits for the scan control to become enabled and checks archive text with read-only DOM expressions. Final browser/native executions pass with these assertions.
- The receipt helper emits a Git-discovery warning for reports outside the repository; summary source/runner identities, build identity and case artifacts remain present and were inspected.
- Full-repository `cargo fmt --check` reports formatting differences in unrelated, unmodified files; the changed Rust file passes. No unrelated formatting was applied.
- TC-MAIL-STORAGE-03 and TC-MAIL-PERF-03 only received the advanced-disclosure prerequisite and shifted verification references; their full workflows were not rerun. Existing storage regression coverage was supplied by TC-MAIL-STORAGE-01/02.
- Linux/macOS and external mail-provider interoperability were not tested in this Windows-only scope.
