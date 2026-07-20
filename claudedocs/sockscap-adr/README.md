# Sockscap Architecture Decision Records

Phase 0 of the Sockscap plan (`../sockscap-cross-platform-design-plan.md` §13)
requires an ADR set that fixes the capture technology, third-party
versions/licenses, minimum system versions and packaging **before** large-scale
UI work. This directory holds those ADRs.

## Status legend

- **Decided** — the decision is fixed for the current implementation.
- **Provisional** — direction chosen; a Phase 0 spike on real hardware must
  confirm license/signing/performance/compat before it is frozen.
- **Blocked-on-infra** — cannot be completed in a code-only environment; needs
  signed drivers, Apple entitlements, or multi-platform hardware.

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-forwarding-core.md) | Third-party forwarding core (tun2proxy vs custom) | Provisional |
| [0002](0002-windows-capture.md) | Windows capture (WinDivert vs WFP ALE) | Provisional / Blocked-on-infra |
| [0003](0003-macos-capture.md) | macOS capture (NETransparentProxyProvider) | Blocked-on-infra |
| [0004](0004-linux-capture.md) | Linux capture (cgroup v2 + nftables + fwmark) | Provisional |
| [0005](0005-ssh-host-key-verification.md) | SSH host-key verification | Decided (implemented) |

## What is implemented in code today

Phases 1–4 and most product-surface work for Phases 5–8 / plan §11 are in
`src-tauri/src/sockscap` and `src/…`:

- Pure policy/rules core, egress connectors, SSH channel pool + known_hosts
- FlowEngine, stats (unknown host ratio, top apps), persistence, IPC, UI
- **Capture plane selection** (`platform.rs`): always-ready local SOCKS5;
  Linux prefers nft transparent when `nft` is present; Windows probes
  WinDivert; macOS probes provider control socket
- Feature-gated WinDivert NAT engine + pure filter/packet helpers
- macOS Swift `NETransparentProxyProvider` source under
  `src-tauri/resources/macos-provider/` (packaging still external)
- Phase 8 tray: colored solid icons, left-click toggle (Win/mac), status emit

**Still blocked-on-infra:** signed WinDivert/WFP driver install packages,
Apple NE entitlement + notarized system extension embed, Linux polkit
helper packaging, full WinDivert CaptureAdapter handoff on hardware.
See each ADR and design plan §13 Definition of Done.
