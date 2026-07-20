# ADR: Sockscap Phase 0 — Capture Technology, Licenses, and Gates

- Status: Accepted baseline; data-plane, Windows provider and first Windows
  production architecture choices **frozen**; platform/support release gates open
- Date: 2026-07-18
- Last updated: 2026-07-20
- Branch: `feat/sockscap-gpt-sol-max`
- Related: `claudedocs/sockscap-cross-platform-design-plan.md` (Revision 8)

## Context

Sockscap must intercept system traffic on Windows, macOS, and Linux, attribute
flows to processes, and route them through PROXY / DIRECT / BLOCK without TLS
MITM. The design plan requires a Phase 0 capability and license gate before any
large UI or full adapter implementation.

This ADR records the frozen architecture choices and the implementation/release
gates that remain **open** until real platform evidence exists.

## Decision summary

| Topic | Decision | Freeze status |
|---|---|---|
| Product name / module | `Sockscap` as independent module (`src-tauri/src/sockscap/`), not an extension of Application Proxy | Frozen |
| Capture architecture | Single capture plane + multi RoutingProfile; adapters do identity/capture only | Frozen |
| Fail policy | Global default fail-open; per-profile fail-closed allowed | Frozen |
| Unknown hostname | Default DIRECT; strict PROXY/BLOCK optional; expose unknown metrics | Frozen |
| TCP-only egress UDP | HTTP CONNECT + SSH Jump default BLOCK for UDP/QUIC | Frozen |
| Production data plane | Taomni-owned `FlowRuntime`; PacketIngress uses a pinned/audited IP-stack adapter; tun2proxy is reference/test-oracle only | Frozen; bounded ingress/L3 admission, in-memory TCP relay and cancellation-safe public `ProductDataPlaneSupervisor` generation ownership have landed. Root-cause diagnostics are separate from retryable cleanup proof. No concrete controlled TCP/UDP/reassembly/Virtual-DNS provider or native/performance evidence exists |
| Windows capture | Global: Wintun/TUN; app/PID: WinDivert SOCKET/FLOW/NETWORK using an unmodified, hash-pinned official package containing the production-signed kernel driver | Frozen architecture; license, DLL provenance/architecture/hash, driver signer/hash, identity-race, EDR/VPN, performance and recovery evidence remain release gates |
| Windows first production scope | Sockscap Beta is `x86_64` only. Under the current official WinDivert/no-custom-driver route, Windows ARM64 Sockscap is not released and app/PID remains unavailable | Frozen for the first production Beta; ARM64 probes/manifests must fail closed rather than imply support |
| Windows user-mode signing | Taomni app/helper/service/installer require trusted, timestamped Authenticode with controlled key custody; this plan does not require EV and does not authorize a custom kernel driver | Fixed first-party policy is deliberately `unconfigured`; publisher/certificate review, route/vendor/account, CI identity, rotation, revocation and clean-host evidence remain external release gates |
| macOS capture | NETransparentProxyProvider system extension | Intent locked; source entitlement/signing/profile-certificate/full-`.app` digest contract landed, but fixed Team/certificate/architecture policy is `unconfigured`, and Apple capability plus real target remain hard gates |
| Linux capture | cgroup v2 + nft socket cgroup match + fwmark/TUN; managed launch netns fallback | WAL/PID/client/TUN/pump, public generation supervisor, product adapter/coordinator recovery and hardened DEB/RPM package contracts landed. Disk Store uses WAL + `synchronous=FULL`; all runtime owners from one Store share a detached-operation mutex. Canonical directory/lock/DB checks plus the retained OS owner lock are the intended source-level journal boundary; desktop single-instance is activation UX only. Same-process double-open/drop-release and Unix path tests exist, while handle-relative SQLite/VFS, Windows SID/DACL and three-platform cross-process/crash/multi-session native evidence remain open; concrete provider/final builder/default async injection, complete distro dependency/signing policy and privileged lab also remain open |
| Remaining support matrices | Freeze minimum macOS version/Apple Silicon/Intel scope and Linux distro/kernel/systemd/cgroup/nft/iproute2/resolver/NetworkManager scope only after real lab evidence and a maintenance owner exist | Open; macOS overlay `11.0` is only a provisional build floor, not a frozen production support claim |
| Production release operations | Updater key custody/rotation/revocation; signed rollback compatibility across component pin/ABI, protocol/schema, journal/tombstone and ready handshake; Active capture clean stop; staged rollout/stop-rollout; continuous SBOM/CVE, threat model, support bounds | Open and blocking. Source/Quick Non-Release workflow Actions are commit-SHA pinned and Rust/MSRV is fixed to 1.95.0 after real 1.94 compilation exposed incompatible current dependencies. Windows/macOS source compile/process jobs are configured, but require matching CI runner results before they can be called PASS; formal `release.yml` does not depend on this workflow. Protected build/sign/publish provenance, runner image and update-audit process are not closed |
| SSH host key | App-owned known-hosts store with exact `TRUST` / `REPLACE` fingerprint confirmation; background reconnect fails closed | Frozen; security gate closed |
| Phase 0 code in tree | Types, capability probe, preflight, orchestrator, commands, authenticated Linux helper WAL/PID/client/TUN/lifecycle/fault-monitor contracts, generation product adapter/recovery boundary, Linux DEB/RPM package Gate, signed-release source gates, bounded decoded-stream + L3 packet ingress/profile selection/IP-stack admission/packet-stack supervisor/product composition/FlowRuntime relay, native window smoke, performance/soak gates | Landed contracts/memory slices only; complete packet→TCP/UDP provider, default product/async IPC wiring and real release evidence remain open |

## License and third-party inventory (Phase 0)

| Component | License (as of design review) | Use intent | Gate |
|---|---|---|---|
| tun2proxy | MIT | Behavior reference and differential test oracle only; not a production runtime dependency | Do not add/fork it as the product data plane without a new ADR |
| ipstack 1.0.1 candidate (`v.1.0.1`, commit `a343ea8c696e761acce8dbcd6687c862ecd8aacd`) | Apache-2.0 | Isolated lower-stack spike only; it has **not** been accepted into production dependencies | Source inspection found multiple `mpsc::unbounded_channel` paths. Do not add it to production `Cargo.toml` until an isolated spike establishes a bounded fork/upstream patch or another controlled adapter and closes UDP, cancellation, lifecycle, fuzz, IPv4/IPv6/DNS, performance and 24-hour resource gates |
| WinDivert 2.2.2-A baseline | LGPLv3 / GPLv2 dual; commercial license is an alternative | Frozen Windows app/PID provider; use only an unmodified official package. The audited x64 `WinDivert.dll` has no PE Authenticode certificate table, while `WinDivert64.sys` is signed; do not treat both files as having the same signer contract | Pin exact package/variant and per-file SHA-256; DLL: verify official-package provenance, PE architecture and hash, with no invented upstream signer requirement. Driver: verify expected signer, hash and kernel policy (`signtool /kp`) on target Windows. Complete LICENSE/NOTICE or commercial-license review, PID-race, packaging, EDR/VPN and uninstall gates |
| Wintun 0.14.1 | WireGuard project redistribution terms | Windows global TUN, using the unmodified official x64 DLL from the pinned ZIP | Preserve the bundled license and permitted-API constraints; verify official package/file hashes, x86_64 PE architecture and signer on the target Windows package |
| First-party WFP callout | Custom | Deferred; not a current fallback because the project cannot obtain the EV certificate/Hardware Developer Program path required for a releasable custom kernel driver | Any future adoption requires new authority, signing capability and a new ADR; if WinDivert gates fail, app/PID capability remains disabled |
| GFWList | LGPL-2.1 list content | Downloaded at runtime, not compiled into install package | Do not vendor list into MIT binary |
| russh (existing) | Apache-2.0 | Shared, bounded SSH Jump `direct-tcpip` controls/channels | Strict host-key verification and user-action errors landed |
| Existing proxy/tunnel modules | MIT (Taomni) | Reuse ResolvedProxy + direct-tcpip patterns | No second credential store |

**Rule:** any third-party network kernel must pass SBOM + license review before
it is added to `Cargo.toml` or shipped as a sidecar.

### Frozen Windows third-party source pins

These SHA-256 values are the source/template baseline, not proof that a final
installed package passed its same-host Windows signature Gate:

| Artifact | Official path | SHA-256 |
|---|---|---|
| Wintun 0.14.1 ZIP | `wintun-0.14.1.zip` | `07c256185d6ee3652e09fa55c0b673e2624b565e02c4b9091c79ca7d2f24ef51` |
| Wintun x64 DLL | `wintun/bin/amd64/wintun.dll` | `e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce` |
| Wintun license | `wintun/LICENSE.txt` | `183adac21e7d96c508c8fd34d394b7b6708bc81564ad1bad61ab66143a008cd2` |
| WinDivert 2.2.2-A ZIP | `WinDivert-2.2.2-A.zip` | `63cb41763bb4b20f600b6de04e991a9c2be73279e317d4d82f237b150c5f3f15` |
| WinDivert x64 DLL | `WinDivert-2.2.2-A/x64/WinDivert.dll` | `c1e060ee19444a259b2162f8af0f3fe8c4428a1c6f694dce20de194ac8d7d9a2` |
| WinDivert x64 driver | `WinDivert-2.2.2-A/x64/WinDivert64.sys` | `8da085332782708d8767bcace5327a6ec7283c17cfb85e40b03cd2323a90ddc2` |
| WinDivert license | `WinDivert-2.2.2-A/LICENSE` | `14a0cb5214d536e4fdae6aa3f5696f981eeda106cd026e9794bba489ee79d628` |

The official 2.2.2-A x64 DLL is expected to be unsigned and is accepted only
through the exact ZIP/path/hash/PE-architecture chain. The driver separately
requires the pinned signer and a successful target-Windows `signtool /kp` run.

## Platform capability matrix (implementation intent)

| Mode | Windows | macOS | Linux |
|---|---|---|---|
| Global new connections | Wintun/TUN | NETransparentProxyProvider (or controlled TUN) | TUN |
| Application group | WinDivert SOCKET/FLOW/NETWORK | audit token + signing identity | cgroup v2 + nft + fwmark |
| Running PID | New connections only; first Beta x86_64 | New connections only | Conditional; degrade if no cgroup v2 |
| Children | Process tree / identity | audit token / tree | cgroup inheritance |

Phase 0 probes in `sockscap::capabilities` report host readiness but keep
`capture_implemented = false` and `can_start_* = false`. Linux helper/client and
TUN/pump/lifecycle source primitives plus the landed product adapter/public
supervisor are not equivalent to an installed product path: a concrete
controlled TCP/UDP/reassembly/Virtual-DNS provider, final snapshot/profile
builder, trusted tuple side channel, default async AppState/IPC/tray injection,
complete distro dependency/signing policy, and privileged end-to-end
fault/capture smoke must all exist before the UI may claim routing works.

## Reference baseline

- Local reference: `wsstun` commit `8282eb2` (`src/sockscap/*`, macOS provider)
- Use as **behavior reference only** — no runtime path dependency between repos
- Do not copy MITM inspection, WebSocket upstream, or CLI secret passing

## Frozen amendment (2026-07-19)

1. The shared product data plane is Taomni-owned `FlowRuntime`. Packet-based
   adapters feed a small, replaceable IP-stack adapter that produces flows for
   the existing policy and Direct/SOCKS5/HTTP CONNECT/SSH connectors. Taomni
   does not implement TCP/IP from scratch, and tun2proxy is not a production
   dependency.
2. Windows global capture remains Wintun/TUN. Windows application/PID capture
   uses WinDivert SOCKET/FLOW/NETWORK and the `wsstun` implementation only as a
   behavior reference.
3. The packaged WinDivert files must come from one unmodified official package.
   The release manifest records exact package version/variant and per-file
   SHA-256. For the current 2.2.2-A x64 baseline, `WinDivert.dll` has no PE
   Authenticode certificate table, so its contract is official-package
   provenance + PE architecture + hash, not a fictitious upstream DLL signer.
   `WinDivert64.sys` must match the expected signer/hash and pass kernel-policy
   verification. Taomni must not patch or rebuild the driver without a new,
   approved production-signing path.
4. A first-party WFP callout is outside the current delivery path because the
   project cannot obtain an EV certificate and complete the Microsoft Hardware
   Developer Program/HLK release path. WFP is not a silent fallback: if
   WinDivert fails a hard gate, Windows app/PID capture remains unavailable and
   capability probing must explain why.
5. The first production Windows Sockscap Beta targets x86_64 only. Windows
   ARM64 is not a release target under the current official WinDivert and
   no-custom-driver constraints; in particular, app/PID capabilities must stay
   false with a stable unsupported reason. No WFP or test-signed fallback is
   introduced to change that result.
6. Taomni app/helper/service/installer still require a trusted, timestamped
   user-mode Authenticode path. EV is not a prerequisite imposed by this plan,
   because Taomni is not signing a first-party kernel driver; key custody,
   timestamping, rotation/revocation and clean-host verification remain open.
7. Concrete Windows OS versions plus macOS and Linux minimum support matrices
   are release decisions, not guesses. Windows architecture is frozen to
   x86_64, but each supported Windows version still requires owned Secure
   Boot/EDR/VPN evidence. The macOS overlay's
   `minimumSystemVersion=11.0` is only a provisional build
   floor. Production matrices remain open until real entitlement/build/lab
   evidence and a maintenance owner support an explicit list.
8. The source half of `S0-CONTRACT-ALIGN` is complete: capability copy, schema 2
   Windows template, fixed release policies, artifact verifier and performance
   receipt tests accept only WinDivert/x86_64 and contain the exact
   Wintun/WinDivert pins above. The Windows publisher/certificate and macOS
   Team/certificate/architecture policy values are deliberately
   `unconfigured`; a staging manifest cannot override them. The Gate remains
   PARTIAL until reviewed identities are committed and final staged artifacts
   pass non-lint runs on their matching hosts, including Windows `/kp` and the
   macOS full verified `.app` digest. Final DMG/PKG/updater binding remains part
   of protected build provenance. Named verifier suites and their current
   counts are recorded in the release ledger/design plan rather than frozen in
   this ADR; macOS host and Bash 3.2 syntax/lint pass, and PowerShell 7.2.24 AST
   plus disabled-template lint pass. None is a real platform non-lint artifact
   run.
9. The first owned shared-runtime slice is implemented and lifecycle-hardened:
   bounded/cancellation-safe decoded `FlowIngress`; capture intent that prevents
   missing app/PID evidence from silently reaching global policy; trusted,
   revisioned child-profile queues; immutable selector limits; revision plus
   full-profile-fingerprint `FlowEngine` binding; and supervisor-owned
   `FlowRuntime` admission, relay, exactly-once close attempts, retryable owner
   cleanup and absolute shutdown deadline. Runtime root-cause diagnostics are
   independent from current cleanup proof: a provider fault may remain visible
   after every owner joins, while any unobserved task/profile/egress/stack join
   keeps cleanup pending. Revision 8 focused and full-suite evidence is recorded
   in the design plan §14.6 after each final run rather than frozen here as a
   stale count. Product Linux adapter/composition source exists, but no concrete
   stack or default async product injection does; no capability is unlocked.
10. `ipstack` 1.0.1 remains an isolated candidate, not a production dependency.
    Its unbounded internal channels conflict with the frozen bounded-queue Gate;
    the next decision is an audited bounded fork/upstream patch versus another
    controlled adapter after an isolated spike, not silent acceptance.
11. The replaceable packet-stack boundary is explicit but remains release-neutral
    source code. `PacketStackSupervisor` checks exact provider/capability/
    generation/revision/platform/queue identity and preserves first-terminal
    cause. The only public start boundary is `ProductDataPlaneSupervisor`: its
    detached generation worker and registry retain startup/recovery ownership
    even if the caller future is cancelled. Linux delegates to this registry;
    Windows/macOS must reuse it. Stack/runtime/profile/task shutdown timeout
    retains retry state, and a bounded emergency reaper is never accepted as
    clean-shutdown, helper rollback, or release recovery proof.
12. The Linux source lifecycle now starts native capture and reinject pumps and
    proves both ready before helper activation; it rechecks the combined native
    pump/data-plane identity and health before and after activation, serializes
    mutation operations, and retains joinable runtime/data-plane owners in the
    lifecycle record across caller cancellation. The helper first computes a
    side-effect-free restore plan, fsyncs its root-owned write-ahead receipt, and
    only then mutates cgroups/TUN/routes; membership refresh similarly persists
    each restore delta before moving a process. PID identity is a Linux kernel
    start-tick incarnation token; start tick, UID, owned/original cgroup and
    exact post-move target are revalidated around apply/cleanup. The operation
    mutex and helper receipt do not replace the separate durable product
    coordinator journal. The helper publishes a
    generation/UID/artifact-bound cleaned tombstone before deleting the pending
    receipt, so a lost response can trigger another absence audit. Tombstones
    currently remain until `/run` is reset; production GC must be driven by a
    durable coordinator journal/rollback low-water mark, never by age/count
    alone, and must preserve fail-closed response-loss retry. These are source
    contracts only: the shared composition and product
    `LinuxCaptureAdapter`/coordinator/orchestrator recovery boundary now exist,
    but there is no concrete controlled stack provider, final profile/config
    builder, trusted tuple side channel or default async product injection. A
    source monitor performs helper-first withdrawal for terminal local faults,
    while real heartbeat/pump/helper crash/package/GC evidence remains absent.
    The numeric PID accepted by `cgroup.procs` cannot
    make identity validation and the write one atomic kernel operation; a real
    PID-reuse stress lab and pidfd/kernel-interface assessment remain mandatory.
13. `PacketFlowRegistry` now maintains explicit active TCP and UDP counts, so
    transport-limit admission no longer scans the complete flow table. This is
    not a claim that every `HashMap` operation has strict worst-case O(1), and it
    does not close the performance or long-stability Gate.
14. Packet admission now parses IPv6 extension chains with bounded head/byte
    budgets and strict ordering/length/TLV/reserved-field checks, derives the
    final transport protocol, and marks fragments before tuple parsing.
    Truncated, malformed, repeated/out-of-order or over-budget chains fail
    closed. Fragment reconstruction is still assigned to the missing bounded
    reassembly provider; this parser is not evidence that reassembly exists.
15. Linux package source security is fail-closed: `/run/taomni` must be exact
    root:root 0755; helper sessions hold a shared lifecycle lock while package
    transactions require the exclusive lock and a crash-persistent sentinel.
    Stage/build policy cannot be bypassed by a raw Tauri overlay invocation;
    verifier inputs are private snapshots run through a controlled environment,
    and DEB/RPM transaction/trigger/sysusers/policies/file-capability/file-flag
    metadata are rejected unless explicitly frozen. Architecture, both OpenPGP
    signers and the complete distro GUI/runtime dependency profile remain
    `unconfigured`, so no production candidate can pass yet.
16. Capture runtime operations execute as owned detached transactions under a
    store-scoped mutex shared by every runtime owner derived from the same
    `SockscapStore`; cancellation of the caller does not release transaction
    ownership or abort cleanup, and another runtime instance cannot bypass
    serialization. Prepare durably binds the selected adapter and
    generation before invoking a privileged adapter; after the call, coordinator
    checks exact platform/spec/generation/config revision/helper PID and complete
    handle/artifact lineage. Recovery rereads the journal and applies an
    expected-generation CAS/revalidation guard before cleanup. A rejected or
    otherwise untrusted receipt is never passed to privileged `stop(handle)`;
    only generation-scoped rollback through the already-bound adapter is allowed.
17. Disk-backed `SockscapStore` uses WAL + `synchronous=FULL` (the memory test
    store remains `NORMAL`), canonicalizes and holds the app-data directory,
    validates directory/owner-lock/DB identities before and after open, and
    keeps the OS lock until SQLite closes. Unix tightens the directory to 0700
    and DB/WAL/SHM/lock files to 0600 while rejecting unsafe links; Windows
    source rejects reparse points, excludes delete sharing on directory/lock
    handles and compares volume/File ID. This retained lock—not Tauri's
    exact-pinned desktop single-instance plugin—is the intended source-level
    journal ownership boundary; the plugin remains activation UX only. Current
    evidence is same-process double-open/drop-release plus Unix path tests.
    Handle-relative SQLite/VFS opening, Windows SID/DACL, malicious same-user
    substitution, cross-process/crash/multi-session native tests, WAL/disk-full/
    I/O/corruption/power-loss and helper/package-lock tests remain required.
18. The single-instance callback currently provides best-effort focus only. It
    does not yet queue activation before the main window exists or forward a
    second launch's `--sockscap-auto-restore` request. Production activation
    requires a bounded allowlisted intent queue, revalidation of persisted
    restore opt-in, and native startup/autostart/updater race tests; no CLI
    argument may bypass the journal or capability Gates.

## Open gates (must close before leaving Phase 0)

1. **Frozen-contract alignment — source complete, platform evidence open**:
   capability copy, schema/templates, fixed policy, artifact verifier,
   performance receipts and tests now reject `wfp` and `unselected` as
   releasable Windows providers and pin the exact WinDivert/Wintun package/
   version/variant/architecture/hashes. Signer is required only where the
   artifact contract provides one: WinDivert DLL uses official-package
   provenance/architecture/hash; the driver uses expected signer/hash and
   `/kp`. First-party Windows/macOS policy placeholders must be replaced by
   reviewed identities before real final distributions can pass their non-lint
   same-host verifiers.
2. **Windows support/signing inputs**: enforce the x86_64-only first Beta and
   fail-closed Windows ARM64 behavior; select and provision trusted user-mode
   Authenticode for app/helper/service/installer with controlled CI access,
   timestamp, renewal, rotation and revocation procedures; commit its exact
   publisher subject and leaf-certificate SHA-256 to the fixed policy. No EV or
   WFP driver is required or authorized by this gate.
3. **Windows WinDivert delivery**: prove the official-package provenance,
   DLL architecture/hash, signed-driver signer/hash, redistribution posture,
   SOCKET/FLOW→NETWORK identity race handling,
   reinjection correctness, IPv6, EDR/VPN coexistence, performance and uninstall
   recovery. Failure keeps app/PID capabilities disabled; there is no current
   WFP fallback.
4. **macOS entitlement and support matrix**: obtain Network Extension
   entitlement, commit the reviewed Team ID/signing-certificate/architecture
   policy, and then freeze the minimum macOS version and Apple Silicon/Intel
   scope from real signed builds/labs. The overlay's provisional `11.0` floor is
   not that production matrix.
5. **Linux support matrix**: freeze the distro/kernel/systemd/cgroup/nft/
   iproute2/resolver/NetworkManager matrix and maintenance owner before a Linux
   release claim.
6. **Production IP-stack adapter**: the owned decoded-stream boundary,
   `FlowDescriptor`, `ProfileSelector`, bounded L3 PacketIngress queues,
   provider pin/limits, tuple admission, replaceable supervisor and in-memory
   TCP relay have landed. Queue `source_id` prevents cross-device pairing;
   provider readiness is bound to an absolute deadline and the decoded-flow
   ingress has a one-shot handoff. The public generation registry is the sole
   product start/recovery boundary and retains ownership across caller cancel.
   Strict IPv6 extension parsing rejects malformed chains and routes fragments
   to the still-missing reassembly boundary. These are source contracts, not a
   stack.
   `ipstack` 1.0.1 is not accepted because its unbounded channels violate the
   Gate. Run it only as an isolated spike, decide a bounded fork/upstream patch
   or another controlled adapter, then implement the full packet→TCP/UDP bridge
   and demonstrate UDP, Virtual DNS, IPv4/IPv6, cancellation/half-close/RST,
   fuzzing, statistics, performance and 24-hour/7-day resource gates.
7. **Installed recovery path**: the coordinator journal, authenticated helper
   heartbeat, mutation-before-WAL root receipts, rollback transaction,
   generation-only recovery API and cleaned-generation tombstone contract have
   landed. Linux source lifecycle keeps local owners across cancellation, waits
   for both pumps before activation and source-tests helper-first withdrawal on
   terminal faults. Package-integrated helper/policy/polkit, lifecycle
   lock/sentinel and product supervisor/`CaptureAdapter`/coordinator
   reconciliation source contracts now exist; a concrete provider/final
   builder, complete dependency/signing policy, default async injection and real
   host heartbeat/pump/helper kill/restart/power-loss/uninstall recovery are
   still required before Active can be exposed. Add
   durable journal/rollback-low-water-mark tombstone GC and prove response-loss
   retry remains fail-closed; time/count-only deletion is forbidden. Emergency
   task reaping is not cleanup evidence.
8. **VPN / sleep / NIC switch conflict matrix**: documented test plan; not yet executed.
9. **Release artifacts and long-run evidence**: the Windows/macOS signature and
   entitlement/full-app candidate verifiers, Linux DEB/RPM
   signature/payload/script/installed-file verifier, plus fixed core/platform
   performance gates have landed, but first-party policy remains unconfigured,
   real signed artifacts, typed real-capture smoke, packet measurements and the
   required 24-hour runs have not. The aggregate Gate re-hashes candidate files
   on the matching host; schema/hash consistency is still not producer identity.
   Protected lab/CI must add signed provenance/attestation binding final
   app/helper/provider/full-app hashes, host and raw evidence; the same
   attestation must also bind the shipped installer/DMG/PKG/updater artifact.
   Linux package-manager provenance is deliberately blocked until a protected
   lab-runner identity/public key and signature protocol are reviewed and
   configured; self-reported lifecycle receipts cannot pass.
10. **Production operations/security/support**: close updater signing-key
    custody/rotation/revocation, staged rollout/stop-rollout/signed rollback,
    compatibility across app/helper/provider/driver pin+ABI, protocol/schema,
    journal/tombstone and ready handshake, and explicit Active-capture stop/join;
    close 24-hour plus staged 7-day long-stability evidence, continuous
    SBOM/CVE/EOL handling, privileged-boundary threat model, and a user-approved
    redacted support bundle with symbol and log-retention bounds.

Closed security gate: `terminal::hostkey` now stores canonical host/port entries in
an app-owned, permission-hardened JSON known-hosts file. First use and key changes
require exact fingerprint confirmation on an interactive path; unattended starts
and reconnects return stable user-action-required errors. The shared SSH pool
reuses only verified controls and never turns a failed check into implicit trust.

## Exit criteria (from design plan §13 Phase 0)

- [ ] Three platforms: TCP vertical slice global + selected app to local echo/HTTP
- [ ] SOCKS5, HTTP CONNECT, SSH Jump egress repeatable tests
- [ ] stop and kill -9 restore network
- [ ] No unexplained DNS / IPv6 leak
- [x] This ADR amended with frozen production data-plane and Windows capture choices
- [x] First production Windows Sockscap Beta architecture scope frozen to x86_64; no Windows ARM64 or WFP fallback claim
- [x] Source capability/manifest/verifier/test contracts enforce WinDivert-only and reject Windows ARM64 release evidence
- [ ] Final staged Windows artifacts pass the non-lint same-host verifier, including driver `/kp`
- [ ] Trusted Windows user-mode Authenticode account/service and key lifecycle verified
- [ ] Fixed Windows publisher/certificate and macOS Team/certificate/architecture policies reviewed and configured
- [ ] Minimum macOS and Linux support matrices frozen from real lab evidence
- [x] Exact Wintun 0.14.1 and WinDivert 2.2.2-A package/DLL/driver/license hashes recorded in committed `windows/release-policy.json` and this ADR; disabled manifest is not a trust source
- [x] Production data-plane/IP-stack architecture decision frozen; tun2proxy remains oracle only
- [ ] Concrete controlled provider and complete release SBOM/license inventory closed
- [ ] Typed native-capture producer and protected signed lab/CI attestation bind one candidate and final distribution artifacts
- [ ] Production updater/security/support work packages closed with exercise evidence

## Consequences

### Positive
- Clear module boundary (`sockscap` ≠ Application Proxy)
- Fail-fast preflight prevents silent “only this app” pretence
- License posture documented before any heavy dependency lands

### Negative / cost
- Phase 0 cannot demo real capture yet
- WinDivert identity correlation, driver signer, DLL provenance/hash, license and compatibility
  constraints are now explicit release risks
- A failed WinDivert hard gate disables Windows app/PID capture because a
  releasable first-party WFP driver is not currently available
- The first production Windows Sockscap Beta excludes ARM64; adding it requires
  an official compatible capture route and a new support-matrix amendment
- Trusted user-mode signing and production updater operations are external and
  operational dependencies even though no EV certificate is required
- macOS blocked on Apple entitlement process outside pure code

## Implementation notes (this branch)

```
src-tauri/src/sockscap/
  mod.rs
  types.rs          # EngineState, profiles, conflicts
  capabilities.rs   # read-only, fail-closed prerequisite probes; installed artifact/signature/data-plane/scope probes remain open
  preflight.rs      # fail-fast start gate
  orchestrator.rs   # state machine; no installed product adapter attached
  commands.rs       # Tauri IPC surface
  capture/
    adapter.rs       # CaptureAdapter transaction contract
    coordinator.rs   # durable platform/spec/handle-bound lifecycle transaction
    runtime.rs       # serialized async adapter recovery owner
    helper_protocol.rs
    unix_transport.rs # peer credentials, executable pin, HMAC transport
    linux*.rs        # cgroup/nft/fwmark/TUN transaction, helper and client
    linux_tun.rs     # exact-name/owner-verified nonblocking L3 TUN source
    linux_product.rs # generation-scoped product adapter owner
    linux_data_plane.rs # Linux bridge to shared product supervisor
    packet_device.rs # bounded native↔stack L3 packet contract
  flow/
    ingress.rs       # bounded decoded TCP ingress + fail-closed FlowDescriptor
    runtime.rs       # owned admission/tasks + in-memory TCP relay
    ip_stack.rs      # pinned provider/admission/tuple lifecycle contract
    packet_stack.rs  # replaceable provider supervisor/readiness/ownership contract
    composition.rs   # cancellation-safe public generation supervisor/registry
  policy/
    selector.rs      # immutable profile selection from trusted identity

src-tauri/src/bin/
  sockscap_helper.rs # root-only Linux helper server
  sockscap_gate.rs   # synthetic core quick/soak evidence harness

scripts/sockscap/    # Windows/macOS/Linux artifact gates + performance verifier
src-tauri/platform/sockscap/ # disabled release manifest templates/contracts

src-tauri/src/terminal/
  hostkey.rs        # strict app-owned known-hosts and confirmation gate
  ssh_pool.rs       # bounded shared control/channel pool for direct-tcpip
```

Commands registered in `lib.rs`:
`sockscap_capabilities`, `sockscap_status`, `sockscap_preflight`,
`sockscap_start`, `sockscap_stop`, `sockscap_recover`, `sockscap_open_window`.

## Follow-ups

- Phase 1: immutable policy matcher + GFWList projection + profile schema
- Phase 2: FlowEngine + egress connectors + SshChannelPool extraction (core landed;
  production profile/session orchestration remains in Phase 3)
- Phase 3: sockscap.db + recovery journal + browser stubs
- Shared runtime work: retain the completed bounded decoded-stream ingress,
  identity selector, strict IPv6 admission, memory TCP relay and packet-stack
  supervisor/public generation registry; keep
  ipstack 1.0.1 out of production dependencies while an isolated spike decides
  a bounded fork/upstream patch or another controlled adapter; then implement
  the complete packet→TCP/UDP/reassembly/Virtual-DNS provider, final
  profile/config builder, default async product injection/fault reconciliation, fuzzing and
  differential behavior tests against tun2proxy/reference fixtures
- Windows product work: Wintun global plus the unmodified official WinDivert
  package/app/PID path on x86_64; validate DLL provenance/architecture/hash and
  signed-driver signer/hash separately; no Windows ARM64 release and no
  first-party WFP implementation in the current scope
- Contract-alignment work: source contract is aligned; run the final non-lint
  same-host Windows artifact verifier and retain `/kp` evidence after committing
  the reviewed non-placeholder publisher/certificate policy
- Windows release-input work: trusted user-mode Authenticode account/service,
  timestamp, key custody, renewal, rotation and revocation
- Linux product work: connect the landed fixed-path helper/TUN/pump, public
  supervisor, generation `CaptureAdapter` and coordinator seam to a concrete
  packet stack/final snapshot builder and the default async AppState/IPC/tray
  path; complete distro dependency/OpenPGP policy, signed repository/package,
  managed-netns fallback, durable tombstone GC, and privileged response-loss/
  heartbeat/pump/helper-crash/package-manager/distro lab
- Platform release work: real Windows signatures, Apple capability/signing/
  notarization/full-app digest plus attested DMG/PKG, typed native packet/leak/performance
  matrices, protected provenance/attestation, and 24-hour evidence
- Production operations work: staged rollout/stop-rollout/signed rollback,
  updater key lifecycle, continuous SBOM/CVE, threat model, redacted support
  bundle, crash symbols and bounded logs
