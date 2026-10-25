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

The hosted runs use `qa-ui-auto-platforms.yml`, selected cases, one shard per platform/mode,
and `publish_issues=false`. No issue comments or state changes were published.

- [Initial implementation run 40155353434](https://github.com/engcapa/taomni/actions/runs/40155353434), tested commit `cd638a000e116731ab10b06f3ef3efc5b758d76f`: browser 20 passed; native 24 passed, 6 failed, 0 skipped. Windows native passed all 10. Linux/macOS mail failed because the case operated the include-mail checkbox before the settings snapshot loaded. Four macOS cloud cases inherited Chinese from the authorization case and failed English text assertions; failure captures show the expected translated UI.
- The layout attempts [40156374590](https://github.com/engcapa/taomni/actions/runs/40156374590) and [40157092320](https://github.com/engcapa/taomni/actions/runs/40157092320) exposed stale theme/language selectors in the newly authored case. The corrected case uses the existing General settings controls, which remain available at narrow widths.
- [Focused rerun 40157945707](https://github.com/engcapa/taomni/actions/runs/40157945707), tested commit `74f3b832b28f1597032a3d44ba761ae931d756b9`: re-executes CLOUD-001/002/003/004 and MAIL-STORAGE-02 natively on all three systems, and CLOUD-002 plus SETTINGS-004 in browsers. English initialization and settings-load waits were added without weakening assertions. All 6 browser and 15 native executions passed, 0 failed/skipped. The workflow completed successfully; its aggregate has no infrastructure errors, gaps or unreviewed cases.

The latest matching results, including unchanged cases from the initial run, are:

| Host | Browser passed | Native passed | Failed / skipped |
| --- | --- | --- | --- |
| Linux | 8 | 10 | 0 / 0 |
| Windows | 8 | 10 | 0 / 0 |
| macOS | 7 | 10 | 0 / 0 |
| Total | 23 | 30 | 0 / 0 |

Only YAML and documentation changed after the implementation commit. All runs have the same
production source fingerprint `e9e5171f38f606b4943bb04a28c7297fbe8b2b0179962218fe814a36e079a8e7`
and runner fingerprint `eed6832f8be50f9ec834c012fa4e18cd62e71921978c9c00aab97b89793e3638`.
Unchanged passing cases are reused only with matching source/runner/case identities;
changed cases require the rerun. A newer matching failure or skip takes precedence over an older pass.

Downloaded evidence is retained under `qa-ui-auto-report/backup-settings-unification/ci-<run-id>/`.
`hosted-evidence.json` records 53 current passing case cells, stale case reports and no missing results.
Report receipt signatures, summary hashes, configuration hashes and native QA/build source/binary
identities were checked. Available receipt-listed artifact hashes were checked as well;
some raw QA profile/diagnostic files are omitted from hosted artifacts and are not claimed as retained evidence.

The four SETTINGS-004 screenshots were reviewed: English/light at 950 pixels, Chinese/dark
at 600 pixels, the expanded inherited cloud destination at 600 pixels, and manual controls
at 950 pixels. Labels wrap, fields stay within their sections, and no overlap/clipping was observed.
Windows native authorization recovery and saved-full screenshots were also reviewed.

Evidence boundaries: native COMPAT-001 inspects the fixed legacy files through the real reader;
the Rust compatibility unit additionally applies/restores each archive and checks payload/hash.
Native CLOUD/AUTH cases exercise a loopback service, not real Feishu account authorization.
The retained TC-045 exit regression passes on its declared Linux/Windows browser platforms,
but retains its existing `legacy-imported` review tag and does not certify a full release scope.
