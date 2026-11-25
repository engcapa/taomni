# TASK-005 CoreState implementation and completion plan (2026-11-16)

## Current implementation status

005-A first delivery implements explicit CoreState/LegacyFeatureRuntime composition and every current Rust caller's owner access; common desktop/headless store bootstrap; explicit profile/plugin roots; core-owned mode/profile leases; named cancellable background task ownership; unified graceful renderer/native/backup/updater exit paths; and a reversible registry quiescence guard. State construction no longer starts host supervision, and LSP stale-cache pruning moves from its constructor to the background runtime. Headless now shuts down registry hosts on both normal signal exit and startup errors after listener activation.

The core terminal output hub keeps only weak typed observer registrations. The actual mobile broker remains owned by the explicit legacy runtime. Observation remains synchronous to preserve current replay/order behavior; bounded asynchronous transport and performance acceptance belong to TASK-022 and are not claimed by this delivery. AppAiCtx remains wholly in `legacy.ai_ctx` because its local ASR model state is not yet extracted.

005-A is **in progress**, not a substitute for complete TASK-005. Remaining integration includes the TASK-024/025 real authorized reverse service dispatcher/admission boundary and hosted cross-process/desktop evidence. TASK-005 remains **incomplete** until 005-B removes the real plugin business owners, with only authorized DEC-2 exceptions documented. TASK-015 was the cancelled LanChat migration; it stays cancelled, with no source reads/copies/deletes added here.

Local verification is limited to unit/static commands. Browser/native/process/network integration runs belong to GitHub. New retained-behavior cases are `TC-MODULES-008` (browser/native core note across renderer reload + registry) and `TC-MODULES-009` (native normal close/restart in the same profile + core note/registry); full crash-regression and affected existing feature cases remain required hosted evidence.

## Completion and dependency rules

- `005-A` means real core state composition, explicit temporary legacy ownership, shared startup/shutdown, and a frozen typed services boundary. It unblocks TASK-006/007 and the contracts in TASK-024/025.
- `005-B` is closed by actual plugin host migrations (TASK-014/016/017/018/019/020/021/022). TASK-005 is not complete until those business owners disappear from the application process, except an explicitly recorded DEC-2 exception.
- Registry owns metadata, verified package paths, host handles, RPC clients, cancellation, and supervision only. No business session maps, `Any`, `Box<dyn PluginState>`, duplicate mirrors, or `Deref` forwarding.
- TASK-003 and TASK-004 integration must land before implementing 005-A. A clean worktree from the root integration branch is the implementation base.

## Exact 005-A ownership

The single 005-A integrator owns all composition and mechanical caller rewrites. Other workers may implement contracts or hosts in their own directories, but must not independently edit `state.rs`, `commands/mod.rs`, `lib.rs`, or the Cargo manifests.

| Files | Concrete change |
| --- | --- |
| `src-tauri/src/state.rs` | Keep a small explicit `AppState { core: Arc<CoreState>, plugins: Arc<PluginRegistry>, plugin_downloads: Arc<DownloadManager>, legacy: LegacyFeatureRuntime }` composition shell. Re-export public responder/domain names so existing module imports survive. Remove inferred plugin root and all start-supervision side effects from state construction. |
| New `src-tauri/src/state/core.rs` | Own core state, including profile paths, tunnels, clipboard, core DB, notes, Vault, catalog, workspace/mail/terminal/files/database/agent domains. Constructor accepts typed already-created dependencies; it does not spawn or attach desktop UI. |
| `src-tauri/src/state/domains.rs` | Keep the existing small core domain structs, with explicit imports instead of `use super::*`. Move only RemoteDesktopRuntime out. No unnecessary splitting of this currently 130-line file. |
| New `src-tauri/src/state/legacy.rs` | Explicit temporary owners: SocksCapRuntime, ServerRegistry, the single servers-tab lease, lazy MfaStore, RemoteDesktopRuntime, MobileRuntime, and mixed AppAiCtx. Hold the existing objects once; never build replacement maps. Include owner/task comments for every field. |
| `src-tauri/src/state/mail.rs` | Move core mail-cache accessors and account-file stem logic to `impl CoreState`; `AppState::mail_db/mail_cache_root` may remain explicit one-line compatibility methods calling `self.core...`. No field-level forwarding. |
| All Rust users of `AppState` | Rewrite access explicitly: `state.core.db`, `.core.agent`, `.core.terminal`, etc.; temporary features use `state.legacy.mfa`, `.legacy.remote_desktop`, etc. Narrow pure helper arguments to `&CoreState` as each touched helper allows. Tauri `State<AppState>` stays the public managed type during migration. |
| New `src-tauri/src/runtime/mod.rs`, `paths.rs`, `profile.rs`, `bootstrap.rs`, `tasks.rs`, `shutdown.rs`, `desktop.rs` | Shared lifecycle owner and adapters described below. Each implementation file stays below 800 lines, preferably 200–500. |
| `src-tauri/src/lib.rs`, `main.rs`, `mobile/headless.rs`, `mobile/mod.rs` | Replace duplicate startup with runtime bootstrap. Move CONFIG_ROOT and ModeLease out of mobile. Remove mobile's old `CoreState<'a>` Deref wrapper; `Core::state()` returns an explicit `&AppState` reference without forwarding feature fields. No Deref hiding the new split. |
| `src-tauri/src/backup/coordination.rs` | Keep the existing core ProfileLease/BackupProcessLock semantics. Runtime owns their lifetime. Only extract generic lease primitives if necessary; do not duplicate or alter lock paths. |
| `src-tauri/src/backup/scheduler.rs`, `app_exit.rs`, `commands/application.rs` | Route normal exit through one coordinator while retaining ExitGate retry/cancellation behavior. A scheduler finishing its exit backup completes the same exit attempt. |
| `src-tauri/src/commands/mod.rs` | Mechanical access/router changes only. It is already 795 lines; add future compatibility routes in separate files and avoid growth. Preserve names, args, returns, events, and invoke ACL behavior. |
| `src-tauri/src/webview_recovery/mod.rs` | Mechanical access only; this file is already 783 lines. Extract any new feature cleanup registration into `webview_recovery/feature_cleanup.rs`; maintain generation guards. |
| `src/lib/updateService.ts`, IPC application wrapper, their existing focused tests | Route restart through a backend lifecycle prepare/restart command so process-plugin relaunch does not bypass teardown. Preserve update flow and authorization behavior. |
| `scripts/modular-boundaries.mjs`, focused boundary fixtures, design/ADR task status | Enforce the new boundaries and record actual 005-A integration/verification progress and 005-B pending rather than marking TASK-005 complete. |

### Deliberate transitional AI and mobile boundaries

For 005-A, keep the entire mixed `AppAiCtx` in `legacy.ai_ctx`; rewriting it as a core field would hide `Arc<AsrManager>` and its native model state. TASK-021 will split core AI configuration/cloud routing/inspector policy from host-owned local recognition and FIM before removing this temporary field. This is explicit migration debt, not proof that core AI is already independent.

Similarly, `TerminalOutputHub` currently owns `Arc<mobile::pty_broker::Broker>`. Two safe stages are required: define the core typed output-observer contract and make the temporary mobile adapter own the real broker; then replace the hub's broker field with a bounded core observation channel. Do not put the broker behind a generic trait object and call it migrated. If the hot-path replacement is deliberately left for TASK-022, record the remaining transitive dependency and do not claim core-only mobile independence. A no-op observer must preserve desktop output, and delivery must never block PTY reads or call a subscriber while holding the desktop subscriber lock.

Typed contracts should use core DTOs and wire RPC clients, not `&AppState` exposed to hosts. They cover terminal/session observation, explicit terminal/control operations, window-generation cleanup, scoped Vault keys, capture, and backup snapshot. TASK-024/025 own their concrete service contracts. 005-A owns composition/registration and must coordinate exact file ownership with those implementors.

## Actual state ownership after all 005-B migrations

| Core | Host / temporary legacy owner |
| --- | --- |
| tunnels; clipboard; taomni.db; notes.db; Vault; catalog; workspace LSP/DAP/SDK; mail caches/pool/archive; terminal PTYs/output/auth responders/local directory; SFTP/transfers/object storage/file handles; database/HBase; agent process registries/chat/capture/permission/tool-call maps | MFA store; VNC sessions/detach claims/connect attempts/key-hook globals; RDP sessions; all server running/status/log/approval/task state; SocksCap orchestrator/helpers/recovery/xray state; OCR/recording encoder and cancellation state; local ASR contexts/model state; FIM singleton; MobileRuntime and observer/control adapters unless DEC-2 |

SSH keyboard-interactive MFA prompts remain core. Session metadata remains core even when the RDP/VNC plugin is absent. AppAiCtx's local model members and FIM globals must move with TASK-021; screenshot recording globals must move with TASK-020, not merely disappear from AppState.

Servers manager-tab locking is one shared `servers/manager-tab` resource, not three independent locks for the future server hosts. Freeze one core generic window/resource lease broker with typed host claims and window-generation cleanup, or one designated server-manager owner. Do not duplicate the OS lock or change cross-window semantics.

## Bootstrap contract and exact order

Suggested public types:

```rust
enum StartupMode { Desktop, Headless }
struct ProfilePaths { data: PathBuf, config: PathBuf, cache: PathBuf, plugins: PathBuf }
struct BootstrapOptions { mode: StartupMode, paths: ProfilePaths /* explicit overrides */ }
struct ApplicationRuntime { /* state + tasks + leases + lifecycle owner */ }
```

1. Resolve explicit paths once. Preserve macOS debug QA overrides and custom headless `<data>/config`. Plugin commands receive `paths.data` directly; stop deriving it from the plugin root or mail-cache parent.
2. Run the existing identity/profile migration in its existing pre-open position. Never inspect/read/copy/migrate/delete `lanchat.sqlite`.
3. Acquire `.mobile-mode.lock` (desktop shared/headless exclusive), then ProfileLease. Pending restore/journal recovery acquires exclusive profile ownership before opening any database or plugin.
4. Open and initialize only core stores. Existing server_configs and rdp_certificate_pins initialization is explicitly isolated in a legacy bootstrap adapter until the relevant migrations. Lazy MFA behavior remains lazy so a broken mfa.db cannot block startup.
5. Construct core domains, legacy owners, registry, downloads, and service registration with no spawned side effects. A malformed optional plugin remains a disabled registry record, never a core-start failure.
6. Attach desktop-only handles/LSP, window lifecycle cleanup, search/history state, and screenshot UI through the desktop adapter. Headless never creates Tauri Builder/AppHandle.
7. Only after construction and required attachment succeed, start supervision and owned background jobs: catalog refresh, agent reaper, backup schedulers/jobs, tunnel autostart, legacy SocksCap repair/xray, server autostart; mobile observer/code rotation belongs to the headless adapter when enabled.
8. Commit BootstrapGuard. On any earlier error, cancel and join started tasks, stop hosts, close opened runtimes/stores, and release leases last. Task closures retain Weak/core handles as possible; avoid an AppHandle/runtime Arc cycle keeping the process alive.

Task ownership uses named handles and a CancellationToken/JoinSet. Reaper extraction preserves the existing active-chat + active-process + idle-window predicate; never reap an active turn. Abort fallback follows cancellation and a bounded join, rather than silently detaching work.

## Shutdown/quiescence contract and all entrances

Separate reversible `quiesce(reason) -> QuiescenceGuard` from permanent `shutdown(reason)`. Existing registry `shutdown()` permanently sets shutting_down and cannot implement a cancelled restore or failed exit preparation.

Normal exit is two-phase:

1. **prepare** under ExitGate: run on-exit backup while stores/required services still work; perform SocksCap privileged recovery-safe teardown; await recording finalization; stage failures return an actionable error and reset gate without `closing_all` or permanent registry shutdown.
2. **commit**: revoke UI outputs/new work, permanently reject new host launches/RPCs, cancel pending calls, stop/join plugin hosts and legacy long-lived services, cancel/join task owners, close service resources; call `closing_all` and platform exit/restart exactly once. Leases outlive stores/hosts. The final RunEvent::Exit path is an idempotent bounded safety fallback, never the only graceful path.

Every entrance must be routed/tested:

- Renderer `exit_app` and recovery-dialog exit (`webview_recovery/mod.rs`).
- Native Quit / Cmd+Q / OS exit and last-window CloseRequested behavior, preserving current platform semantics and quit prevention.
- Backup scheduler's second `app.exit` call after an on-exit backup; prevent recursion/double backup/double shutdown.
- Updater relaunch in `src/lib/updateService.ts:relaunchApp`, direct process-plugin relaunch, `RunEvent::ExitRequested` with RESTART_EXIT_CODE. Tauri restart may be unpreventable, so prepare must run before requesting restart and Exit stays an idempotent fallback.
- Startup rollback at every failed stage, including failed desktop window creation.
- Headless SIGINT/SIGTERM (stop), SIGHUP (rotate/show code only), and errors after starting mobile/Feishu. Current headless cleanup misses registry shutdown; close this gap.
- Restore/migration quiescence: refuse new work/spawns, snapshot desired enabled/active state, cancel/wait handles, acquire exclusive profile, apply mutation, resume only previously desired installed/enabled services. Cancel/error drops a guard that restores acceptance without replaying requests.
- Renderer death/window recreation: release only that renderer's channels and window-generation claims. Keep PTYs, chat turns, services, downloads, and recording finalization alive according to current policy.

Core helper entrypoints (`--ssh-stdio-forward`, Windows `--screenshot-scroll-input`) remain core. `--vnc-special-key-hook` and macOS `--sockscap-redirector-bridge` move with their hosts under TASK-024; update launcher and helper dispatch together. `--headless` follows DEC-9 / explicit DEC-2 outcome; if mobile becomes a plugin and is absent, return a clear startup error, never fall back to hidden monolith execution.

## Explicit compatibility façade

- Keep `AppState` as the managed composition object and preserve core Tauri command names/serializable contracts. Field usage is always `.core.*` or `.legacy.*`; no `Deref`, public duplicate fields, or macro-generated implicit access.
- Existing `mail_db` and other truly shared methods may explicitly delegate to the core owner. A plugin command façade maps its exact legacy payload/result to `plugin_invoke(slug, command, typed_payload)` once that plugin migrates.
- Transitional feature routing is selected explicitly in composition, not on host failure. Disabled/missing/invalid plugins return stable unavailable errors or placeholders; they must never execute the legacy implementation as a fallback.
- New command routing stays in dedicated `commands/compat_*.rs` files. Preserve current events/Channel ownership/cancellation and frontend APIs until the front-end plugin route migration is complete.
- Core service reverse requests need real bidirectional dispatch: the current process response loop discards host-to-core requests except heartbeat notifications. A declared Vault/capture/snapshot service is not implemented until it can receive authorized, correlated, cancellable requests. Coordinate this with TASK-024/025, do not pass `AppState` to a host.

## 005-B closure order and dependencies

1. MFA (TASK-014): verified host + scoped exact `mfa.data-key-v1` Vault service + capture + legacy readonly migration/snapshot. Remove real MfaStore after upgrade and lifecycle cases pass; SSH prompts remain.
2. VNC/RDP clients (TASK-016): move session maps/claims/static helpers, relay lifecycle and re-exec, preserve core session records and one-use credentials. Remove legacy remote desktop owner only after native detach/reconnect/failure tests pass.
3. RDP/VNC servers then servers (TASK-017/018): freeze shared lock broker, split ServerRegistry/approval/task ownership, capture/TCC/input policy, autostart and server_configs row migration. Remove unconditional core plugin schema initialization.
4. SocksCap (TASK-019): move all runtime/recovery/xray/helper state and bridge entrypoint; privileged helper boundary and residual-recovery warnings remain explicit; verify upgrade/uninstall/parent death before removing legacy owner.
5. Screenshot/local AI (TASK-020/021): move recording globals/OCR and local ASR/FIM owners. Split mixed AppAiCtx at this point so only core config/cloud router remains; preserve config reload snapshots and cancellation. Core still capture/overlay/scroll, cloud ASR, microphone capture and cleanup stay core.
6. Mobile (TASK-022): observation and explicit control ports, headless and desktop services, hot-path performance evidence, or explicit DEC-2 retention. Remove all direct core-path imports and real business state only if go; synchronize exception into design, modules.json and release notes.

Only after these close: remove `LegacyFeatureRuntime`, compatibility implementation modules and legacy dependencies; make state boundaries mandatory for the final core-only build. TASK-006 validates Cargo/default-feature/resource/dependency closure separately; a smaller state.rs is not build/package purity evidence.

## Validation and evidence

Local: focused unit/static checks only, per user requirement. Do not launch browser/native/cross-process apps locally.

- Unit bootstrap tests with in-process fake stage/resources: construction spawns nothing; GUI/headless same core schema; paths explicit; invalid optional module is disabled; startup failure unwinds in reverse order; no lanchat access.
- Unit owner identity tests: core and compatibility methods reach the same Arc/store; state is not duplicated; legacy feature construction occurs once. Use observable behavior, not only field existence checks.
- Unit lifecycle tests: keep existing ExitGate once/failure/concurrency/cancel tests; add ordered prepare/commit, failed prepare still accepts plugin calls, restart exactly once, scheduler backup once, shutdown idempotent, headless cleans registry/tasks, SIGHUP does not stop runtime.
- Unit task/observer tests: cancellation/join/late results; reaper active-turn semantics; disconnected renderer unsubscribes without terminating PTY; bounded observation overload behavior and no stale-generation cleanup.
- Static boundary tests: core/domains cannot import plugin business types; no new Deref forwarding; plugins cannot own internal business maps in Registry; compatibility/task debt explicit; source-file limits maintained. Run `pnpm check:refactor`, formatting, focused Rust/Vitest checks before commit.

Hosted GitHub only:

- Run `qa-ui-auto-platforms` browser plus matching native QA binary for affected module/core commands and complete crash-regression suites on the required platform matrix. Preserve per-case requires-plugin/core-only accounting and DEC-2 mobile status.
- Extend existing TC-MODULES-001/004/005 instead of only adding stub assertions. Add focused scenarios for startup profile isolation, window reload keeping native work alive, retry after a refused exit, graceful normal quit/relaunch, and headless/desktop same-profile lease behavior. Allocate new case IDs after checking the final integration branch.
- Real helper/re-exec, host process tree cleanup, OS leases, TCC/keyboard/menu delivery, parent death, restore quiesce and upgrade from 0.5.x are native/cross-process workflow tests, not evidence inferred from browser stubs or in-process tests.
- Use the merged upgrade workflow for old monolith fixture -> new runtime, pending/failed signed package -> startup/retry, data/key/archive compatibility, repeated/cancelled migrations, and lanchat byte fingerprints unchanged.
- Fetch each completed shard's case/report/log artifact while other shards are still running. Attribute failures against changed behavior, fix relevant cases/code and rerun; record unrelated failures separately as user-authorized ignores. Do not wait for the summary job to inspect failures.

Review evidence labels must distinguish 005-A structural/lifecycle completion from 005-B plugin-state migration and G1–G11 gates. No claim of full TASK-005 / core-only purity until all required work passes or an authorized DEC-2 exception is recorded.

### Local evidence snapshot (2026-11-16)

The final Rust unit harness was rebuilt successfully by `cargo test --manifest-path src-tauri/Cargo.toml --lib runtime::paths::tests --locked` at source commit `e9b65d99b2a879eb00a8362db6725d83bd1f5097`. All sources were stable before that compilation. The same harness then ran the following exact filter union serially, without recompiling or launching an application, host, network fixture, browser, or native session:

| Rust unit filter | Passed | Behavior established |
| --- | ---: | --- |
| `app_exit::tests` | 3 | Prepare ordering, once-only commit, cleanup failure/retry, concurrent attempts and cancellation before commit. |
| `runtime::bootstrap::tests` | 3 | Lazy optional data and mail owner identity; desktop/headless core schema and profile lease lifetime; startup failure releases mode/profile ownership. The fixture also verifies unchanged LanChat bytes. |
| `runtime::paths::tests` | 1 | Explicit plugin root independent of mail-cache location. |
| `runtime::tasks::tests` | 1 | Owned work cancels and joins, shutdown is repeatable, and late work is refused. |
| `runtime::reaper::tests` | 1 | Active turns survive the idle-window predicate. |
| `terminal::observation::tests` | 2 | Weak registrations do not retain the feature runtime; callbacks run outside the observer-registry lock. |
| `plugin::quiescence::tests` | 3 | Declared calls are refused without starting/disabling the module; nested/cancelled mutations recover acceptance; a dropped guard cannot undo permanent shutdown. |
| `backup::scheduler::tests` | 4 | Cancelled exit-backup retries do not rerun a completed backup; due schedules, enabled frequencies and clock rollback retain their behavior. |

Result: **18 passed, 0 failed, 0 ignored**, 2,170 unrelated tests filtered out. The local raw log is `/tmp/taomni-005a-final-unit.log`; `/tmp/taomni-005a-final-unit.json` records the exact filters, source commit and harness SHA-256 `27cdb67a98db2174d12974288445ab685ad7899605ceb1601528c06872488912`. These temporary files are local supporting evidence, not hosted execution receipts or release artifacts.

Other completed checks:

| Check | Result |
| --- | --- |
| `src/lib/updateService.test.ts` | 8 passed. |
| Focused existing MainLayout exit tests | 3 passed: application menu exit, cleanup failure/retry, and titlebar close. Other tests were deliberately filtered. |
| Modular boundary script unit tests | 7 passed. |
| `pnpm exec tsc -b --pretty false` | Passed. |
| `pnpm check:refactor` | Passed: 800 native commands, 274 facade exports and 29 literal events preserved; module boundaries and source sizes pass. |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | Passed after the cancellation fix. |
| QA catalog audit `--gate` and exact selection plan for `TC-MODULES-008`/`009` | Passed. These are static catalog/selection checks, not executed case evidence. |

The earlier production `cargo check --lib --locked` passed before the final cancellation fix; the final Rust test-harness compilation above covers that fix. This snapshot does not cover later root-branch service/admission/download integration.

The committed teardown handoff is synchronous before `ExitGate::run` returns, but the current pure tests do not directly hold teardown pending after commit, drop its IPC caller, and assert continued cleanup or repeated native-exit prevention. Those remain explicit acceptance gaps alongside the pending hosted cases, crash-regression, real host/service, restore and old-monolith upgrade evidence. 005-A and complete TASK-005 therefore remain **in progress**.
