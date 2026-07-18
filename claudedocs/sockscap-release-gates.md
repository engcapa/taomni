# Sockscap Release Gate Ledger

- Snapshot: 2026-07-18
- Branch: `feat/sockscap-gpt-sol-max`
- Design baseline: [sockscap-cross-platform-design-plan.md](./sockscap-cross-platform-design-plan.md)
- Capture ADR: [sockscap-phase0-adr.md](./sockscap-phase0-adr.md)

## Current verdict

**Not ready for Windows Beta, macOS release, Linux release, or the
“cross-platform stable” label.**

This branch implements the policy/egress/persistence/IPC/UI foundation,
strict SSH host-key handling, a recovery journal, guarded exit, and a native
tray shell. It intentionally keeps native capture unavailable:
`capture_implemented = false` and all real start capabilities remain false
until a signed/privileged platform adapter is installed and verified.

It is safe to review or merge as a **preview-only, fail-fast foundation**. It
must not be marketed as a working system/process traffic interceptor, and the
capability gate must not be bypassed for a demo.

## Status legend

| Status | Meaning |
|---|---|
| PASS | Repeatable evidence in this branch satisfies the listed software gate. |
| PARTIAL | A useful slice exists, but the design exit criterion includes evidence not yet produced. |
| BLOCKED | Required platform capability, entitlement, signing, helper, driver, or lab work does not exist yet. |
| NOT RUN | Implementation may exist, but the required verification was not executed for this snapshot. |

## Verification evidence

| Check | Result | Release interpretation |
|---|---|---|
| `pnpm build` | PASS | TypeScript project build and Vite production build completed. Existing chunk-size and ineffective dynamic-import warnings remain. |
| Sockscap frontend tests | PASS — 12 files, 66 tests | Covers components, helpers, store, window routing, and browser Stub behavior. |
| `cargo test sockscap --lib --quiet` | PASS — 126 passed, 0 failed, 879 filtered | Covers the Rust Sockscap modules reachable through the library test target. Repository-wide Rust warnings remain; this is not a full `cargo test`. |
| `cargo check --lib` | PASS | Library compiles; existing unrelated warnings remain. |
| `qa_ui_auto.lint` | PASS — 132 unique cases, 0 errors | Feature/testcase schema and selector ownership parse successfully. |
| Sockscap control coverage | PASS — 81/81 required, shallow 0 | Six cataloged areas: Dashboard 15/15, Profiles 27/27, Process Picker 6/6, Rules 26/26, Capabilities 2/2, Recovery 5/5. |
| Six Sockscap YAML cases, `--dry-run` | PASS — 6/6 | YAML/schema/step dispatch is valid; this does not prove DOM behavior. |
| Browser qa-ui-auto preflight | BLOCKED | `http://localhost:5000` was not running. The skill forbids auto-starting Vite without explicit approval, so the six YAML cases were not run against a live browser. |
| Global `qa_ui_auto.audit --gate` | FAIL — 12 non-Sockscap regressions | Sockscap features are fully covered, but the repository gate remains red; details are recorded below and must not be ratcheted away. |
| Full `pnpm test` | NOT CLEAN | An earlier full run reached 208 test files and 1625 assertions, then emitted the known post-teardown `window is not defined` error in `useWorkspaceGitSnapshots.test.tsx`; the isolated file passed. A clean full process exit is still required. |
| Tauri/native independent-window and tray smoke | NOT RUN | jsdom/browser mode cannot prove native window labels, tray clicks, hide/show behavior, or guarded process exit. |
| Performance, long stability, leak, install/upgrade/uninstall | NOT RUN | Required hardware and platform lab gates remain open. |

The coverage baseline was updated only with the six fully covered Sockscap
features. The updater refused a full ratchet because that would accept existing
regressions. The remaining global gate failures are:

1. global shallow controls: 21 to 36;
2. global orphan selectors: 112 to 135;
3. `F1.6` shallow: 1 to 2;
4. `F1.8` shallow: 0 to 1;
5. `F1.9` covered required: 6 to 5;
6. `F4.2` shallow: 1 to 4;
7. `F5.2` covered required: 15 to 2;
8. `F5.5` covered required: 3 to 1;
9. `F6.2` shallow: 0 to 5;
10. `F6.4` covered required: 7 to 6;
11. `F-AI-2.4` shallow: 3 to 5;
12. `F-ImportPreview-1` shallow: 4 to 5.

## Phase exit ledger

| Phase | Status | Evidence present | Missing exit evidence |
|---|---|---|---|
| Phase 0 — capability/license gate | BLOCKED | Capability probes, fail-fast preflight, accepted non-final ADR, license principles, recovery model. | Three real platform vertical slices; Windows capture choice; entitlement/signing; repeatable three-egress servers; stop/kill recovery; DNS/IPv6 leak audit; VPN/sleep/NIC matrix. |
| Phase 1 — policy/rule core | PASS for software scope | Profile model, overlap rejection, GFWList projection, exceptions, unsupported reporting, immutable matcher snapshots, target explanations, last-good behavior, Rust tests. | Live mirror availability remains an operational rather than parser gate. |
| Phase 2 — FlowEngine/egress core | PARTIAL | DIRECT, SOCKS5 TCP, HTTP CONNECT, shared SSH `direct-tcpip` pool, loop bypass, cancellation/stats boundaries, strict host-key confirmation. | Repeatable real SOCKS/HTTP/SSH server matrix for auth failure, DNS, IPv4/IPv6, disconnect/reconnect, MFA, concurrency and cancellation; SOCKS5 UDP ASSOCIATE stable gate. |
| Phase 3 — persistence/IPC/Stub | PASS for software scope | Dedicated SQLite/WAL store, recovery journal, bounded statistics/live outcomes, Rust/TS IPC contract fixture, browser Stub and scenario controls. | Native helper heartbeat/artifact cleanup can only close with a real capture helper. |
| Phase 4 — independent UI | PARTIAL | Independent route/window shell, complete profile/rule/process/capability/recovery UI, dashboard privacy controls, 66 frontend tests, six QA cases and catalog. | Live browser execution of the six YAML cases; keyboard/accessibility review; real Tauri independent-window smoke. |
| Phase 5 — Windows vertical | BLOCKED | UI/core capability model only. | Wintun global capture; WinDivert vs WFP decision; app/PID attribution; signed driver/helper installation; EDR/VPN; crash/update/uninstall recovery; Windows package matrix. |
| Phase 6 — macOS vertical | BLOCKED | UI/core capability model only. | Network Extension entitlement; Swift/system-extension target and bridge; audit-token identity; Developer ID signing/notarization; user approval/upgrade/uninstall; Intel and Apple Silicon tests. |
| Phase 7 — Linux vertical | BLOCKED | UI/core capability model only. | Least-privilege helper; polkit/capabilities; cgroup v2+nft+fwmark/TUN; managed netns fallback; resolved/NetworkManager/IPv6; distro and package matrix. |
| Phase 8 — tray/reliability/release | PARTIAL | Dynamic native tray code, Linux menu fallback, guarded stop-before-exit transaction, login restore opt-in, recovery UI, Rust/frontend regression tests. | Native tray/window smoke on supported platforms; sleep/NIC/VPN/upstream fault matrix; 100 start/stop cycles; kill/power-loss recovery; long stability, performance, leak, packaging and uninstall tests; clean global QA gate. |

## Definition of Done audit

| Design requirement | Status | Notes |
|---|---|---|
| Windows, macOS and supported Linux run global + application group | BLOCKED | No platform capture adapter is implemented. |
| Running PID selection with new-connection semantics | PARTIAL | Model, PID/start-time guard, privacy-bounded picker and degradation UI exist; native capture does not. |
| SOCKS5, HTTP CONNECT and SSH Jump TCP against real servers | PARTIAL | Connectors and shared SSH pool exist; full real-server matrix was not executed. Changed SSH host keys are rejected in code. |
| GFWList refresh/fallback/exceptions/manual/test-target | PASS for software scope | Parser, snapshots, manual override, target explanation, persistence and UI are covered. |
| DNS/IPv6/UDP state does not silently leak | PARTIAL | Explicit policies and dashboard unknown/degraded state exist; native packet/leak verification is absent. |
| Multiple profiles run stably through one capture plane | PARTIAL | Conflict/priority core exists; there is no real capture plane. |
| Window hide/tray recovery is platform-correct | PARTIAL | Code and unit tests exist, including Linux menu fallback; native smoke is absent. |
| stop/crash/restart/upgrade/uninstall leave no network state | PARTIAL | Journal, guarded exit and dirty-marker refusal exist; real system artifact tests are absent. |
| Secrets stay in Vault and telemetry remains bounded | PARTIAL | Egress references resolve through saved sessions, logs/stats omit payload/full URL/credentials, and browser tests assert privacy boundaries; native audit and package review remain. |
| Rust, Vitest, qa-ui-auto, native smoke, performance and long-run gates all pass | BLOCKED | Only focused Rust/frontend and static/dry-run QA gates pass. |

## Platform work required before release labels

### Windows Beta

All of the following must pass before using the Windows Beta label:

- amend the ADR with WinDivert versus WFP ALE selection and approved licenses;
- implement signed Wintun/global and app/PID capture paths with hard self/upstream bypass;
- verify IPv4, IPv6, DNS and TCP through SOCKS5, HTTP CONNECT and SSH Jump;
- verify install, upgrade, rollback, crash, kill, reboot and uninstall cleanup;
- run EDR, Windows Defender, common VPN and NIC/sleep compatibility matrices;
- run native window/tray/guarded-exit smoke and the performance targets;
- obtain a clean full Rust/frontend/qa-ui-auto release gate.

### Linux release

- define the supported distro/kernel/systemd matrix;
- ship and review a least-privilege helper with a recoverable install path;
- validate cgroup v2+nft+fwmark/TUN and the managed netns fallback;
- prove no route, nft, cgroup or DNS residue after every failure/uninstall path;
- run native tray menu, package, performance and compatibility gates.

### macOS release

- obtain the Network Extension entitlement before claiming capture support;
- implement, sign and notarize the system extension and Rust/Swift bridge;
- validate audit-token application identity, provider bypass and permission denial;
- verify upgrades/uninstall on both Intel and Apple Silicon;
- run native menu/window and recovery gates. Tauri WebDriver does not replace the
  required macOS manual/native system-extension validation.

### Cross-platform stable

Windows, Linux and macOS platform gates must all be green, including recovery,
packaging, performance and long stability. Windows Beta passing alone does not
permit the cross-platform stable label.

## Next executable verification steps

Browser QA requires explicit approval to start the development server:

```bash
DEV_PROXY_ALLOW_PRIVATE=1 ALLOW_PRIVATE_TARGETS=1 pnpm dev
python .agents/skills/qa-ui-auto/scripts/probe.py --mode browser
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.runner \
  --filter TC-auto-F-SOCKSCAP-1-dashboard,TC-auto-F-SOCKSCAP-2-profile-editor,TC-auto-F-SOCKSCAP-3-process-picker,TC-auto-F-SOCKSCAP-4-rules,TC-auto-F-SOCKSCAP-5-capability-warning,TC-auto-F-SOCKSCAP-6-recovery \
  --workers 1
```

After browser QA, run native smoke from each platform lab using the packaged or
debug Tauri binary and record artifacts separately. Do not use the browser Stub
result as evidence for capture, elevated permission, independent native window,
tray, driver/helper cleanup, or application exit behavior.
