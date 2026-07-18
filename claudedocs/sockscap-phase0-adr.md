# ADR: Sockscap Phase 0 — Capture Technology, Licenses, and Gates

- Status: Accepted for scaffolding; capture technology **not frozen**
- Date: 2026-07-18
- Branch: `feat/sockscap-implementation`
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
| macOS capture | NETransparentProxyProvider system extension | Intent locked; entitlement is a hard gate |
| Linux capture | cgroup v2 + nft socket cgroup match + fwmark; managed launch netns fallback | Intent locked; host probe required |
| SSH host key | known_hosts / fingerprint confirmation is a **release gate**; current unconditional accept must be fixed before SSH egress ships | Frozen |
| Phase 0 code in tree | Types, capability probe, preflight, orchestrator state machine, Tauri commands | Landed on this branch |

## License and third-party inventory (Phase 0)

| Component | License (as of design review) | Use intent | Gate |
|---|---|---|---|
| tun2proxy | MIT | Candidate userspace TUN→proxy core; need per-flow selector | Spike: can we expose RouteSelector without forking into GPL? |
| WinDivert | LGPLv3 / GPLv2 dual | Windows app/PID capture reference from wsstun | Must not static-link into MIT binary without compliance path; packaging + driver signature + EDR |
| Wintun | Special / open (check current) | Windows global TUN | Signature + redistribution review |
| WFP callout / helper | Custom / first-party preferred | Alternative to WinDivert | Prefer if WinDivert license/EDR fails |
| GFWList | LGPL-2.1 list content | Downloaded at runtime, not compiled into install package | Do not vendor list into MIT binary |
| russh (existing) | Apache-2.0 | SSH Jump `direct-tcpip` | Host-key verification gap is product risk, not license |
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

Phase 0 probes in `sockscap::capabilities` report host readiness but set
`capture_implemented = false` and `can_start_* = false` so the UI cannot claim
routing works before adapters exist.

## Reference baseline

- Local reference: `wsstun` commit `8282eb2` (`src/sockscap/*`, macOS provider)
- Use as **behavior reference only** — no runtime path dependency between repos
- Do not copy MITM inspection, WebSocket upstream, or CLI secret passing

## Open gates (must close before leaving Phase 0)

1. **Windows ADR amendment**: choose WinDivert vs WFP after license, signature, reinjection correctness, IPv6, EDR/VPN, and uninstall recovery spikes.
2. **macOS entitlement**: obtain Network Extension entitlement; without it, macOS vertical is blocked.
3. **tun2proxy fitness**: per-flow route hook + lifecycle callback + cancel; if too invasive, build local FlowEngine on ipstack / own connectors.
4. **SSH known_hosts**: fix `terminal/ssh.rs::SshHandler::check_server_key` (currently accepts all keys) before any SSH Jump egress release.
5. **Recovery journal + helper heartbeat**: design landed; implementation required before Active on any platform.
6. **VPN / sleep / NIC switch conflict matrix**: documented test plan; not yet executed.

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
  capabilities.rs   # read-only host probes
  preflight.rs      # fail-fast start gate
  orchestrator.rs   # state machine (no capture install)
  commands.rs       # Tauri IPC surface
```

Commands registered in `lib.rs`:
`sockscap_capabilities`, `sockscap_status`, `sockscap_preflight`,
`sockscap_start`, `sockscap_stop`, `sockscap_recover`, `sockscap_open_window`.

## Implementation progress (feat/sockscap-implementation)

As of 2026-07-18 on branch `feat/sockscap-implementation`:

| Phase | Status | Notes |
|---|---|---|
| 0 scaffold | Done | types, probes, preflight, orchestrator, ADR |
| 1 policy | Done | rules, matcher, GFWList last-good, test_target |
| 2 flow | Done | attribution, bypass, DIRECT/SOCKS5/HTTP CONNECT, SSH host-key gate |
| 3 persistence | Done | sockscap.db, profile CRUD, recovery journal, browser stubs |
| 4 UI | Done | independent window, settings entry, en/zh-CN |
| 5–7 adapters | Scaffold | CaptureAdapter trait + Win/macOS/Linux refuse-install implementations |
| 8 tray | Scaffold | color/menu presentation + IPC; not yet bound to app tray |

**Still open for true Active routing:** Windows dual spike ADR, macOS entitlement, Linux nft/cgroup install path, SSH known_hosts, helper heartbeat.

## Follow-ups

- Phase 1: immutable policy matcher + GFWList projection + profile schema
- Phase 2: FlowEngine + egress connectors + SshChannelPool extraction
- Phase 3: sockscap.db + recovery journal + browser stubs
- Phase 0 spikes: Windows dual path, Linux cgroup vertical slice, tun2proxy evaluation
- Bind `sockscap_tray_presentation` to the main Tauri tray
- Implement Linux CaptureAdapter install/uninstall with recovery journal
- Fix `terminal/ssh.rs` host-key verification before enabling SshJumpConnector
