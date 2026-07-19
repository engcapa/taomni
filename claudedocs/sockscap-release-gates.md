# Sockscap Release Gate Ledger

- Snapshot: 2026-07-19
- Branch: `feat/sockscap-gpt-sol-max`
- Design baseline: [sockscap-cross-platform-design-plan.md](./sockscap-cross-platform-design-plan.md)
- Capture ADR: [sockscap-phase0-adr.md](./sockscap-phase0-adr.md)
- Gate commands: [`scripts/sockscap/README.md`](../scripts/sockscap/README.md)

## Current verdict

**Not ready for Windows Beta, macOS release, Linux release, or the
“cross-platform stable” label.**

The branch now contains more than a UI scaffold: it has the policy/egress/
persistence core, an authenticated Linux root-helper protocol, real Linux
cgroup-v2 + nftables + fwmark/TUN transaction code, recovery receipts, source
gates for Windows signing and macOS signing/entitlements, an isolated Linux
native-window smoke, and fail-closed performance/soak receipt verification.

It still intentionally reports `capture_implemented = false` and
`can_start_global`, `can_start_app`, and `can_start_pid` as false. The Linux
helper source is not yet connected to a packaged product-side launcher and TUN
packet pump; no signed Windows provider/helper package or entitled/notarized
macOS Network Extension is present. The current result is therefore a
**preview-only foundation with release gates**, not working end-to-end host
traffic capture.

## Status legend

| Status | Meaning |
|---|---|
| PASS | Repeatable evidence in this branch satisfies the listed software gate. |
| PARTIAL | A useful slice exists, but the design exit criterion includes evidence not yet produced. |
| BLOCKED | Required platform capability, entitlement, signing, packaging, or lab evidence does not exist. |
| NOT RUN | Implementation may exist, but the required verification was not executed for this snapshot. |

## Verification evidence

| Check | Result | Release interpretation |
|---|---|---|
| `pnpm build` | PASS | TypeScript and Vite production builds complete. Existing chunk-size and ineffective dynamic-import warnings remain. |
| All Sockscap frontend tests | PASS — 12 files, 67 tests | Components, stores, IPC helpers, routing, privacy bounds, and browser Stub behavior pass. |
| `cargo test sockscap --lib --quiet` | PASS — 163 passed, 0 failed, 879 filtered | Includes policy, recovery, helper protocol, Linux transaction, and orchestration tests. Existing repository warnings remain; this is not repository-wide `cargo test`. |
| `cargo check --bin sockscap-gate` | PASS | The release-profile performance/soak harness compiles against production matcher, sampler, store, and transaction coordinator. |
| `pnpm tauri build --debug --no-bundle` | PASS — 6m01s | A Linux native debug application was built without packaging. |
| `qa_ui_auto.lint` | PASS — 133 cases, 79 features, 0 errors | Schema and feature catalog are valid. There are 134 existing repository-wide orphan-selector warnings. |
| testid catalog check | PASS | Generated catalog is current. |
| `F-SOCKSCAP-1` control coverage | PASS — 19/19 required, shallow 0 | Native entry/window controls and Dashboard controls have direct coverage. |
| Sockscap native case dry-run | PASS — 1/1 | YAML verbs/selectors dispatch correctly. |
| Linux native WebDriver smoke `run-20260719-112341` | PASS — 1/1, case 11.3s | Proves main-menu discovery, exactly two native WebViews, Lifecycle navigation, hide, reopen, and state preservation. It does not prove tray behavior or packet capture. |
| Core quick performance receipt | PASS | Final-source release run: 10,000 rules compiled in 9ms; 20,000 timed matches had P99 3.405us against the fixed 100us limit; 100/100 start-stop cycles cleaned the journal; RSS and open files both grew by 0. |
| Short soak execution proof | PASS — 3.213s | Active heartbeat, bounded events, resource sampling, and clean stop execute correctly. This is deliberately **not** 24-hour evidence. |
| Performance receipt verifier | PASS/FAIL-CLOSED — 5 focused tests | Valid local quick/short-soak receipts pass their applicable minimum; tampered claims/counts, lint/native-browser evidence, the disabled platform template, and a 3s receipt presented as 24h evidence are rejected. |
| Windows/macOS source release gates | PASS for static contracts | Disabled manifests and same-platform signature/entitlement/notarization verifiers are committed. No real signed artifacts passed them. |
| Global `qa_ui_auto.audit --gate` | FAIL — pre-existing repository baseline | Current totals are 367/389 required, 36 shallow, and 134 orphans. Twelve non-Sockscap regressions remain and were not ratcheted into the baseline. |
| Full `pnpm test` clean process exit | NOT RUN for this snapshot | Focused Sockscap tests are clean; an earlier full run had a known post-teardown error outside Sockscap. |
| Real capture TCP/throughput/leak/install matrix | NOT RUN / BLOCKED | Requires installed native adapters and per-platform privileged labs. |
| Required 24-hour core and real-platform soak | NOT RUN | The committed verifier requires at least 86,400 seconds and cannot be shortened for release evidence. |

### Evidence boundaries

- `sockscap-gate` uses a synthetic adapter and never changes host networking.
  Its receipts explicitly contain `releaseEligible=false` and
  `evidenceClass=synthetic_core_no_host_capture`.
- The Linux native smoke proves the independent window path only. It is not a
  tray, root-helper, permission, cleanup, DNS, IPv6, UDP, or throughput test.
- The Windows and macOS templates default to release disabled. A source lint
  pass never substitutes for a signed driver/helper or Apple-managed
  entitlement, provisioning, notarization, and system-extension approval.
- Generated receipts and native artifacts stay outside the repository and are
  SHA-256 pinned by the platform manifest.

## Phase exit ledger

| Phase | Status | Evidence present | Missing exit evidence |
|---|---|---|---|
| Phase 0 — capability/license gate | BLOCKED | Fail-fast capability probes; accepted ADR; source release gates; Linux helper/transaction spike; recovery model. | Three real platform vertical slices; final Windows provider choice; actual certificates/entitlements; repeatable three-egress servers; real stop/kill recovery; DNS/IPv6 leak and VPN/sleep/NIC matrices. |
| Phase 1 — policy/rule core | PASS for software scope | Profile model, overlap rejection, GFWList projection, exceptions, immutable matcher snapshots, target explanations, and last-good behavior. | Live mirror availability remains an operational gate. |
| Phase 2 — FlowEngine/egress core | PARTIAL | DIRECT, SOCKS5 TCP, HTTP CONNECT, shared SSH `direct-tcpip`, hard loop-bypass modeling, cancellation/stats boundaries, and strict host-key confirmation. | Repeatable real SOCKS/HTTP/SSH matrix covering auth, DNS, IPv4/IPv6, reconnect, MFA, concurrency, cancellation, and stable SOCKS5 UDP ASSOCIATE. |
| Phase 3 — persistence/IPC/Stub | PASS for software scope | SQLite/WAL store, recovery journal, bounded statistics/live outcomes, IPC contract fixture, browser Stub, helper heartbeat, authenticated receipts, and cleanup recovery state. | Installed product helper client and real host-artifact recovery can only close in a privileged platform lab. |
| Phase 4 — independent UI | PARTIAL | Independent route/window shell, complete UI, 67 focused tests, cataloged YAML coverage, and a real Linux WebDriver hide/reopen smoke. | Native tray click/exit smoke on all platforms, accessibility/keyboard review, and permission/recovery system smoke. |
| Phase 5 — Windows vertical | BLOCKED | Fail-closed manifest and signature verifier; provider contract allows only WFP or WinDivert. | Final provider decision; real Wintun/global and app/PID adapters; signed/timestamped helper, catalog/INF or release-signed driver; install/update/uninstall; EDR/VPN and recovery labs. |
| Phase 6 — macOS vertical | BLOCKED | Release-only Tauri overlay, provider plist/entitlement contract, and signed-app/provider/notarization verifier. | Apple-approved Network Extension capability; real Swift Network Extension/system-extension target and Rust bridge; Developer ID provisioning/signing/notarization; permission, upgrade, uninstall, Intel, and Apple Silicon labs. |
| Phase 7 — Linux vertical | PARTIAL | Real cgroup-v2/nft/fwmark/TUN transaction source; root-only helper; peer credential and executable SHA pinning; HMAC bootstrap; two-phase activate; root-owned receipts; rollback/recovery tests. | Product-side installed launcher/client and TUN packet pump; polkit/package policy; real root smoke with captured TCP/DNS/IPv4/IPv6; managed-netns fallback; distro/kernel/systemd/resolved/NetworkManager matrix. |
| Phase 8 — tray/reliability/release | PARTIAL | Native Linux window smoke; guarded exit; recovery UI; fixed performance thresholds; 100 synthetic lifecycle cycles; fail-closed quick/24h/platform receipt verifier. | Actual adapter 100-cycle cleanup; native tray/system recovery; 24h core and real-capture soak; throughput/latency/leak gates; signed packages and install/update/uninstall matrices; clean global QA gate. |

## Definition of Done audit

| Design requirement | Status | Notes |
|---|---|---|
| Windows, macOS and supported Linux run global + application group | BLOCKED | Linux helper-side mutation code exists, but no product runtime has an end-to-end active capture plane; Windows/macOS release artifacts do not exist. |
| Running PID selection with new-connection semantics | PARTIAL | Model, PID/start-time guard, privacy-bounded picker, cgroup enforcement source, and degradation UI exist; product capture is disabled. |
| SOCKS5, HTTP CONNECT and SSH Jump TCP against real servers | PARTIAL | Connectors and shared SSH pool exist; the full real-server matrix was not executed. |
| GFWList refresh/fallback/exceptions/manual/test-target | PASS for software scope | Parser, snapshots, manual override, explanation, persistence, and UI are covered. |
| DNS/IPv6/UDP state does not silently leak | PARTIAL | Explicit policies and unknown/degraded reporting exist; native packet/leak verification is absent. |
| Multiple profiles run stably through one capture plane | PARTIAL | Conflict/priority core exists; no product capture plane is active. |
| Window hide/tray recovery is platform-correct | PARTIAL | Linux native hide/reopen passes; real tray and cross-platform behavior remain open. |
| stop/crash/restart/upgrade/uninstall leave no network state | PARTIAL | Journal, authenticated receipts, rollback source, and synthetic cleanup pass; installed-system artifact tests are absent. |
| Secrets stay in Vault and telemetry remains bounded | PARTIAL | Egress references use saved sessions; logs/stats omit payload, URL, and credentials; native package audit remains. |
| Rust, Vitest, qa-ui-auto, native smoke, performance, and long-run gates all pass | BLOCKED | Focused software and Linux window gates pass; global QA, real platform capture, signed packages, and 24h evidence remain red. |

## Platform work required before release labels

### Windows Beta

- Amend the ADR with the WinDivert versus WFP ALE choice and approved licenses.
- Implement Wintun/global plus application/PID capture with hard self/upstream
  bypass and reinjection-loop protection.
- Produce timestamped release-signed Taomni/helper/provider/driver artifacts;
  satisfy the committed same-host signature gate.
- Verify IPv4, IPv6, DNS, TCP, cleanup, EDR/VPN/NIC/sleep compatibility, install,
  upgrade, rollback, reboot, and uninstall.

### Linux release

- Wire the helper client/launcher and userspace TUN pump into the product
  adapter, keeping capability start flags false until an installed probe passes.
- Package a reviewed root policy/polkit path; exercise real privilege denial,
  stale receipt, main-process kill, helper kill, restart, and uninstall cleanup.
- Prove real cgroup app-group/global/PID TCP plus DNS/IPv4/IPv6 behavior, managed
  netns fallback, throughput, leak, and 24h stability across the supported
  distro/kernel/systemd/network-manager matrix.

### macOS release

- Obtain the Apple-managed Network Extension capability and build the actual
  transparent-proxy provider/system extension and Rust/Swift bridge.
- Sign, provision, notarize, staple, install, approve, upgrade, and uninstall the
  app/provider with matching team and application-group identities.
- Verify audit-token attribution, hard bypass, permission denial, recovery, and
  Intel/Apple Silicon behavior in native labs.

### Cross-platform stable

Windows, Linux, and macOS platform manifests must all pass on the matching OS,
including real capture, signed artifacts, recovery, packaging, latency,
throughput, leak, 100-cycle, and 24-hour evidence. A synthetic core receipt or
one platform passing never permits the cross-platform stable label.

## Next executable verification steps

1. Follow [`scripts/sockscap/README.md`](../scripts/sockscap/README.md) to create
   quick and 24-hour core receipts outside the repository.
2. In each platform lab, stage the signed-artifact log, native smoke, core
   receipts, real capture matrix, performance samples, soak/recovery results,
   and raw leak/install evidence under one evidence directory.
3. Copy the disabled performance manifest into that directory, set
   `releaseEvidence=true`, pin every artifact by SHA-256, and run the platform
   verifier on the same OS.
4. Keep `capture_implemented=false` until the installed product adapter and its
   privileged end-to-end smoke pass; do not use browser Stub, source lint, or
   the synthetic gate as native capture evidence.
