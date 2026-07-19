# ADR: Sockscap Phase 0 — Capture Technology, Licenses, and Gates

- Status: Accepted baseline; Windows provider choice and platform release gates **open**
- Date: 2026-07-18
- Last updated: 2026-07-19
- Branch: `feat/sockscap-gpt-sol-max`
- Related: `claudedocs/sockscap-cross-platform-design-plan.md` (Revision 3)

## Context

Sockscap must intercept system traffic on Windows, macOS, and Linux, attribute
flows to processes, and route them through PROXY / DIRECT / BLOCK without TLS
MITM. The design plan requires a Phase 0 capability and license gate before any
large UI or full adapter implementation.

This ADR records decisions that are **safe to lock now** and gates that remain
**open** until platform spikes complete.

## Decision summary

| Topic | Decision | Freeze status |
|---|---|---|
| Product name / module | `Sockscap` as independent module (`src-tauri/src/sockscap/`), not an extension of Application Proxy | Frozen |
| Capture architecture | Single capture plane + multi RoutingProfile; adapters do identity/capture only | Frozen |
| Fail policy | Global default fail-open; per-profile fail-closed allowed | Frozen |
| Unknown hostname | Default DIRECT; strict PROXY/BLOCK optional; expose unknown metrics | Frozen |
| TCP-only egress UDP | HTTP CONNECT + SSH Jump default BLOCK for UDP/QUIC | Frozen |
| Third-party core | Prefer MIT; evaluate tun2proxy as library candidate; no GPL static link into MIT app | Frozen principle |
| Windows capture | Global: Wintun/TUN baseline; app/PID: WinDivert SOCKET/FLOW/NETWORK **vs** WFP ALE dual spike | **Open** — ADR amendment after spikes |
| macOS capture | NETransparentProxyProvider system extension | Intent locked; source entitlement/signing contract landed, but Apple capability and real target remain hard gates |
| Linux capture | cgroup v2 + nft socket cgroup match + fwmark/TUN; managed launch netns fallback | Helper-side transaction and recovery source landed; packaged product adapter and privileged lab remain open |
| SSH host key | App-owned known-hosts store with exact `TRUST` / `REPLACE` fingerprint confirmation; background reconnect fails closed | Frozen; security gate closed |
| Phase 0 code in tree | Types, capability probe, preflight, orchestrator, commands, authenticated Linux helper transaction, signed-release source gates, native window smoke, performance/soak gates | Landed; real platform release evidence remains open |

## License and third-party inventory (Phase 0)

| Component | License (as of design review) | Use intent | Gate |
|---|---|---|---|
| tun2proxy | MIT | Candidate userspace TUN→proxy core; need per-flow selector | Spike: can we expose RouteSelector without forking into GPL? |
| WinDivert | LGPLv3 / GPLv2 dual | Windows app/PID capture reference from wsstun | Must not static-link into MIT binary without compliance path; packaging + driver signature + EDR |
| Wintun | Special / open (check current) | Windows global TUN | Signature + redistribution review |
| WFP callout / helper | Custom / first-party preferred | Alternative to WinDivert | Prefer if WinDivert license/EDR fails |
| GFWList | LGPL-2.1 list content | Downloaded at runtime, not compiled into install package | Do not vendor list into MIT binary |
| russh (existing) | Apache-2.0 | Shared, bounded SSH Jump `direct-tcpip` controls/channels | Strict host-key verification and user-action errors landed |
| Existing proxy/tunnel modules | MIT (Taomni) | Reuse ResolvedProxy + direct-tcpip patterns | No second credential store |

**Rule:** any third-party network kernel must pass SBOM + license review before
it is added to `Cargo.toml` or shipped as a sidecar.

## Platform capability matrix (implementation intent)

| Mode | Windows | macOS | Linux |
|---|---|---|---|
| Global new connections | Wintun/TUN | NETransparentProxyProvider (or controlled TUN) | TUN |
| Application group | WinDivert **or** WFP ALE | audit token + signing identity | cgroup v2 + nft + fwmark |
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

## Open gates (must close before leaving Phase 0)

1. **Windows ADR amendment**: choose WinDivert vs WFP after license, signature, reinjection correctness, IPv6, EDR/VPN, and uninstall recovery spikes.
2. **macOS entitlement**: obtain Network Extension entitlement; without it, macOS vertical is blocked.
3. **tun2proxy fitness**: per-flow route hook + lifecycle callback + cancel; if too invasive, build local FlowEngine on ipstack / own connectors.
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
- [ ] This ADR amended with frozen Windows capture choice + dependency versions

## Consequences

### Positive
- Clear module boundary (`sockscap` ≠ Application Proxy)
- Fail-fast preflight prevents silent “only this app” pretence
- License posture documented before any heavy dependency lands

### Negative / cost
- Phase 0 cannot demo real capture yet
- Windows dual-spike increases short-term engineering cost
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
- Phase 0 spikes: Windows dual path and tun2proxy evaluation
- Linux product work: install policy, helper client/launcher, TUN packet pump,
  managed-netns fallback, and privileged distro/recovery lab
- Platform release work: real Windows signatures, Apple capability/signing/
  notarization, native packet/leak/performance matrices, and 24-hour evidence
