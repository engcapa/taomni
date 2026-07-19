# Sockscap Release Gate Ledger

- Snapshot: 2026-07-19
- Branch: `feat/sockscap-gpt-sol-max`
- Design baseline: [sockscap-cross-platform-design-plan.md](./sockscap-cross-platform-design-plan.md) (Revision 6)
- Capture ADR: [sockscap-phase0-adr.md](./sockscap-phase0-adr.md)
- Gate commands: [`scripts/sockscap/README.md`](../scripts/sockscap/README.md)

## Current verdict

**Not ready for Windows Beta, macOS release, Linux release, or the
“cross-platform stable” label.**

The branch now contains more than a UI scaffold: it has the policy/egress/
persistence core, an authenticated Linux root-helper protocol, real Linux
cgroup-v2 + nftables + fwmark/TUN transaction code, recovery receipts, source
gates for Windows signing and macOS signing/entitlements, an isolated Linux
native-window smoke, fail-closed performance/soak receipt verification, and a
bounded decoded-stream slice consisting of `FlowDescriptor`, `ProfileSelector`,
`FlowIngress`, and the owned `FlowRuntime` TCP relay. The source tree now also
contains a release-neutral `PacketStackSupervisor` contract (exact provider
pin/capability/identity, absolute ready deadline, one-shot ingress handoff,
first-terminal-event attribution, retryable shutdown), packet-device
`source_id` cross-wire protection, a bounded strict IPv6 extension parser, and
explicit TCP/UDP registry counters that remove the admission-time transport
scan. The returned ingress is reference-counted, so exclusive downstream use is
still a product-composition invariant. Fragments are admitted only to the
bounded reassembly boundary; none of these contracts supplies production TCP,
UDP, reassembly or Virtual DNS.

It still intentionally reports `capture_implemented = false` and
`can_start_global`, `can_start_app_group`, and `can_attach_pid` as false. Linux now
has source-level fixed-path helper client/session and exact-name,
owner-verified TUN L3 I/O primitives. Its helper now plans without side effects,
fsyncs a root-owned write-ahead recovery receipt before every first mutation,
and applies membership changes only after their restore intent is durable.
Linux process identity uses the kernel start-tick incarnation token with
pre/post validation. The lifecycle has bidirectional pump readiness before
activation, combined identity/health checks, serialized mutation,
cancellation-safe owner retention, cleaned-generation tombstones, and a
source-level terminal-fault monitor that withdraws helper capture before
stopping local owners. It still lacks the concrete stack + `FlowRuntime`
composition factory, product `CaptureAdapter`/coordinator wiring, packaging and
real privileged fault evidence; no signed Windows provider/helper package or
entitled/notarized macOS Network Extension is present. The current result is
therefore a **preview-only foundation with release gates**, not working
end-to-end host traffic capture.

Revision 6 also freezes the first production Windows Sockscap Beta to
`x86_64` and adds explicit contract-alignment, user-mode signing,
support-matrix, release-operations, security-response, and supportability
gates. These are planned/open gates, not evidence that the corresponding code,
accounts, packages, labs, or operational exercises exist.

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
| `cargo test sockscap --lib --quiet` | PASS — 295 passed, 0 failed | Final shared source snapshot. Includes policy/recovery/helper protocol, Linux mutation-before-WAL and kernel-incarnation PID contracts, generation/tombstone recovery, hardened decoded runtime, strict L3/IPv6 admission, packet-stack supervisor/first-event contracts, exact TUN/client and automatic source fault-withdrawal lifecycle. Existing repository warnings remain. |
| Final Rust lib test binary, unfiltered | PASS — 1,163 passed, 0 failed, 11 ignored (1,174 total) | Covers the repository lib-test binary, but not separate integration-test binaries or any native/root platform lab. Existing unrelated warnings remain. |
| Shared stream/packet/IP-stack and Linux contract focused tests | PASS — ingress 10/10, packet-device 12/12, selector 11/11, runtime 12/12, engine 13/13, IP-stack admission 10/10, packet-stack supervisor 17/17, Linux helper 10/10, Linux process 12/12, Linux TUN 4/4, Linux client 12/12, Linux adapter source lifecycle 24/24 | Proves bounded queues and identity, strict bounded IPv6 extension parsing, explicit transport limits, one-shot supervisor handoff/first-terminal attribution, runtime relay/shutdown, helper WAL-before-mutation, PID/cgroup revalidation, ready-before-activate, cancellation-safe owners, helper-first terminal/heartbeat fault cleanup, exact active queue/source binding and tombstone retry. The ingress handoff returns an `Arc`, so exclusive downstream consumption is a product-factory invariant. Linux numeric `cgroup.procs` still lacks an atomic process-incarnation handle and requires a real PID-race lab. These tests do not prove a complete TCP/UDP/reassembly/Virtual-DNS stack, product adapter/orchestrator, root/package smoke, or host capture. |
| New packet-stack/Linux lifecycle source contracts | PASS for source-contract scope only | Exact provider/capability/identity readiness, same-device packet identity, one-shot ingress handoff, retryable stack shutdown, strict IPv6 admission, helper WAL/PID checks, dual-pump ready, combined health, automatic source fault withdrawal and cleaned tombstones passed the focused tests above. This is non-native evidence and does not unlock a capability. |
| `cargo check --bin sockscap-gate` | PASS | The release-profile performance/soak harness compiles against production matcher, sampler, store, and transaction coordinator. |
| `pnpm tauri build --debug --no-bundle` | PASS — 6m01s | A Linux native debug application was built without packaging. |
| `qa_ui_auto.lint` | PASS — 133 cases, 79 features, 0 errors | Schema and feature catalog are valid. There are 134 existing repository-wide orphan-selector warnings. |
| testid catalog check | PASS | Generated catalog is current. |
| `F-SOCKSCAP-1` control coverage | PASS — 19/19 required, shallow 0 | Native entry/window controls and Dashboard controls have direct coverage. |
| Sockscap native case dry-run | PASS — 1/1 | YAML verbs/selectors dispatch correctly. |
| Linux native WebDriver smoke `run-20260719-112341` | PASS — 1/1, case 11.3s | Proves main-menu discovery, exactly two native WebViews, Lifecycle navigation, hide, reopen, and state preservation. It does not prove tray behavior or packet capture. |
| Core quick performance receipt | PASS | Final-source release run: 10,000 rules compiled in 9ms; 20,000 timed matches had P99 3.405us against the fixed 100us limit; 100/100 start-stop cycles cleaned the journal; RSS and open files both grew by 0. |
| Short soak execution proof | PASS — 3.213s | Active heartbeat, bounded events, resource sampling, and clean stop execute correctly. This is deliberately **not** 24-hour evidence. |
| Python performance/artifact/native verifier | PASS/FAIL-CLOSED — 10/10 | Covers fixed policy mismatch/unconfigured identity, exact Windows provenance, macOS release proofs/full-bundle digest, same-host file/tree rehash, case-sensitive build ID, typed real-capture receipt binding, tampered receipts and shortened soak rejection. This is verifier self-test, not platform evidence. |
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
- A startup/Drop emergency reaper is a bounded last resort, not evidence that a
  provider joined cleanly or that privileged capture artifacts were withdrawn.
  Release evidence must exercise explicit stop/join and automatic Active-fault
  revocation.

## Phase exit ledger

| Phase | Status | Evidence present | Missing exit evidence |
|---|---|---|---|
| Phase 0 — capability/license gate | BLOCKED | Fail-fast capability probes; accepted ADR; WinDivert-only/x86_64 source contract; exact WinDivert/Wintun pins; bounded decoded-stream/L3 admission and replaceable packet-stack supervisor contracts; queue `source_id`; Linux helper WAL/PID/client/TUN/dual-pump/lifecycle/tombstone/fault-monitor source contracts. | Concrete controlled TCP/UDP/reassembly/Virtual-DNS provider/SBOM; Linux composition factory/product adapter/coordinator integration; configured Windows/macOS first-party identity policies; Windows user-mode signing and same-host non-lint `/kp`; frozen macOS/Linux matrices; three real platform vertical slices; real stop/kill recovery; DNS/IPv6 leak and VPN/sleep/NIC matrices. |
| Phase 1 — policy/rule core | PASS for software scope | Profile model, overlap rejection, GFWList projection, exceptions, immutable matcher snapshots, target explanations, and last-good behavior. | Live mirror availability remains an operational gate. |
| Phase 2 — FlowEngine/egress core | PARTIAL | DIRECT, SOCKS5 TCP, HTTP CONNECT, shared SSH `direct-tcpip`, hard loop-bypass modeling, cancellation/stats boundaries, strict host-key confirmation, bounded decoded-stream relay, strict IPv6 admission and the packet-stack supervisor source boundary. | Concrete controlled TCP/UDP/reassembly/Virtual-DNS provider and composition; orchestrator/native adapter wiring; product-level fault propagation; repeatable real SOCKS/HTTP/SSH matrix covering auth, DNS, IPv4/IPv6, reconnect, MFA, concurrency, cancellation, and stable SOCKS5 UDP ASSOCIATE. |
| Phase 3 — persistence/IPC/Stub | PASS for existing software scope | SQLite/WAL store, recovery journal, bounded statistics/live outcomes, IPC contract fixture, browser Stub, helper heartbeat, authenticated receipts, cleanup recovery state, generation-only recovery, root-helper mutation-before-WAL and cleaned-generation tombstone contracts. | Durable-journal low-water-mark tombstone GC, package-integrated helper client/product `CaptureAdapter`, coordinator reconciliation of the landed source fault monitor, and real host-artifact recovery can only close in a privileged platform lab. |
| Phase 4 — independent UI | PARTIAL | Independent route/window shell, complete UI, 67 focused tests, cataloged YAML coverage, and a real Linux WebDriver hide/reopen smoke. | Native tray click/exit smoke on all platforms, accessibility/keyboard review, and permission/recovery system smoke. |
| Phase 5 — Windows vertical | BLOCKED | Provider is frozen to Wintun/global plus WinDivert app/PID and first Beta is x86_64 only; source capability/fixed policy/template/verifiers reject other providers/architectures and pin official artifacts. First-party WFP is out of scope. | Replace `unconfigured` publisher/certificate policy through review; implement adapters/service/orchestrator; provision user-mode Authenticode; run Windows non-lint `/kp`; complete license, install/update/uninstall, identity-race, EDR/VPN and recovery labs. |
| Phase 6 — macOS vertical | BLOCKED | Release-only Tauri overlay, provider plist/entitlement/profile-certificate/full-app-digest contract, and signed-app/provider/notarization verifier. | Replace `unconfigured` Team/certificate/architecture policy through review; Apple-approved capability; real Swift target/Rust bridge; Developer ID provisioning/signing/notarization; final DMG/PKG provenance; permission, upgrade, uninstall and frozen architecture labs. |
| Phase 7 — Linux vertical | PARTIAL | Real cgroup-v2/nft/fwmark/TUN transaction source; mutation-before-WAL root receipt; kernel-incarnation PID checks; root-only helper; peer/executable pinning; HMAC; two-phase activation; typed fixed-path client; exact TUN source; bidirectional pump ready-before-activate; combined health; serialized operations; cancellation-safe owner retention; cleaned tombstone; source-level automatic terminal-fault withdrawal. | Concrete stack provider and stack+`FlowRuntime` factory; product `LinuxCaptureAdapter`/coordinator and journal reconciliation; pidfd/kernel-interface assessment and real PID-reuse race lab because numeric `cgroup.procs` is not an atomic incarnation+move operation; heartbeat/terminal-fault privileged evidence; tombstone GC/real crash evidence; polkit/package; TCP/UDP/reassembly/Virtual-DNS bridge; root smoke; managed-netns and distro matrix. |
| Phase 8 — tray/reliability/release | PARTIAL | Native Linux window smoke; guarded exit; recovery UI; fixed performance thresholds; 100 synthetic lifecycle cycles; fail-closed quick/24h/platform receipt verifier. | Actual adapter 100-cycle cleanup; native tray/system recovery; 24h core/real-capture soak and 7-day staged long-stability run; throughput/latency/leak gates; signed packages and install/update/uninstall matrices; updater key/rollout/rollback exercise; continuous SBOM/CVE; threat model; redacted support bundle/symbol/log policy; clean global QA gate. |

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
| stop/crash/restart/upgrade/uninstall leave no network state | PARTIAL | Coordinator journal, helper write-ahead receipts, rollback, owner-retention, cleaned tombstones and source-level automatic terminal-fault withdrawal exist; product coordinator integration, installed-system crash/power-loss tests and durable low-water-mark tombstone GC are absent. |
| Secrets stay in Vault and telemetry remains bounded | PARTIAL | Egress references use saved sessions; logs/stats omit payload, URL, and credentials; native package audit remains. |
| Rust, Vitest, qa-ui-auto, native smoke, performance, and long-run gates all pass | BLOCKED | Focused software and Linux window gates pass; global QA, real platform capture, signed packages, 24h evidence, and the stable 7-day staged actual-capture receipt/verifier remain red. |
| Production release can be staged, stopped, rolled back and supported securely | BLOCKED | The functional updater foundation exists, but key-lifecycle, staged rollout/stop-rollout/signed rollback, compatibility, continuous SBOM/CVE, threat-model and redacted-support exercises have not passed. |

## Revision 6 production-readiness gates

| Work package | Status | Required evidence |
|---|---|---|
| `S0-CONTRACT-ALIGN` | PARTIAL — source complete, platform evidence open | Capability text, schema/templates, fixed release policies, artifact verifier and performance receipt contract accept only WinDivert/x86_64 on Windows and fail closed for obsolete provider/architecture choices. Exact WinDivert 2.2.2-A and Wintun 0.14.1 package/file hashes are pinned. Windows publisher/certificate and macOS Team/certificate/architecture policies are intentionally `unconfigured`, so non-lint release cannot pass until separately reviewed identities are committed. Closure also requires real same-host Windows `/kp`, macOS signing/profile/notary plus stable full-`.app` digest, and protected provenance binding the shipped DMG/PKG/updater artifact to that candidate. |
| `S1-STREAM-RUNTIME` | PARTIAL — bounded stream/packet admission slice complete | `FlowDescriptor`, `ProfileSelector`, bounded decoded `FlowIngress`, bounded L3 `PacketIngress`, pinned `IpStackConfig`/`PacketFlowRegistry`, snapshot-bound `FlowEngine`, and supervisor-owned `FlowRuntime` relay are implemented. App/PID capture intent is fail-closed, child inheritance requires a trusted revisioned queue, stale engines/ownerless live egress are rejected, and queue/flow state is bounded. Explicit TCP/UDP counters remove the registry's admission-time transport scan without claiming strict worst-case `HashMap` O(1). Strict bounded IPv6 extension parsing rejects malformed, repeated/out-of-order and over-budget chains; fragments still require the missing controlled reassembly provider. This remains contract/memory evidence only; complete transport reconstruction, platform adapters, native smoke, performance and 24h/7d evidence remain open. |
| `S1-PACKET-IPSTACK` | PARTIAL — supervisor/admission contracts landed, provider implementation open | `capture/packet_device.rs` supplies bounded native↔stack queues whose opaque same-device `source_id` rejects cross-wiring. `flow/ip_stack.rs` pins provider source and limits flow/reassembly state. `flow/packet_stack.rs` validates exact pin/capabilities/generation/revision/platform, shares one absolute build+ready deadline, offers a one-shot ingress handoff, preserves the first terminal event, and retains the driver handle after shutdown timeout for retry. Because the handed-off receiver is an `Arc`, exclusive consumption remains a factory invariant. Its Drop/startup-cancel emergency reaper is not cleanup proof. `ipstack` 1.0.1 remains excluded for unbounded channels. A concrete controlled TCP/UDP/reassembly/Virtual-DNS provider, composition factory, fuzz/native/performance/long-stability evidence are still required. |
| `S1-LINUX-LIFECYCLE` | PARTIAL — source contract only | The root helper durably records complete restore intent before cgroup/TUN/network mutation and membership deltas before process moves. Native pumps become ready before activation; lifecycle validates exact queue/source identity and health, serializes mutations, retains joinable owners, and source-tests helper-first withdrawal on terminal and recovery-required heartbeat faults. PID/start-tick/UID/owned-cgroup are checked around apply and cleanup, and exact target cgroup is confirmed. The helper publishes a cleaned tombstone before deleting its receipt and re-audits absence after response loss. Its mutex/root receipt do not replace the product coordinator journal, and numeric `cgroup.procs` cannot make PID incarnation + move one atomic kernel operation. Still required: concrete stack/factory, product adapter/coordinator reconciliation, pidfd/kernel-interface assessment plus race lab, low-water-mark tombstone GC, polkit/package and root crash/power-loss/fault evidence. |
| `W0-SUPPORT-MATRIX` | PARTIAL | Windows Beta is frozen to x86_64 and Windows ARM64 must remain unsupported under the current official WinDivert/no-custom-driver route. `minimumSystemVersion=11.0` in the macOS Tauri overlay is only a provisional build floor, not a production support claim. Exact Windows versions, macOS minimum/architecture scope and Linux distro/kernel/userspace-network matrix still require owned lab evidence. |
| `W0-SIGNING-ACCOUNT` | BLOCKED | Commit a reviewed non-placeholder Windows publisher subject and leaf-certificate SHA-256, then prove trusted timestamped Authenticode for Taomni app/helper/service/installer, controlled/non-exported CI use, clean-host chain verification, renewal/rotation/revocation owner and exercise. EV and a custom kernel-driver signing path are not required or authorized. |
| `P0-RELEASE-OPS` | BLOCKED | Updater key custody/offline recovery/rotation/revocation; app/helper/provider/driver pin+ABI, protocol/schema, journal/tombstone and ready-handshake compatibility; protected evidence producer plus signed provenance/attestation binding raw evidence, candidate artifacts and shipped package; Active capture explicit stop/join before upgrade/rollback; staged rollout, stop-rollout kill switch and signed rollback exercise. |
| `P0-SECURITY` | BLOCKED | Privileged-boundary/parser/bypass/update-chain threat model; per-release SBOM/license/CVE/EOL output; fail-closed severity policy and time-bounded waivers. |
| `P0-SUPPORT` | BLOCKED | User-approved redacted support bundle, hostile-field redaction tests, bounded logs/receipts, crash-symbol access/retention and field-recovery runbook. |

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
- Package the fixed-path helper client/session launcher and exact-name TUN L3
  source plus landed bidirectional pump/lifecycle into a concrete stack + sole
  `FlowRuntime` composition factory and product `LinuxCaptureAdapter`, keeping
  capability start flags false until an installed probe and native evidence pass.
- Package a reviewed root policy/polkit path; exercise real privilege denial,
  stale receipt/tombstone, lost response, main-process kill, helper/data-plane
  kill, restart, power loss, and uninstall cleanup. Add tombstone GC driven only
  by a durable coordinator journal/rollback low-water mark; never delete merely
  by age/count, and preserve fail-closed response-loss retry.
- Integrate the landed source-level terminal/heartbeat fault withdrawal into
  the product adapter, coordinator journal and orchestrator; prove helper-first
  cleanup and recovery on real root failures. Source fake tests and later-user-
  operation health checks are not sufficient.
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

1. Implement and audit the pinned controlled TCP/UDP/reassembly/Virtual-DNS
   provider, then add the single product composition factory that performs the
   supervisor's one-shot ingress handoff to one `FlowRuntime` and aggregates
   provider/runtime/native health. Complete fuzz, conformance and optimized
   memory/performance checks before a platform capability can use it.
2. Finish Linux first as the nearest vertical slice: wrap the landed helper,
   TUN, pump and lifecycle contracts in the installed `LinuxCaptureAdapter`,
   connect coordinator/journal/orchestrator reconciliation, package polkit and
   fixed artifacts, and prove WAL/PID/fault/kill/power-loss cleanup in a
   disposable root lab.
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
   attestation for artifact, native, performance and raw evidence; JSON
   consistency alone is insufficient.
8. Exercise updater key recovery/rotation/revocation, staged rollout,
   stop-rollout and signed rollback; close threat-model/SBOM/CVE/support-bundle
   gates against the same candidate.
9. Keep `capture_implemented=false` and all three `can_start_*` fields false
   until the installed product adapter, signed artifact and privileged native
   evidence for that platform all pass.
