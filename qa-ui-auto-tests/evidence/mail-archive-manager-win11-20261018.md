# Local archive manager — Windows 11 verification

Local acceptance uses an isolated `com.taomni.app.qa` build and disposable loopback IMAP/SMTP accounts. The installed production app and personal mailbox are not modified. Toolchain: Node 22.23.3, pnpm 10.34.7, Rust 1.96.0, matching EdgeDriver/WebView2 155.

## Behavior and storage design

Local archive searches the entire account, independently of header-cache retention and the visible 200-row page. Search covers subject, sender and To/Cc recipients; filters cover folder, attachment presence, mail date, saved date and original size. Six sort orders, page selection, cross-page selection, all matching with exclusions, and keyboard search/select/cleanup support large collections. Dates include the selected final local day; sizes distinguish original bytes from compressed stored bytes. The centered dialog retains original and attachment export and provides an adjacent original preview.

`mail_archive_index` materializes scalar metadata alongside the existing immutable gzip objects and SHA-256 references. Account/folder/saved-time, mail-date, original-size and attachment indexes support filtering and sorting. External-content FTS5 trigram indexing supports literal substring queries of at least three characters; shorter queries scan account metadata. Parameterized SQL and a literal recheck prevent wildcard/query-syntax interpretation. SQLite triggers update metadata and FTS within the original publication/deletion transaction. Queries do not decompress MIME or parse header JSON.

Existing archives are backfilled transactionally on first initialization. A bounded streaming MIME-header scanner records attachment metadata during compression and repairs legacy missing flags once during migration. Existing missing or unreadable objects retain their metadata. Initial migration can take time for large archives because legacy MIME inspection runs under the database initialization lock; subsequent searches use the index. No speedup or latency benchmark on the user's mailbox is claimed.

Cleanup preview freezes exact folder/UID validity/UID/hash membership in temporary SQLite tables, including exclusions, with a ten-minute expiry. Confirmation rejects changed or expired snapshots; later arrivals are excluded. Reclaimable bytes count unique objects whose final references are removed. Backup hard links can retain space, so the UI describes this as an upper bound. Confirmation pauses full storage and atomically records skip markers and removes selected originals. Server mail remains, shared originals survive, and later scans do not restore deliberately removed copies.

## Verification

- Frontend: 33 focused Vitest tests pass for MailArchiveDialog, MailArchivePanel, MailStorageSettings and mailFolders. TypeScript and Vite production compilation pass in the isolated QA build.
- Rust: `cargo test --manifest-path src-tauri/Cargo.toml --lib mail:: --locked -- --test-threads=1` passes: 141 passed, zero failed, one existing ignored helper. Log: `qa-ui-auto-report/_local/mail-manage-rust-serial.log`. New tests cover indexed pagination/filtering, literal and Unicode search, query plans, legacy migration, attachment metadata, frozen cleanup membership, stale tokens, account isolation and shared objects.
- Changed Rust files pass rustfmt with `skip_children=true`; unrelated repository formatting is outside this change.
- Python: `python -m unittest test_tauri_webdriver.NativeSessionFillTest test_mail_storage_oracle -q` passes all 23 tests, including Windows date input verification and independent original/attachment validation.
- Native manager: TC-MAIL-STORAGE-07 passes with zero skips in `D:/qa-taomni-mail/run-20261018-104204-098805700/summary.json`. The independent SQLite/gzip oracle observes 212 mappings and 211 objects initially, then 3 mappings and 3 objects after cleanup and again after rescan. All retained originals and applicable attachments match fixture hashes. The Archive copy of Invoice 0000 and `invoice.bin` remain readable after removing its INBOX copy. The overview and cleanup preview screenshots were visually inspected, including cleared date fields after Reset filters.

Final QA build log: `qa-ui-auto-report/_local/mail-manage-native-build-final.log`. Source fingerprint: `8cba276bc4491ae8486f85ba98f6833dcc542fe13dc28a81948dc373f5d2c877`; QA executable SHA-256: `5dc8c10fefe2acbaac46261342c629e84eabb24fcb3dd603724c2130bdf73b55`.

- Browser: TC-MAIL-STORAGE-01, 04 and 06 pass, zero failures/skips. Final report: `qa-ui-auto-report/mail-manage-browser-accepted/run-20261018-104324-023688700/summary.json`.
- Native retained behavior: TC-MAIL-STORAGE-02, 03, 04 and 05 pass, zero failures/skips. Final report: `D:/qa-taomni-mail/run-20261018-104324-029226800/summary.json`. These retain complete-original storage/export, relocation/backup/cleanup, retry after size mismatch, readable folder selection and incremental publication/pause/resume/200+150 pagination.
- F-MAIL-23 audit passes with 52/52 required controls covered. Log: `qa-ui-auto-report/_local/mail-manage-audit-final.log`. Development contract reports zero warnings/errors; selected-case CI planning passes. `git diff --check` passes.

All eight case/mode observations are current and passed. `load_observations` accepted all report receipts with no rejections; source, runner, case, configuration and native QA build fingerprints match. Every final summary reports stable execution inputs. Identity check: `qa-ui-auto-report/_local/mail-manage-final-identities.json`.

## Recovered failures and scope

- Older browser cleanup expectations used obsolete notice text and an incorrect seeded-recipient count; assertions were corrected to the actual intended fixture behavior.
- Two native regression cases immediately counted rows before asynchronous query completion. They now wait for query readiness while retaining exact count assertions.
- Screenshot review exposed incomplete dates in Windows segmented inputs. Native automation now enters localized date segments through real keyboard actions and verifies the exact ISO DOM value. Native acceptance also requires nonmatching mail-date and saved-date ranges to return zero before restoring matching ranges.
- A pre-existing Windows relocation child assertion compared ordinary and extended-length representations of the same path. The test now compares canonical paths. A timer test timed out under parallel build/test load; the complete serial mail suite passes.
- The broad WebDriver unit suite includes an unrelated macOS debugger cleanup test that accesses `signal.SIGKILL`, unavailable on Windows. It failed on this host; the focused input tests are reported separately. Linux/macOS native acceptance is not claimed.
- Native reports use `D:/qa-taomni-mail` to avoid Windows path limits. Git-discovery warnings from the external report root do not replace receipt/source/build validation.
- Functional fixtures exercise 212 mappings with a shared object in the manager case and 350 messages in incremental storage regression. They do not establish performance for tens of thousands of real messages.
