# Sockscap Release Gate Ledger

- Snapshot: 2026-07-20
- Branch: `feat/sockscap-gpt-sol-max`
- Design baseline: [sockscap-cross-platform-design-plan.md](./sockscap-cross-platform-design-plan.md) (Revision 9)
- Capture ADR: [sockscap-phase0-adr.md](./sockscap-phase0-adr.md)
- Gate commands: [`scripts/sockscap/README.md`](../scripts/sockscap/README.md)

## Current verdict

**Not ready for Windows Beta, macOS release, Linux release, or the
“cross-platform stable” label.**

The branch now contains the policy/egress/persistence core, authenticated Linux
root-helper and cgroup-v2+nft+fwmark/TUN transactions, recovery receipts,
cross-platform source release Gates, and bounded dual-transport
ingress/`FlowRuntime` code. Packet admission derives its authoritative TCP/UDP
tuple from validated packet bytes, verifies IPv4/TCP/UDP checksums and accepts a
new TCP tuple only on a pure initial SYN. Direct UDP relay has independent
association admission plus a runtime-wide bidirectional in-flight byte budget.
The exact smoltcp 0.13.1 crate is pinned by archive checksum and wrapped in a
bounded `Medium::Ip` staging device, with fragmentation features disabled. A
release-neutral `PacketStackSupervisor` is owned by the only public
`ProductDataPlaneSupervisor`. Its detached generation registry retains startup
and recovery owners across caller cancellation; Linux delegates to it rather
than maintaining a second registry. `FlowRuntime` keeps root-cause diagnostics
separate from current cleanup proof, and cannot report clean until stack,
runtime, profile, egress and task owners are observed joined. Ready shutdown
now fences native/TCP/UDP admission and waits for an explicit provider quiesce
acknowledgement before runtime drain and final stack termination; every phase
retains its owner on timeout. This is still source/memory evidence: the smoltcp
AnyIP/TCP/UDP executable compatibility spike and complete socket actor/bridge,
Virtual DNS/reassembly policy and final `PacketStackProvider` do not exist yet.

It still intentionally reports `capture_implemented = false` and
`can_start_global`, `can_start_app_group`, and `can_attach_pid` as false. Linux now
has fixed-path helper client/session and exact-name, owner-verified TUN L3 I/O
primitives. Its helper plans without side effects,
fsyncs a root-owned write-ahead recovery receipt before every first mutation,
and applies membership changes only after their restore intent is durable.
Linux process identity uses the kernel start-tick incarnation token with
pre/post validation. The lifecycle has bidirectional pump readiness before
activation, combined identity/health checks, serialized mutation,
cancellation-safe owner retention, cleaned-generation tombstones, and a
terminal-fault monitor that withdraws helper capture before stopping local
owners. Linux now also has a generation-scoped product `CaptureAdapter`,
cancellation-safe coordinator/orchestrator recovery injection, and a fixed
helper-policy/polkit DEB/RPM-only packaging and artifact-verification contract.
Capture operations execute as detached runtime transactions under one
store-scoped mutex shared by every `CaptureRuntimeOwner` derived from the same
`SockscapStore`; caller cancellation therefore neither aborts the transaction
nor permits a second runtime owner to bypass serialization. Prepare persists
the adapter and generation binding before a privileged call; recovery uses an
expected-generation CAS/revalidation guard, returned handles must retain exact
helper PID and full context lineage, and untrusted receipts can trigger only
generation-scoped rollback through the bound adapter. Disk-backed
`SockscapStore` uses WAL with `synchronous=FULL`; the in-memory test store stays
at `NORMAL`. Before opening SQLite it canonicalizes and holds the app-data
directory, validates directory/lock/database path identity, rejects unsafe
links, and retains an OS-level owner lock until SQLite closes. On Unix the
directory and lock ownership/modes are hardened and checked; Windows source
uses non-delete-sharing handles and rejects reparse points. This is the current
source-level journal ownership boundary, not a completed native security proof.
The exact-pinned Tauri single-instance plugin is activation UX only. Evidence
currently covers same-process double-open contention/drop-release and source
path-hardening tests. Handle-relative SQLite/VFS opening, Windows SID/DACL,
malicious same-user substitution, true cross-process/crash release and
multi-session validation on all three platforms remain open. Package source
adds exact runtime-dir
permissions, shared/exclusive lifecycle locking, a crash-persistent transaction
sentinel, strict staging, private input snapshots, hermetic verification and
DEB/RPM semantic-metadata/mode rejection. Default product construction still
injects no adapter, all probes/capabilities remain false, AppImage/updater
capture is disabled, and Linux architecture/OpenPGP/complete distro dependency
policy remains `unconfigured`. There is no signed Linux package or real
package-manager/root/native evidence. The aggregate verifier also intentionally
fails Linux release manifests with
`LINUX_INSTALL_PROVENANCE_ATTESTATION_UNCONFIGURED` until a reviewed protected
lab-runner identity/public key and signature protocol exist; a self-reported
receipt cannot bypass that blocker. There is no signed Windows implementation
and no entitled/notarized macOS provider. The result remains a **preview-only
foundation with release gates**, not end-to-end host capture.

Revision 9 retains the frozen Taomni-owned data plane and first Windows Beta
`x86_64` + Wintun/WinDivert decisions. The Sockscap workflow is explicitly a
Source/Quick Non-Release workflow and pins every third-party Action to a full
commit SHA and Rust/MSRV to 1.95.0. Windows and macOS source compile/process jobs
are configured, but no matching CI runner result is recorded in this snapshot;
they cannot yet be called PASS. The general `.github/workflows/release.yml`
neither depends on Sockscap Gates nor provides
protected native/non-lint/24h/7-day promotion, and still contains movable
Action/toolchain tags; it can only be treated as a capture-disabled ordinary
bundle path. Protected build/sign/publish provenance, runner-image policy and
action-update auditing remain open. Planned gates are not evidence that
accounts, signed packages, labs, or operational exercises exist.

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
| `cargo test sockscap --lib --quiet` | PASS — 355 passed, 0 failed | Final shared source snapshot. Includes policy/recovery/helper protocol, Linux mutation-before-WAL and kernel-incarnation PID contracts, generation/tombstone recovery, hardened decoded runtime, strict L3/IPv6 admission, packet-stack supervisor/first-event contracts, exact TUN/client and automatic source fault-withdrawal lifecycle, Store-global/caller-cancel transaction ownership, pre-heartbeat generation binding, invalid-receipt generation cleanup, disk durability and owner/path checks. Existing repository warnings remain. |
| Final Rust lib test binary, unfiltered | PASS — 1,223 passed, 0 failed, 11 ignored (1,234 total) | Covers the repository lib-test binary, but not separate integration-test binaries or any native/root platform lab. Existing unrelated warnings remain. |
| Shared stream/packet/IP-stack and Linux contract focused tests | PASS for source-contract scope | Proves bounded queues and identity, strict bounded IPv6 extension parsing, explicit transport limits, one-shot supervisor handoff/first-terminal attribution, runtime relay/shutdown, helper WAL-before-mutation, PID/cgroup revalidation, ready-before-activate, cancellation-safe owners, helper-first terminal/heartbeat fault cleanup, exact active queue/source binding and tombstone retry. A Linux generation-scoped product adapter/coordinator seam exists; what remains unproven is its default product/native execution, while Windows/macOS adapters remain absent. The ingress handoff returns an `Arc`, so exclusive downstream consumption is a product-factory invariant. Linux numeric `cgroup.procs` still lacks an atomic process-incarnation handle and requires a real PID-race lab. These tests do not prove a complete TCP/UDP/reassembly/Virtual-DNS stack, root/package smoke, or host capture. |
| New packet-stack/Linux lifecycle source contracts | PASS for source-contract scope only | Exact provider/capability/identity readiness, same-device packet identity, one-shot ingress handoff, retryable stack shutdown, strict IPv6 admission, helper WAL/PID checks, dual-pump ready, combined health, automatic source fault withdrawal and cleaned tombstones passed the focused tests above. This is non-native evidence and does not unlock a capability. |
| Windows/macOS CI source compile and process jobs | NOT RUN for this snapshot | Jobs are configured in the Source/Quick Non-Release workflow, but matching Windows/macOS runner results are required before either platform compile check can be called PASS. This is not a release, signing, native-capture, entitlement or notarization Gate. |
| `cargo check --locked --all-targets` | PASS on Linux source snapshot | The application and performance/soak harness compile against the production matcher, sampler, store, runtime owner and private transaction coordinator. This is not a Windows/macOS runner result. |
| `pnpm tauri build --debug --no-bundle` | PASS — 6m01s | A Linux native debug application was built without packaging. |
| `qa_ui_auto.lint` | PASS — 133 cases, 79 features, 0 errors | Schema and feature catalog are valid. There are 134 existing repository-wide orphan-selector warnings. |
| testid catalog check | PASS | Generated catalog is current. |
| `F-SOCKSCAP-1` control coverage | PASS — 19/19 required, shallow 0 | Native entry/window controls and Dashboard controls have direct coverage. |
| Sockscap native case dry-run | PASS — 1/1 | YAML verbs/selectors dispatch correctly. |
| Linux native WebDriver smoke `run-20260719-112341` | PASS — 1/1, case 11.3s | Proves main-menu discovery, exactly two native WebViews, Lifecycle navigation, hide, reopen, and state preservation. It does not prove tray behavior or packet capture. |
| Prior core quick performance receipt | PASS for its earlier synthetic source snapshot | 10,000 rules compiled in 9ms; 20,000 timed matches had P99 3.405us against the fixed 100us limit; 100/100 start-stop cycles cleaned the journal; RSS and open files both grew by 0. It is not final-candidate-bound evidence and must be rerun against the exact candidate commit. |
| Short soak execution proof | PASS — 3.213s | Active heartbeat, bounded events, resource sampling, and clean stop execute correctly. This is deliberately **not** 24-hour evidence. |
| Python Sockscap verifier contracts | PASS/FAIL-CLOSED — 68/68 | Helper policy 5/5, Linux package contract 10/10, Linux release verifier 27/27 and aggregate/performance verifier 26/26. They cover policy/provenance, semantic package metadata, artifact rehashing, typed real-capture binding, tampering and shortened-soak rejection. This is verifier self-test, not platform evidence. |
| Store ownership/durability source tests | PASS | Same-Store runtime owners serialize through one mutex; caller cancellation retains ownership; disk WAL reads back `synchronous=FULL` while the memory test store reads `NORMAL`; owner-lock contention/drop release, canonical private directory binding and Unix symlink rejection pass. This is configuration/unit evidence, not independent-process, filesystem-controller power-loss or Windows SID/DACL proof. |
| macOS source release gate | PASS for syntax/template lint only | `bash -n`, Bash 3.2 parse, JSON validation and disabled-template lint pass. Lint reports policy `unconfigured`; no real codesign/profile/Gatekeeper/notary `.app` passed non-lint verification. |
| Windows PowerShell source gate | PASS for AST/template lint; NOT RUN on Windows release artifacts | PowerShell 7.2.24 parsed the script (3,697 tokens) and executed disabled-template lint successfully. Fixed policy/schema align to x86_64 + WinDivert. This Linux-host lint is not a real Windows non-lint run; final Authenticode artifacts and driver `/kp` remain unrun. |
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
- The desktop single-instance callback currently focuses an already-created
  main window and deliberately is not a journal lock. It does not yet queue a
  focus request before window readiness or forward an allowlisted
  `--sockscap-auto-restore` intent from a second launch; native autostart,
  updater-relaunch and startup-race cases remain open.
- Release `nativeSmoke` is a different typed
  `sockscap_native_capture_smoke` receipt bound to the candidate, platform,
  provider, artifact-Gate digest and component hashes. The existing
  `qa-ui-auto.summary.v1` window receipt is deliberately rejected. The schema
  verifier exists; a protected real-host producer and platform cases do not.
- The Windows and macOS templates default to release disabled. A source lint
  pass never substitutes for configured first-party release policy, a signed
  driver/helper or Apple-managed entitlement, provisioning, notarization, and
  system-extension approval.
- Generated receipts and native artifacts must stay outside the repository and
  are SHA-256 pinned by the platform manifest. The aggregate verifier re-hashes
  every required absolute receipt-listed candidate path on the matching host;
  a copied PASS JSON without its candidate artifacts is rejected.
- Schema checks, candidate binding and same-host re-hashing prove consistency,
  not producer identity. Production evidence must also carry protected-lab/CI
  signed provenance/attestation binding the host, raw evidence and final
  app/helper/provider artifacts. On macOS, artifact/native receipts bind the
  canonical full-`.app` tree digest; the protected build attestation must then
  prove that the shipped DMG/PKG/updater payload contains that same candidate.
  Self-reported JSON cannot unlock a capability.
- A startup/Drop emergency reaper is a bounded last resort, not cleanup proof.
  The public registry must retain each uncertain generation until stack,
  runtime, profile, egress and task joins are observed; release evidence must
  exercise retry after caller cancellation/timeout plus automatic Active-fault
  revocation.

## Phase exit ledger

| Phase | Status | Evidence present | Missing exit evidence |
|---|---|---|---|
| Phase 0 — capability/license gate | BLOCKED | Fail-fast probes; accepted ADR; WinDivert-only/x86_64 pins; smoltcp 0.13.1/0BSD exact archive pin and bounded IP-device foundation; authoritative TCP/UDP packet admission; bounded dual-transport runtime and two-phase provider shutdown contract; store-global detached capture transactions, expected-generation guard, durable adapter binding/handle lineage; disk WAL `synchronous=FULL`; canonical directory/lock/path validation; Linux helper/TUN/lifecycle and hardened DEB/RPM Gate. The Store owner lock is the intended source-level journal boundary; desktop single-instance is activation UX only. | Executable smoltcp compatibility spike, complete controlled socket actor/bridge, final builder, Virtual-DNS/reassembly policy and SBOM; handle-relative DB/lock binding and Windows SID/DACL; three-platform cross-process/crash/multi-session owner-lock native evidence; configured signing and complete Linux dependency policies; frozen macOS/Linux matrices; three real vertical slices; package/native/stop/kill/leak/compatibility evidence. |
| Phase 1 — policy/rule core | PASS for software scope | Profile model, overlap rejection, GFWList projection, exceptions, immutable matcher snapshots, target explanations, and last-good behavior. | Live mirror availability remains an operational gate. |
| Phase 2 — FlowEngine/egress core | PARTIAL | DIRECT TCP/UDP, SOCKS5 TCP, HTTP CONNECT, shared SSH `direct-tcpip`, UDP policy/fail-open/fail-closed routing, bypass/cancellation/stats, strict host-key, bounded relay/IPv6 admission, independent TCP/UDP quotas, shared UDP in-flight bytes and public product supervisor plus Linux injection seam. | Complete transparent smoltcp TCP/UDP provider, SOCKS5 UDP ASSOCIATE connector, Virtual DNS/reassembly policy, final profile/config builder, default async wiring and product fault propagation; repeatable real SOCKS/HTTP/SSH matrix. |
| Phase 3 — persistence/IPC/Stub | PASS for existing software scope | SQLite/WAL with disk `synchronous=FULL`, recovery journal, bounded stats, IPC/Stub, helper receipts, store-scoped operation serialization, OS owner lock/path checks, Linux generation adapter and cancellation-safe, durable-context-bound coordinator seam. | `AppState` still uses `with_store`; commands/tray still call synchronous fail-closed recovery. Default adapter/async start-update-heartbeat-stop injection, handle-relative SQLite/lock binding, Windows SID/DACL, native crash/power-loss/fault evidence, durable tombstone GC and real host recovery remain. |
| Phase 4 — independent UI | PARTIAL | Independent route/window shell, complete UI, 67 focused tests, cataloged YAML coverage, and a real Linux WebDriver hide/reopen smoke. | Native tray click/exit smoke on all platforms, accessibility/keyboard review, and permission/recovery system smoke. |
| Phase 5 — Windows vertical | BLOCKED | Provider is frozen to Wintun/global plus WinDivert app/PID and first Beta is x86_64 only; source capability/fixed policy/template/verifiers reject other providers/architectures and pin official artifacts. First-party WFP is out of scope. | Replace `unconfigured` publisher/certificate policy through review; implement adapters/service/orchestrator; provision user-mode Authenticode; run Windows non-lint `/kp`; complete license, install/update/uninstall, identity-race, EDR/VPN and recovery labs. |
| Phase 6 — macOS vertical | BLOCKED | Release-only Tauri overlay, provider plist/entitlement/profile-certificate/full-app-digest contract, and signed-app/provider/notarization verifier. | Replace `unconfigured` Team/certificate/architecture policy through review; Apple-approved capability; real Swift target/Rust bridge; Developer ID provisioning/signing/notarization; final DMG/PKG provenance; permission, upgrade, uninstall and frozen architecture labs. |
| Phase 7 — Linux vertical | PARTIAL | Helper/TUN/pump/fault/tombstone, public supervisor, generation adapter/coordinator, authoritative packet admission, dual-transport runtime, explicit quiesce/drain/terminate ownership, pinned smoltcp staging foundation, canonical directory/lock/DB checks and OS-held Store owner lock; desktop single-instance is activation UX only; fixed policy/polkit and DEB/RPM-only lifecycle lock/sentinel/snapshot/hermetic metadata Gate. | Handle-relative SQLite/VFS binding and hostile same-user path tests; three-platform cross-process/crash/multi-session Store-lock native evidence; executable provider spike, complete provider/final builder/tuple side channel/default async IPC; configured signer/architecture/complete distro dependencies, signed apt/RPM repository or mandatory verified installer, trusted lab attestation; package-manager/PID/root/native matrix. |
| Phase 8 — tray/reliability/release | PARTIAL | Native Linux window smoke; guarded exit; recovery UI; fixed performance thresholds; 100 synthetic lifecycle cycles; fail-closed quick/24h/platform receipt verifier. | Allowlisted second-launch/autostart activation-intent queue with window-ready delivery; actual adapter 100-cycle cleanup; native tray/system recovery; 24h core/real-capture soak and 7-day staged long-stability run; throughput/latency/leak gates; signed packages and install/update/uninstall matrices; updater key/rollout/rollback exercise; continuous SBOM/CVE; threat model; redacted support bundle/symbol/log policy; clean global QA gate. |

## Definition of Done audit

| Design requirement | Status | Notes |
|---|---|---|
| Windows, macOS and supported Linux run global + application group | BLOCKED | Linux helper-side mutation code exists, but no product runtime has an end-to-end active capture plane; Windows/macOS release artifacts do not exist. |
| Running PID selection with new-connection semantics | PARTIAL | Model, platform-native process-incarnation guard (Linux kernel start tick with mutation-time revalidation), privacy-bounded picker, cgroup enforcement source, and degradation UI exist; product capture is disabled and real PID-race lab evidence is absent. |
| SOCKS5, HTTP CONNECT and SSH Jump TCP against real servers | PARTIAL | Connectors and shared SSH pool exist; the full real-server matrix was not executed. |
| GFWList refresh/fallback/exceptions/manual/test-target | PASS for software scope | Parser, snapshots, manual override, explanation, persistence, and UI are covered. |
| DNS/IPv6/UDP state does not silently leak | PARTIAL | Explicit policies and unknown/degraded reporting exist; native packet/leak verification is absent. |
| Multiple profiles run stably through one capture plane | PARTIAL | Conflict/priority core exists; no product capture plane is active. |
| Window hide/tray recovery is platform-correct | PARTIAL | Linux native hide/reopen passes; real tray and cross-platform behavior remain open. |
| stop/crash/restart/upgrade/uninstall leave no network state | PARTIAL | Coordinator journal, helper WAL/rollback, owner retention, tombstones, automatic withdrawal and Linux product recovery integration exist; installed-system crash/power-loss/package-manager tests and durable tombstone GC are absent. |
| Secrets stay in Vault and telemetry remains bounded | PARTIAL | Egress references use saved sessions; logs/stats omit payload, URL, and credentials; native package audit remains. |
| Rust, Vitest, qa-ui-auto, native smoke, performance, and long-run gates all pass | BLOCKED | Focused software and Linux window gates pass; global QA, real platform capture, signed packages, 24h evidence, and the stable 7-day staged actual-capture receipt/verifier remain red. |
| Production release can be staged, stopped, rolled back and supported securely | BLOCKED | The functional updater foundation exists, but key-lifecycle, staged rollout/stop-rollout/signed rollback, compatibility, continuous SBOM/CVE, threat-model and redacted-support exercises have not passed. |

## Revision 9 production-readiness gates

| Work package | Status | Required evidence |
|---|---|---|
| `S0-CONTRACT-ALIGN` | PARTIAL — source complete, platform evidence open | Capability text, schema/templates, fixed release policies, artifact verifier and performance receipt contract accept only WinDivert/x86_64 on Windows and fail closed for obsolete provider/architecture choices. Exact WinDivert 2.2.2-A and Wintun 0.14.1 package/file hashes are pinned. Windows publisher/certificate and macOS Team/certificate/architecture policies are intentionally `unconfigured`, so non-lint release cannot pass until separately reviewed identities are committed. Closure also requires real same-host Windows `/kp`, macOS signing/profile/notary plus stable full-`.app` digest, and protected provenance binding the shipped DMG/PKG/updater artifact to that candidate. |
| `S1-STREAM-RUNTIME` | PARTIAL — bounded TCP/UDP runtime slice complete | `FlowDescriptor`, `ProfileSelector`, independent bounded decoded TCP/UDP ingress, bounded L3 `PacketIngress`, pinned `IpStackConfig`/`PacketFlowRegistry`, snapshot-bound `FlowEngine`, Direct UDP and supervisor-owned `FlowRuntime` relays are implemented. App/PID capture intent is fail-closed, child inheritance requires a trusted revisioned queue, stale engines/ownerless live egress are rejected, combined active transports are checked, and both UDP relay directions share a worst-case-datagram byte semaphore. TCP/UDP reject-close/finalization pools are separated and bounded; foreign close panic is contained. Queued-but-unaccepted association quarantine/explicit drain remains a release blocker, as do native smoke, performance and 24h/7d evidence. |
| `S1-PACKET-IPSTACK` | PARTIAL — pinned bounded foundation, runnable provider open | Bounded native queues/exact `source_id`, packet-derived authoritative tuples, IPv4/TCP/UDP checksum validation, pure-SYN new TCP admission, strict bounded IPv6 parsing, explicit provider limits/first-terminal attribution and a bounded smoltcp `Medium::Ip` staging device. `ProductDataPlaneSupervisor` is the sole public start path; detached generation ownership survives caller cancel. Normal stop requires provider quiesce acknowledgement, runtime/owner cleanup, then final actor termination; timeouts retain the exact owner. `ipstack` 1.0.1 remains excluded and smoltcp is pinned exactly to 0.13.1/0BSD with fragmentation disabled. Executable AnyIP/TCP/UDP probes, complete socket actor/bridge, MTU/parser-differential closure, final builder, Virtual DNS/reassembly decision plus fuzz/native/performance/long-stability evidence remain required. Drop-time detached reapers are containment only. |
| `S1-LINUX-LIFECYCLE` | PARTIAL — product/source contract, real evidence open | Helper WAL/PID/pump/withdrawal/tombstone, product adapter/public supervisor, Store-global detached transaction ownership, expected-generation guard, durable adapter binding, helper PID lineage and generation-only rollback for untrusted receipts exist. Disk Store uses WAL + `synchronous=FULL`; canonical directory/lock/DB checks and the retained OS owner lock form the intended source-level journal boundary; desktop single-instance is activation UX only. Same-process double-open/drop-release and Unix path tests exist. Package hooks add exact runtime dir, lifecycle lock/sentinel, strict stage, snapshots/hermetic tools and semantic metadata/mode rejection. Still required: handle-relative SQLite/VFS binding, Windows SID/DACL, three-platform cross-process/crash/multi-session lock evidence, WAL/disk-full/I/O/corruption/power-loss faults, provider/default injection, complete dependency/signing/repository policy, pidfd/PID-race/tombstone GC and signed package-manager/root evidence. |
| `W0-SUPPORT-MATRIX` | PARTIAL | Windows Beta is frozen to x86_64 and Windows ARM64 must remain unsupported under the current official WinDivert/no-custom-driver route. `minimumSystemVersion=11.0` in the macOS Tauri overlay is only a provisional build floor, not a production support claim. Exact Windows versions, macOS minimum/architecture scope and Linux distro/kernel/userspace-network matrix still require owned lab evidence. |
| `W0-SIGNING-ACCOUNT` | BLOCKED | Commit a reviewed non-placeholder Windows publisher subject and leaf-certificate SHA-256, then prove trusted timestamped Authenticode for Taomni app/helper/service/installer, controlled/non-exported CI use, clean-host chain verification, renewal/rotation/revocation owner and exercise. EV and a custom kernel-driver signing path are not required or authorized. |
| `P0-RELEASE-OPS` | BLOCKED | The Source/Quick Non-Release workflow Actions are commit-SHA pinned and Rust/MSRV is fixed to 1.95.0; a real 1.94 build exposed incompatible current `sysinfo` and `libsqlite3-sys` code, so the prior declaration was not a valid Gate. Windows/macOS source compile/process jobs are configured but have no matching runner result in this snapshot, so neither may be claimed PASS. The general release workflow does not depend on it, retains movable tags, and has no protected native/non-lint/24h/7-day Sockscap promotion. Still required: capture-disabled release separation, reviewed action-update process, frozen runner images, isolated least-privilege build/sign/publish provenance; updater key custody/offline recovery/rotation/revocation; component compatibility; Active stop/join; staged rollout/kill switch/signed rollback exercise. |
| `P0-SECURITY` | BLOCKED | Privileged-boundary/parser/bypass/update-chain threat model; per-release SBOM/license/CVE/EOL output; fail-closed severity policy and time-bounded waivers. |
| `P0-SUPPORT` | BLOCKED | User-approved redacted support bundle, hostile-field redaction tests, bounded logs/receipts, crash-symbol access/retention and field-recovery runbook. |

Store/journal release evidence must additionally cover independent child
process contention, same-user multi-session ownership, crash release, hostile
directory/lock/DB substitution, Windows reparse/SID/DACL semantics, and
WAL/checkpoint behavior under `ENOSPC`, I/O error, corruption, process kill and
power loss. The current canonical directory handle and pre/post identity checks
detect and reject known unsafe paths, but SQLite still opens by pathname; fully
closing the remaining TOCTOU class requires a reviewed handle-relative
SQLite/VFS design. `synchronous=FULL` must also be profiled under the real stats
write rate (batch throughput, commit p95/p99, checkpoint latency/size and
capture/UI jitter) without weakening durability to make a benchmark pass.

## Platform work required before release labels

### Windows Beta

- Build and release Sockscap only for Windows x86_64 in the first production
  Beta. Windows ARM64 must not produce a Sockscap PASS manifest and its app/PID
  capabilities remain false under the current official WinDivert/no-custom-
  driver route.
- Finish the evidence half of `S0-CONTRACT-ALIGN`: run the aligned verifier on
  Windows against final staged artifacts and retain the non-lint receipt,
  including kernel-policy `/kp` validation. Source alignment alone remains
  non-release evidence.
- Implement the frozen Wintun/global plus WinDivert application/PID capture
  with hard self/upstream
  bypass and reinjection-loop protection.
- Pin the exact unmodified official Wintun/WinDivert package/version/variant and
  per-file SHA-256. For WinDivert, validate DLL official-package provenance and
  PE architecture/hash without requiring a nonexistent upstream DLL signer;
  validate the kernel driver's expected signer/hash with `signtool /kp`.
  Complete LGPL/GPL LICENSE/NOTICE or approved commercial-license review. Do
  not rebuild, patch or test-sign the drivers.
- Produce timestamped release-signed Taomni/helper/service artifacts and
  installer through the approved user-mode Authenticode account/service and
  commit the reviewed publisher subject/leaf-certificate fingerprint to the
  fixed first-party policy before satisfying the same-host signature gate. EV
  is not required by this route and no Taomni kernel driver is signed.
- Verify IPv4, IPv6, DNS, TCP, cleanup, EDR/VPN/NIC/sleep compatibility, install,
  upgrade, rollback, reboot, and uninstall.
- If a WinDivert hard gate fails, keep Windows app/PID capabilities disabled;
  there is no first-party WFP fallback in the current release plan.

### Linux release

- Freeze the explicit distro/kernel/systemd/cgroup/nft/iproute2/resolver/
  NetworkManager support matrix and maintenance owner before issuing a release
  claim; do not substitute an undefined “mainstream Linux” label.
- Finish the smoltcp executable compatibility Gate, then implement the bounded
  socket actor/bridge, ingress/close quarantine and final checked Linux
  profile/config builder. Wire that provider and the landed public composition/
  generation adapter into the default async product path. Keep capability
  start flags false until installed probe, self-test and native evidence pass.
- Replace the intentionally `unconfigured` Linux signer/architecture policy,
  and derive/review a complete per-distro/architecture dependency profile from
  the final app/helper ELF plus scripts; the current three capture-tool
  dependencies are intentionally not release-complete. Build only through the
  canonical DEB/RPM overlay, sign and verify the final packages, and exercise
  real privilege denial,
  stale receipt/tombstone, lost response, main-process kill, helper/data-plane
  kill, restart, power loss, and uninstall cleanup. Add tombstone GC driven only
  by a durable coordinator journal/rollback low-water mark; never delete merely
  by age/count, and preserve fail-closed response-loss retry.
- Distribute DEB through a signed apt `Release/InRelease` chain or a mandatory
  non-bypassable verified installer; a detached package `.asc` alone is not an
  apt/dpkg enforcement path. Apply the equivalent repository-GPG requirement
  to RPM and test tampered downloads, stale metadata, key expiry and rollback.
- Implement the protected package-manager lab runner, freeze its reviewed
  identity/public key and signed attestation protocol, and remove the aggregate
  verifier's `LINUX_INSTALL_PROVENANCE_ATTESTATION_UNCONFIGURED` blocker only
  after negative forgery/replay/candidate-substitution tests pass.
- Prove the landed product adapter/coordinator/orchestrator helper-first cleanup
  and cancellation/retry behavior on real root failures. Source fake tests and
  later-user-operation health checks are not sufficient.
- Prove real cgroup app-group/global/PID TCP plus DNS/IPv4/IPv6 behavior, managed
  netns fallback, throughput, leak, and 24h stability across the supported
  distro/kernel/systemd/network-manager matrix.

### macOS release

- Freeze the minimum macOS version and Apple Silicon/Intel scope from actual
  entitlement, signed-build and lab evidence. The overlay's current `11.0` is a
  provisional build floor, not a supported-production claim.
- Obtain the Apple-managed Network Extension capability and build the actual
  transparent-proxy provider/system extension and Rust/Swift bridge.
- Commit the reviewed Team ID, signing leaf-certificate SHA-256 and exact
  architecture scope to the fixed macOS policy; its current placeholders make
  every non-lint release run fail closed.
- Sign, provision, notarize, staple, install, approve, upgrade, and uninstall the
  app/provider with matching team and application-group identities.
- Verify audit-token attribution, hard bypass, permission denial, recovery, and
  the frozen Apple Silicon/Intel scope in native labs.

### Cross-platform stable

Windows x86_64 and the frozen Linux/macOS support matrices must all pass on the
matching OS, including real capture, signed artifacts, recovery, packaging,
latency, throughput, leak, 100-cycle, 24-hour evidence and the staged 7-day
long-stability Gate. `P0-RELEASE-OPS`,
`P0-SECURITY`, and `P0-SUPPORT` must also close. A synthetic core receipt, an
unsupported Windows ARM64 run, or one platform passing never permits the
cross-platform stable label.

## Next executable verification steps

1. Run and freeze the smoltcp 0.13.1 P0 executable STOP/GO suite for arbitrary
   IPv4/IPv6 TCP exact-listener/SYN-ACK, shared-port UDP metadata demux/reply and
   MTU rejection. Then implement the bounded sharded socket actor, TCP/UDP
   bridge, tuple leases, ingress close/drain plus close-failure quarantine,
   complete checked stack/bridge/association/binding memory builder, Virtual
   DNS/reassembly policy and final snapshot/profile builder. Complete fuzz,
   conformance and optimized memory/performance checks before any platform
   capability can use it.
2. Finish Linux first as the nearest vertical slice: wire that provider into
   the landed generation adapter/default async runtime, configure reviewed
   architecture/OpenPGP policy, build/sign the fixed DEB/RPM candidates, and
   prove install/dirty blocker/upgrade/rollback/uninstall plus WAL/PID/fault/
   kill/power-loss cleanup in disposable root VMs.
3. In parallel, implement Windows x86_64 Wintun global + WinDivert app/PID and
   the signed service/helper, and implement the macOS Xcode system-extension/
   Network Extension provider plus Rust bridge. Freeze owned support matrices
   and commit reviewed Windows publisher/certificate and macOS Team/certificate/
   architecture policies; keep all runtime start flags false meanwhile.
4. Add a protected real-host producer for typed
   `sockscap_native_capture_smoke` receipts and the required global/app/PID,
   TCP/UDP, IPv4/IPv6/DNS/bypass/cleanup cases. Bind it to the exact artifact
   Gate and final app/helper/provider artifacts. For macOS, bind the native run
   directly to the canonical full-`.app` digest and bind DMG/PKG/updater output
   to that candidate through protected build attestation. Retain the existing
   native-window case only as UI/IPC evidence.
5. Run the final Windows non-lint gate with `signtool /kp`, the macOS
   signing/profile/Gatekeeper/notary/full-app gate plus final DMG/PKG
   provenance, and the Linux package owner/policy/signature gate on clean
   supported hosts. Aggregate only receipts whose absolute candidate paths can
   be re-hashed on that host.
6. Follow [`scripts/sockscap/README.md`](../scripts/sockscap/README.md) to create
   quick and 24-hour core receipts, the real platform latency/throughput/leak/
   recovery/100-cycle evidence, and the staged 7-day actual-capture receipt for
   the same immutable candidate.
7. Protect the lab/CI producer and sign/record provenance or equivalent
   attestation for artifact, native, performance and raw evidence; for Linux,
   implement and pin the package-manager runner identity/public key and
   verification protocol before removing the committed fail-closed attestation
   blocker. JSON consistency alone is insufficient.
8. Exercise updater key recovery/rotation/revocation, staged rollout,
   stop-rollout and signed rollback; close threat-model/SBOM/CVE/support-bundle
   gates against the same candidate.
9. Keep `capture_implemented=false` and all three `can_start_*` fields false
   until the installed product adapter, signed artifact and privileged native
   evidence for that platform all pass.
