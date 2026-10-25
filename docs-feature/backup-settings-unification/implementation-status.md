# Backup settings implementation and verification

Branch: `feat/backup-settings-unification`.
Base: `65a822785a86c52671983076cd0a244c59626260`.

## Delivered behavior

- Only the existing Backup group is reorganized; Settings navigation, grouping and search are unchanged.
- One persisted global scope drives all manual destinations and file exports. Full selects mail atomically; explicit mail exclusion remains visible and durable. Full still excludes local file history.
- Automatic local/cloud destinations can inherit or override that scope. New cloud destinations inherit; a missing legacy marker means custom and preserves the original source.
- Narrow revision-checked policy/control patches preserve device identity, connections and scheduler timestamps. A single frontend queue retains failed drafts, rejects stale reads and flushes writes before execution. Passwords remain separate OS credential-store writes.
- Cloud task journals freeze their execution source; retries reuse it. No range/inheritance/revision fields enter an archive.
- Authorization has an independent banner, durable cancellation intent, cleanup acknowledgement, conditional owner release and dismissal tombstones. Cancellation cannot commit a late granted credential bundle. Clearing local feedback does not delete a remote application, registration recovery material, saved connection or another target's password.
- Existing proxy app/custom/none configuration, background transfer progress, cancellation/retry/discard, cache cleanup, readable device history and restore remain available. Credential-store errors are target-specific, keeping local settings usable.
- English/Chinese labels, summaries, save states, authorization recovery and translated error categories update without remounting or resetting tasks.

## Implementation boundaries

The settings snapshot and patch commands own policy/control persistence, while
`backupSettingsStore` owns their renderer draft. `backupStore` remains a compatibility
facade for local history/restore and delegates policy operations. The separate
`backupControlStore` observes backend-owned authorization/transfers. Channel settings,
global/manual sections, history and restore dialog have separate views.

Feishu's former mixed authorization module is split into session journal/ownership,
task orchestration, connection flow, and the retained credential refresh facade.
Public commands and event names remain; new commands are registered in both Tauri
handlers and the command dispatcher. The legacy batch entry adapts to global scope;
low-level archive creation keeps its explicit scope API for existing callers.

The archive codec, manifest and restore mapping are unchanged. Fixed independently
encoded plain/V1/V2 samples exercise inspection and actual restore with checksums and
unchanged source bytes. Newly written archives retain manifest version 1 and the
existing ZIP paths and encryption envelope. See
`src-tauri/tests/fixtures/backup/README.md` for fixture provenance.

## Local verification

No local browser/native application automation was run, as requested.

- Frontend: focused Vitest store/component regressions using Node 22.23.4 and pnpm 10.34.8: 35 passed, including waiting for pending writes before exit, cancelling exit after failure and retrying the retained draft.
- Application shell: `src/layouts/MainLayout.test.tsx`: 48 passed after integrating the Backup save guard into the existing exit flow.
- Rust: `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --features hbase-kerberos,rdp-server-audio,voice-capture,asr-sherpa --lib backup:: -- --test-threads=1`: 63 passed after final review (log: `qa-ui-auto-report/_local/backup-rust-unit-verified.log`).
- Default-feature local linking hit an existing Whisper `/MT` vs cityhash `/MD` conflict. The focused backup tests exclude only the unrelated Whisper feature. No product dependency changes were made for that environment issue.
- The mail restore unit fixture now closes its cached connection before startup restore, matching the production lifecycle and Windows file replacement rules. Payload and redirect assertions are retained after reopening.
- TypeScript, refactor contracts/boundaries/size, Rust formatting and QA catalog gates passed. Fixture unit checks: 3 passed. Hosted selection includes the retained TC-045 exit confirmation regression alongside the Backup/mail/MFA cases.

## Hosted verification selection

Run `qa-ui-auto-platforms.yml` with exact branch SHA, Linux/Windows/macOS, browser/native,
`publish_issues=false`. Keep RDP/tool contracts enabled. Browser/native builds and execution
remain hosted. Record run URL, tested SHA, selected/pass/fail/skip counts and evidence review
below when the run completes.

| Acceptance | Evidence |
| --- | --- |
| Full persistence, failed drafts, CAS/queue, inheritance/manual semantics | Vitest settings/store/component units; TC-BACKUP-SETTINGS-001/002/003 |
| Issue #714 cancellation after adding another target, cleanup and dismissal | Rust session units; mounted component regression; TC-BACKUP-AUTH-714/715 |
| Fixed legacy archive compatibility | Rust compat_tests; TC-BACKUP-COMPAT-001 |
| Local scheduling/retention and MFA/vault | TC-BACKUP-001; TC-MFA-103; retained Rust backup tests |
| Proxy/password configuration and language changes | TC-BACKUP-CLOUD-001/002; component units; existing network units |
| Token refresh, retry, renamed cloud folders and device filtering | TC-BACKUP-CLOUD-003/004/005 |
| Complete mail backup inclusion/exclusion and storage behavior | TC-MAIL-STORAGE-01/02; retained native mail snapshot unit |

Loopback service evidence establishes native IPC/network/credential/journal/archive
boundaries; it does not claim real Feishu account registration, permissions or provider
history rollback. No personal or enterprise account was changed during local verification.

## Final evidence

Pending hosted execution; this section is updated with actual receipts rather than plan status.
