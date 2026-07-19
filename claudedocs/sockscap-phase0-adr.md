# ADR: Sockscap Phase 0 — Capture Technology, Licenses, and Gates

- Status: Accepted baseline; data-plane and Windows provider choices **frozen**;
  platform release gates open
- Date: 2026-07-18
- Last updated: 2026-07-19
- Branch: `feat/sockscap-gpt-sol-max`
- Related: `claudedocs/sockscap-cross-platform-design-plan.md` (Revision 5)

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
| Production data plane | Taomni-owned `FlowRuntime`; PacketIngress uses a pinned/audited IP-stack adapter; tun2proxy is reference/test-oracle only | Frozen; lower-stack version and real performance evidence remain gates |
| Windows capture | Global: Wintun/TUN; app/PID: WinDivert SOCKET/FLOW/NETWORK using an unmodified, hash-pinned official signed distribution | Frozen architecture; license, artifact, identity-race, EDR/VPN, performance and recovery evidence remain release gates |
| macOS capture | NETransparentProxyProvider system extension | Intent locked; source entitlement/signing contract landed, but Apple capability and real target remain hard gates |
| Linux capture | cgroup v2 + nft socket cgroup match + fwmark/TUN; managed launch netns fallback | Helper-side transaction and recovery source landed; packaged product adapter and privileged lab remain open |
| SSH host key | App-owned known-hosts store with exact `TRUST` / `REPLACE` fingerprint confirmation; background reconnect fails closed | Frozen; security gate closed |
| Phase 0 code in tree | Types, capability probe, preflight, orchestrator, commands, authenticated Linux helper transaction, signed-release source gates, native window smoke, performance/soak gates | Landed; real platform release evidence remains open |

## License and third-party inventory (Phase 0)

| Component | License (as of design review) | Use intent | Gate |
|---|---|---|---|
| tun2proxy | MIT | Behavior reference and differential test oracle only; not a production runtime dependency | Do not add/fork it as the product data plane without a new ADR |
| ipstack (exact version/commit TBD before dependency lands) | Apache-2.0 | Lower-level TCP/UDP reconstruction behind a Taomni-owned adapter, not a from-scratch TCP/IP implementation | Pin/audit or vendor; bounded queues, fuzzing, cancellation, IPv4/IPv6/DNS/UDP, performance and 24-hour evidence |
| WinDivert 2.2.2 baseline | LGPLv3 / GPLv2 dual; commercial license is an alternative | Frozen Windows app/PID provider; use only an unmodified official signed binary variant until a separately approved signing path exists | Pin exact variant and SHA-256; verify Authenticode/kernel signature on target Windows; complete LICENSE/NOTICE or commercial-license review, PID-race, packaging, EDR/VPN and uninstall gates |
| Wintun | Special / open (check current) | Windows global TUN | Signature + redistribution review |
| First-party WFP callout | Custom | Deferred; not a current fallback because the project cannot obtain the EV certificate/Hardware Developer Program path required for a releasable custom kernel driver | Any future adoption requires new authority, signing capability and a new ADR; if WinDivert gates fail, app/PID capability remains disabled |
| GFWList | LGPL-2.1 list content | Downloaded at runtime, not compiled into install package | Do not vendor list into MIT binary |
| russh (existing) | Apache-2.0 | Shared, bounded SSH Jump `direct-tcpip` controls/channels | Strict host-key verification and user-action errors landed |
| Existing proxy/tunnel modules | MIT (Taomni) | Reuse ResolvedProxy + direct-tcpip patterns | No second credential store |

**Rule:** any third-party network kernel must pass SBOM + license review before
it is added to `Cargo.toml` or shipped as a sidecar.

## Platform capability matrix (implementation intent)

| Mode | Windows | macOS | Linux |
|---|---|---|---|
| Global new connections | Wintun/TUN | NETransparentProxyProvider (or controlled TUN) | TUN |
| Application group | WinDivert SOCKET/FLOW/NETWORK | audit token + signing identity | cgroup v2 + nft + fwmark |
| Running PID | New connections only | New connections only | Conditional; degrade if no cgroup v2 |
| Children | Process tree / identity | audit token / tree | cgroup inheritance |

Phase 0 probes in `sockscap::capabilities` report host readiness but keep
`capture_implemented = false` and `can_start_* = false`. Linux helper source is
not equivalent to an installed product adapter: a packaged launcher/client,
userspace TUN packet pump, root policy, and privileged end-to-end smoke must all
exist before the UI may claim routing works.

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
3. The packaged WinDivert driver must be an unmodified official signed artifact
   with an exact version, binary variant, signer and SHA-256 recorded in the
   release manifest. Taomni must not patch or rebuild the driver without a new,
   approved production-signing path.
4. A first-party WFP callout is outside the current delivery path because the
   project cannot obtain an EV certificate and complete the Microsoft Hardware
   Developer Program/HLK release path. WFP is not a silent fallback: if
   WinDivert fails a hard gate, Windows app/PID capture remains unavailable and
   capability probing must explain why.

## Open gates (must close before leaving Phase 0)

1. **Windows WinDivert delivery**: prove the official signed artifact and
   redistribution posture, SOCKET/FLOW→NETWORK identity race handling,
   reinjection correctness, IPv6, EDR/VPN coexistence, performance and uninstall
   recovery. Failure keeps app/PID capabilities disabled; there is no current
   WFP fallback.
2. **macOS entitlement**: obtain Network Extension entitlement; without it, macOS vertical is blocked.
3. **Production IP-stack adapter**: freeze the exact lower-stack dependency and
   demonstrate per-flow identity, bounded lifecycle/cancellation, Virtual DNS,
   IPv4/IPv6, explicit UDP degradation, fuzzing, statistics, performance and
   24-hour resource gates.
4. **Installed recovery path**: the journal, authenticated helper heartbeat,
   root-owned receipts, rollback transaction, and tests have landed. Product
   helper-client/TUN-pump wiring plus real host-artifact kill/restart/uninstall
   recovery are still required before Active on Linux.
5. **VPN / sleep / NIC switch conflict matrix**: documented test plan; not yet executed.
6. **Release artifacts and long-run evidence**: the Windows/macOS signature and
   entitlement verifiers plus fixed core/platform performance gates have
   landed, but real signed artifacts, packet-capture measurements, and the
   required 24-hour runs have not.

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
- [ ] Exact ipstack/Wintun/WinDivert artifact versions, variants and SHA-256 values recorded in the release manifest/SBOM

## Consequences

### Positive
- Clear module boundary (`sockscap` ≠ Application Proxy)
- Fail-fast preflight prevents silent “only this app” pretence
- License posture documented before any heavy dependency lands

### Negative / cost
- Phase 0 cannot demo real capture yet
- WinDivert identity correlation, third-party signer, license and compatibility
  constraints are now explicit release risks
- A failed WinDivert hard gate disables Windows app/PID capture because a
  releasable first-party WFP driver is not currently available
- macOS blocked on Apple entitlement process outside pure code

## Implementation notes (this branch)

```
src-tauri/src/sockscap/
  mod.rs
  types.rs          # EngineState, profiles, conflicts
  capabilities.rs   # read-only, fail-closed installed-capability probes
  preflight.rs      # fail-fast start gate
  orchestrator.rs   # state machine; no installed product adapter attached
  commands.rs       # Tauri IPC surface
  capture/
    adapter.rs       # CaptureAdapter transaction contract
    coordinator.rs   # prepare/activate/stop/recover journal coordination
    helper_protocol.rs
    unix_transport.rs # peer credentials, executable pin, HMAC transport
    linux*.rs        # cgroup/nft/fwmark/TUN transaction and root helper

src-tauri/src/bin/
  sockscap_helper.rs # root-only Linux helper server
  sockscap_gate.rs   # synthetic core quick/soak evidence harness

scripts/sockscap/    # Windows/macOS artifact gates + performance verifier
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
- Shared runtime work: pinned/audited IP-stack adapter, bounded PacketIngress,
  fuzzing and differential behavior tests against tun2proxy/reference fixtures
- Windows product work: Wintun global plus the unmodified official signed
  WinDivert app/PID path; no first-party WFP implementation in the current scope
- Linux product work: install policy, helper client/launcher, TUN packet pump,
  managed-netns fallback, and privileged distro/recovery lab
- Platform release work: real Windows signatures, Apple capability/signing/
  notarization, native packet/leak/performance matrices, and 24-hour evidence
